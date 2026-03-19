import type pg from 'pg';
import { embedQuery } from './embedder.js';

export interface KeywordExtractionResult {
  entities: Array<{ id: string; name: string; entity_type: string; profile_summary: string | null }>;
  themes: Array<{ community_id: string; title: string; similarity: number }>;
  queryEmbedding: number[];
}

interface KeywordConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
}

// Common English stop words (shared with context-builder)
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

export async function extractKeywords(
  query: string,
  pool: pg.Pool,
  config: KeywordConfig,
): Promise<KeywordExtractionResult> {
  // Run entity name match and query embedding in parallel
  const [entities, queryEmbedding] = await Promise.all([
    findMatchingEntitiesForKeywords(query, pool),
    embedQuery(query, config),
  ]);

  // Search community embeddings with the query embedding
  const vectorStr = `[${queryEmbedding.join(',')}]`;
  const { rows: themes } = await pool.query(
    `SELECT c.id as community_id, c.title,
            1 - ((c.embedding::halfvec(768)) <=> ($1::vector::halfvec(768))) as similarity
     FROM communities c
     WHERE c.summary IS NOT NULL AND c.embedding IS NOT NULL
     ORDER BY c.embedding::halfvec(768) <=> $1::vector::halfvec(768)
     LIMIT 3`,
    [vectorStr]
  );

  return {
    entities,
    themes: themes
      .filter((t: { similarity: string }) => parseFloat(t.similarity) > 0.3)
      .map((t: { community_id: string; title: string; similarity: string }) => ({
        community_id: t.community_id,
        title: t.title,
        similarity: parseFloat(t.similarity),
      })),
    queryEmbedding,
  };
}

async function findMatchingEntitiesForKeywords(
  message: string,
  pool: pg.Pool,
): Promise<Array<{ id: string; name: string; entity_type: string; profile_summary: string | null }>> {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !ENTITY_STOP_WORDS.has(w));

  if (words.length === 0) return [];

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
