import { metadataSchema, type ThoughtMetadata } from '@danielbrain/shared';

interface ExtractConfig {
  ollamaBaseUrl: string;
  extractionModel: string;
  enableGleaning?: boolean;
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
      description: 'Full real names of people only. Never include email addresses, usernames, pronouns, or generic words like "the team".',
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
      description: 'Specific named software, hardware, or platforms only. Use "Docker" or "GPT-4". Do not include generic categories like "GPUs" or concepts like "AI operating system". A product has a proper name — if you cannot name it specifically, omit it.',
    },
    projects: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only real-world project names that are proper nouns. A project must have an actual name used by the people involved. Do not invent project names. Do not include build phases, activities, features, concepts, or generic descriptions.',
    },
  },
  required: ['thought_type', 'people', 'topics', 'action_items', 'dates_mentioned', 'sentiment', 'summary', 'companies', 'products', 'projects'],
};

export { GLEANING_SYSTEM_PROMPT, GLEANING_SCHEMA };

export const EXTRACTION_SYSTEM_PROMPT = `You are a metadata extraction assistant for a personal knowledge management system. Extract structured metadata from the given text. Return valid JSON matching the schema.

RULES FOR EACH FIELD:

people: Extract full real names of people mentioned.
- DO: "Daniel Liebeskind", "Rob Fisher", "Chris Psiaki"
- DON'T: "damenlopez" (username), "You", "the team", "attendees", "someone"
- DON'T: "chris@topia.io" (email address — NEVER include emails as people)
- DON'T: "Chris Psiaki <chris@topia.io>" — strip emails, just use "Chris Psiaki"
- DON'T: "Chris (Topia)" or "Jason Levin (WGU Labs)" — strip parenthetical annotations
- DON'T: "Salyers, Tosha (Contractor)" — use "Tosha Salyers" (normal order, no parenthetical)
- If you see "Name <email>" or "Name (org)", extract ONLY the name part
- If you only see a first name, that's fine: "Chris" is acceptable

companies: Extract organization names without domains or legal suffixes.
- DO: "Topia", "AWS", "Google", "Stride"
- DON'T: "Topia.io", "Acme Corp Inc.", "Google LLC"
- DON'T list a company that is also listed as a product — choose one

products: Only specific named software, hardware, or platforms with a proper name.
- DO: "Docker", "Kubernetes", "GPT-4", "Slack", "PostgreSQL", "SchoolSpace", "K12 Zone", "Canvas"
- DON'T: "GPUs" (generic category), "AI operating system" (concept), "carbon capture" (topic), "database" (generic)
- DON'T: "3d virtual environments" (description), "ai inference at the edge" (concept), "massively scalable experiences" (description)
- DON'T list a product that is also listed as a company — choose one. If it's both (e.g., "Slack"), prefer product.
- TEST: Would someone Google this exact name to find it? If not, it's not a product.

projects: Only named projects that function as proper nouns — a team would refer to it by this name.
- DO: "DanielBrain", "College Conversations", "Choose Love Academy", "K12 Zone"
- DON'T: "Phase 4" (build phase, not a project name)
- DON'T: "bare-metal experiment" (activity), "onboarding flow" (feature), "the project" (vague)
- DON'T: "AI operating system" or "carbon capture" (concepts, not project names)
- DON'T: "canvas integration" (task), "career fair" (event), "classroom one-pager" (deliverable), "case studies and logos" (work items)
- DON'T: "field day planning" (activity), "conference planning" (activity), "new deal" (status)
- DON'T invent or guess project names. If unsure, omit it. An empty list [] is MUCH better than a wrong entry.
- TEST: Is this a specific named initiative that has a team and timeline? If it's just a task or activity, put it in topics instead.

sentiment: Must be exactly one of: positive, negative, neutral, mixed (lowercase only).

dates_mentioned: Only YYYY-MM-DD format. If no specific calendar dates are mentioned, return [].

summary: Write 1-2 sentences. Name specific people and companies — say "Daniel and Rob discussed" not "they discussed".

EXAMPLE 1:
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
}

EXAMPLE 2 (meeting with participant list):
Input: "Meeting: K12 Zone Launch Prep. Attendees: Anna Cueni <anna@topia.io>, Gordon Smith <gordon.smith@topia.io>, Kevin Killeen. Discussed SSO integration timeline for Stride's Canvas LMS. Gordon to test LTI 1.3 by Wednesday."
Output:
{
  "thought_type": "meeting_note",
  "people": ["Anna Cueni", "Gordon Smith", "Kevin Killeen"],
  "topics": ["SSO integration", "LTI 1.3", "K12 Zone launch"],
  "action_items": ["Gordon to test LTI 1.3 by Wednesday"],
  "dates_mentioned": [],
  "sentiment": "neutral",
  "summary": "Anna Cueni, Gordon Smith, and Kevin Killeen discussed SSO integration timeline for Stride's Canvas LMS ahead of the K12 Zone launch.",
  "companies": ["Stride"],
  "products": ["K12 Zone", "Canvas"],
  "projects": []
}`;

const GLEANING_SCHEMA = {
  type: 'object',
  properties: {
    additional_people: {
      type: 'array',
      items: { type: 'string' },
      description: 'People missed in the first pass. Same rules: full real names only, no emails, no usernames, no pronouns.',
    },
    additional_companies: {
      type: 'array',
      items: { type: 'string' },
      description: 'Companies missed in the first pass. Same rules: no domain extensions or legal suffixes.',
    },
    additional_products: {
      type: 'array',
      items: { type: 'string' },
      description: 'Products missed in the first pass. Same rules: specific named software/platforms only.',
    },
    additional_projects: {
      type: 'array',
      items: { type: 'string' },
      description: 'Projects missed in the first pass. Same rules: real proper noun project names only.',
    },
    additional_action_items: {
      type: 'array',
      items: { type: 'string' },
      description: 'Action items missed in the first pass. Each should start with a verb.',
    },
  },
  required: ['additional_people', 'additional_companies', 'additional_products', 'additional_projects', 'additional_action_items'],
};

const GLEANING_SYSTEM_PROMPT = `You are a quality reviewer for a metadata extraction system. You will be given:
1. The original text
2. The metadata that was already extracted

Your job is to find entities and action items that were MISSED in the first extraction pass. Only return genuinely new items — do NOT repeat anything already extracted.

RULES:
- Same rules as original extraction: no emails, no usernames, no descriptions-as-names, no generic concepts
- Only return items that are clearly present in the text but missing from the extraction
- If nothing was missed, return empty arrays for all fields
- Do NOT hallucinate or invent entities that aren't clearly mentioned in the text
- When in doubt, leave it out — precision matters more than recall`;

function mergeGleanedMetadata(
  base: ThoughtMetadata,
  gleaned: Record<string, string[]>,
): ThoughtMetadata {
  const addUnique = (existing: string[], additional: string[]): string[] => {
    const lowerExisting = new Set(existing.map(s => s.toLowerCase()));
    const merged = [...existing];
    for (const item of additional) {
      if (!lowerExisting.has(item.toLowerCase())) {
        merged.push(item);
        lowerExisting.add(item.toLowerCase());
      }
    }
    return merged;
  };

  return {
    ...base,
    people: addUnique(base.people, gleaned.additional_people ?? []),
    companies: addUnique(base.companies, gleaned.additional_companies ?? []),
    products: addUnique(base.products, gleaned.additional_products ?? []),
    projects: addUnique(base.projects, gleaned.additional_projects ?? []),
    action_items: addUnique(base.action_items, gleaned.additional_action_items ?? []),
  };
}

async function callOllama(
  config: ExtractConfig,
  messages: Array<{ role: string; content: string }>,
  format: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      format,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama extraction failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message: { content: string } };
  return JSON.parse(data.message.content);
}

export async function extractMetadata(
  text: string,
  config: ExtractConfig
): Promise<ThoughtMetadata> {
  // Pass 1: Primary extraction
  const raw = await callOllama(config, [
    { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
    { role: 'user', content: text },
  ], EXTRACTION_SCHEMA);

  const base = metadataSchema.parse(raw);

  // Pass 2: Gleaning — find missed entities
  if (config.enableGleaning === false) {
    return base;
  }

  try {
    const gleaningInput = `ORIGINAL TEXT:\n${text}\n\nALREADY EXTRACTED:\nPeople: ${base.people.join(', ') || 'none'}\nCompanies: ${base.companies.join(', ') || 'none'}\nProducts: ${base.products.join(', ') || 'none'}\nProjects: ${base.projects.join(', ') || 'none'}\nAction items: ${base.action_items.join('; ') || 'none'}`;

    const gleaned = await callOllama(config, [
      { role: 'system', content: GLEANING_SYSTEM_PROMPT },
      { role: 'user', content: gleaningInput },
    ], GLEANING_SCHEMA) as Record<string, string[]>;

    return mergeGleanedMetadata(base, gleaned);
  } catch (err) {
    // Gleaning is best-effort — don't fail extraction if it errors
    console.error('Gleaning pass failed (non-fatal):', err);
    return base;
  }
}
