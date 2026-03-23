import type pg from 'pg';
import { RELATIONSHIP_DESCRIPTION_BATCH_SIZE, OLLAMA_LLM_TIMEOUT_MS } from '@danielbrain/shared';
import { createRelationshipProposal } from '../proposals/helpers.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('relationship-describer');

interface DescriberConfig {
  ollamaBaseUrl: string;
  relationshipModel: string;
}

export const RELATIONSHIP_SYSTEM_PROMPT = `You are describing the relationship between two entities in a knowledge graph. Your description will be used by AI agents to quickly understand how these entities are connected.

RULES:
- Write exactly 1-2 sentences describing the relationship.
- Be factual — only state what is supported by the provided context.
- Focus on the nature and significance of the relationship, not a list of interactions.
- Write in third person. Example: "Alice works with Bob on Project Atlas."
- Do NOT start with "Based on" or similar meta-phrases.
- Do NOT include entity types in parentheses.

EXAMPLE:
Entity A: "Daniel Liebeskind" (person)
Entity B: "Topia" (company)
Interactions:
1. Daniel discussed Topia's Q1 roadmap with the engineering team.
2. Daniel presented Topia's new spatial platform features at the all-hands.
3. Daniel reviewed Topia's hiring pipeline with HR.

Description: Daniel Liebeskind is the CEO of Topia and is actively involved in product strategy, engineering roadmap, and hiring decisions.

BAD EXAMPLES (do NOT do these):
- "They co-occur in 5 thoughts." (too mechanical, no insight)
- "Based on the interactions provided, it appears that..." (meta-phrasing)
- "Daniel Liebeskind (person) and Topia (company) are related." (includes types, too vague)`;

export const CONTRADICTION_SYSTEM_PROMPT = `You are a fact-checker for a knowledge graph. You must determine whether a relationship description has changed based on new interactions.

RULES:
- Compare the existing description against the new interactions.
- Determine if the relationship has materially changed (role change, status change, new significant context).
- Minor additions or elaborations are NOT changes.
- Return EXACTLY this JSON format, nothing else:

{"changed": true, "new_description": "Updated 1-2 sentence description.", "confidence": 0.9}

or

{"changed": false, "confidence": 0.95}

EXAMPLE (changed):
Existing: "Alice is a junior engineer at Acme reporting to Bob."
New interactions mention Alice was promoted to senior engineer and now leads the platform team.
Output: {"changed": true, "new_description": "Alice is a senior engineer at Acme who leads the platform team.", "confidence": 0.85}

EXAMPLE (not changed):
Existing: "Alice works with Bob on the platform migration."
New interactions mention another meeting about the platform migration.
Output: {"changed": false, "confidence": 0.95}`;

interface ContradictionResult {
  changed: boolean;
  new_description?: string;
  confidence: number;
}

export async function describeRelationship(
  edgeId: string,
  pool: pg.Pool,
  config: DescriberConfig,
): Promise<string | null> {
  // Fetch edge + entity info
  const { rows: edgeRows } = await pool.query(
    `SELECT er.*,
            s.name as source_name, s.entity_type as source_type, s.profile_summary as source_profile,
            t.name as target_name, t.entity_type as target_type, t.profile_summary as target_profile
     FROM entity_relationships er
     JOIN entities s ON s.id = er.source_id
     JOIN entities t ON t.id = er.target_id
     WHERE er.id = $1`,
    [edgeId]
  );

  if (edgeRows.length === 0) return null;

  const edge = edgeRows[0];

  // Fetch source thoughts for context
  const thoughtIds = edge.source_thought_ids || [];
  let thoughtContext = '';
  if (thoughtIds.length > 0) {
    const { rows: thoughts } = await pool.query(
      `SELECT content, summary, source, created_at
       FROM thoughts
       WHERE id = ANY($1)
       ORDER BY created_at DESC
       LIMIT 10`,
      [thoughtIds]
    );

    thoughtContext = thoughts.map((t: { summary: string | null; content: string; source: string }, i: number) => {
      const text = t.summary || t.content.slice(0, 300);
      return `${i + 1}. (${t.source}) ${text}`;
    }).join('\n');
  }

  if (!thoughtContext) {
    // No context to describe from
    return null;
  }

  // Check if this is an update (existing description) or new description
  if (edge.description) {
    return handleContradictionCheck(edge, thoughtContext, pool, config);
  }

  // Generate new description
  const prompt = `Entity A: "${edge.source_name}" (${edge.source_type})
Entity B: "${edge.target_name}" (${edge.target_type})
Co-occurrence weight: ${edge.weight}
Interactions:
${thoughtContext}

Description:`;

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.relationshipModel,
      stream: false,
      messages: [
        { role: 'system', content: RELATIONSHIP_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama relationship description failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message: { content: string } };
  const description = data.message.content.trim();

  // Update edge with description
  await pool.query(
    `UPDATE entity_relationships SET description = $1 WHERE id = $2`,
    [description, edgeId]
  );

  return description;
}

async function handleContradictionCheck(
  edge: Record<string, unknown>,
  thoughtContext: string,
  pool: pg.Pool,
  config: DescriberConfig,
): Promise<string | null> {
  const prompt = `Existing description: "${edge.description}"

Entity A: "${edge.source_name}" (${edge.source_type})
Entity B: "${edge.target_name}" (${edge.target_type})

New interactions:
${thoughtContext}

Has the relationship materially changed? Return JSON only.`;

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.relationshipModel,
      stream: false,
      messages: [
        { role: 'system', content: CONTRADICTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama contradiction check failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message: { content: string } };
  const raw = data.message.content.trim();

  let result: ContradictionResult;
  try {
    // Extract JSON from response (LLM may include extra text)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    result = JSON.parse(jsonMatch[0]);
  } catch {
    log.error({ raw }, 'Failed to parse contradiction response');
    return null;
  }

  if (!result.changed) {
    return edge.description as string;
  }

  // High confidence change → invalidate old edge, create new
  if (result.confidence >= 0.8 && result.new_description) {
    // Set invalid_at on current edge
    await pool.query(
      `UPDATE entity_relationships SET invalid_at = NOW() WHERE id = $1`,
      [edge.id]
    );

    // Create new edge with valid_at
    await pool.query(
      `INSERT INTO entity_relationships (source_id, target_id, relationship, description, weight, source_thought_ids, valid_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        edge.source_id,
        edge.target_id,
        edge.relationship,
        result.new_description,
        edge.weight,
        edge.source_thought_ids,
      ]
    );

    return result.new_description;
  }

  // Low confidence change → create proposal for human review
  if (result.new_description) {
    try {
      await createRelationshipProposal({
        edgeId: edge.id as string,
        sourceEntityId: edge.source_id as string,
        sourceName: edge.source_name as string,
        targetName: edge.target_name as string,
        currentDescription: edge.description as string,
        proposedDescription: result.new_description,
        confidence: result.confidence,
      }, pool);
    } catch (err) {
      log.error({ err }, 'Failed to create relationship proposal');
    }
  }

  return edge.description as string;
}

export async function describeUndescribedRelationships(
  pool: pg.Pool,
  config: DescriberConfig,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id FROM entity_relationships
     WHERE description IS NULL AND invalid_at IS NULL AND weight >= 2
     ORDER BY weight DESC
     LIMIT $1`,
    [RELATIONSHIP_DESCRIPTION_BATCH_SIZE]
  );

  let described = 0;
  for (const edge of rows) {
    try {
      const result = await describeRelationship(edge.id, pool, config);
      if (result) described++;
    } catch (err) {
      log.error({ err, edgeId: edge.id }, 'Relationship description failed');
    }
  }

  return described;
}
