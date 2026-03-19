import type pg from 'pg';
import type { z } from 'zod';
import type { globalSearchInputSchema } from '@danielbrain/shared';
import { embedQuery } from '../../processor/embedder.js';

type GlobalSearchInput = z.infer<typeof globalSearchInputSchema>;

interface GlobalSearchConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
}

export async function handleGlobalSearch(
  input: GlobalSearchInput,
  pool: pg.Pool,
  config: GlobalSearchConfig,
) {
  // Embed query
  const queryEmbedding = await embedQuery(input.query, config);
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  // Cosine similarity search over community embeddings
  const { rows: communities } = await pool.query(
    `SELECT c.id, c.title, c.summary, c.full_report, c.member_count,
            1 - ((c.embedding::halfvec(768)) <=> ($1::vector::halfvec(768))) as similarity
     FROM communities c
     WHERE c.level = $2 AND c.summary IS NOT NULL AND c.embedding IS NOT NULL
     ORDER BY c.embedding::halfvec(768) <=> $1::vector::halfvec(768)
     LIMIT $3`,
    [vectorStr, input.level, input.limit]
  );

  // Fetch members for each matched community
  const results = [];
  for (const community of communities) {
    const { rows: members } = await pool.query(
      `SELECT e.name, e.entity_type
       FROM entity_communities ec
       JOIN entities e ON e.id = ec.entity_id
       WHERE ec.community_id = $1
       ORDER BY e.mention_count DESC`,
      [community.id]
    );

    results.push({
      community_id: community.id,
      title: community.title,
      summary: community.summary,
      full_report: community.full_report,
      member_count: community.member_count,
      similarity: parseFloat(community.similarity),
      members: members.map((m: { name: string; entity_type: string }) => ({
        name: m.name,
        entity_type: m.entity_type,
      })),
    });
  }

  return {
    query: input.query,
    results,
    total: results.length,
  };
}
