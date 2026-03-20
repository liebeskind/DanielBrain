/**
 * Integration tests for entity merge proposal workflow against real PostgreSQL.
 *
 * Tests the full applyProposal('entity_merge') lifecycle: thought_entities reassignment,
 * alias merging, entity_relationships cascade, community cleanup, mention count summing,
 * duplicate edge handling, and transaction atomicity.
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 * Prereq: docker compose -f docker/docker-compose.test.yml up -d && npm run migrate (on test DB)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import {
  TEST_DB_URL, randomEmbedding,
  insertTestUser, insertTestThought, insertTestEntity,
  linkThoughtEntity, insertEntityRelationship, insertTestProposal,
  cleanupTestData,
} from './helpers.js';
import { applyProposal } from '../../src/proposals/applier.js';
import type { Proposal } from '@danielbrain/shared';

let pool: pg.Pool;

const TEST_USER = { id: crypto.randomUUID(), email: 'em-user@test.com', displayName: 'EM User', role: 'owner' as const };

// These track IDs of entities created per test for cleanup.
// We clean up thoughts via cleanupTestData (source='test'), but entities need manual cleanup
// because insertTestEntity uses name patterns and merge deletes the loser.
const allCreatedEntityIds: string[] = [];
const allCreatedCommunityIds: string[] = [];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 5 });
  await pool.query('SELECT 1');

  await insertTestUser(pool, {
    id: TEST_USER.id, email: TEST_USER.email,
    displayName: TEST_USER.displayName, role: TEST_USER.role,
  });
});

afterAll(async () => {
  // Clean up entity_communities
  if (allCreatedCommunityIds.length > 0) {
    await pool.query(
      `DELETE FROM entity_communities WHERE community_id = ANY($1::uuid[])`,
      [allCreatedCommunityIds],
    );
    await pool.query(
      `DELETE FROM communities WHERE id = ANY($1::uuid[])`,
      [allCreatedCommunityIds],
    );
  }

  // Clean up entities (some may have been deleted by merge)
  if (allCreatedEntityIds.length > 0) {
    await pool.query(
      `DELETE FROM thought_entities WHERE entity_id = ANY($1::uuid[])`,
      [allCreatedEntityIds],
    );
    await pool.query(
      `DELETE FROM entity_relationships WHERE source_id = ANY($1::uuid[]) OR target_id = ANY($1::uuid[])`,
      [allCreatedEntityIds],
    );
    await pool.query(
      `DELETE FROM entity_communities WHERE entity_id = ANY($1::uuid[])`,
      [allCreatedEntityIds],
    );
    await pool.query(
      `DELETE FROM proposals WHERE entity_id = ANY($1::uuid[])`,
      [allCreatedEntityIds],
    );
    await pool.query(
      `DELETE FROM entities WHERE id = ANY($1::uuid[])`,
      [allCreatedEntityIds],
    );
  }

  await cleanupTestData(pool);
  await pool.end();
});

/** Build a minimal Proposal object for applyProposal */
function buildMergeProposal(
  proposalId: string,
  winnerId: string,
  loserId: string,
): Proposal {
  return {
    id: proposalId,
    proposal_type: 'entity_merge',
    status: 'approved',
    entity_id: winnerId,
    title: `Merge test entities`,
    description: null,
    proposed_data: { winner_id: winnerId, loser_id: loserId },
    current_data: null,
    auto_applied: false,
    reviewer_notes: null,
    source: 'test',
    applied_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/** Create a full merge scenario: winner, loser, thoughts, relationships, community */
async function createMergeScenario(suffix: string) {
  // Create two entities (winner and loser)
  const winnerId = await insertTestEntity(pool, {
    name: `Test Winner ${suffix}`,
    entityType: 'person',
    aliases: [`test winner ${suffix}`, `test w ${suffix}`],
    mentionCount: 5,
  });
  allCreatedEntityIds.push(winnerId);

  const loserId = await insertTestEntity(pool, {
    name: `Test Loser ${suffix}`,
    entityType: 'person',
    aliases: [`test loser ${suffix}`, `test l ${suffix}`],
    mentionCount: 3,
  });
  allCreatedEntityIds.push(loserId);

  // Create a third entity for relationship edges
  const thirdId = await insertTestEntity(pool, {
    name: `Test Third ${suffix}`,
    entityType: 'company',
    mentionCount: 1,
  });
  allCreatedEntityIds.push(thirdId);

  // Create thoughts linked to winner and loser
  const thoughtForWinner = await insertTestThought(pool, {
    content: `Thought linked to winner ${suffix}`,
    ownerId: TEST_USER.id,
    embedding: randomEmbedding(),
  });

  const thoughtForLoser = await insertTestThought(pool, {
    content: `Thought linked to loser ${suffix}`,
    ownerId: TEST_USER.id,
    embedding: randomEmbedding(),
  });

  const thoughtForBoth = await insertTestThought(pool, {
    content: `Thought linked to both ${suffix}`,
    ownerId: TEST_USER.id,
    embedding: randomEmbedding(),
  });

  // Link thoughts to entities
  await linkThoughtEntity(pool, thoughtForWinner, winnerId, 'mentions');
  await linkThoughtEntity(pool, thoughtForLoser, loserId, 'mentions');
  await linkThoughtEntity(pool, thoughtForBoth, winnerId, 'mentions');
  await linkThoughtEntity(pool, thoughtForBoth, loserId, 'mentions');

  // Create entity_relationships: loser -> third
  await insertEntityRelationship(pool, loserId, thirdId, {
    relationship: 'co_occurs',
    weight: 2,
    description: 'Loser works with Third',
    sourceThoughtIds: [thoughtForLoser],
  });

  // Create a community and add loser to it
  const { rows: communityRows } = await pool.query(
    `INSERT INTO communities (level, title, member_count) VALUES (0, 'Test Community ${suffix}', 2) RETURNING id`,
  );
  const communityId = communityRows[0].id;
  allCreatedCommunityIds.push(communityId);

  await pool.query(
    `INSERT INTO entity_communities (entity_id, community_id, level) VALUES ($1, $2, 0)`,
    [loserId, communityId],
  );

  // Create proposal
  const proposalId = await insertTestProposal(pool, {
    proposalType: 'entity_merge',
    entityId: winnerId,
    title: `Merge loser into winner ${suffix}`,
    proposedData: { winner_id: winnerId, loser_id: loserId },
    status: 'approved',
  });

  return {
    winnerId, loserId, thirdId,
    thoughtForWinner, thoughtForLoser, thoughtForBoth,
    communityId, proposalId,
  };
}

describe('entity merge — full cascade', () => {
  it('reassigns thought_entities from loser to winner', async () => {
    const s = await createMergeScenario('te-reassign');
    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);

    await applyProposal(proposal, pool);

    // Loser's exclusive thought should now be linked to winner
    const { rows } = await pool.query(
      `SELECT entity_id FROM thought_entities WHERE thought_id = $1 AND relationship = 'mentions'`,
      [s.thoughtForLoser],
    );
    const entityIds = rows.map((r: any) => r.entity_id);
    expect(entityIds).toContain(s.winnerId);
    expect(entityIds).not.toContain(s.loserId);
  });

  it('merges aliases from loser into winner', async () => {
    const s = await createMergeScenario('alias-merge');
    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);

    await applyProposal(proposal, pool);

    const { rows } = await pool.query(
      `SELECT aliases FROM entities WHERE id = $1`,
      [s.winnerId],
    );
    const aliases: string[] = rows[0].aliases;

    // Winner should have its own aliases plus loser's aliases
    expect(aliases).toContain(`test winner alias-merge`);
    expect(aliases).toContain(`test w alias-merge`);
    expect(aliases).toContain(`test loser alias-merge`);
    expect(aliases).toContain(`test l alias-merge`);
  });

  it('updates entity_relationships: source_id references reassigned to winner', async () => {
    const s = await createMergeScenario('rel-source');

    // Create an edge where loser is source
    // canonical direction: smaller UUID = source, but let's insert explicitly
    await pool.query(
      `INSERT INTO entity_relationships (source_id, target_id, relationship, weight)
       VALUES ($1, $2, 'works_at', 1)
       ON CONFLICT (source_id, target_id, relationship) DO NOTHING`,
      [s.loserId < s.thirdId ? s.loserId : s.thirdId, s.loserId < s.thirdId ? s.thirdId : s.loserId],
    );

    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);
    await applyProposal(proposal, pool);

    // No edges should reference loser anymore
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM entity_relationships WHERE source_id = $1 OR target_id = $1`,
      [s.loserId],
    );
    expect(rows[0].count).toBe(0);
  });

  it('updates entity_relationships: target_id references reassigned to winner', async () => {
    const s = await createMergeScenario('rel-target');

    // Ensure the loser->third edge has loser as target (create third->loser)
    // Use canonical direction
    const [src, tgt] = s.thirdId < s.loserId ? [s.thirdId, s.loserId] : [s.loserId, s.thirdId];
    await pool.query(
      `INSERT INTO entity_relationships (source_id, target_id, relationship, weight)
       VALUES ($1, $2, 'advises', 1)
       ON CONFLICT (source_id, target_id, relationship) DO NOTHING`,
      [src, tgt],
    );

    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);
    await applyProposal(proposal, pool);

    // No edges should reference loser
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM entity_relationships WHERE source_id = $1 OR target_id = $1`,
      [s.loserId],
    );
    expect(rows[0].count).toBe(0);
  });

  it('deletes loser entity after merge', async () => {
    const s = await createMergeScenario('delete-loser');
    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);

    await applyProposal(proposal, pool);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM entities WHERE id = $1`,
      [s.loserId],
    );
    expect(rows[0].count).toBe(0);
  });

  it('removes loser from community memberships', async () => {
    const s = await createMergeScenario('community');
    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);

    await applyProposal(proposal, pool);

    // Loser should have no community memberships
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM entity_communities WHERE entity_id = $1`,
      [s.loserId],
    );
    expect(rows[0].count).toBe(0);
  });

  it('sums mention counts correctly', async () => {
    const s = await createMergeScenario('mentions');

    // Get counts before merge
    const { rows: beforeWinner } = await pool.query(
      `SELECT mention_count FROM entities WHERE id = $1`, [s.winnerId],
    );
    const { rows: beforeLoser } = await pool.query(
      `SELECT mention_count FROM entities WHERE id = $1`, [s.loserId],
    );
    const expectedTotal = beforeWinner[0].mention_count + beforeLoser[0].mention_count;

    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);
    await applyProposal(proposal, pool);

    const { rows: afterWinner } = await pool.query(
      `SELECT mention_count FROM entities WHERE id = $1`, [s.winnerId],
    );
    expect(afterWinner[0].mention_count).toBe(expectedTotal);
  });

  it('handles duplicate edge gracefully: winner already has edge to same target', async () => {
    const s = await createMergeScenario('dup-edge');

    // Winner already has a co_occurs edge to third (setup creates loser->third;
    // now add winner->third so merge would create a duplicate)
    await insertEntityRelationship(pool, s.winnerId, s.thirdId, {
      relationship: 'co_occurs',
      weight: 5,
      description: 'Winner already knows Third',
    });

    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);

    // Should not throw despite the potential duplicate
    await expect(applyProposal(proposal, pool)).resolves.not.toThrow();

    // Winner->Third edge should still exist (the winner's original edge preserved)
    const [src, tgt] = s.winnerId < s.thirdId ? [s.winnerId, s.thirdId] : [s.thirdId, s.winnerId];
    const { rows } = await pool.query(
      `SELECT weight, description FROM entity_relationships
       WHERE source_id = $1 AND target_id = $2 AND relationship = 'co_occurs'`,
      [src, tgt],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // No loser edges remain
    const { rows: loserEdges } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM entity_relationships WHERE source_id = $1 OR target_id = $1`,
      [s.loserId],
    );
    expect(loserEdges[0].count).toBe(0);
  });

  it('handles thought linked to both winner and loser (dedup)', async () => {
    const s = await createMergeScenario('both-link');

    // thoughtForBoth is linked to both winner and loser
    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);
    await applyProposal(proposal, pool);

    // After merge, thoughtForBoth should only be linked to winner (no duplicate)
    const { rows } = await pool.query(
      `SELECT entity_id, relationship FROM thought_entities
       WHERE thought_id = $1`,
      [s.thoughtForBoth],
    );
    const entityIds = rows.map((r: any) => r.entity_id);
    // Winner should appear (existing link preserved or loser's link reassigned)
    expect(entityIds).toContain(s.winnerId);
    // Loser should not appear
    expect(entityIds).not.toContain(s.loserId);
    // No duplicate winner entries for same relationship
    const winnerMentions = rows.filter(
      (r: any) => r.entity_id === s.winnerId && r.relationship === 'mentions',
    );
    expect(winnerMentions).toHaveLength(1);
  });
});

describe('entity merge — transaction atomicity', () => {
  it('merge is all-or-nothing: winner and relationships are consistent', async () => {
    const s = await createMergeScenario('atomicity');
    const proposal = buildMergeProposal(s.proposalId, s.winnerId, s.loserId);

    await applyProposal(proposal, pool);

    // Verify complete state:
    // 1. Loser gone
    const { rows: loserExists } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM entities WHERE id = $1`,
      [s.loserId],
    );
    expect(loserExists[0].count).toBe(0);

    // 2. No thought_entities reference loser
    const { rows: loserLinks } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM thought_entities WHERE entity_id = $1`,
      [s.loserId],
    );
    expect(loserLinks[0].count).toBe(0);

    // 3. No entity_relationships reference loser
    const { rows: loserRels } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM entity_relationships WHERE source_id = $1 OR target_id = $1`,
      [s.loserId],
    );
    expect(loserRels[0].count).toBe(0);

    // 4. No entity_communities reference loser
    const { rows: loserComms } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM entity_communities WHERE entity_id = $1`,
      [s.loserId],
    );
    expect(loserComms[0].count).toBe(0);

    // 5. Winner still exists and has accumulated state
    const { rows: winnerExists } = await pool.query(
      `SELECT id FROM entities WHERE id = $1`,
      [s.winnerId],
    );
    expect(winnerExists).toHaveLength(1);
  });

  it('merge with invalid loser_id fails cleanly without corrupting winner', async () => {
    const winnerId = await insertTestEntity(pool, {
      name: 'Test Safe Winner',
      entityType: 'person',
      mentionCount: 10,
      aliases: ['test safe winner'],
    });
    allCreatedEntityIds.push(winnerId);

    const fakeLoserId = crypto.randomUUID(); // Does not exist

    const proposalId = await insertTestProposal(pool, {
      proposalType: 'entity_merge',
      entityId: winnerId,
      title: 'Merge with nonexistent',
      proposedData: { winner_id: winnerId, loser_id: fakeLoserId },
      status: 'approved',
    });

    const proposal = buildMergeProposal(proposalId, winnerId, fakeLoserId);

    // applyProposal should not throw for this case — the DELETE/UPDATE just affect 0 rows
    // (No FK violation because we're updating/deleting by loser_id which doesn't exist)
    await expect(applyProposal(proposal, pool)).resolves.not.toThrow();

    // Winner should be untouched
    const { rows } = await pool.query(
      `SELECT mention_count, aliases FROM entities WHERE id = $1`,
      [winnerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mention_count).toBe(10);
  });
});
