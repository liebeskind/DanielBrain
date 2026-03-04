import { metadataSchema, type ThoughtMetadata } from '@danielbrain/shared';

interface ExtractConfig {
  ollamaBaseUrl: string;
  extractionModel: string;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    thought_type: {
      type: 'string',
      description: 'Type of thought: idea, meeting_note, decision, task, observation, reflection, question, learning, conversation, or other',
    },
    people: {
      type: 'array',
      items: { type: 'string' },
      description: 'Names of people mentioned',
    },
    topics: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key topics or themes',
    },
    action_items: {
      type: 'array',
      items: { type: 'string' },
      description: 'Action items or tasks mentioned',
    },
    dates_mentioned: {
      type: 'array',
      items: { type: 'string' },
      description: 'Dates mentioned in YYYY-MM-DD format',
    },
    sentiment: {
      type: 'string',
      description: 'Overall sentiment: positive, negative, neutral, or mixed',
    },
    summary: {
      type: 'string',
      description: 'A 1-2 sentence summary of the content',
    },
    companies: {
      type: 'array',
      items: { type: 'string' },
      description: 'Companies or organizations mentioned',
    },
    products: {
      type: 'array',
      items: { type: 'string' },
      description: 'Products or tools mentioned',
    },
    projects: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named projects mentioned',
    },
  },
  required: ['thought_type', 'people', 'topics', 'action_items', 'dates_mentioned', 'sentiment', 'summary', 'companies', 'products', 'projects'],
};

export async function extractMetadata(
  text: string,
  config: ExtractConfig
): Promise<ThoughtMetadata> {
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      format: EXTRACTION_SCHEMA,
      messages: [
        {
          role: 'system',
          content:
            'You are a metadata extraction assistant. Extract structured metadata from the given text. Identify people, companies/organizations, products/tools, and named projects. Return valid JSON matching the schema.',
        },
        {
          role: 'user',
          content: text,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama extraction failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message: { content: string } };
  const raw = JSON.parse(data.message.content);

  // Validate and apply defaults via Zod
  return metadataSchema.parse(raw);
}
