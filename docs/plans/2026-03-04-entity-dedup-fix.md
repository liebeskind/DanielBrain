# Entity Resolver Dedup Fix

## Context

After processing 57 real Telegram messages through the pipeline, the entity graph has 276 entities with significant dedup problems:
- **People duplicates**: Parenthetical affiliations create separate entities (`Daniel Liebeskind` vs `Daniel Liebeskind (Topia)`, `Rob Fisher` vs `Rob Fisher (provocative.earth)`)
- **Username vs real name**: `damenlopez` (45 mentions) is a separate entity from `Damen Lopez` (22)
- **First-name-only**: `Chris` (19) not linked to `Chris Psiaki` (50)
- **Junk entities**: `You`, `>{`, `curl`, `],`, empty strings, `the speaker (not specified)`
- **Company duplicates**: `Topia` vs `Topia.io`, `provocative.earth` vs `provocative`
- **Product/project noise**: 122 products + 88 projects, many are generic topics (`carbon capture`, `AI operating system`)

Root causes: (1) `normalizeName()` doesn't strip parentheticals or domain suffixes, (2) no junk filtering, (3) LLM prompts too terse for a small model, (4) no first-name matching.

## What was already done this session

- Pulled `llama3.1:8b` model on Spark (wasn't installed)
- Fixed Zod schema resilience (`packages/shared/src/schema.ts`):
  - `resilientSentiment`: coerces uppercase/invalid LLM sentiment to lowercase enum or null
  - `resilientDates`: filters non-ISO-date strings from `dates_mentioned`
- Updated tests in `packages/shared/__tests__/schema.test.ts` (167 tests passing)
- Reprocessed all 57 queue items — 55/57 completed, 241 thoughts, 276 entities, 1035 links
- **These schema changes are uncommitted** — commit them as part of implementation

## Design Principle: Claude Writes Prompts for Local Models

All LLM calls go to **llama3.1:8b** on the DGX Spark via Ollama. This is a capable but small model — it needs much more explicit prompting than a frontier model. The current prompts are one-liners that assume the model will "figure it out."

**Three prompts to rewrite** (all in `packages/service/src/processor/`):
1. `extractor.ts` — metadata extraction (system prompt + schema descriptions)
2. `summarizer.ts` — long content summarization
3. `profile-generator.ts` — entity profile generation

**Prompt engineering principles for llama3.1:8b:**
- **Explicit rules with examples** — small models need concrete "do this / don't do this" with real examples
- **Few-shot examples** — include 1-2 input→output examples in the system prompt so the model knows the exact format and quality bar
- **Negative examples** — explicitly show what NOT to output (junk names, generic topics as products, etc.)
- **Structured constraints** — repeat key constraints from the schema descriptions in the system prompt
- **Short, direct sentences** — avoid complex compound instructions; one rule per line
- **Role grounding** — give the model a concrete role and context about what system it's part of

## Plan — 4 Phases

### Phase 1: Enhanced Normalization + Junk Filter
**File: `packages/service/src/processor/entity-resolver.ts`**

**1a. Improve `normalizeName()`** — add regex transforms:
- Strip all parentheticals: `\s*\([^)]*\)\s*` → removes `(Topia)`, `(he/him/his)`, `(Founder of NEU)`
- Strip domain suffixes: `\.(io|com|org|net|co|earth|ai|dev|app|xyz|tech)$`
- Strip pronoun suffixes outside parens: `\s+(he/him|she/her|they/them|...)$`
- Expand company suffixes regex to include `gmbh|plc|s\.?a\.?`

**1b. Add `isJunkEntity()` function** — gate before any DB interaction:
- Min length 2, max length 60 (after normalization)
- Blocklist: `you`, `me`, `we`, `they`, `someone`, `the speaker`, `not specified`, `unknown`, `n/a`, `none`, `null`, `undefined`, `your_name`
- Pattern reject: no alphabetic chars, only punctuation, starts with article, ends with `attendees`, CLI commands (`curl`, `wget`)

**1c. Wire into `resolveEntities()`** — skip junk entries with `continue`

**Tests:** ~15 new tests for normalization edge cases + junk detection

### Phase 2: Rewrite All LLM Prompts (Claude-authored, optimized for llama3.1:8b)

All three LLM-facing prompts get rewritten with explicit rules, few-shot examples, and negative examples.

**2a. Extraction prompt** — `packages/service/src/processor/extractor.ts`

Current system prompt (1 line): `"You are a metadata extraction assistant. Extract structured metadata..."`

Replace with a detailed prompt including:
- Explicit rules per field with DO/DON'T examples
- **people**: "Extract full real names. DO: 'Daniel Liebeskind', 'Rob Fisher'. DON'T: 'damenlopez' (username), 'You', 'the team', 'attendees', 'Chris (Topia)' (strip the parenthetical → 'Chris')"
- **companies**: "Extract organization names without domains or legal suffixes. DO: 'Topia', 'AWS'. DON'T: 'Topia.io', 'Acme Corp Inc.'"
- **products**: "Only specific named software, hardware, or platforms. DO: 'Docker', 'Kubernetes', 'GPT-4'. DON'T: 'GPUs' (generic category), 'AI operating system' (concept), 'carbon capture' (topic)"
- **projects**: "Only explicitly named projects with proper nouns. DO: 'Project Atlas', 'DanielBrain'. DON'T: 'bare-metal experiment' (activity), 'onboarding flow' (feature)"
- **sentiment**: "Must be exactly one of: positive, negative, neutral, mixed (lowercase)"
- **dates_mentioned**: "Only YYYY-MM-DD format. If no specific dates, return empty array []"
- **One complete few-shot example** in the system prompt showing input text → expected JSON output
- Update `EXTRACTION_SCHEMA` field descriptions to match the detailed rules

**2b. Summarizer prompt** — `packages/service/src/processor/summarizer.ts`

Current system prompt (1 line): `"You are a summarization assistant. Produce a concise 2-3 sentence summary..."`

Replace with:
- Context about what the system does ("You are summarizing content for a personal knowledge management system")
- Explicit structure: "Sentence 1: What this is about. Sentence 2: Key decisions or facts. Sentence 3: Action items if any."
- Rule: "Name specific people, companies, and projects — don't say 'they discussed' when you can say 'Daniel and Rob discussed'"
- Rule: "Keep names exactly as they appear in the text, without adding parenthetical annotations"
- Length constraint: "Exactly 2-3 sentences. No bullet points, no headers."

**2c. Profile generator prompt** — `packages/service/src/processor/profile-generator.ts`

Current system prompt (1 line): `"You are a concise profile writer..."`

Replace with:
- Context: "You are writing a profile for a knowledge graph entity. This profile will be used by AI agents to understand who/what this entity is."
- Structure: "Sentence 1: Who/what this is (role, title, affiliation). Sentences 2-3: Key themes and context from recent interactions. Sentences 4-5 (if relevant): Notable relationships, projects, or decisions."
- Rule: "Write in third person. Be factual, not speculative."
- Rule: "If the context is thin (few interactions), write a shorter profile rather than padding with generic statements."
- One example showing context → profile output

**Tests for Phase 2:**
- `extractor.test.ts`: Verify system prompt contains key rules (check for "DON'T", few-shot markers, etc.)
- `summarizer.test.ts`: Verify prompt mentions knowledge management context
- `profile-generator.test.ts`: Verify prompt mentions knowledge graph context

### Phase 3: First-Name Prefix Matching + Alias Auto-Population
**File: `packages/service/src/processor/entity-resolver.ts`**

**3a. Add prefix match stage** in `findOrCreateEntity()` — between alias match and INSERT:
- Only for `person` entity type
- Only when input is a single token (no spaces)
- Matches `canonical_name LIKE $1 || ' %'` ordered by `mention_count DESC`
- Returns confidence 0.7 (lower than canonical=1.0 and alias=0.9)
- Auto-adds first name to matched entity's aliases array

**3b. Auto-populate aliases** after every successful match:
- Store raw lowered input as alias if it differs from canonical
- Ensures `find_entity_by_name()` SQL function can find variants too

**Tests:** ~6 new tests for prefix matching behavior + non-person exclusion

### Phase 4: Database Cleanup Migration
**File: `migrations/012_merge_duplicate_entities.sql`**

Run AFTER Phases 1-3 are deployed. Steps:
1. Delete known junk entities (blocklist + pattern)
2. Re-normalize all `canonical_name` values with same transforms as new `normalizeName()`
3. For each group of now-duplicate entities (same canonical + type): pick highest mention_count as survivor, reassign `thought_entities` + `entity_relationships`, merge aliases, sum mention counts, delete losers
4. Manual merge for known cases: `NEU` + `No Excuses University`, `damenlopez` + `Damen Lopez`
5. Invalidate all profiles (set `profile_summary = NULL`) so they regenerate with merged data

**File: `migrations/013_update_find_entity_function.sql`** — align SQL function normalization with app code

**Pre-requisite**: `pg_dump` backup before running

## Implementation Order

Phases 1 + 2 in parallel (independent files), then Phase 3, then Phase 4 (after restart).

## Verification

1. `npm test` — all tests pass (existing + new)
2. Restart service, send new test messages via Telegram
3. Run DB queries to verify:
   - No new junk entities created
   - Parenthetical variants resolve to same entity
   - First-name "Chris" links to "Chris Psiaki"
   - Entity count drops significantly after migration
4. Check entity list: `SELECT name, entity_type, mention_count FROM entities ORDER BY mention_count DESC`

## CLAUDE.md Update

Add a new section to `CLAUDE.md` under "Key Design Decisions" documenting the prompting standard:

**LLM Prompting Standard**: All prompts sent to local Ollama models (llama3.1:8b) must be explicit, structured prompts with examples. Claude writes these prompts, optimized for the smaller model's capabilities. Every prompt must include:
- Clear role and context about the system
- Explicit DO/DON'T rules per field or output requirement
- At least one concrete few-shot example (input → expected output)
- Negative examples showing common mistakes to avoid
- Exact format constraints (lowercase enums, date formats, length limits)

This applies to all current and future LLM calls: extraction, summarization, profile generation, and any new processing steps.

## Files to Modify

- `packages/service/src/processor/entity-resolver.ts` — normalization, junk filter, prefix match, alias population
- `packages/service/src/processor/extractor.ts` — rewrite extraction prompt + schema descriptions
- `packages/service/src/processor/summarizer.ts` — rewrite summarization prompt
- `packages/service/src/processor/profile-generator.ts` — rewrite profile generation prompt
- `packages/service/__tests__/processor/entity-resolver.test.ts` — new tests
- `packages/service/__tests__/processor/extractor.test.ts` — prompt verification tests
- `packages/service/__tests__/processor/summarizer.test.ts` — prompt verification test
- `packages/service/__tests__/processor/profile-generator.test.ts` — prompt verification test
- `migrations/012_merge_duplicate_entities.sql` — new migration
- `migrations/013_update_find_entity_function.sql` — new migration
- `CLAUDE.md` — add LLM prompting standard to Key Design Decisions
