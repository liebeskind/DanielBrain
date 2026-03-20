/**
 * Integration tests for Phase 9 visibility enforcement.
 *
 * These tests run against a real PostgreSQL database (docker-compose.test.yml on port 5433).
 * They verify that visibility filtering works correctly at the SQL level — the critical
 * security boundary that unit tests with mocked pools cannot validate.
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 * Prereq: docker compose -f docker/docker-compose.test.yml up -d && npm run migrate (on test DB)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { buildVisibilityTags } from '../../src/user-context.js';

const TEST_DB_URL = 'postgresql://danielbrain_test:test_password@localhost:5433/danielbrain_test';

let pool: pg.Pool;

// Test users
const USER_ALICE = { id: crypto.randomUUID(), email: 'alice@test.com', displayName: 'Alice', role: 'member' as const };
const USER_BOB = { id: crypto.randomUUID(), email: 'bob@test.com', displayName: 'Bob', role: 'member' as const };
const USER_OWNER = { id: crypto.randomUUID(), email: 'owner@test.com', displayName: 'Owner', role: 'owner' as const };

// Visibility tags for each user
const ALICE_TAGS = buildVisibilityTags({ userId: USER_ALICE.id, role: 'member' });
const BOB_TAGS = buildVisibilityTags({ userId: USER_BOB.id, role: 'member' });
const OWNER_TAGS = buildVisibilityTags({ userId: USER_OWNER.id, role: 'owner' });

// Test thought IDs (filled during setup)
let thoughtPrivateAlice: string;
let thoughtPrivateBob: string;
let thoughtCompany: string;
let thoughtSharedAliceBob: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 5 });

  // Verify DB connectivity
  await pool.query('SELECT 1');

  // Create test users
  for (const user of [USER_ALICE, USER_BOB, USER_OWNER]) {
    await pool.query(
      `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET id = EXCLUDED.id, display_name = EXCLUDED.display_name, role = EXCLUDED.role`,
      [user.id, user.email, user.displayName, user.role],
    );
  }

  // Create a dummy embedding (768 zeros) for test thoughts
  const dummyEmbedding = `[${new Array(768).fill(0).join(',')}]`;

  // Create thoughts with different visibility
  const insertThought = async (content: string, visibility: string[], ownerId: string): Promise<string> => {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, embedding, source, visibility, owner_id, thought_type, people, topics, action_items, processed_at)
       VALUES ($1, $2::vector, 'test', $3, $4, 'note', '{}', '{}', '{}', NOW())
       RETURNING id`,
      [content, dummyEmbedding, visibility, ownerId],
    );
    return rows[0].id;
  };

  thoughtPrivateAlice = await insertThought(
    'Alice private note about Q2 budget planning',
    [`user:${USER_ALICE.id}`],
    USER_ALICE.id,
  );

  thoughtPrivateBob = await insertThought(
    'Bob private note about performance reviews',
    [`user:${USER_BOB.id}`],
    USER_BOB.id,
  );

  thoughtCompany = await insertThought(
    'Company-wide announcement about product launch',
    ['company'],
    USER_OWNER.id,
  );

  thoughtSharedAliceBob = await insertThought(
    'Shared meeting notes between Alice and Bob',
    [`user:${USER_ALICE.id}`, `user:${USER_BOB.id}`],
    USER_ALICE.id,
  );
});

afterAll(async () => {
  // Clean up test data
  await pool.query(`DELETE FROM thoughts WHERE source = 'test'`);
  await pool.query(`DELETE FROM users WHERE email LIKE '%@test.com'`);
  await pool.end();
});

describe('Visibility filtering (SQL level)', () => {
  it('Alice can see her own private thoughts', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE visibility && $1 AND source = 'test'`,
      [ALICE_TAGS],
    );
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain(thoughtPrivateAlice);
    expect(ids).toContain(thoughtCompany); // company-wide
    expect(ids).toContain(thoughtSharedAliceBob); // shared with her
  });

  it('Alice CANNOT see Bob private thoughts', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE visibility && $1 AND source = 'test'`,
      [ALICE_TAGS],
    );
    const ids = rows.map((r: any) => r.id);
    expect(ids).not.toContain(thoughtPrivateBob);
  });

  it('Bob can see his own private thoughts but not Alice private', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE visibility && $1 AND source = 'test'`,
      [BOB_TAGS],
    );
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain(thoughtPrivateBob);
    expect(ids).toContain(thoughtCompany);
    expect(ids).toContain(thoughtSharedAliceBob);
    expect(ids).not.toContain(thoughtPrivateAlice);
  });

  it('Owner sees ALL thoughts (empty tags = no filtering)', async () => {
    // Owner tags are empty, meaning no filtering. Test with NULL.
    expect(OWNER_TAGS).toEqual([]);

    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE ($1::text[] IS NULL OR visibility && $1) AND source = 'test'`,
      [null], // owner = no filtering
    );
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain(thoughtPrivateAlice);
    expect(ids).toContain(thoughtPrivateBob);
    expect(ids).toContain(thoughtCompany);
    expect(ids).toContain(thoughtSharedAliceBob);
  });

  it('Company-tagged thoughts are visible to all members', async () => {
    for (const tags of [ALICE_TAGS, BOB_TAGS]) {
      const { rows } = await pool.query(
        `SELECT id FROM thoughts WHERE visibility && $1 AND id = $2`,
        [tags, thoughtCompany],
      );
      expect(rows).toHaveLength(1);
    }
  });
});

describe('hybrid_search visibility parameter', () => {
  it('filters results by visibility when parameter is provided', async () => {
    // Use a zero embedding for cosine similarity (will match all equally)
    const queryEmbedding = `[${new Array(768).fill(0).join(',')}]`;

    const { rows } = await pool.query(
      `SELECT * FROM hybrid_search($1::vector, 'budget', 0.0, 100, NULL, NULL, NULL, NULL, 60, 1.0, 1.0, $2)`,
      [queryEmbedding, ALICE_TAGS],
    );

    const ids = rows.map((r: any) => r.id);
    // Alice should see her private + company + shared, not Bob's private
    expect(ids).not.toContain(thoughtPrivateBob);
  });

  it('returns all results when visibility is NULL', async () => {
    const queryEmbedding = `[${new Array(768).fill(0).join(',')}]`;

    const { rows } = await pool.query(
      `SELECT * FROM hybrid_search($1::vector, 'note', 0.0, 100, NULL, NULL, NULL, NULL, 60, 1.0, 1.0, NULL)`,
      [queryEmbedding],
    );

    const ids = rows.map((r: any) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });
});

describe('User context and API key resolution', () => {
  it('generates and resolves API keys linked to users', async () => {
    // Generate a key for Alice
    const rawKey = crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    await pool.query(
      `INSERT INTO access_keys (name, key_hash, user_id, scopes) VALUES ('test-key', $1, $2, '{owner}')`,
      [keyHash, USER_ALICE.id],
    );

    // Resolve key back to user
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role
       FROM access_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.key_hash = $1 AND ak.active = true AND u.active = true`,
      [keyHash],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(USER_ALICE.id);
    expect(rows[0].email).toBe('alice@test.com');

    // Clean up
    await pool.query(`DELETE FROM access_keys WHERE key_hash = $1`, [keyHash]);
  });
});

describe('Audit logging', () => {
  it('writes audit entries to the database', async () => {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'search', 'thought', $2, $3)`,
      [USER_ALICE.id, thoughtCompany, JSON.stringify({ query: 'test', resultCount: 3 })],
    );

    const { rows } = await pool.query(
      `SELECT * FROM audit_log WHERE user_id = $1 AND action = 'search'`,
      [USER_ALICE.id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].resource_type).toBe('thought');
    expect(rows[0].metadata.query).toBe('test');

    // Clean up
    await pool.query(`DELETE FROM audit_log WHERE user_id = $1`, [USER_ALICE.id]);
  });
});

describe('Thought sharing', () => {
  it('can promote visibility by appending tags', async () => {
    // Alice's private thought — initially only visible to her
    const { rows: before } = await pool.query(
      `SELECT id FROM thoughts WHERE id = $1 AND visibility && $2`,
      [thoughtPrivateAlice, BOB_TAGS],
    );
    expect(before).toHaveLength(0); // Bob can't see it

    // Share with Bob
    await pool.query(
      `UPDATE thoughts SET visibility = array_append(visibility, $1) WHERE id = $2`,
      [`user:${USER_BOB.id}`, thoughtPrivateAlice],
    );

    // Record share
    await pool.query(
      `INSERT INTO thought_shares (thought_id, shared_by, visibility_added) VALUES ($1, $2, $3)`,
      [thoughtPrivateAlice, USER_ALICE.id, `user:${USER_BOB.id}`],
    );

    // Now Bob can see it
    const { rows: after } = await pool.query(
      `SELECT id FROM thoughts WHERE id = $1 AND visibility && $2`,
      [thoughtPrivateAlice, BOB_TAGS],
    );
    expect(after).toHaveLength(1);

    // Revert for other tests
    await pool.query(
      `UPDATE thoughts SET visibility = array_remove(visibility, $1) WHERE id = $2`,
      [`user:${USER_BOB.id}`, thoughtPrivateAlice],
    );
    await pool.query(`DELETE FROM thought_shares WHERE thought_id = $1`, [thoughtPrivateAlice]);
  });
});
