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
      description: 'One of: idea, meeting_note, decision, task, observation, reflection, question, learning, conversation, other',
    },
    people: {
      type: 'array',
      items: { type: 'string' },
      description: 'Full real names of people. Use "Daniel Liebeskind" not "Daniel Liebeskind (Topia)". Do not include usernames, pronouns, or generic words like "the team".',
    },
    topics: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key topics or themes discussed. Use short noun phrases like "AI infrastructure" or "Q1 planning".',
    },
    action_items: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific action items or tasks. Each should start with a verb. Example: "Draft the proposal by Friday".',
    },
    dates_mentioned: {
      type: 'array',
      items: { type: 'string' },
      description: 'Dates in YYYY-MM-DD format only. If no specific dates are mentioned, return [].',
    },
    sentiment: {
      type: 'string',
      description: 'Exactly one of: positive, negative, neutral, mixed. Lowercase only.',
    },
    summary: {
      type: 'string',
      description: 'A 1-2 sentence summary. Name specific people and companies instead of saying "they".',
    },
    companies: {
      type: 'array',
      items: { type: 'string' },
      description: 'Organization names without domain extensions or legal suffixes. Use "Topia" not "Topia.io" or "Topia Inc.".',
    },
    products: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific named software, hardware, or platforms only. Use "Docker" or "GPT-4". Do not include generic categories like "GPUs" or concepts like "AI operating system".',
    },
    projects: {
      type: 'array',
      items: { type: 'string' },
      description: 'Explicitly named projects with proper nouns only. Use "Project Atlas" or "DanielBrain". Do not include activities like "bare-metal experiment" or features like "onboarding flow".',
    },
  },
  required: ['thought_type', 'people', 'topics', 'action_items', 'dates_mentioned', 'sentiment', 'summary', 'companies', 'products', 'projects'],
};

export const EXTRACTION_SYSTEM_PROMPT = `You are a metadata extraction assistant for a personal knowledge management system. Extract structured metadata from the given text. Return valid JSON matching the schema.

RULES FOR EACH FIELD:

people: Extract full real names of people mentioned.
- DO: "Daniel Liebeskind", "Rob Fisher", "Chris Psiaki"
- DON'T: "damenlopez" (that's a username, not a name), "You", "the team", "attendees", "someone"
- DON'T: "Chris (Topia)" — strip parenthetical annotations, just use "Chris"
- If you only see a first name, that's fine: "Chris" is acceptable

companies: Extract organization names without domains or legal suffixes.
- DO: "Topia", "AWS", "Google", "NEU"
- DON'T: "Topia.io", "Acme Corp Inc.", "Google LLC"

products: Only specific named software, hardware, or platforms.
- DO: "Docker", "Kubernetes", "GPT-4", "Slack", "PostgreSQL"
- DON'T: "GPUs" (generic category), "AI operating system" (concept), "carbon capture" (topic), "database" (generic)

projects: Only explicitly named projects with proper nouns.
- DO: "Project Atlas", "DanielBrain", "Phase 4"
- DON'T: "bare-metal experiment" (activity), "onboarding flow" (feature), "the project" (vague)

sentiment: Must be exactly one of: positive, negative, neutral, mixed (lowercase only).

dates_mentioned: Only YYYY-MM-DD format. If no specific calendar dates are mentioned, return [].
- DO: "2026-03-15"
- DON'T: "next week", "recently", "Q1"

summary: Write 1-2 sentences. Name specific people and companies — say "Daniel and Rob discussed" not "they discussed".

EXAMPLE:
Input: "Had a great call with Rob Fisher from provocative.earth about the carbon offset marketplace. He's interested in integrating with Topia's spatial platform. Action item: Daniel to send API docs by Friday."
Output:
{
  "thought_type": "meeting_note",
  "people": ["Rob Fisher", "Daniel"],
  "topics": ["carbon offset marketplace", "spatial platform integration"],
  "action_items": ["Daniel to send API docs by Friday"],
  "dates_mentioned": [],
  "sentiment": "positive",
  "summary": "Rob Fisher discussed integrating provocative.earth's carbon offset marketplace with Topia's spatial platform. Daniel will send API docs by Friday.",
  "companies": ["provocative.earth", "Topia"],
  "products": [],
  "projects": []
}`;

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
          content: EXTRACTION_SYSTEM_PROMPT,
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
