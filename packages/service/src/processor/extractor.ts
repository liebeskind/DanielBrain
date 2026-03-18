import { metadataSchema, type ThoughtMetadata, OLLAMA_LLM_TIMEOUT_MS } from '@danielbrain/shared';

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
      description: 'Specific entities, products, or projects mentioned. Use short noun phrases. NOT abstract themes — put those in "themes" instead.',
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
      description: '2-4 sentences. Resolve ALL pronouns — say "Daniel discussed" not "he discussed". Name specific people and companies.',
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
    department: {
      type: ['string', 'null'],
      description: 'One of: engineering, product, sales, marketing, hr, finance, leadership, operations, legal, support, other. Null if unclear.',
    },
    confidentiality: {
      type: 'string',
      description: 'One of: public, internal, confidential, restricted. Default "internal".',
    },
    meeting_participants: {
      type: 'array',
      items: { type: 'string' },
      description: 'Full names of meeting attendees. Only for meeting_notes. Return [] for non-meetings.',
    },
    themes: {
      type: 'array',
      items: { type: 'string' },
      description: 'High-level business themes (max 3). Examples: "product_strategy", "hiring", "partnerships", "infrastructure", "customer_success". Abstract categories, NOT specific entities.',
    },
    key_decisions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Decisions made. E.g., "Agreed to launch K12 Zone beta by March 15". Return [] if no decisions.',
    },
    key_insights: {
      type: 'array',
      items: { type: 'string' },
      description: 'Notable observations or learnings. E.g., "Canvas LTI 1.3 does not support SSO passthrough". Return [] if none.',
    },
    action_items_structured: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'The action item text' },
          assignee: { type: ['string', 'null'], description: 'Person name or null' },
          deadline: { type: ['string', 'null'], description: 'Date string or null' },
          status: { type: ['string', 'null'], description: 'One of: open, done, or null' },
        },
        required: ['action', 'assignee', 'deadline', 'status'],
      },
      description: 'Structured version of action_items with assignee/deadline/status. Mirror the action_items array.',
    },
  },
  required: ['thought_type', 'people', 'topics', 'action_items', 'dates_mentioned', 'sentiment', 'summary', 'companies', 'products', 'projects', 'department', 'confidentiality', 'meeting_participants', 'themes', 'key_decisions', 'key_insights', 'action_items_structured'],
};

export { GLEANING_SYSTEM_PROMPT, GLEANING_SCHEMA };

export const EXTRACTION_SYSTEM_PROMPT = `You are a metadata extraction assistant for a personal knowledge management system. Extract structured metadata from the given text. Return valid JSON matching the schema.

CRITICAL RULE — Pronoun Resolution: Replace ALL pronouns with the actual person/company name. In summaries and action items, write "Daniel discussed" NOT "he discussed". Always use the full name at least once.

Return [] for any array field with no data. An empty array is always better than a guess.

RULES FOR EACH FIELD:

people: Extract full real names of people mentioned.
- DO: "Daniel Liebeskind", "Rob Fisher", "Chris Psiaki"
- DON'T: "damenlopez" (username), "You", "the team", "attendees", "someone"
- DON'T: "chris@topia.io" (email address — NEVER include emails as people)
- DON'T: "Chris Psiaki <chris@topia.io>" — strip emails, just use "Chris Psiaki"
- DON'T: "Chris (Topia)" or "Jason Levin (WGU Labs)" — strip parenthetical annotations
- DON'T: "Salyers, Tosha (Contractor)" — use "Tosha Salyers" (normal order, no parenthetical)
- If you see "Name <email>" or "Name (org)", extract ONLY the name part

topics: Specific entities, products, or projects mentioned. Short noun phrases.
- DO: "SSO integration", "LTI 1.3", "K12 Zone launch"
- DON'T: "product_strategy" or "hiring" — those are abstract themes, put them in "themes"

themes: High-level business themes (max 3). Abstract categories only.
- DO: "product_strategy", "hiring", "partnerships", "infrastructure", "customer_success"
- DON'T: "K12 Zone" (that's a topic, not a theme)

companies: Organization names without domains or legal suffixes.
- DO: "Topia", "AWS", "Google", "Stride"
- DON'T: "Topia.io", "Acme Corp Inc."

products: Specific named software/platforms only.
- DO: "Docker", "K12 Zone", "Canvas", "Slack"
- DON'T: "GPUs" (generic), "AI operating system" (concept)
- TEST: Would someone Google this exact name? If not, omit.

projects: Only proper-noun project names used by the team.
- DO: "DanielBrain", "College Conversations", "K12 Zone"
- DON'T: "Phase 4" (build phase), "canvas integration" (task)
- DON'T invent project names. [] is better than a wrong entry.

summary: 2-4 sentences. Resolve ALL pronouns. Name specific people and companies.

department: engineering, product, sales, marketing, hr, finance, leadership, operations, legal, support, other. Null if unclear.

confidentiality: public, internal, confidential, restricted. Default "internal".

meeting_participants: Full names of all meeting attendees. Only for meeting_notes — return [] otherwise.

key_decisions: Specific decisions made. E.g., "Agreed to launch K12 Zone beta by March 15". Return [] if none.

key_insights: Notable observations. E.g., "Canvas LTI 1.3 does not support SSO passthrough". Return [] if none.

action_items_structured: Mirror action_items with assignee/deadline/status. Use null for unknown fields.

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
  "summary": "Rob Fisher discussed integrating provocative.earth's carbon offset marketplace with Topia's spatial platform. Rob Fisher expressed interest in the integration. Daniel will send API docs by Friday.",
  "companies": ["provocative.earth", "Topia"],
  "products": [],
  "projects": [],
  "department": null,
  "confidentiality": "internal",
  "meeting_participants": ["Rob Fisher", "Daniel"],
  "themes": ["partnerships"],
  "key_decisions": [],
  "key_insights": [],
  "action_items_structured": [{"action": "Daniel to send API docs by Friday", "assignee": "Daniel", "deadline": null, "status": "open"}]
}

EXAMPLE 2 (meeting with participant list):
Input: "Meeting: K12 Zone Launch Prep. Attendees: Anna Cueni <anna@topia.io>, Gordon Smith <gordon.smith@topia.io>, Kevin Killeen. Discussed SSO integration timeline for Stride's Canvas LMS. Gordon to test LTI 1.3 by Wednesday. Decision: launch beta on March 15."
Output:
{
  "thought_type": "meeting_note",
  "people": ["Anna Cueni", "Gordon Smith", "Kevin Killeen"],
  "topics": ["SSO integration", "LTI 1.3", "K12 Zone launch"],
  "action_items": ["Gordon to test LTI 1.3 by Wednesday"],
  "dates_mentioned": ["2026-03-15"],
  "sentiment": "neutral",
  "summary": "Anna Cueni, Gordon Smith, and Kevin Killeen discussed SSO integration timeline for Stride's Canvas LMS ahead of the K12 Zone launch. The team decided to launch beta on March 15.",
  "companies": ["Stride"],
  "products": ["K12 Zone", "Canvas"],
  "projects": [],
  "department": "engineering",
  "confidentiality": "internal",
  "meeting_participants": ["Anna Cueni", "Gordon Smith", "Kevin Killeen"],
  "themes": ["product_strategy"],
  "key_decisions": ["Launch K12 Zone beta on March 15"],
  "key_insights": [],
  "action_items_structured": [{"action": "Gordon to test LTI 1.3 by Wednesday", "assignee": "Gordon Smith", "deadline": null, "status": "open"}]
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
    additional_key_decisions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key decisions missed in the first pass.',
    },
    additional_key_insights: {
      type: 'array',
      items: { type: 'string' },
      description: 'Key insights missed in the first pass.',
    },
    additional_meeting_participants: {
      type: 'array',
      items: { type: 'string' },
      description: 'Meeting participants missed in the first pass. Full names only.',
    },
    additional_themes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Themes missed in the first pass. High-level business categories.',
    },
  },
  required: ['additional_people', 'additional_companies', 'additional_products', 'additional_projects', 'additional_action_items'],
};

const GLEANING_SYSTEM_PROMPT = `You are a quality reviewer for a metadata extraction system. You will be given:
1. The original text
2. The metadata that was already extracted

Your job is to find entities, action items, decisions, insights, participants, and themes that were MISSED in the first extraction pass. Only return genuinely new items — do NOT repeat anything already extracted.

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
    key_decisions: addUnique(base.key_decisions, gleaned.additional_key_decisions ?? []),
    key_insights: addUnique(base.key_insights, gleaned.additional_key_insights ?? []),
    meeting_participants: addUnique(base.meeting_participants, gleaned.additional_meeting_participants ?? []),
    themes: addUnique(base.themes, gleaned.additional_themes ?? []),
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
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
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
