import type pg from 'pg';
import type { z } from 'zod';
import type { getCommunitiesInputSchema } from '@danielbrain/shared';

type GetCommunitiesInput = z.infer<typeof getCommunitiesInputSchema>;

export async function handleGetCommunities(
  input: GetCommunitiesInput,
  pool: pg.Pool,
) {
  const conditions: string[] = ['c.level = $1'];
  const params: (string | number)[] = [input.level];
  let paramIdx = 2;

  // Filter by entity membership
  if (input.entity_id) {
    conditions.push(`c.id IN (SELECT community_id FROM entity_communities WHERE entity_id = $${paramIdx})`);
    params.push(input.entity_id);
    paramIdx++;
  }

  // Search by title/summary
  if (input.search) {
    conditions.push(`(c.title ILIKE $${paramIdx} OR c.summary ILIKE $${paramIdx})`);
    params.push(`%${input.search}%`);
    paramIdx++;
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const { rows: communities } = await pool.query(
    `SELECT c.id, c.level, c.title, c.summary, c.member_count, c.created_at, c.updated_at
     FROM communities c
     ${whereClause}
     ORDER BY c.member_count DESC
     LIMIT $${paramIdx}`,
    [...params, input.limit]
  );

  // Fetch members for each community
  const result = [];
  for (const community of communities) {
    const { rows: members } = await pool.query(
      `SELECT e.id, e.name, e.entity_type, e.mention_count
       FROM entity_communities ec
       JOIN entities e ON e.id = ec.entity_id
       WHERE ec.community_id = $1
       ORDER BY e.mention_count DESC`,
      [community.id]
    );

    result.push({
      ...community,
      members: members.map((m: { id: string; name: string; entity_type: string; mention_count: number }) => ({
        id: m.id,
        name: m.name,
        entity_type: m.entity_type,
        mention_count: m.mention_count,
      })),
    });
  }

  return {
    communities: result,
    total: result.length,
  };
}
