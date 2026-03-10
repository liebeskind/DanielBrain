# Mem0 Memory Lifecycle (ADD/UPDATE/DELETE/NOOP)

## Overview

Mem0's core innovation is using an LLM to classify how each new fact should interact with existing memories. Rather than a separate classifier, it leverages the LLM's reasoning capabilities via function-calling to select the appropriate operation.

## The `add()` Pipeline in Detail

### Step 1: Input Normalization

Accepts strings, dicts, or lists of message dicts. At least one scope ID required (user_id, agent_id, or run_id).

```python
# All valid inputs:
m.add("I like hiking", user_id="alice")
m.add([{"role": "user", "content": "I like hiking"}], user_id="alice")
m.add(messages, user_id="alice", agent_id="bot", metadata={"source": "chat"})
```

### Step 2: Fact Extraction (LLM Call #1)

Messages are concatenated and sent to the LLM with the FACT_RETRIEVAL_PROMPT:

**Prompt instructs extraction of 7 categories:**
1. Personal preferences (food, activities, entertainment)
2. Personal details (name, age, location)
3. Plans and intentions
4. Activity/service preferences
5. Health/wellness preferences
6. Professional details
7. Miscellaneous

**Output format:**
```json
{"facts": ["Name is John", "Is a software engineer", "Likes hiking"]}
```

**Few-shot examples in prompt:**
- `"Hi"` -> `{"facts": []}`
- `"My name is John. I am a software engineer."` -> `{"facts": ["Name is John", "Is a Software engineer"]}`

**Skip with `infer=False`:** Stores messages directly without extraction.

### Step 3: Embedding + Similarity Search

Each extracted fact is embedded and used to search the vector store:
- Top **s=5** similar existing memories retrieved per fact
- Results deduplicated by memory ID across all facts
- Filtered by session scope (user_id, agent_id, run_id)

### Step 4: Update Decision (LLM Call #2)

The LLM receives existing memories + new facts and classifies each:

**The DEFAULT_UPDATE_MEMORY_PROMPT (verbatim core):**

```
You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) add into the memory, (2) update the memory,
(3) delete from the memory, and (4) no change.

Compare newly retrieved facts with the existing memory. For each new fact, decide whether to:
- ADD: Add it to the memory as a new element
- UPDATE: Update an existing memory element
- DELETE: Delete an existing memory element
- NONE: Make no change (if the fact is already present or irrelevant)
```

**Output format:**
```json
{
    "memory": [
        {"id": "0", "text": "Name is John", "event": "NONE"},
        {"id": "1", "text": "Loves hiking with friends", "event": "UPDATE", "old_memory": "Likes hiking"},
        {"id": "2", "text": "Works at Acme Corp", "event": "ADD"}
    ]
}
```

### Step 5: Action Execution

For each classified fact:

| Event | Action |
|-------|--------|
| **ADD** | Create new memory: embed text, generate UUID, store in vector DB with metadata |
| **UPDATE** | Modify existing memory: new embedding, preserve creation timestamp, update hash (MD5), update timestamp |
| **DELETE** | Remove from vector store, record in history with `is_deleted=1` |
| **NOOP** | Update session IDs if new ones provided, otherwise skip |

Vector and graph operations execute **in parallel** via ThreadPoolExecutor.

## Conflict Resolution Rules

The prompt provides explicit guidelines with examples:

### ADD Rules
- New information not present in existing memory
- LLM generates a new ID

### UPDATE Rules
- Information already present but **totally different** -> update
- Same semantic meaning but more detail -> update with richer version
  - Memory: "User likes to play cricket" + Fact: "Loves to play cricket with friends" -> UPDATE
- Same semantic meaning, same detail level -> NOOP (no update needed)
  - Memory: "Likes cheese pizza" + Fact: "Loves cheese pizza" -> NOOP
- Can **merge** related facts:
  - Memory: "Likes cheese pizza" + Fact: "Loves chicken pizza" -> "Loves cheese and chicken pizza"
- Preserves same ID on update

### DELETE Rules
- New fact **contradicts** existing memory
  - Memory: "Loves cheese pizza" + Fact: "Dislikes cheese pizza" -> DELETE existing
- LLM removes the contradicted memory

### NOOP Rules
- Fact already present in memory -> no action
- Fact is irrelevant -> no action

## Graph Memory Conflict Resolution

When graph memory is enabled, a separate conflict resolution pipeline runs:

### Entity Dedup
1. Embed source and destination entities
2. Search for existing nodes with cosine similarity above threshold (default 0.7)
3. Four cases:
   - Both nodes exist -> link with relationship only
   - Only source exists -> create destination, link
   - Only destination exists -> create source, link
   - Neither exists -> create both, link
4. Increment `mentions` counter on matched nodes

### Relationship Conflict
The DELETE_RELATIONS_SYSTEM_PROMPT guides removal decisions:
- Delete only when information is **outdated, inaccurate, or contradictory**
- Preserve relationships that can coexist (e.g., "loves pizza" and "loves burger" are not contradictory)
- Rather than physically removing contradicted edges, they can be **marked as invalid** to preserve temporal history

### Entity Name Normalization
- Self-references (I, me, my) replaced with user_id
- Names lowercased with spaces replaced by underscores
- Special characters sanitized for Cypher compatibility

## The `infer=False` Bypass

Setting `infer=False` skips both LLM calls:
- No fact extraction
- No conflict resolution
- Each message stored directly as a memory
- Embedding still happens (for future search)
- **Warning**: duplicates will accumulate if you add the same content twice

## Custom Prompts

Both extraction and update prompts are customizable:

```python
config = MemoryConfig(
    custom_fact_extraction_prompt="Extract only technical preferences...",
    custom_update_memory_prompt="Always prefer the most recent information..."
)
```

## History Audit Trail

Every operation is tracked in SQLite:

```python
m.history(memory_id="abc-123")
# Returns: [
#   {"prev_value": None, "new_value": "Likes hiking", "event": "ADD", ...},
#   {"prev_value": "Likes hiking", "new_value": "Loves hiking with friends", "event": "UPDATE", ...},
# ]
```
