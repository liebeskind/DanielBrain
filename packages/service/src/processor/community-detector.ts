import type pg from 'pg';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import crypto from 'crypto';
import { COMMUNITY_MIN_EDGE_WEIGHT } from '@danielbrain/shared';

export interface DetectionResult {
  communities: number;
  changed: boolean;
}

/**
 * Build an undirected graph from entities + relationships, run Louvain community detection,
 * and persist the results. Returns early if community memberships haven't changed.
 */
export async function detectCommunities(pool: pg.Pool, level = 0): Promise<DetectionResult> {
  // Load entities that participate in relationships
  const { rows: edges } = await pool.query(
    `SELECT source_id, target_id, weight
     FROM entity_relationships
     WHERE weight >= $1 AND invalid_at IS NULL`,
    [COMMUNITY_MIN_EDGE_WEIGHT]
  );

  if (edges.length === 0) {
    return { communities: 0, changed: false };
  }

  // Build graph
  const graph = new Graph({ type: 'undirected', allowSelfLoops: false });

  for (const edge of edges) {
    if (edge.source_id === edge.target_id) continue; // skip self-loops
    if (!graph.hasNode(edge.source_id)) graph.addNode(edge.source_id);
    if (!graph.hasNode(edge.target_id)) graph.addNode(edge.target_id);

    // Canonical key: smaller UUID first (matches DB convention, avoids A--B / B--A dupes)
    const [a, b] = edge.source_id < edge.target_id
      ? [edge.source_id, edge.target_id]
      : [edge.target_id, edge.source_id];
    const key = `${a}--${b}`;

    if (graph.hasEdge(key)) {
      graph.setEdgeAttribute(key, 'weight', graph.getEdgeAttribute(key, 'weight') + edge.weight);
    } else {
      graph.addEdgeWithKey(key, a, b, { weight: edge.weight });
    }
  }

  // Run Louvain
  const assignments = louvain(graph, { resolution: 1.0 });

  // Group nodes by community
  const communityMembers = new Map<number, string[]>();
  for (const [nodeId, communityIdx] of Object.entries(assignments)) {
    if (!communityMembers.has(communityIdx)) {
      communityMembers.set(communityIdx, []);
    }
    communityMembers.get(communityIdx)!.push(nodeId);
  }

  // Compute hash of current assignments to detect changes
  const newHash = hashAssignments(communityMembers);

  // Check existing assignments hash
  const { rows: existingCommunities } = await pool.query(
    `SELECT c.id, ARRAY_AGG(ec.entity_id ORDER BY ec.entity_id) as member_ids
     FROM communities c
     JOIN entity_communities ec ON ec.community_id = c.id
     WHERE c.level = $1
     GROUP BY c.id
     ORDER BY c.id`,
    [level]
  );

  const existingMembers = new Map<string, string[]>();
  for (const row of existingCommunities) {
    existingMembers.set(row.id, row.member_ids);
  }
  const existingHash = hashAssignments(existingMembers);

  if (newHash === existingHash) {
    return { communities: communityMembers.size, changed: false };
  }

  // Persist within transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete old communities and mappings for this level
    await client.query(
      `DELETE FROM communities WHERE level = $1`,
      [level]
    );

    // Insert new communities
    for (const [, members] of communityMembers) {
      const { rows: [community] } = await client.query(
        `INSERT INTO communities (level, member_count)
         VALUES ($1, $2)
         RETURNING id`,
        [level, members.length]
      );

      // Insert entity-community mappings
      for (const entityId of members) {
        await client.query(
          `INSERT INTO entity_communities (entity_id, community_id, level)
           VALUES ($1, $2, $3)`,
          [entityId, community.id, level]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { communities: communityMembers.size, changed: true };
}

/**
 * Hash community membership sets to detect changes without comparing full sets.
 */
function hashAssignments(communities: Map<number | string, string[]>): string {
  // Sort each community's members, then sort communities by their sorted member lists
  const sorted = [...communities.values()]
    .map(members => members.sort().join(','))
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(sorted).digest('hex');
}
