# Atomic Fact Extraction Research

**Date**: 2026-03-23
**Purpose**: Concrete implementation details from leading systems for fact-level knowledge management. Informing design decisions for TopiaBrain fact extraction.

---

## 1. Graphiti (Zep) — Facts as Edges

**Paper**: [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/html/2501.13956v1) (Jan 2025)
**Source**: [github.com/getzep/graphiti](https://github.com/getzep/graphiti)

### Fact Schema (EntityEdge)

Facts ARE edges in the knowledge graph. Every fact connects two entities.

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | str | Unique identifier |
| `source_node_uuid` | str | Source entity |
| `target_node_uuid` | str | Target entity |
| `name` | str | Relation type in SCREAMING_SNAKE_CASE (`WORKS_AT`, `MANAGES`) |
| `fact` | str | Natural language description of the relationship |
| `fact_embedding` | float[] | Vector embedding of `fact` text |
| `episodes` | str[] | UUIDs of source episodes that produced this edge |
| `valid_at` | datetime | Event time: when fact became true in reality |
| `invalid_at` | datetime | Event time: when fact stopped being true |
| `created_at` | datetime | Transaction time: when edge was created in system |
| `expired_at` | datetime | Transaction time: when edge was superseded in system |
| `attributes` | dict | Custom attributes from Pydantic edge type definitions |
| `group_id` | str | Namespace/tenant partition |

### How Facts Are Extracted

**1 LLM call per episode for edge extraction.** Prompt structure:

```
System: "You are an expert fact extractor that extracts fact triples from text."

Context provided:
- edge_types: Permitted relationship types with Pydantic signatures
- previous_episodes: Prior conversation context
- episode_content: Current message to analyze
- nodes: Entity list with IDs (from prior entity extraction step)
- reference_time: ISO 8601 timestamp
- custom_prompt: Optional domain-specific instructions

Output per edge:
{
  "relation_type": "SCREAMING_SNAKE_CASE",
  "source_entity_id": int,
  "target_entity_id": int,
  "fact": "natural language description",
  "valid_at": "ISO 8601 or null",
  "invalid_at": "ISO 8601 or null"
}
```

**Temporal extraction rules** (from the prompt):
- Present tense → `valid_at` = reference_time
- Terminated relationships → `invalid_at` = relevant timestamp
- No explicit timing → both null
- Date-only → assume 00:00:00 UTC
- Year-only → January 1st 00:00:00 UTC

### Contradiction Detection

**Multi-stage edge resolution pipeline:**

1. **In-batch dedup**: Remove exact duplicates within extracted edges using (source UUID, target UUID, normalized fact) as composite key
2. **Parallel search**: For each edge, concurrently fetch existing edges between same node pair AND semantically similar edges via hybrid search + RRF
3. **Verbatim fast-path**: If normalized fact text + node endpoints match exactly, reuse existing edge (append episode UUID to `episodes` list)
4. **LLM dedup + contradiction** (1 LLM call per edge): Returns `duplicate_facts` (indices of identical existing edges) and `contradicted_facts` (indices of edges contradicted by new fact)

**Key rule**: A fact can be BOTH a duplicate AND contradicted — "semantically the same but the new fact updates/supersedes it." Numeric value variations prevent duplicate classification.

### Temporal Invalidation Logic

```
for each contradicted edge:
    if edge.invalid_at <= new_edge.valid_at:
        continue  # Already expired
    if new_edge.invalid_at <= edge.valid_at:
        continue  # New fact expired before old was valid
    if edge.valid_at < new_edge.valid_at:
        edge.invalid_at = new_edge.valid_at  # Old ends when new begins
        edge.expired_at = utc_now()          # Mark expired in system time
```

**Never deletes.** Contradicted edges get `expired_at` + `invalid_at` set. Full history preserved.

### Dedup Strategy

- Same entity pair + semantically identical fact text = duplicate (reuse existing edge, append episode)
- Hybrid search (cosine on `fact_embedding` + BM25 on `fact` text) finds candidates
- LLM confirms semantic equivalence
- Constrained to edges between same entity pairs (reduces search space)

### LLM Cost Per Episode

5-15+ LLM calls: 1 entity extraction + 1 per new entity summary + 1 entity dedup + 1 edge extraction + 1 per edge dedup/contradiction + 1 per community update.

---

## 2. Mem0 — Facts as Atomic Memories

**Paper**: [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/html/2504.19413v1) (Apr 2025)
**Source**: [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0)

### Memory Schema (MemoryItem)

Each memory is a **single extracted fact** stored as a vector with metadata.

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique identifier |
| `memory` | str | The fact text ("User likes hiking") |
| `hash` | str | MD5 hex digest of content |
| `created_at` | datetime | Creation timestamp |
| `updated_at` | datetime | Last modification |
| `user_id` | str | User scope |
| `agent_id` | str | Agent scope |
| `run_id` | str | Session scope |
| `metadata` | dict | Custom metadata fields |

**Memories are atomic facts, not full messages.** Examples:
- "Name is John"
- "Is a software engineer"
- "Favourite movies are Inception and Interstellar"

### How Facts Are Extracted (LLM Call #1)

**FACT_RETRIEVAL_PROMPT** (from `mem0/configs/prompts.py`):

```
"You are a Personal Information Organizer, specialized in accurately
storing facts, user memories, and preferences."

Extracts 7 categories:
1. Personal preferences (food, activities, entertainment)
2. Personal details (name, age, location)
3. Plans and intentions
4. Activity/service preferences
5. Health/wellness preferences
6. Professional details
7. Miscellaneous

Output: {"facts": ["Name is John", "Is a Software engineer"]}

Few-shot examples:
- "Hi" → {"facts": []}
- "My name is John. I am a software engineer." →
  {"facts": ["Name is John", "Is a Software engineer"]}
```

### ADD/UPDATE/DELETE/NOOP Classification (LLM Call #2)

**DEFAULT_UPDATE_MEMORY_PROMPT:**

```
"You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) add into the memory, (2) update
the memory, (3) delete from the memory, and (4) no change."

Input: existing memories + new extracted facts
Output:
{
  "memory": [
    {"id": "0", "text": "Name is John", "event": "NONE"},
    {"id": "1", "text": "Loves hiking with friends", "event": "UPDATE",
     "old_memory": "Likes hiking"},
    {"id": "2", "text": "Works at Acme Corp", "event": "ADD"}
  ]
}
```

### Contradiction Detection Rules

| Scenario | Operation |
|----------|-----------|
| New info not in existing memory | ADD (new ID) |
| Info present but totally different | UPDATE (same ID, richer version) |
| Same semantic meaning, more detail | UPDATE ("Likes hiking" → "Loves hiking with friends") |
| Same semantic meaning, same detail | NOOP ("Likes cheese pizza" ≈ "Loves cheese pizza") |
| Related facts can merge | UPDATE ("Likes cheese pizza" + "Loves chicken pizza" → "Loves cheese and chicken pizza") |
| New fact contradicts existing | DELETE existing + ADD new |

### Dedup Strategy

1. Each extracted fact is embedded
2. Top-5 (configurable, recommended 10) similar existing memories retrieved per fact via vector search
3. Results deduplicated by memory ID across all facts
4. LLM classifies each as ADD/UPDATE/DELETE/NOOP
5. No explicit similarity threshold — relies on LLM judgment

### History Audit Trail

Every operation tracked in SQLite:
```
{memory_id, prev_value, new_value, event: "ADD"|"UPDATE"|"DELETE", timestamp, actor_id}
```

### Graph Memory (Optional, Mem0g)

When enabled, also extracts (source, relationship, destination) triples stored in Neo4j:
- Nodes: name, entity_type, embedding, created_at, mentions count
- Edges: source → relationship → destination
- Conflict detection: LLM determines if relationships should be marked invalid (not deleted)
- Entity dedup: cosine similarity threshold 0.7

### LLM Cost Per Input

2 LLM calls: 1 fact extraction + 1 update classification. Plus optional graph extraction.

---

## 3. Microsoft GraphRAG — Claims as Covariates

**Paper**: [From Local to Global: A Graph RAG Approach](https://arxiv.org/html/2404.16130v1) (Apr 2024)
**Source**: [github.com/microsoft/graphrag](https://github.com/microsoft/graphrag)

### Claim Schema (Covariate)

Claims are **optional, disabled by default** because they "generally require prompt tuning to be useful."

| Field | Type | Description |
|-------|------|-------------|
| `subject_id` | str | Entity that committed the action (capitalized) |
| `object_id` | str | Entity affected/reported; "NONE" if unknown |
| `type` | str | Repeatable category (capitalized, e.g., "ANTI-COMPETITIVE PRACTICES") |
| `description` | str | Detailed claim with evidence and references |
| `status` | str | TRUE, FALSE, or SUSPECTED |
| `start_date` | str | ISO-8601, or NONE |
| `end_date` | str | ISO-8601, or NONE |
| `source_text` | str | Relevant quotes from original text |

### How Claims Are Extracted

Output tuple format:
```
(subject_entity, object_entity, claim_type, claim_status,
 claim_start_date, claim_end_date, claim_description, claim_source)
```

The prompt is parameterized with `{entity_specs}` (what entities to look for), `{claim_description}` (what kind of claims to extract), and `{input_text}`. The default prompt is oriented toward identifying "malicious behavior such as fraud" — requires customization for other domains.

### Contradiction Detection

**None.** GraphRAG has no contradiction detection. It's a batch indexing system — reindex to update.

### Dedup Strategy

**None at the claim level.** Entities and relationships get dedup (descriptions merged across chunks, re-summarized by LLM). Claims don't.

### Key Insight

GraphRAG's claim extraction is the weakest of the systems studied. It's optional, domain-specific (fraud/compliance-oriented by default), has no dedup or contradiction handling, and requires significant prompt tuning. However, the **schema design** (subject, object, type, status, dates, source_text) is well-structured.

---

## 4. FActScore — Atomic Fact Decomposition

**Paper**: [FActScore: Fine-grained Atomic Evaluation of Factual Precision](https://arxiv.org/abs/2305.14251) (EMNLP 2023)
**Source**: [github.com/shmsw25/FActScore](https://github.com/shmsw25/FActScore)

### What Is an Atomic Fact?

"A short sentence conveying one piece of information" — more fundamental than a sentence.

### Decomposition Method

1. Split generation into sentences
2. Feed each sentence to InstructGPT with instructions to break into atomic facts
3. Human annotators revised: 18% needed further splitting, 34% needed merging

### Concrete Example

**Input**: "Ylona Garcia has since appeared in various TV shows such as ASAP (All-Star Sunday Afternoon Party), Wansapanataym Presents: Annika PINTAsera and Maalaala Mo Kaya."

**Output atomic facts**:
- Ylona Garcia has appeared in various TV shows
- She has appeared in ASAP
- ASAP stands for All-Star Sunday Afternoon Party
- ASAP is a TV show

**Average**: 4.4 atomic facts per sentence (ChatGPT), ~40% of sentences contain mix of supported/unsupported facts.

### Verification Pipeline

Each atomic fact is verified against Wikipedia via:
1. Dense retrieval (GTR-based) to find relevant passages
2. LLM judges if fact is supported/not-supported/irrelevant
3. FActScore = percentage of supported atomic facts

### Key Insight for TopiaBrain

FActScore is an **evaluation** framework, not a storage system. But its decomposition methodology — one fact per sentence, self-contained, independently verifiable — defines the gold standard for what an "atomic fact" should look like.

---

## 5. SAFE (Google DeepMind) — Search-Augmented Factuality

**Paper**: [Long-form factuality in large language models](https://arxiv.org/abs/2403.18802) (NeurIPS 2024)
**Source**: [github.com/google-deepmind/long-form-factuality](https://github.com/google-deepmind/long-form-factuality)

### Decomposition Process

1. LLM (GPT-4) decomposes long-form response into individual atomic facts
2. Each fact independently verified via multi-step reasoning with Google Search
3. Agreement with human annotators: 72% (SAFE wins 76% of disagreements)
4. 20x cheaper than human annotation

### Key Finding

Single sentences often contain multiple individual facts. Sentence-level evaluation is too coarse.

---

## 6. Dense X Retrieval — Propositions as Retrieval Units

**Paper**: [Dense X Retrieval: What Retrieval Granularity Should We Use?](https://weaviate.io/papers/paper10) (EMNLP 2024)

### Proposition Definition

Three required properties:
1. **Unique**: A distinct piece of meaning in text
2. **Atomic**: Cannot be further split into separate propositions
3. **Self-contained**: Includes all necessary context (no pronouns, no implicit references)

### Extraction Method

GPT-4 prompted with definition + 1-shot example, processing 42K Wikipedia passages into propositions. A fine-tuned FlanT5-large ("The Propositionizer") automates this at scale.

### Performance

- 17-25% Recall@5 improvement on EntityQuestions (unsupervised retrievers)
- +4.9 to +7.8 EM@100 on downstream QA tasks
- ~10 propositions per 100-200 word passage (vs 5 sentences, 2 passages)

### Storage

Each proposition stored independently with embedding + metadata linking back to source passage. Propositions are the retrieval unit, not chunks.

---

## 7. Claimify (Microsoft Research) — Quality-First Claim Extraction

**Paper**: [Claimify blog post](https://www.microsoft.com/en-us/research/blog/claimify-extracting-high-quality-claims-from-language-model-outputs/)

### Four-Stage Pipeline

1. **Sentence Splitting + Context**: Divide into sentences with neighboring context
2. **Selection**: LLM identifies sentences lacking verifiable content → skip or trim
3. **Disambiguation**: LLM detects ambiguities. If unresolvable → flag, don't guess
4. **Decomposition**: LLM creates standalone claims preserving critical context

### Quality Principles

- Claims must capture all verifiable content, exclude opinion
- Each claim fully supported by source text (no overgeneralization)
- Claims must be understandable independently
- Critical context preserved (prevent fact-checking verdict distortion)
- Flag irreducible ambiguities rather than guess

---

## 8. Proposition Chunking (RAG Techniques)

**Source**: [NirDiamant/RAG_Techniques](https://github.com/NirDiamant/RAG_Techniques)

### Prompt Template for Extraction

Five criteria per proposition:
1. Express a single fact
2. Be understandable without context (self-contained)
3. Use full entity names (no pronouns)
4. Include relevant dates/qualifiers
5. One subject-predicate relationship per proposition

### Quality Assurance

Each proposition scored on accuracy, clarity, completeness, conciseness (threshold >= 7/10 on each).

### Storage

Propositions embedded with nomic-embed-text into FAISS. Metadata includes source title, origin chunk ID, document reference.

---

## Cross-System Comparison

| System | Fact Unit | Schema Fields | Extraction Cost | Contradiction Detection | Dedup Strategy | Temporal Model | Storage |
|--------|-----------|---------------|-----------------|------------------------|----------------|----------------|---------|
| **Graphiti** | Edge (entity→entity) | fact, relation_type, valid/invalid_at, created/expired_at, episodes, fact_embedding | 1 LLM call extraction + 1 per edge resolution | LLM compares against existing edges between same entity pair | Hybrid search + LLM confirmation | Bi-temporal (event + transaction) | Separate (edges in Neo4j) |
| **Mem0** | Atomic memory | memory text, hash, timestamps, scope IDs | 1 LLM call extraction + 1 classification | LLM classifies as DELETE when contradicting | Vector similarity + LLM judgment | None (overwrite via UPDATE) | Separate (vector store) |
| **GraphRAG** | Covariate/Claim | subject, object, type, status, dates, description, source_text | 1 LLM call per text unit | None | None | start_date/end_date (one-time) | Separate (Parquet) |
| **FActScore** | Atomic fact | text only | 1 LLM call per sentence | N/A (evaluation only) | N/A | None | N/A |
| **Dense X** | Proposition | text + source_passage_id | 1 LLM call per passage | N/A (retrieval only) | N/A | None | Separate (vector index) |
| **Claimify** | Claim | text + source_text | 4 LLM calls per passage (select, disambig, decompose, quality) | N/A (evaluation only) | N/A | None | N/A |

---

## Design Recommendations for TopiaBrain

### Q1: Separate table or embedded in thought metadata?

**Separate table.** Every system that stores facts uses a separate data structure:
- Graphiti: edges (separate from episodes)
- Mem0: memories (separate from source messages)
- GraphRAG: covariates (separate from text units)
- Dense X: propositions (separate from passages)

**Reasons for separate table:**
- Facts have their own embeddings (for semantic search at fact granularity)
- Facts need independent lifecycle (create, update, invalidate, delete)
- Same fact can be sourced from multiple thoughts
- Facts link to entities independently of their source thought
- Dedup requires comparing facts across thoughts

### Q2: What's the minimal viable atomic fact schema?

Based on the cross-system analysis, the minimum viable schema:

```sql
CREATE TABLE facts (
    id UUID PRIMARY KEY,
    content TEXT NOT NULL,                -- The atomic fact in natural language
    content_embedding vector(768),        -- For semantic search/dedup

    -- Entity linkage (Graphiti model: facts connect entities)
    subject_entity_id UUID REFERENCES entities(id),
    object_entity_id UUID REFERENCES entities(id),  -- nullable
    relation_type TEXT,                   -- SCREAMING_SNAKE_CASE

    -- Provenance (which thoughts produced this fact)
    source_thought_ids UUID[],            -- Array of thought IDs
    source_text TEXT,                     -- Original text excerpt

    -- Temporal validity (Graphiti bi-temporal model)
    valid_at TIMESTAMPTZ,                 -- When fact became true
    invalid_at TIMESTAMPTZ,               -- When fact stopped being true

    -- System timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    expired_at TIMESTAMPTZ,               -- When superseded in system

    -- Confidence & status (GraphRAG + Mem0)
    confidence TEXT DEFAULT 'auto',       -- auto, confirmed, rejected
    status TEXT DEFAULT 'active',         -- active, superseded, deleted

    -- Metadata
    visibility TEXT[] DEFAULT '{}',       -- Same model as thoughts
    source_meta JSONB DEFAULT '{}'        -- Extraction metadata
);
```

### Q3: How should extraction work?

**Recommended: Hybrid Graphiti + Mem0 approach**

1. **Extract facts from thought** (1 LLM call): After entity extraction (which we already do), extract facts between identified entities. Use Graphiti's prompt pattern: given ENTITIES and CONTENT, extract fact triples with temporal information.

2. **Search for existing similar facts** (0 LLM calls): For each extracted fact, query `facts` table using hybrid search (cosine on `content_embedding` + BM25 on `content`), constrained to facts involving the same entity pair (Graphiti optimization).

3. **Classify each fact** (1 LLM call, batched): Mem0's ADD/UPDATE/NOOP pattern. Send existing similar facts + new fact to LLM. Determine:
   - **ADD**: Genuinely new information
   - **UPDATE**: Enriches/supersedes existing fact → create new, invalidate old
   - **NOOP**: Already captured

4. **Route through proposals for contradictions**: When UPDATE would invalidate an existing fact, create a proposal for review (our existing HITL advantage). Auto-apply high-confidence updates, hold low-confidence ones.

### Q4: How should contradiction detection work?

**Two levels:**

1. **Automatic (Graphiti temporal model)**: When a new fact supersedes an old one between the same entities:
   - Set `invalid_at` on old fact = `valid_at` of new fact
   - Set `expired_at` on old fact = now()
   - Never delete — preserve full history

2. **HITL-gated (our advantage)**: Create a proposal for the human to review when:
   - Confidence is low (LLM uncertain about whether this contradicts)
   - High-impact entities (e.g., company relationships, deal statuses)
   - The contradicted fact was previously human-confirmed

### Q5: What gives the most value with minimal effort?

**Phase 1 (MVP)**: Extract facts only for entity-entity relationships during existing entity resolution pipeline. Store as rows in `facts` table with embeddings. Enable fact-level semantic search. This is essentially upgrading our `entity_relationships` table to store facts per-edge rather than just descriptions.

**Phase 2**: Add contradiction detection + temporal invalidation. Route through proposals queue.

**Phase 3**: Full proposition extraction from all thoughts (Dense X style). Every thought decomposed into standalone facts. This enables fact-level retrieval as an alternative to chunk-level retrieval.

### Key Trade-offs

| Approach | LLM Cost | Complexity | Value |
|----------|----------|------------|-------|
| Facts only between entities (Graphiti-style) | +1-2 calls/thought | Low | High — upgrades entity relationships |
| Full atomic decomposition (Dense X style) | +1 call/thought | Medium | Highest — enables fact-level retrieval |
| Mem0-style memory lifecycle | +2 calls/thought | High | Medium — best for personal preference tracking |
| GraphRAG claims | +1 call/text unit | Low | Low — too domain-specific without tuning |

**Recommendation**: Start with Graphiti-style entity-linked facts (Phase 1), then add Dense X proposition extraction (Phase 3) once the schema and pipeline prove out. Skip GraphRAG claims and Mem0's full lifecycle — our proposals queue handles the HITL better.

---

## Sources

- [Zep Paper](https://arxiv.org/html/2501.13956v1)
- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [Graphiti Edge Extraction Prompt](https://github.com/getzep/graphiti/blob/5a67e660dce965582ba4b80d3c74f25e7d86f6b3/graphiti_core/prompts/extract_edges.py)
- [Graphiti Edge Dedup Prompt](https://github.com/getzep/graphiti/blob/5a67e660dce965582ba4b80d3c74f25e7d86f6b3/graphiti_core/prompts/dedupe_edges.py)
- [Graphiti Edge Operations (DeepWiki)](https://deepwiki.com/getzep/graphiti/5.3-edge-operations)
- [Mem0 Paper](https://arxiv.org/html/2504.19413v1)
- [Mem0 GitHub](https://github.com/mem0ai/mem0)
- [Mem0 Prompts](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)
- [Mem0 Architecture (DeepWiki)](https://deepwiki.com/mem0ai/mem0)
- [GraphRAG Paper](https://arxiv.org/html/2404.16130v1)
- [GraphRAG Claim Extraction Prompts](https://github.com/langgptai/GraphRAG-Prompts)
- [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/)
- [FActScore Paper](https://arxiv.org/abs/2305.14251)
- [FActScore GitHub](https://github.com/shmsw25/FActScore)
- [SAFE Paper (Google DeepMind)](https://arxiv.org/abs/2403.18802)
- [SAFE GitHub](https://github.com/google-deepmind/long-form-factuality)
- [Dense X Retrieval](https://weaviate.io/papers/paper10)
- [Claimify (Microsoft Research)](https://www.microsoft.com/en-us/research/blog/claimify-extracting-high-quality-claims-from-language-model-outputs/)
- [Proposition Chunking (RAG Techniques)](https://github.com/NirDiamant/RAG_Techniques/blob/main/all_rag_techniques/proposition_chunking.ipynb)
- [Atomic Fact Extraction and Verification (AFEV)](https://arxiv.org/html/2506.07446v1)
- [Question-Based Retrieval using Atomic Units](https://aclanthology.org/2024.fever-1.25/)
