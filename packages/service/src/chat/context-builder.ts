import type pg from 'pg';
import { handleSemanticSearch } from '../mcp/tools/semantic-search.js';
import { CHAT_CONTEXT_SEARCH_LIMIT, CHAT_CONTEXT_SEARCH_THRESHOLD } from '@danielbrain/shared';

interface ContextConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
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
    name: string;
    entity_type: string;
    profile_summary: string | null;
  }>;
}

export async function buildContext(
  userMessage: string,
  pool: pg.Pool,
  config: ContextConfig,
): Promise<ContextResult> {
  // Run semantic search and entity lookup in parallel
  const [searchResults, entityResults] = await Promise.all([
    handleSemanticSearch(
      { query: userMessage, limit: CHAT_CONTEXT_SEARCH_LIMIT, threshold: CHAT_CONTEXT_SEARCH_THRESHOLD },
      pool,
      config,
    ),
    findMatchingEntities(userMessage, pool),
  ]);

  const sources = searchResults.map((r) => ({
    id: r.id,
    summary: r.summary,
    source: r.source,
    similarity: r.similarity,
  }));

  const entities = entityResults;

  // Build context text block
  const parts: string[] = [];

  if (searchResults.length > 0) {
    parts.push('RELEVANT THOUGHTS:');
    for (const r of searchResults) {
      const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : 'unknown date';
      const source = r.source || 'unknown';
      const summary = r.parent_context?.summary || r.summary || '';
      const snippet = r.content.length > 300 ? r.content.slice(0, 300) + '...' : r.content;
      parts.push(`- [${date}, ${source}] ${summary ? summary + ' — ' : ''}${snippet}`);
    }
  }

  if (entityResults.length > 0) {
    parts.push('');
    parts.push('KNOWN ENTITIES:');
    for (const e of entityResults) {
      const profile = e.profile_summary ? ` — ${e.profile_summary}` : '';
      parts.push(`- ${e.name} (${e.entity_type})${profile}`);
    }
  }

  return {
    contextText: parts.join('\n'),
    sources,
    entities,
  };
}

async function findMatchingEntities(
  message: string,
  pool: pg.Pool,
): Promise<Array<{ name: string; entity_type: string; profile_summary: string | null }>> {
  // Extract meaningful words (3+ chars) and search against entity names
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  if (words.length === 0) return [];

  // Check if any words match entity canonical_name or appear in aliases
  const { rows } = await pool.query(
    `SELECT DISTINCT name, entity_type, profile_summary
     FROM entities
     WHERE canonical_name = ANY($1)
        OR canonical_name LIKE ANY(SELECT w || ' %' FROM unnest($1::text[]) w)
     LIMIT 5`,
    [words],
  );

  return rows;
}

export { findMatchingEntities };
