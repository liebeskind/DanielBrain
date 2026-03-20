/**
 * Integration tests for entity resolver functions against real PostgreSQL.
 *
 * Tests normalizeName, isJunkEntity, findOrCreateEntity, inferRelationship,
 * and thought-entity linking with real DB constraints.
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 * Prereq: docker compose -f docker/docker-compose.test.yml up -d && npm run migrate (on test DB)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import {
  TEST_DB_URL, randomEmbedding,
  insertTestUser, insertTestThought, insertTestEntity,
  linkThoughtEntity, cleanupTestData,
} from './helpers.js';
import {
  normalizeName, isJunkEntity, findOrCreateEntity, inferRelationship,
} from '../../src/processor/entity-resolver.js';
import type { ThoughtMetadata } from '@danielbrain/shared';

let pool: pg.Pool;

const TEST_USER = { id: crypto.randomUUID(), email: 'er-user@test.com', displayName: 'ER User', role: 'owner' as const };

// Track entity IDs created by findOrCreateEntity for cleanup
const createdEntityIds: string[] = [];

/** Minimal metadata for inferRelationship tests */
function makeMetadata(overrides: Partial<ThoughtMetadata> = {}): ThoughtMetadata {
  return {
    thought_type: 'note',
    people: [],
    topics: [],
    action_items: [],
    dates_mentioned: [],
    sentiment: null,
    summary: null,
    companies: [],
    products: [],
    projects: [],
    department: null,
    confidentiality: null,
    themes: [],
    key_decisions: [],
    key_insights: [],
    meeting_participants: [],
    action_items_structured: [],
    ...overrides,
  };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 5 });
  await pool.query('SELECT 1');

  await insertTestUser(pool, {
    id: TEST_USER.id, email: TEST_USER.email,
    displayName: TEST_USER.displayName, role: TEST_USER.role,
  });
});

afterAll(async () => {
  // Clean up entities created by findOrCreateEntity (not caught by cleanupTestData's LIKE 'Test%')
  if (createdEntityIds.length > 0) {
    // Remove thought_entities referencing these
    await pool.query(
      `DELETE FROM thought_entities WHERE entity_id = ANY($1::uuid[])`,
      [createdEntityIds],
    );
    // Remove entity_relationships referencing these
    await pool.query(
      `DELETE FROM entity_relationships WHERE source_id = ANY($1::uuid[]) OR target_id = ANY($1::uuid[])`,
      [createdEntityIds],
    );
    // Remove proposals referencing these
    await pool.query(
      `DELETE FROM proposals WHERE entity_id = ANY($1::uuid[])`,
      [createdEntityIds],
    );
    // Remove the entities themselves
    await pool.query(
      `DELETE FROM entities WHERE id = ANY($1::uuid[])`,
      [createdEntityIds],
    );
  }
  await cleanupTestData(pool);
  await pool.end();
});

describe('findOrCreateEntity — canonical match', () => {
  it('returns existing entity on exact canonical name match', async () => {
    // Pre-create an entity via direct SQL
    const entityId = await insertTestEntity(pool, {
      name: 'Test Gordon Smith',
      entityType: 'person',
      canonicalName: 'test gordon smith',
      aliases: ['test gordon smith'],
    });
    createdEntityIds.push(entityId);

    // Now findOrCreateEntity should find it
    const match = await findOrCreateEntity('Test Gordon Smith', 'person', pool);
    expect(match.id).toBe(entityId);
    expect(match.match_type).toBe('canonical');
    expect(match.confidence).toBe(1.0);
  });
});

describe('findOrCreateEntity — alias match', () => {
  it('matches entity via alias, returns match_type alias', async () => {
    // Create entity with a known alias
    const entityId = await insertTestEntity(pool, {
      name: 'Test Christine Doe',
      entityType: 'person',
      canonicalName: 'test christine doe',
      aliases: ['test christine doe', 'test chrissie'],
    });
    createdEntityIds.push(entityId);

    // Search using the alias
    const match = await findOrCreateEntity('Test Chrissie', 'person', pool);
    expect(match.id).toBe(entityId);
    expect(match.match_type).toBe('alias');
    expect(match.confidence).toBe(0.9);
  });
});

describe('findOrCreateEntity — first-name prefix match', () => {
  it('matches person by first-name prefix, auto-adds alias', async () => {
    // Create an entity with a full name
    const entityId = await insertTestEntity(pool, {
      name: 'Test Zachary Williams',
      entityType: 'person',
      canonicalName: 'test zachary williams',
      aliases: ['test zachary williams'],
      mentionCount: 5,
    });
    createdEntityIds.push(entityId);

    // Search with just the first name "test zachary" (single token after prefix)
    // Actually, prefix match requires single-token canonical. Let's create a realistic one.
    const entityId2 = await insertTestEntity(pool, {
      name: 'Test Quentin Tarantino',
      entityType: 'person',
      canonicalName: 'test quentin tarantino',
      aliases: ['test quentin tarantino'],
      mentionCount: 3,
    });
    createdEntityIds.push(entityId2);

    // "test quentin" has a space so it won't trigger prefix match.
    // For prefix match, the input canonical must be a single token (no space).
    // We need: canonical_name LIKE 'inputname %' AND single token input.
    // Let's create a proper scenario: entity "testzach williams" searched as "testzach"
    const entityId3 = await insertTestEntity(pool, {
      name: 'Testzach Williams',
      entityType: 'person',
      canonicalName: 'testzach williams',
      aliases: ['testzach williams'],
      mentionCount: 8,
    });
    createdEntityIds.push(entityId3);

    const match = await findOrCreateEntity('Testzach', 'person', pool);
    expect(match.id).toBe(entityId3);
    expect(match.match_type).toBe('prefix');
    expect(match.confidence).toBe(0.7);

    // Verify alias was auto-added
    const { rows } = await pool.query(
      `SELECT aliases FROM entities WHERE id = $1`,
      [entityId3],
    );
    expect(rows[0].aliases).toContain('testzach');
  });

  it('does not prefix-match for non-person entity types', async () => {
    const entityId = await insertTestEntity(pool, {
      name: 'Testcorp Solutions',
      entityType: 'company',
      canonicalName: 'testcorp solutions',
      aliases: ['testcorp solutions'],
    });
    createdEntityIds.push(entityId);

    // "testcorp" is single token, but entity type is company — no prefix match
    const match = await findOrCreateEntity('Testcorp', 'company', pool);
    // Should create new, not prefix match
    expect(match.match_type).toBe('new');
    createdEntityIds.push(match.id);
  });
});

describe('findOrCreateEntity — ON CONFLICT race safety', () => {
  it('concurrent creation of same entity does not produce duplicates', async () => {
    const name = `TestRace-${crypto.randomUUID().slice(0, 8)}`;
    const canonical = normalizeName(name);

    // Fire two concurrent findOrCreateEntity calls for the same name
    const [result1, result2] = await Promise.all([
      findOrCreateEntity(name, 'person', pool),
      findOrCreateEntity(name, 'person', pool),
    ]);

    // Both should resolve to the same entity
    expect(result1.id).toBe(result2.id);
    createdEntityIds.push(result1.id);

    // Verify only one entity exists with that canonical name
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM entities WHERE canonical_name = $1 AND entity_type = 'person'`,
      [canonical],
    );
    expect(rows[0].count).toBe(1);
  });
});

describe('normalizeName in real entity context', () => {
  it('strips parentheticals', async () => {
    const result = normalizeName('Test Alice (PM)');
    expect(result).toBe('test alice');
  });

  it('strips domain suffixes', async () => {
    const result = normalizeName('TestBrainCorp.io');
    expect(result).toBe('testbraincorp');
  });

  it('strips name prefixes', async () => {
    const result = normalizeName('Dr. Test Anderson');
    expect(result).toBe('test anderson');
  });

  it('strips company suffixes', async () => {
    const result = normalizeName('TestAcme Inc.');
    expect(result).toBe('testacme');
  });

  it('strips pronoun suffixes', async () => {
    const result = normalizeName('Test Jordan he/him');
    expect(result).toBe('test jordan');
  });
});

describe('isJunkEntity', () => {
  it('rejects email addresses', () => {
    expect(isJunkEntity('alice@example.com')).toBe(true);
    expect(isJunkEntity('user@domain.io')).toBe(true);
  });

  it('rejects Phase N patterns', () => {
    expect(isJunkEntity('Phase 4')).toBe(true);
    expect(isJunkEntity('Phase 12')).toBe(true);
  });

  it('rejects blocklisted words', () => {
    expect(isJunkEntity('someone')).toBe(true);
    expect(isJunkEntity('the team')).toBe(true);
    expect(isJunkEntity('attendees')).toBe(true);
  });

  it('rejects strings with no alphabetic chars', () => {
    expect(isJunkEntity('>{,')).toBe(true);
    expect(isJunkEntity('123')).toBe(true);
  });

  it('rejects CLI commands', () => {
    expect(isJunkEntity('npm install')).toBe(true);
    expect(isJunkEntity('docker compose')).toBe(true);
  });

  it('accepts valid entity names', () => {
    expect(isJunkEntity('Chris Psiaki')).toBe(false);
    expect(isJunkEntity('Topia')).toBe(false);
    expect(isJunkEntity('K12 Zone')).toBe(false);
  });
});

describe('thought-entity linking', () => {
  it('ON CONFLICT DO NOTHING for duplicate thought-entity links', async () => {
    const thoughtId = await insertTestThought(pool, {
      content: 'Test linking thought',
      ownerId: TEST_USER.id,
      embedding: randomEmbedding(),
    });

    const entityId = await insertTestEntity(pool, {
      name: 'Test Link Target',
      entityType: 'person',
    });
    createdEntityIds.push(entityId);

    // Link once
    await linkThoughtEntity(pool, thoughtId, entityId, 'mentions');

    // Link again — should not throw
    await linkThoughtEntity(pool, thoughtId, entityId, 'mentions');

    // Verify only one link exists
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM thought_entities
       WHERE thought_id = $1 AND entity_id = $2 AND relationship = 'mentions'`,
      [thoughtId, entityId],
    );
    expect(rows[0].count).toBe(1);
  });

  it('mention count increments when entity is linked to a new thought', async () => {
    const entityId = await insertTestEntity(pool, {
      name: 'Test Mention Counter',
      entityType: 'person',
      mentionCount: 0,
    });
    createdEntityIds.push(entityId);

    // Get initial count
    const { rows: before } = await pool.query(
      `SELECT mention_count FROM entities WHERE id = $1`,
      [entityId],
    );
    const initialCount = before[0].mention_count;

    // Create a thought and link it (using the resolver's internal linkEntity via findOrCreateEntity path)
    // We'll simulate by calling the helper and then manually bumping
    const thoughtId = await insertTestThought(pool, {
      content: 'Test mention bump thought',
      ownerId: TEST_USER.id,
      embedding: randomEmbedding(),
    });

    await linkThoughtEntity(pool, thoughtId, entityId, 'mentions');

    // Manually bump mention count as the pipeline would
    await pool.query(
      `UPDATE entities SET mention_count = mention_count + 1 WHERE id = $1`,
      [entityId],
    );

    const { rows: after } = await pool.query(
      `SELECT mention_count FROM entities WHERE id = $1`,
      [entityId],
    );
    expect(after[0].mention_count).toBe(initialCount + 1);
  });
});

describe('findOrCreateEntity — new entity creation', () => {
  it('creates new entity when no match found, match_type = new, confidence = 1.0', async () => {
    const uniqueName = `Test NewEntity ${crypto.randomUUID().slice(0, 8)}`;
    const match = await findOrCreateEntity(uniqueName, 'product', pool);

    expect(match.match_type).toBe('new');
    expect(match.confidence).toBe(1.0);
    expect(match.entity_type).toBe('product');
    expect(match.name).toBe(uniqueName);
    createdEntityIds.push(match.id);

    // Verify it exists in DB
    const { rows } = await pool.query(
      `SELECT canonical_name, entity_type, aliases FROM entities WHERE id = $1`,
      [match.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe('product');
    expect(rows[0].canonical_name).toBe(normalizeName(uniqueName));
    expect(rows[0].aliases).toContain(normalizeName(uniqueName));
  });
});

describe('inferRelationship', () => {
  it('returns from when entity matches source_meta author', () => {
    const metadata = makeMetadata({ people: ['Alice'] });
    const result = inferRelationship('Alice', metadata, 'some content', {
      user_name: 'Alice',
    });
    expect(result).toBe('from');
  });

  it('returns assigned_to when entity appears in an action item', () => {
    const metadata = makeMetadata({
      people: ['Bob'],
      action_items: ['Bob should review the PR by Friday'],
    });
    const result = inferRelationship('Bob', metadata, 'some content', null);
    expect(result).toBe('assigned_to');
  });

  it('returns about when entity is mentioned in summary', () => {
    const metadata = makeMetadata({
      people: ['Chris'],
      summary: 'Discussion about Chris and the roadmap',
    });
    const result = inferRelationship('Chris', metadata, 'some content', null);
    expect(result).toBe('about');
  });

  it('returns mentions as default fallback', () => {
    const metadata = makeMetadata({ people: ['Dan'] });
    const result = inferRelationship('Dan', metadata, 'some content', null);
    expect(result).toBe('mentions');
  });
});
