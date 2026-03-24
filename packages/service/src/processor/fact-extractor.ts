import type pg from 'pg';
import type { ThoughtMetadata } from '@danielbrain/shared';
import { OLLAMA_LLM_TIMEOUT_MS } from '@danielbrain/shared';
import { embed } from './embedder.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('fact-extractor');

interface FactExtractionConfig {
  ollamaBaseUrl: string;
  extractionModel: string;
  embeddingModel: string;
}

export interface ExtractedFact {
  statement: string;
  fact_type: string;
  confidence: number;
  subject: string | null;
  object: string | null;
  valid_at: string | null;
}

const FACT_EXTRACTION_PROMPT = `You extract atomic facts from text. An atomic fact is a single, self-contained statement that conveys one piece of information. Each fact should be understandable without the original text.

RULES:
- Each fact must be a complete sentence with resolved pronouns (use full names, not "he/she/they")
- Facts must be directly supported by the text — do NOT infer or speculate
- Extract 3-10 facts. Prioritize: decisions, role/relationship claims, capabilities, constraints, events
- Skip generic/obvious facts ("The meeting happened")
- Subject/object should be entity names (people, companies, products, projects) when applicable
- fact_type: "claim" (general statement), "decision" (agreed action), "constraint" (limitation), "event" (happened), "capability" (can/supports), "preference" (wants/prefers)
- confidence: 0.5-1.0 based on how explicitly stated (direct quote = 1.0, implied = 0.6)
- valid_at: ISO date if the fact has a specific time reference, null otherwise

Return JSON array:
[
  {"statement": "...", "fact_type": "claim", "confidence": 0.9, "subject": "Entity A", "object": "Entity B", "valid_at": null}
]

EXAMPLE:
Text: "Meeting with Chris Psiaki about K12 Zone. Chris confirmed Stride wants to add 3 more schools by Q2. Decision: launch beta March 15. Canvas LTI 1.3 does not support SSO passthrough."
Entities: Chris Psiaki (person), Stride (company), K12 Zone (product), Canvas (product)

[
  {"statement": "Stride wants to add 3 more schools to K12 Zone by Q2.", "fact_type": "event", "confidence": 0.9, "subject": "Stride", "object": "K12 Zone", "valid_at": null},
  {"statement": "K12 Zone beta will launch on March 15.", "fact_type": "decision", "confidence": 1.0, "subject": "K12 Zone", "object": null, "valid_at": null},
  {"statement": "Canvas LTI 1.3 does not support SSO passthrough.", "fact_type": "constraint", "confidence": 1.0, "subject": "Canvas", "object": null, "valid_at": null},
  {"statement": "Chris Psiaki confirmed the Stride expansion plans.", "fact_type": "claim", "confidence": 0.85, "subject": "Chris Psiaki", "object": "Stride", "valid_at": null}
]`;

/** Extract atomic facts from thought content via LLM */
export async function extractFactsFromContent(
  content: string,
  entities: Array<{ name: string; entity_type: string }>,
  config: FactExtractionConfig,
): Promise<ExtractedFact[]> {
  const entityList = entities.length > 0
    ? entities.map((e) => `${e.name} (${e.entity_type})`).join(', ')
    : 'none identified';

  const truncated = content.length > 3000 ? content.slice(0, 3000) + '...' : content;

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      messages: [
        { role: 'system', content: FACT_EXTRACTION_PROMPT },
        { role: 'user', content: `Text: "${truncated}"\nEntities: ${entityList}` },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Ollama fact extraction failed: ${response.status}`);
  }

  const data = (await response.json()) as { message: { content: string } };
  const parsed = JSON.parse(data.message.content);

  if (!Array.isArray(parsed)) return [];

  const validTypes = new Set(['claim', 'decision', 'constraint', 'event', 'capability', 'preference']);

  return parsed
    .filter((f: any) => f.statement && typeof f.statement === 'string')
    .map((f: any) => ({
      statement: f.statement,
      fact_type: validTypes.has(f.fact_type) ? f.fact_type : 'claim',
      confidence: typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.8,
      subject: typeof f.subject === 'string' ? f.subject : null,
      object: typeof f.object === 'string' ? f.object : null,
      valid_at: typeof f.valid_at === 'string' ? f.valid_at : null,
    }))
    .slice(0, 15); // cap to prevent runaway extraction
}

/** Resolve entity name to ID from already-resolved entities in the thought */
async function resolveEntityId(
  name: string | null,
  thoughtId: string,
  pool: pg.Pool,
): Promise<string | null> {
  if (!name) return null;
  const normalized = name.toLowerCase().trim();
  if (!normalized) return null;

  // Look up entity linked to this thought whose canonical_name matches
  const { rows } = await pool.query(
    `SELECT e.id FROM entities e
     JOIN thought_entities te ON te.entity_id = e.id
     WHERE te.thought_id = $1
       AND (e.canonical_name = $2 OR $2 = ANY(SELECT lower(a) FROM unnest(e.aliases) a))
     LIMIT 1`,
    [thoughtId, normalized],
  );

  return rows.length > 0 ? rows[0].id : null;
}

/** Check for contradictions with existing facts about the same entities */
async function findContradictions(
  fact: ExtractedFact,
  subjectId: string | null,
  objectId: string | null,
  factEmbedding: number[],
  pool: pg.Pool,
): Promise<Array<{ id: string; statement: string; similarity: number }>> {
  if (!subjectId) return [];

  const vectorStr = `[${factEmbedding.join(',')}]`;

  // Find existing active facts about the same subject entity with high embedding similarity
  const { rows } = await pool.query(
    `SELECT f.id, f.statement,
            1 - ((f.embedding::halfvec(768)) <=> ($1::vector::halfvec(768))) as similarity
     FROM facts f
     WHERE f.subject_entity_id = $2
       AND f.invalid_at IS NULL
       AND f.embedding IS NOT NULL
     ORDER BY f.embedding::halfvec(768) <=> $1::vector::halfvec(768)
     LIMIT 5`,
    [vectorStr, subjectId],
  );

  // High similarity (> 0.85) suggests potential contradiction or duplicate
  return rows
    .filter((r: any) => parseFloat(r.similarity) > 0.85)
    .map((r: any) => ({
      id: r.id,
      statement: r.statement,
      similarity: parseFloat(r.similarity),
    }));
}

/** Store extracted facts in the database with embeddings */
export async function storeFacts(
  thoughtId: string,
  facts: ExtractedFact[],
  visibility: string[],
  pool: pg.Pool,
  config: FactExtractionConfig,
): Promise<{ stored: number; contradictions: number }> {
  let stored = 0;
  let contradictions = 0;

  for (const fact of facts) {
    try {
      // Resolve entity references
      const [subjectId, objectId, factEmbedding] = await Promise.all([
        resolveEntityId(fact.subject, thoughtId, pool),
        resolveEntityId(fact.object, thoughtId, pool),
        embed(fact.statement, config),
      ]);

      // Check for contradictions
      const similar = await findContradictions(fact, subjectId, objectId, factEmbedding, pool);

      if (similar.length > 0) {
        // Very high similarity (> 0.95) = likely duplicate, skip
        const isDuplicate = similar.some((s) => s.similarity > 0.95);
        if (isDuplicate) {
          log.debug({ statement: fact.statement.slice(0, 80) }, 'Fact skipped (duplicate)');
          continue;
        }

        // High similarity (0.85-0.95) = potential contradiction, invalidate old
        for (const old of similar) {
          await pool.query(
            `UPDATE facts SET invalid_at = NOW(), invalidated_by = NULL WHERE id = $1 AND invalid_at IS NULL`,
            [old.id],
          );
          contradictions++;
          log.info(
            { oldFact: old.statement.slice(0, 60), newFact: fact.statement.slice(0, 60), similarity: old.similarity },
            'Fact superseded (temporal invalidation)',
          );
        }
      }

      const vectorStr = `[${factEmbedding.join(',')}]`;
      const { rows } = await pool.query(
        `INSERT INTO facts (thought_id, statement, fact_type, confidence, embedding, subject_entity_id, object_entity_id, valid_at, visibility)
         VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9)
         RETURNING id`,
        [
          thoughtId,
          fact.statement,
          fact.fact_type,
          fact.confidence,
          vectorStr,
          subjectId,
          objectId,
          fact.valid_at,
          visibility,
        ],
      );

      // If we invalidated old facts, link them to this new fact
      if (contradictions > 0 && rows.length > 0) {
        for (const old of similar.filter((s) => s.similarity <= 0.95)) {
          await pool.query(
            `UPDATE facts SET invalidated_by = $1 WHERE id = $2`,
            [rows[0].id, old.id],
          );
        }
      }

      stored++;
    } catch (err) {
      log.error({ err, statement: fact.statement.slice(0, 80) }, 'Failed to store fact (non-fatal)');
    }
  }

  return { stored, contradictions };
}

/** Full fact extraction pipeline: extract → resolve entities → detect contradictions → store */
export async function extractAndStoreFacts(
  thoughtId: string,
  content: string,
  metadata: ThoughtMetadata,
  visibility: string[],
  pool: pg.Pool,
  config: FactExtractionConfig,
): Promise<void> {
  // Build entity list from already-extracted metadata
  const entities: Array<{ name: string; entity_type: string }> = [
    ...metadata.people.map((n) => ({ name: n, entity_type: 'person' })),
    ...metadata.companies.map((n) => ({ name: n, entity_type: 'company' })),
    ...metadata.products.map((n) => ({ name: n, entity_type: 'product' })),
    ...metadata.projects.map((n) => ({ name: n, entity_type: 'project' })),
  ];

  const facts = await extractFactsFromContent(content, entities, config);

  if (facts.length === 0) {
    log.debug({ thoughtId }, 'No facts extracted');
    return;
  }

  const result = await storeFacts(thoughtId, facts, visibility, pool, config);
  log.info(
    { thoughtId, extracted: facts.length, stored: result.stored, contradictions: result.contradictions },
    'Facts extracted and stored',
  );
}
