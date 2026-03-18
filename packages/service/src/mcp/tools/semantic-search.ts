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
  config: EmbedConfig
): Promise<SearchResultWithParent[]> {
  const queryEmbedding = await embedQuery(input.query, config);
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  const { rows } = await pool.query(
    `SELECT * FROM hybrid_search($1::vector, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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

  // For chunks, fetch parent context
  const results: SearchResultWithParent[] = [];
  for (const row of filtered) {
    const result: SearchResultWithParent = { ...row };

    if (row.parent_id) {
      const { rows: parentRows } = await pool.query(
        `SELECT id, summary, thought_type, people, topics FROM thoughts WHERE id = $1`,
        [row.parent_id]
      );
      if (parentRows.length > 0) {
        result.parent_context = {
          summary: parentRows[0].summary,
          thought_type: parentRows[0].thought_type,
          people: parentRows[0].people,
          topics: parentRows[0].topics,
        };
      }
    }

    results.push(result);
  }

  return results;
}
