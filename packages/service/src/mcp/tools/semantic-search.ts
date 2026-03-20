import type pg from 'pg';
import { embedQuery } from '../../processor/embedder.js';
import { RRF_K, HYBRID_VECTOR_WEIGHT, HYBRID_BM25_WEIGHT } from '@danielbrain/shared';
import type { SearchResult } from '@danielbrain/shared';

interface SemanticSearchInput {
  query: string;
  limit: number;
  threshold: number;
  thought_type?: string;
  person?: string;
  topic?: string;
  days_back?: number;
  source?: string;
  sources?: string[];
}

interface EmbedConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
}

interface SearchResultWithParent extends SearchResult {
  parent_context?: {
    summary: string | null;
    thought_type: string | null;
    people: string[];
    topics: string[];
  };
}

export async function handleSemanticSearch(
  input: SemanticSearchInput,
  pool: pg.Pool,
  config: EmbedConfig,
  visibilityTags?: string[] | null,
): Promise<SearchResultWithParent[]> {
  const queryEmbedding = await embedQuery(input.query, config);
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  const { rows } = await pool.query(
    `SELECT * FROM hybrid_search($1::vector, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      vectorStr,
      input.query,
      input.threshold,
      input.limit,
      input.thought_type ?? null,
      input.person ?? null,
      input.topic ?? null,
      input.days_back ?? null,
      RRF_K,
      HYBRID_VECTOR_WEIGHT,
      HYBRID_BM25_WEIGHT,
      visibilityTags ?? null,
    ]
  );

  // Post-filter by source/sources
  let filtered = rows;
  if (input.source) {
    filtered = rows.filter((r: { source: string }) => r.source === input.source);
  } else if (input.sources?.length) {
    const sourceSet = new Set(input.sources);
    filtered = rows.filter((r: { source: string }) => sourceSet.has(r.source));
  }

  // Batch-fetch parent context for all chunks (avoids N+1 queries)
  const parentIds = [...new Set(filtered.filter((r: any) => r.parent_id).map((r: any) => r.parent_id))];
  const parentMap = new Map<string, { summary: string | null; thought_type: string | null; people: string[]; topics: string[] }>();

  if (parentIds.length > 0) {
    const { rows: parentRows } = await pool.query(
      `SELECT id, summary, thought_type, people, topics FROM thoughts WHERE id = ANY($1)`,
      [parentIds]
    );
    for (const p of parentRows) {
      parentMap.set(p.id, {
        summary: p.summary,
        thought_type: p.thought_type,
        people: p.people,
        topics: p.topics,
      });
    }
  }

  const results: SearchResultWithParent[] = filtered.map((row: any) => {
    const result: SearchResultWithParent = { ...row };
    if (row.parent_id) {
      result.parent_context = parentMap.get(row.parent_id) ?? undefined;
    }
    return result;
  });

  return results;
}
