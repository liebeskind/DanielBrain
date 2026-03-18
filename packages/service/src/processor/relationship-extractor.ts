import { OLLAMA_LLM_TIMEOUT_MS } from '@danielbrain/shared';

interface ExtractedRelationship {
  source: string;
  target: string;
  relationship: string;
  description: string;
}

interface RelExtractConfig {
  ollamaBaseUrl: string;
  extractionModel: string;
}

const RELATIONSHIP_EXTRACTION_PROMPT = `You extract explicit relationships between entities from text. You will receive the text and a list of known entity names.

RULES:
- Only extract relationships EXPLICITLY stated or strongly implied by the text.
- Do NOT infer relationships from mere co-occurrence (e.g., two names in the same meeting).
- Each relationship needs: source entity, target entity, relationship type, and a 1-sentence description.
- Use relationship types like: works_at, manages, partners_with, reports_to, founded, invested_in, competes_with, supplies_to, acquired, uses, leads, advises, collaborates_with
- Return [] if no explicit relationships are found. An empty array is always better than a guess.
- Both source and target must be from the provided entity list.

EXAMPLE:
Text: "Gordon Smith, who leads Topia's engineering team, discussed the Canvas integration with Kevin Killeen from Stride."
Entities: ["Gordon Smith", "Topia", "Kevin Killeen", "Stride", "Canvas"]
Output:
[
  {"source": "Gordon Smith", "target": "Topia", "relationship": "works_at", "description": "Gordon Smith leads Topia's engineering team."},
  {"source": "Kevin Killeen", "target": "Stride", "relationship": "works_at", "description": "Kevin Killeen works at Stride."}
]

NOT this (mere co-occurrence, not explicit):
[
  {"source": "Gordon Smith", "target": "Kevin Killeen", "relationship": "collaborates_with", "description": "They discussed something."}
]`;

const RELATIONSHIP_EXTRACTION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Source entity name from the provided list' },
      target: { type: 'string', description: 'Target entity name from the provided list' },
      relationship: { type: 'string', description: 'Relationship type e.g. works_at, manages, partners_with' },
      description: { type: 'string', description: 'One-sentence description of the relationship' },
    },
    required: ['source', 'target', 'relationship', 'description'],
  },
};

export async function extractRelationships(
  content: string,
  resolvedEntityNames: string[],
  config: RelExtractConfig,
): Promise<ExtractedRelationship[]> {
  const prompt = `Text:\n${content.slice(0, 4000)}\n\nKnown entities: ${JSON.stringify(resolvedEntityNames)}\n\nExtract explicit relationships (return JSON array):`;

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      format: RELATIONSHIP_EXTRACTION_SCHEMA,
      messages: [
        { role: 'system', content: RELATIONSHIP_EXTRACTION_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama relationship extraction failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message: { content: string } };
  const parsed = JSON.parse(data.message.content);

  // Validate: must be array of objects with required fields
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (r: any) =>
      typeof r.source === 'string' &&
      typeof r.target === 'string' &&
      typeof r.relationship === 'string' &&
      typeof r.description === 'string' &&
      r.source !== r.target,
  );
}

export { ExtractedRelationship, RELATIONSHIP_EXTRACTION_PROMPT };
