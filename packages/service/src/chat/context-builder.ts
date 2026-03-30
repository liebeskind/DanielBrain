import type pg from 'pg';
import { handleSemanticSearch } from '../mcp/tools/semantic-search.js';
import { detectIntent } from '../processor/intent-detector.js';
import { searchFacts } from '../db/fact-queries.js';
import { embedQuery } from '../processor/embedder.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('context-builder');
import {
  CHAT_CONTEXT_SEARCH_LIMIT,
  CHAT_CONTEXT_SEARCH_THRESHOLD,
  CHAT_CONTEXT_SNIPPET_LENGTH,
  CHAT_CONTEXT_SHORT_SUMMARY_THRESHOLD,
  CHAT_CONTEXT_CONTENT_EXCERPT_LENGTH,
  CHAT_CONTEXT_ENTITY_RELATIONSHIP_LIMIT,
} from '@danielbrain/shared';

interface ContextConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
  extractionModel: string;
  rerankerModel?: string;
}

export interface ContextTrace {
  intent: {
    type: string;
    confidence: number;
    reasoning: string;
    reformulated_query: string | null;
    was_fast_path: boolean;
  };
  search_params: {
    query: string;
    threshold: number;
    limit: number;
    days_back: number | null;
  };
  thoughts: Array<{
    id: string;
    summary: string | null;
    source: string;
    similarity: number;
    thought_type: string | null;
    created_at: string;
  }>;
  facts: Array<{
    statement: string;
    fact_type: string;
    confidence: number;
    similarity: number;
    subject_name: string | null;
  }>;
  crm: {
    triggered: boolean;
    record_count: number;
  };
  timing: {
    intent_ms: number;
    search_ms: number;
  };
}

export interface ContextResult {
  contextText: string;
  sources: Array<{
    id: string;
    summary: string | null;
    source: string;
    similarity: number;
  }>;
  entities: Array<{
    id: string;
    name: string;
    entity_type: string;
    profile_summary: string | null;
  }>;
  trace: ContextTrace;
}

interface SearchResult {
  id: string;
  content: string;
  summary: string | null;
  source: string;
  similarity: number;
  created_at: string;
  thought_type: string | null;
  people: string[];
  topics: string[];
  action_items: string[];
  sentiment: string;
  parent_id: string | null;
  parent_context?: {
    summary?: string;
    people?: string[];
    topics?: string[];
  };
}

export function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const groups = new Map<string, SearchResult>();
  for (const r of results) {
    const key = r.parent_id || r.id;
    const existing = groups.get(key);
    if (!existing || r.similarity > existing.similarity) {
      groups.set(key, r);
    }
  }
  return Array.from(groups.values());
}

export async function buildContext(
  userMessage: string,
  pool: pg.Pool,
  config: ContextConfig,
  visibilityTags?: string[] | null,
): Promise<ContextResult> {
  // Detect intent to adjust search params, run search + entity lookup in parallel
  const intentStart = Date.now();
  const [intent, entityResults] = await Promise.all([
    detectIntent(userMessage, [], config),
    findMatchingEntities(userMessage, pool),
  ]);
  const intentMs = Date.now() - intentStart;

  const searchQuery = intent.reformulated_query || userMessage;
  const searchThreshold = intent.adjustments.threshold ?? CHAT_CONTEXT_SEARCH_THRESHOLD;
  const searchLimit = intent.adjustments.limit ?? CHAT_CONTEXT_SEARCH_LIMIT;

  // Search phase: semantic search depends on Ollama (embedding), CRM is pure SQL.
  // If Ollama is unavailable, degrade to CRM + entity-only context instead of failing entirely.
  const searchStart = Date.now();
  const crmRelated = CRM_QUERY_PATTERN.test(userMessage);
  let searchResults: any[] = [];
  let factResults: any[] = [];
  let crmResults: any[] = [];

  const crmPromise = crmRelated ? fetchRecentCrmContext(pool, visibilityTags ?? null) : Promise.resolve([]);

  try {
    // Semantic search + facts need Ollama for embedding — wrap with 15s timeout
    const semanticPromise = Promise.race([
      (async () => {
        const [search, facts] = await Promise.all([
          handleSemanticSearch(
            { query: searchQuery, limit: searchLimit, threshold: searchThreshold, days_back: intent.adjustments.days_back },
            pool,
            config,
            visibilityTags,
          ),
          embedQuery(searchQuery, config).then((emb) =>
            searchFacts(pool, emb, { limit: 5, threshold: 0.3 }, visibilityTags ?? null),
          ),
        ]);
        return { search, facts };
      })(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Semantic search timeout')), 15_000)),
    ]);

    // Run semantic search and CRM in parallel — CRM always succeeds independently
    const [semanticResult, crm] = await Promise.all([semanticPromise, crmPromise]);
    searchResults = semanticResult.search;
    factResults = semanticResult.facts;
    crmResults = crm;
  } catch (err) {
    // Ollama unavailable or slow — still get CRM data
    log.warn({ err }, 'Semantic search failed, falling back to CRM + entities only');
    try { crmResults = await crmPromise; } catch { /* CRM already resolved or failed */ }
  }

  const searchMs = Date.now() - searchStart;

  // Merge CRM results with search results (dedup by ID)
  const mergedResults = [...searchResults];
  if (crmResults.length > 0) {
    const existingIds = new Set(searchResults.map((r: any) => r.id));
    for (const r of crmResults) {
      if (!existingIds.has(r.id)) mergedResults.push(r as any);
    }
  }

  // Deduplicate chunks from the same parent thought
  const dedupedResults = deduplicateResults(mergedResults as SearchResult[]);

  const sources = dedupedResults.map((r) => ({
    id: r.id,
    summary: r.summary,
    source: r.source,
    similarity: r.similarity,
  }));

  // Fetch entity relationships if we found entities
  const entityIds = entityResults.map((e) => e.id);
  const relationships = entityIds.length > 0
    ? await fetchEntityRelationships(entityIds, pool)
    : new Map<string, Array<{ name: string; entity_type: string; weight: number }>>();

  // Build context text block
  const parts: string[] = [];

  if (dedupedResults.length > 0) {
    parts.push('RELEVANT THOUGHTS:');
    for (const r of dedupedResults) {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : 'unknown date';
      const source = r.source || 'unknown';
      const thoughtType = r.thought_type || null;

      // Build bracket label: [date, source, thought_type]
      const bracketParts = [date, source];
      if (thoughtType) bracketParts.push(thoughtType);
      const bracket = bracketParts.join(', ');

      // Prefer summary over raw content (shorter, more focused)
      const summary = r.parent_context?.summary || r.summary;
      let snippet: string;
      if (summary) {
        snippet = summary;
        // Short summary: append content excerpt for detail
        if (summary.length < CHAT_CONTEXT_SHORT_SUMMARY_THRESHOLD && r.content && r.content !== summary) {
          const excerpt = r.content.length > CHAT_CONTEXT_CONTENT_EXCERPT_LENGTH
            ? r.content.slice(0, CHAT_CONTEXT_CONTENT_EXCERPT_LENGTH) + '...'
            : r.content;
          snippet += `\n  DETAIL: ${excerpt}`;
        }
      } else {
        snippet = r.content.length > CHAT_CONTEXT_SNIPPET_LENGTH
          ? r.content.slice(0, CHAT_CONTEXT_SNIPPET_LENGTH) + '...'
          : r.content;
      }

      // Metadata line: people, topics
      const people = r.parent_context?.people || r.people || [];
      const topics = r.parent_context?.topics || r.topics || [];
      const meta: string[] = [];
      if (people.length > 0) meta.push(`people: ${people.join(', ')}`);
      if (topics.length > 0) meta.push(`topics: ${topics.join(', ')}`);
      const metaStr = meta.length > 0 ? ` (${meta.join('; ')})` : '';

      parts.push(`- [${bracket}]${metaStr} ${snippet}`);

      // Surface action items (high value for "what should I do" queries)
      const actionItems = r.action_items || [];
      if (actionItems.length > 0) {
        for (const ai of actionItems) {
          parts.push(`  ACTION: ${ai}`);
        }
      }

      // Surface key decisions and insights
      const keyDecisions = (r as any).key_decisions || [];
      for (const kd of keyDecisions) {
        parts.push(`  DECISION: ${kd}`);
      }
      const keyInsights = (r as any).key_insights || [];
      for (const ki of keyInsights) {
        parts.push(`  INSIGHT: ${ki}`);
      }
    }
  }

  if (entityResults.length > 0) {
    parts.push('');
    parts.push('KNOWN ENTITIES:');
    for (const e of entityResults) {
      const profile = e.profile_summary ? ` — ${e.profile_summary}` : '';
      let line = `- ${e.name} (${e.entity_type})${profile}`;

      // Add relationship connections
      const rels = relationships.get(e.id);
      if (rels && rels.length > 0) {
        const connParts = rels.map((r) => `${r.name} (${r.entity_type}, ${r.weight}x)`);
        line += `\n  Connected: ${connParts.join(', ')}`;
      }

      parts.push(line);
    }
  }

  if (factResults.length > 0) {
    parts.push('');
    parts.push('KNOWN FACTS:');
    for (const f of factResults) {
      const subject = f.subject_name ? `[${f.subject_name}]` : '';
      parts.push(`- ${subject} ${f.statement} (${f.fact_type}, confidence: ${f.confidence})`);
    }
  }

  return {
    contextText: parts.join('\n'),
    sources,
    entities: entityResults,
    trace: {
      intent: {
        type: intent.intent,
        confidence: intent.confidence,
        reasoning: intent.reasoning,
        reformulated_query: intent.reformulated_query ?? null,
        was_fast_path: intent.was_fast_path ?? false,
      },
      search_params: {
        query: searchQuery,
        threshold: searchThreshold,
        limit: searchLimit,
        days_back: intent.adjustments.days_back ?? null,
      },
      thoughts: dedupedResults.map((r) => ({
        id: r.id,
        summary: r.summary,
        source: r.source,
        similarity: r.similarity,
        thought_type: r.thought_type,
        created_at: r.created_at,
      })),
      facts: factResults.map((f: any) => ({
        statement: f.statement,
        fact_type: f.fact_type,
        confidence: f.confidence,
        similarity: f.similarity,
        subject_name: f.subject_name ?? null,
      })),
      crm: {
        triggered: crmRelated,
        record_count: crmResults.length,
      },
      timing: {
        intent_ms: intentMs,
        search_ms: searchMs,
      },
    },
  };
}

// Common English stop words that should never match entity names
const ENTITY_STOP_WORDS = new Set([
  'the', 'and', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had',
  'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'shall', 'can', 'need', 'not', 'but', 'for', 'with', 'from', 'into', 'that',
  'this', 'then', 'than', 'what', 'when', 'where', 'which', 'who', 'whom',
  'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'also', 'just', 'any', 'about',
  'use', 'top', 'best', 'many', 'much', 'very', 'too', 'yet', 'out', 'there',
  'here', 'why', 'our', 'you', 'your', 'they', 'them', 'their', 'his', 'her',
  'its', 'she', 'him', 'who', 'get', 'got', 'let', 'put', 'say', 'said',
  'tell', 'told', 'ask', 'asked', 'give', 'gave', 'take', 'took', 'make',
  'made', 'know', 'think', 'come', 'came', 'want', 'look', 'like', 'new',
  'cases', 'discussed', 'between', 'after', 'before', 'during', 'through',
]);

async function findMatchingEntities(
  message: string,
  pool: pg.Pool,
): Promise<Array<{ id: string; name: string; entity_type: string; profile_summary: string | null }>> {
  // Extract meaningful words (3+ chars), filtering stop words
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !ENTITY_STOP_WORDS.has(w));

  if (words.length === 0) return [];

  // Check if any words match entity canonical_name or appear in aliases
  const { rows } = await pool.query(
    `SELECT DISTINCT id, name, entity_type, profile_summary
     FROM entities
     WHERE canonical_name = ANY($1)
        OR canonical_name LIKE ANY(SELECT w || ' %' FROM unnest($1::text[]) w)
     LIMIT 5`,
    [words],
  );

  return rows;
}

async function fetchEntityRelationships(
  entityIds: string[],
  pool: pg.Pool,
): Promise<Map<string, Array<{ name: string; entity_type: string; weight: number }>>> {
  const { rows } = await pool.query(
    `SELECT
       CASE WHEN er.source_id = ANY($1) THEN er.source_id ELSE er.target_id END as entity_id,
       e.name, e.entity_type, er.weight
     FROM entity_relationships er
     JOIN entities e ON e.id = CASE WHEN er.source_id = ANY($1) THEN er.target_id ELSE er.source_id END
     WHERE (er.source_id = ANY($1) OR er.target_id = ANY($1))
       AND er.invalid_at IS NULL
     ORDER BY er.weight DESC`,
    [entityIds],
  );

  const result = new Map<string, Array<{ name: string; entity_type: string; weight: number }>>();
  for (const row of rows) {
    const list = result.get(row.entity_id) || [];
    if (list.length < CHAT_CONTEXT_ENTITY_RELATIONSHIP_LIMIT) {
      list.push({ name: row.name, entity_type: row.entity_type, weight: row.weight });
      result.set(row.entity_id, list);
    }
  }
  return result;
}

/** Detect CRM/sales-oriented queries that need direct DB lookups (semantic search often misses structured CRM data) */
const CRM_QUERY_PATTERN = /\b(?:prospects?|leads?|pipeline|deals?|opportunities|sales|crm|hubspot|customers?|accounts?|contacts?|calls?|meetings?)\b/i;

type CrmRow = { id: string; content: string; summary: string | null; source: string; similarity: number; created_at: string; thought_type: string | null; people: string[]; topics: string[]; action_items: string[]; sentiment: string; parent_id: string | null };

/** Fetch recent CRM records — deals, calls, meetings, and contacts that semantic search often misses */
async function fetchRecentCrmContext(
  pool: pg.Pool,
  visibilityTags: string[] | null,
): Promise<CrmRow[]> {
  const { rows } = await pool.query(
    `SELECT id, content, summary, source, created_at, thought_type, people, topics, action_items, sentiment, parent_id,
            source_meta->'deal_synthesis'->>'summary' as deal_synthesis_summary
     FROM thoughts
     WHERE (
       (thought_type IN ('deal', 'contact', 'company_profile') AND source = 'hubspot')
       OR (thought_type IN ('call', 'meeting', 'meeting_note') AND source IN ('hubspot', 'fathom'))
     )
       AND ($1::text[] IS NULL OR visibility && $1)
       AND parent_id IS NULL
     ORDER BY created_at DESC
     LIMIT 25`,
    [visibilityTags],
  );

  return rows.map((r: any) => ({
    ...r,
    // Use pre-computed deal synthesis as summary when available
    summary: r.deal_synthesis_summary || r.summary,
    similarity: 0.5,
  }));
}

export { findMatchingEntities, fetchEntityRelationships };
