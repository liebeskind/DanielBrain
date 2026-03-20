/**
 * Integration tests for relationship-builder (co-occurrence edges).
 *
 * Tests `createCooccurrenceEdges` against a real PostgreSQL database
 * (docker-compose.test.yml on port 5433).
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 * Prereq: docker compose -f docker/docker-compose.test.yml up -d && npm run migrate (on test DB)
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { TEST_DB_URL, createTestPool, insertTestEntity, insertTestThought, cleanupTestData } from './helpers.js';
import { createCooccurrenceEdges } from '../../src/processor/relationship-builder.js';
import { MAX_COOCCURRENCE_ENTITIES } from '@danielbrain/shared';

let pool: pg.Pool;

beforeAll(async () => {
  pool = createTestPool();
  await pool.query('SELECT 1');
});

afterAll(async () => {
  await cleanupTestData(pool);
  await pool.end();
});

afterEach(async () => {
  // Clean up edges and entities from test data
  await pool.query(
    `DELETE FROM entity_relationships WHERE source_id IN (SELECT id FROM entities WHERE name LIKE 'TestRB%')`,
  );
  await pool.query(
    `DELETE FROM entity_communities WHERE entity_id IN (SELECT id FROM entities WHERE name LIKE 'TestRB%')`,
  );
  await pool.query(
    `DELETE FROM thought_entities WHERE thought_id IN (SELECT id FROM thoughts WHERE source = 'test')`,
  );
  await pool.query(`DELETE FROM thoughts WHERE source = 'test'`);
  await pool.query(`DELETE FROM entities WHERE name LIKE 'TestRB%'`);
});

describe('createCooccurrenceEdges integration', () => {
  it('creates co-occurrence edge between 2 entities with weight=1', async () => {
    const entityA = await insertTestEntity(pool, { name: 'TestRB Alpha', entityType: 'person' });
    const entityB = await insertTestEntity(pool, { name: 'TestRB Beta', entityType: 'person' });
    const thoughtId = await insertTestThought(pool, { content: 'Alpha and Beta met' });

    const count = await createCooccurrenceEdges(thoughtId, [entityA, entityB], pool);
    expect(count).toBe(1);

    // Verify edge exists
    const [sourceId, targetId] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
    const { rows } = await pool.query(
      `SELECT source_id, target_id, relationship, weight, source_thought_ids
       FROM entity_relationships
       WHERE source_id = $1 AND target_id = $2 AND relationship = 'co_occurs'`,
      [sourceId, targetId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(1);
    expect(rows[0].source_thought_ids).toContain(thoughtId);
  });

  it('enforces canonical direction: smaller UUID = source_id', async () => {
    const entityA = await insertTestEntity(pool, { name: 'TestRB Charlie', entityType: 'person' });
    const entityB = await insertTestEntity(pool, { name: 'TestRB Delta', entityType: 'person' });
    const thoughtId = await insertTestThought(pool, { content: 'Charlie and Delta discussed' });

    // Pass in reverse order (larger UUID first)
    const [smaller, larger] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
    await createCooccurrenceEdges(thoughtId, [larger, smaller], pool);

    // Edge should always have smaller UUID as source_id
    const { rows } = await pool.query(
      `SELECT source_id, target_id FROM entity_relationships
       WHERE relationship = 'co_occurs'
       AND (source_id = $1 OR source_id = $2)
       AND (target_id = $1 OR target_id = $2)`,
      [entityA, entityB],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe(smaller);
    expect(rows[0].target_id).toBe(larger);
  });

  it('increments weight when called twice with same entities, different thoughts', async () => {
    const entityA = await insertTestEntity(pool, { name: 'TestRB Echo', entityType: 'person' });
    const entityB = await insertTestEntity(pool, { name: 'TestRB Foxtrot', entityType: 'person' });
    const thought1 = await insertTestThought(pool, { content: 'First meeting of Echo and Foxtrot' });
    const thought2 = await insertTestThought(pool, { content: 'Second meeting of Echo and Foxtrot' });

    await createCooccurrenceEdges(thought1, [entityA, entityB], pool);
    await createCooccurrenceEdges(thought2, [entityA, entityB], pool);

    const [sourceId, targetId] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
    const { rows } = await pool.query(
      `SELECT weight, source_thought_ids FROM entity_relationships
       WHERE source_id = $1 AND target_id = $2 AND relationship = 'co_occurs'`,
      [sourceId, targetId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(2);
    // Both thought IDs should be tracked
    expect(rows[0].source_thought_ids).toHaveLength(2);
    expect(rows[0].source_thought_ids).toContain(thought1);
    expect(rows[0].source_thought_ids).toContain(thought2);
  });

  it('source_thought_ids: no duplicates when same thought processed twice', async () => {
    const entityA = await insertTestEntity(pool, { name: 'TestRB Golf', entityType: 'person' });
    const entityB = await insertTestEntity(pool, { name: 'TestRB Hotel', entityType: 'person' });
    const thoughtId = await insertTestThought(pool, { content: 'Golf and Hotel met' });

    // Call twice with same thought — simulates idempotent retry
    await createCooccurrenceEdges(thoughtId, [entityA, entityB], pool);
    await createCooccurrenceEdges(thoughtId, [entityA, entityB], pool);

    const [sourceId, targetId] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
    const { rows } = await pool.query(
      `SELECT source_thought_ids FROM entity_relationships
       WHERE source_id = $1 AND target_id = $2 AND relationship = 'co_occurs'`,
      [sourceId, targetId],
    );
    // source_thought_ids should NOT contain duplicates (the SQL CASE prevents it)
    const ids = rows[0].source_thought_ids;
    const unique = [...new Set(ids)];
    expect(ids).toHaveLength(unique.length);
    expect(ids).toContain(thoughtId);
  });

  it('caps at MAX_COOCCURRENCE_ENTITIES to prevent quadratic explosion', async () => {
    // Create MAX_COOCCURRENCE_ENTITIES + 5 entities
    const entityCount = MAX_COOCCURRENCE_ENTITIES + 5;
    const entityIds: string[] = [];
    for (let i = 0; i < entityCount; i++) {
      const id = await insertTestEntity(pool, {
        name: `TestRB Capped${String(i).padStart(3, '0')}`,
        entityType: 'person',
      });
      entityIds.push(id);
    }
    const thoughtId = await insertTestThought(pool, { content: 'Large meeting with many participants' });

    const count = await createCooccurrenceEdges(thoughtId, entityIds, pool);

    // Should only create edges for the first MAX_COOCCURRENCE_ENTITIES entities
    // C(MAX_COOCCURRENCE_ENTITIES, 2) = MAX_COOCCURRENCE_ENTITIES * (MAX_COOCCURRENCE_ENTITIES - 1) / 2
    const expectedEdges = (MAX_COOCCURRENCE_ENTITIES * (MAX_COOCCURRENCE_ENTITIES - 1)) / 2;
    expect(count).toBe(expectedEdges);

    // Verify the extra 5 entities are NOT in any edges
    const cappedIds = entityIds.slice(0, MAX_COOCCURRENCE_ENTITIES);
    const skippedIds = entityIds.slice(MAX_COOCCURRENCE_ENTITIES);

    for (const skippedId of skippedIds) {
      const { rows } = await pool.query(
        `SELECT id FROM entity_relationships
         WHERE (source_id = $1 OR target_id = $1) AND relationship = 'co_occurs'`,
        [skippedId],
      );
      expect(rows).toHaveLength(0);
    }
  });

  it('skipPairs parameter: explicit pairs are skipped', async () => {
    const entityA = await insertTestEntity(pool, { name: 'TestRB India', entityType: 'person' });
    const entityB = await insertTestEntity(pool, { name: 'TestRB Juliet', entityType: 'person' });
    const entityC = await insertTestEntity(pool, { name: 'TestRB Kilo', entityType: 'person' });
    const thoughtId = await insertTestThought(pool, { content: 'India, Juliet, and Kilo' });

    // Skip the A-B pair
    const [sA, tA] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
    const skipPairs = new Set([`${sA}:${tA}`]);

    const count = await createCooccurrenceEdges(thoughtId, [entityA, entityB, entityC], pool, skipPairs);

    // 3 entities => 3 pairs total, 1 skipped => 2 created
    expect(count).toBe(2);

    // Verify skipped pair does NOT exist
    const { rows: skippedEdge } = await pool.query(
      `SELECT id FROM entity_relationships
       WHERE source_id = $1 AND target_id = $2 AND relationship = 'co_occurs'`,
      [sA, tA],
    );
    expect(skippedEdge).toHaveLength(0);
  });

  it('returns 0 with fewer than 2 entities', async () => {
    const entityA = await insertTestEntity(pool, { name: 'TestRB Lone', entityType: 'person' });
    const thoughtId = await insertTestThought(pool, { content: 'Just one entity' });

    const count0 = await createCooccurrenceEdges(thoughtId, [], pool);
    expect(count0).toBe(0);

    const count1 = await createCooccurrenceEdges(thoughtId, [entityA], pool);
    expect(count1).toBe(0);

    // Duplicate IDs should also return 0 (deduped to 1)
    const countDup = await createCooccurrenceEdges(thoughtId, [entityA, entityA], pool);
    expect(countDup).toBe(0);
  });
});
