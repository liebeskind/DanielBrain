import { OLLAMA_LLM_TIMEOUT_MS } from '@danielbrain/shared';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('intent-detector');

export type IntentType = 'temporal' | 'entity_profile' | 'action_task' | 'relational' | 'exploratory' | 'general';

export interface SearchAdjustments {
  days_back?: number;
  limit?: number;
  threshold?: number;
  thought_type?: string;
}

export interface IntentResult {
  intent: IntentType;
  confidence: number;
  adjustments: SearchAdjustments;
  reasoning: string;
  reformulated_query?: string;
  was_fast_path?: boolean;
}

interface IntentConfig {
  ollamaBaseUrl: string;
  extractionModel: string;
}

// --- Layer 1: Heuristic fast-path (no LLM) ---

interface PatternRule {
  regex: RegExp;
  confidence: number;
  extractDays?: (match: RegExpMatchArray) => number;
}

const TEMPORAL_PATTERNS: PatternRule[] = [
  { regex: /\b(?:last|past)\s+(\d+)\s+(day|week|month)s?\b/i, confidence: 0.9, extractDays: (m) => {
    const n = parseInt(m[1]); const u = m[2].toLowerCase();
    return u === 'day' ? n : u === 'week' ? n * 7 : n * 30;
  }},
  { regex: /\blast\s+week\b/i, confidence: 0.85, extractDays: () => 7 },
  { regex: /\blast\s+month\b/i, confidence: 0.85, extractDays: () => 30 },
  { regex: /\blast\s+year\b/i, confidence: 0.85, extractDays: () => 365 },
  { regex: /\byesterday\b/i, confidence: 0.85, extractDays: () => 2 },
  { regex: /\btoday\b/i, confidence: 0.85, extractDays: () => 1 },
  { regex: /\bthis week\b/i, confidence: 0.8, extractDays: () => 7 },
  { regex: /\bthis month\b/i, confidence: 0.8, extractDays: () => 30 },
  { regex: /\b(?:recently|recent|latest)\b/i, confidence: 0.7, extractDays: () => 14 },
  { regex: /\bwhen did\b/i, confidence: 0.8 },
];

const ACTION_PATTERNS: PatternRule[] = [
  { regex: /\baction items?\b/i, confidence: 0.9 },
  { regex: /\btasks?\b(?!\s+force)/i, confidence: 0.8 },
  { regex: /\bto-?dos?\b/i, confidence: 0.9 },
  { regex: /\bfollow[- ]?ups?\b/i, confidence: 0.85 },
  { regex: /\bwhat (?:should|needs? to|do i need)\b/i, confidence: 0.8 },
  { regex: /\b(?:overdue|pending|assigned to)\b/i, confidence: 0.85 },
];


/** Try heuristic classification. Returns null if no high-confidence match. */
export function detectIntentFast(query: string): IntentResult | null {
  const lower = query.toLowerCase();

  // Temporal (highest priority fast-path)
  for (const p of TEMPORAL_PATTERNS) {
    const match = lower.match(p.regex);
    if (match && p.confidence >= 0.7) {
      const days = p.extractDays?.(match);
      return {
        intent: 'temporal',
        confidence: p.confidence,
        adjustments: {
          ...(days ? { days_back: days } : {}),
          threshold: 0.15,
        },
        reasoning: `Temporal keyword: "${match[0]}"`,
        was_fast_path: true,
      };
    }
  }

  // Action/task
  for (const p of ACTION_PATTERNS) {
    const match = lower.match(p.regex);
    if (match && p.confidence >= 0.8) {
      return {
        intent: 'action_task',
        confidence: p.confidence,
        adjustments: { days_back: 30, threshold: 0.15 },
        reasoning: `Action keyword: "${match[0]}"`,
        was_fast_path: true,
      };
    }
  }

  return null;
}

// --- Layer 2: LLM classification ---

const INTENT_PROMPT = `You are a query intent classifier for a knowledge management system. Given a user query and any matched entity names, classify the intent and optionally reformulate the query for better retrieval.

Return JSON only:
{
  "intent": "temporal" | "entity_profile" | "action_task" | "relational" | "exploratory" | "general",
  "days_back": <number or null>,
  "reasoning": "<brief explanation>",
  "reformulated_query": "<improved search query or null>"
}

Intent definitions:
- temporal: questions about specific time periods, events, what happened when
- entity_profile: questions about a specific person, company, or project
- action_task: questions about tasks, action items, todos, follow-ups
- relational: questions about relationships between entities, connections, collaborations
- exploratory: broad questions about status, overviews, themes, what's happening
- general: none of the above

Examples:
Query: "What happened in meetings last week?"
Entities: []
{"intent":"temporal","days_back":7,"reasoning":"Temporal: last week","reformulated_query":null}

Query: "Tell me about Chris Psiaki"
Entities: ["Chris Psiaki (person)"]
{"intent":"entity_profile","days_back":null,"reasoning":"Entity profile request for Chris Psiaki","reformulated_query":"Chris Psiaki role background context"}

Query: "How do Topia and Stride work together?"
Entities: ["Topia (company)", "Stride (company)"]
{"intent":"relational","days_back":null,"reasoning":"Relationship between Topia and Stride","reformulated_query":"Topia Stride partnership collaboration deal"}

Query: "What's the team working on?"
Entities: []
{"intent":"exploratory","days_back":null,"reasoning":"Broad team status question","reformulated_query":null}

Query: "What are the open action items from the product meeting?"
Entities: []
{"intent":"action_task","days_back":30,"reasoning":"Action items request","reformulated_query":"action items product meeting pending"}

Query: "Prep me for my meeting with Alice about the K12 deal"
Entities: ["Alice (person)", "K12 Zone (product)"]
{"intent":"entity_profile","days_back":30,"reasoning":"Meeting prep combining entity context and recent activity","reformulated_query":"Alice K12 Zone deal recent interactions action items context"}

Query: "Who are the top prospects right now?"
Entities: []
{"intent":"exploratory","days_back":90,"reasoning":"Sales query — needs recent meetings, deal discussions, and CRM contacts","reformulated_query":"prospect deal opportunity pipeline meeting call demo interested potential customer sales conversation"}

Query: "What deals are in the pipeline?"
Entities: []
{"intent":"exploratory","days_back":null,"reasoning":"Pipeline overview — needs deal records and recent sales discussions","reformulated_query":"deal pipeline stage opportunity close amount contract proposal negotiation"}`;

export async function detectIntentLLM(
  query: string,
  entities: Array<{ name: string; entity_type: string }>,
  config: IntentConfig,
): Promise<IntentResult> {
  const entityList = entities.length > 0
    ? entities.map((e) => `${e.name} (${e.entity_type})`).join(', ')
    : 'none';

  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.extractionModel,
      stream: false,
      messages: [
        { role: 'system', content: INTENT_PROMPT },
        { role: 'user', content: `Query: "${query}"\nEntities: [${entityList}]` },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Ollama intent classification failed: ${response.status}`);
  }

  const data = (await response.json()) as { message: { content: string } };
  const parsed = JSON.parse(data.message.content);

  const intent: IntentType = ['temporal', 'entity_profile', 'action_task', 'relational', 'exploratory'].includes(parsed.intent)
    ? parsed.intent
    : 'general';

  const adjustments: SearchAdjustments = {};
  if (parsed.days_back && typeof parsed.days_back === 'number') {
    adjustments.days_back = parsed.days_back;
  }
  if (intent === 'temporal' || intent === 'exploratory' || intent === 'relational') {
    adjustments.threshold = 0.15;
  }
  if (intent === 'exploratory' || intent === 'relational') {
    adjustments.limit = 20;
  }
  if (intent === 'action_task') {
    adjustments.threshold = 0.15;
    adjustments.days_back = adjustments.days_back ?? 30;
  }

  return {
    intent,
    confidence: 0.8,
    adjustments,
    reasoning: parsed.reasoning || `LLM classified as ${intent}`,
    reformulated_query: parsed.reformulated_query || undefined,
    was_fast_path: false,
  };
}

// --- Orchestrator ---

/**
 * Detect query intent using two-layer hybrid (Khoj pattern):
 * Layer 1: Fast regex heuristics for obvious cases
 * Layer 2: LLM classification for ambiguous queries
 *
 * Returns general intent on any failure (graceful degradation).
 */
export async function detectIntent(
  query: string,
  entities: Array<{ name: string; entity_type: string }>,
  config: IntentConfig,
): Promise<IntentResult> {
  // Layer 1: fast-path heuristics
  const fast = detectIntentFast(query);
  if (fast) {
    log.debug({ intent: fast.intent, confidence: fast.confidence }, 'Intent detected (fast-path)');
    return fast;
  }

  // Layer 2: LLM classification (short timeout — better to fall back than block context build)
  try {
    const llmResult = await Promise.race([
      detectIntentLLM(query, entities, config),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Intent LLM timeout')), 15_000)),
    ]);
    log.debug({ intent: llmResult.intent, confidence: llmResult.confidence }, 'Intent detected (LLM)');
    return llmResult;
  } catch (err) {
    log.warn({ err }, 'LLM intent detection failed, using general');
    return {
      intent: 'general',
      confidence: 0.0,
      adjustments: { threshold: 0.15, limit: 20 },
      reasoning: 'LLM classification unavailable',
      was_fast_path: false,
    };
  }
}
