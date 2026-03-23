import type pg from 'pg';
import { embedQuery } from '../../processor/embedder.js';
import { rerank } from '../../processor/reranker.js';
import { RRF_K, HYBRID_VECTOR_WEIGHT, HYBRID_BM25_WEIGHT } from '@danielbrain/shared';
import type { SearchResult } from '@danielbrain/shared';
import { fetchParentContext } from '../../db/thought-queries.js';

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
  rerankerModel?: string;
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

  // Batch-fetch parent context for all chunks (with visibility filtering)
  const parentIds = [...new Set(filtered.filter((r: any) => r.parent_id).map((r: any) => r.parent_id))];
  const parentMap = await fetchParentContext(pool, parentIds, visibilityTags ?? null);

  const results: SearchResultWithParent[] = filtered.map((row: any) => {
    const result: SearchResultWithParent = { ...row };
    if (row.parent_id) {
      const parent = parentMap.get(row.parent_id);
      if (parent) {
        result.parent_context = {
          summary: parent.summary,
          thought_type: parent.thought_type,
          people: parent.people,
          topics: parent.topics,
        };
      }
    }
    return result;
  });

  // Cross-encoder reranking (opt-in via RERANKER_MODEL)
  if (config.rerankerModel && results.length > 1) {
    return rerank(
      input.query,
      results,
      (r) => r.parent_context?.summary || r.summary || r.content.slice(0, 500),
      config.rerankerModel,
    );
  }

  return results;
}
