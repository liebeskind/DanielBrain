# GraphRAG — Data Model

Seven primary data structures form the "Knowledge Model":

## Entities

- **Fields**: title, type, description (LLM-summarized), embedding
- **Types**: configurable; defaults are PERSON, ORGANIZATION, LOCATION, EVENT
- **Extraction**: one LLM call per text chunk, then descriptions merged across chunks and re-summarized
- **Format**: `("entity"{tuple_delimiter}<name>{tuple_delimiter}<type>{tuple_delimiter}<description>)`

## Relationships

- **Fields**: source_entity, target_entity, description (free text), relationship_strength (numeric 1-10)
- **Extraction**: same LLM call as entities; pairwise between all entities found in a chunk
- **Format**: `("relationship"{tuple_delimiter}<source>{tuple_delimiter}<target>{tuple_delimiter}<description>{tuple_delimiter}<strength>)`
- Duplicate relationships across chunks are merged; descriptions concatenated then LLM-summarized

## Communities

- **Algorithm**: Hierarchical Leiden (via graspologic)
- **Fields**: community_id, level, member_entities, parent_community
- **Hierarchy**: Level 0 = finest granularity; higher levels = coarser groupings
- Each entity belongs to exactly one community per level
- `max_cluster_size` controls when large communities get recursively subdivided

## Community Reports

- **Fields**: community_id, title, summary, full_content, rank, embedding
- **Structure**: executive summary + 5-10 key findings/insights
- **Format**: JSON with `summary` and `findings` array, each with `[Data: Entities (id1, id2); Relationships (id3)]` references
- Generated at every level of the hierarchy

## Text Units (Chunks)

- **Fields**: text, document_id, entity_ids, relationship_ids, embedding
- Default chunk size: 1200 tokens (configurable)
- Maintain provenance links back to source documents
- Linked to entities/relationships extracted from them

## Covariates (Claims)

- **Fields**: subject_id, object_id, type, description, status, start_date, end_date
- Optional (disabled by default)
- Time-bounded factual assertions about entities
- Example: "Entity X was suspected of action Y during period Z"

## Documents

Source documents with links to their constituent text units.
