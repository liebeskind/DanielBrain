/**
 * Integration tests for hybrid_search() SQL function.
 *
 * Tests the 12-parameter hybrid search function that combines vector cosine similarity
 * and BM25 full-text search via Reciprocal Rank Fusion (RRF).
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 * Prereq: docker compose -f docker/docker-compose.test.yml up -d && npm run migrate (on test DB)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import {
  TEST_DB_URL, randomEmbedding,
  insertTestUser, insertTestThought, cleanupTestData,
} from './helpers.js';
import { buildVisibilityTags } from '../../src/user-context.js';

let pool: pg.Pool;

const ALICE = { id: crypto.randomUUID(), email: 'hs-alice@test.com', displayName: 'HS Alice', role: 'member' as const };
const BOB = { id: crypto.randomUUID(), email: 'hs-bob@test.com', displayName: 'HS Bob', role: 'member' as const };
const OWNER = { id: crypto.randomUUID(), email: 'hs-owner@test.com', displayName: 'HS Owner', role: 'owner' as const };

let aliceTags: string[];
let bobTags: string[];

// Store thought IDs
let thoughtAlicePrivate: string;
let thoughtBobPrivate: string;
let thoughtCompany: string;
let thoughtMeeting: string;
let thoughtOldNote: string;

/**
 * Create a deterministic embedding in a known region of vector space.
 * All test embeddings are clustered together so they rank highly when searched
 * with the same base embedding, even when other test files' thoughts exist.
 * The seed controls a small perturbation to avoid exact duplicates.
 */
function clusteredEmbedding(seed: number): string {
  // Base direction: first 10 dims positive, rest zero-ish
  const values = new Array(768).fill(0).map((_, i) => {
    if (i < 10) return 1.0 + seed * 0.001 * (i + 1);
    return seed * 0.0001 * Math.sin(i + seed);
  });
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  const normalized = values.map(v => v / norm);
  return `[${normalized.join(',')}]`;
}

/** The query embedding used for searches -- same cluster as our test thoughts */
const QUERY_EMBEDDING = clusteredEmbedding(0);

/** Helper to call hybrid_search with all 12 parameters */
async function callHybridSearch(params: {
  embedding?: string;
  queryText?: string;
  threshold?: number;
  matchCount?: number;
  filterType?: string | null;
  filterPerson?: string | null;
  filterTopic?: string | null;
  filterDays?: number | null;
  rrfK?: number;
  vectorWeight?: number;
  textWeight?: number;
  filterVisibility?: string[] | null;
}): Promise<any[]> {
  const {
    embedding = QUERY_EMBEDDING,
    queryText = '',
    threshold = -1.0,
    matchCount = 100,
    filterType = null,
    filterPerson = null,
    filterTopic = null,
    filterDays = null,
    rrfK = 60,
    vectorWeight = 1.0,
    textWeight = 1.0,
    filterVisibility = null,
  } = params;

  const { rows } = await pool.query(
    `SELECT * FROM hybrid_search($1::vector, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      embedding,
      queryText,
      threshold,
      matchCount,
      filterType,
      filterPerson,
      filterTopic,
      filterDays,
      rrfK,
      vectorWeight,
      textWeight,
      filterVisibility,
    ],
  );
  return rows;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 5 });
  await pool.query('SELECT 1');

  // Create test users
  for (const u of [ALICE, BOB, OWNER]) {
    await insertTestUser(pool, { id: u.id, email: u.email, displayName: u.displayName, role: u.role });
  }

  aliceTags = buildVisibilityTags({ userId: ALICE.id, role: 'member' });
  bobTags = buildVisibilityTags({ userId: BOB.id, role: 'member' });

  // Create thoughts with varied content and metadata.
  // All use clusteredEmbedding(N) so they are close to QUERY_EMBEDDING in vector space.

  thoughtAlicePrivate = await insertTestThought(pool, {
    content: 'Budget planning for Q2 revenue targets and forecasting spreadsheets',
    visibility: [`user:${ALICE.id}`],
    ownerId: ALICE.id,
    thoughtType: 'note',
    people: ['Alice', 'Chris'],
    topics: ['budget', 'Q2'],
    summary: 'Q2 budget planning discussion',
    embedding: clusteredEmbedding(1),
  });

  thoughtBobPrivate = await insertTestThought(pool, {
    content: 'Performance review feedback for the engineering team quarterly cycle',
    visibility: [`user:${BOB.id}`],
    ownerId: BOB.id,
    thoughtType: 'note',
    people: ['Bob'],
    topics: ['performance'],
    summary: 'Engineering performance review notes',
    embedding: clusteredEmbedding(2),
  });

  thoughtCompany = await insertTestThought(pool, {
    content: 'Company-wide product launch announcement for new features and integrations',
    visibility: ['company'],
    ownerId: OWNER.id,
    thoughtType: 'meeting',
    people: ['Daniel', 'Chris'],
    topics: ['product', 'launch'],
    summary: 'Product launch meeting',
    embedding: clusteredEmbedding(3),
  });

  thoughtMeeting = await insertTestThought(pool, {
    content: 'Meeting notes about the K12 Zone partnership strategy and roadmap',
    visibility: [`user:${ALICE.id}`, `user:${BOB.id}`],
    ownerId: ALICE.id,
    thoughtType: 'meeting',
    people: ['Alice', 'Bob'],
    topics: ['K12 Zone', 'strategy'],
    summary: 'K12 Zone partnership meeting',
    embedding: clusteredEmbedding(4),
  });

  // Old thought (created 90 days ago)
  thoughtOldNote = await insertTestThought(pool, {
    content: 'Old planning document from last year about infrastructure setup',
    visibility: ['company'],
    ownerId: OWNER.id,
    thoughtType: 'note',
    topics: ['planning'],
    embedding: clusteredEmbedding(5),
  });
  // Backdate it
  await pool.query(
    `UPDATE thoughts SET created_at = NOW() - INTERVAL '90 days' WHERE id = $1`,
    [thoughtOldNote],
  );
});

afterAll(async () => {
  await cleanupTestData(pool);
  await pool.end();
});

describe('hybrid_search() integration', () => {
  it('returns results with correct shape', async () => {
    const rows = await callHybridSearch({ queryText: 'budget' });
    // Should return at least the thought containing "budget"
    expect(rows.length).toBeGreaterThan(0);

    const row = rows[0];
    // Verify shape has all expected columns
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('content');
    expect(row).toHaveProperty('thought_type');
    expect(row).toHaveProperty('people');
    expect(row).toHaveProperty('topics');
    expect(row).toHaveProperty('action_items');
    expect(row).toHaveProperty('summary');
    expect(row).toHaveProperty('similarity');
    expect(row).toHaveProperty('parent_id');
    expect(row).toHaveProperty('chunk_index');
    expect(row).toHaveProperty('source');
    expect(row).toHaveProperty('created_at');

    // similarity is the RRF score, should be a positive number
    expect(typeof row.similarity).toBe('number');
    expect(row.similarity).toBeGreaterThan(0);
  });

  it('filters by visibility: Alice sees her private + company + shared, not Bob private', async () => {
    const rows = await callHybridSearch({
      filterVisibility: aliceTags,
    });
    const ids = rows.map((r: any) => r.id);

    expect(ids).toContain(thoughtAlicePrivate);
    expect(ids).toContain(thoughtCompany);
    expect(ids).toContain(thoughtMeeting);
    expect(ids).not.toContain(thoughtBobPrivate);
  });

  it('returns all thoughts when visibility is NULL (owner mode)', async () => {
    const rows = await callHybridSearch({
      filterVisibility: null,
    });
    const ids = rows.map((r: any) => r.id);

    // Owner sees everything
    expect(ids).toContain(thoughtAlicePrivate);
    expect(ids).toContain(thoughtBobPrivate);
    expect(ids).toContain(thoughtCompany);
    expect(ids).toContain(thoughtMeeting);
  });

  it('text search: BM25 matches on specific words', async () => {
    // "forecasting" appears only in Alice's private note
    const rows = await callHybridSearch({
      queryText: 'forecasting spreadsheets',
      filterVisibility: null,
    });
    const ids = rows.map((r: any) => r.id);

    // The thought containing "forecasting" should be in results
    expect(ids).toContain(thoughtAlicePrivate);
  });

  it('type filter: filter_type = note excludes meetings', async () => {
    const rows = await callHybridSearch({
      filterType: 'note',
      filterVisibility: null,
    });
    const types = rows.map((r: any) => r.thought_type);

    // All returned rows should be notes
    for (const t of types) {
      expect(t).toBe('note');
    }

    const ids = rows.map((r: any) => r.id);
    // Meeting thoughts should be excluded
    expect(ids).not.toContain(thoughtCompany); // meeting type
    expect(ids).not.toContain(thoughtMeeting); // meeting type
  });

  it('person filter: filter_person matches people array', async () => {
    const rows = await callHybridSearch({
      filterPerson: 'Daniel',
      filterVisibility: null,
    });
    const ids = rows.map((r: any) => r.id);

    // Only the company thought has "Daniel" in people
    expect(ids).toContain(thoughtCompany);
    // Thoughts without Daniel should not appear
    expect(ids).not.toContain(thoughtAlicePrivate); // has Alice, Chris
    expect(ids).not.toContain(thoughtBobPrivate); // has Bob
  });

  it('topic filter: filter_topic matches topics array', async () => {
    const rows = await callHybridSearch({
      filterTopic: 'K12 Zone',
      filterVisibility: null,
    });
    const ids = rows.map((r: any) => r.id);

    // Only the meeting thought has "K12 Zone" topic
    expect(ids).toContain(thoughtMeeting);
    expect(ids).not.toContain(thoughtAlicePrivate);
    expect(ids).not.toContain(thoughtCompany);
  });

  it('days filter: excludes old thoughts', async () => {
    const rows = await callHybridSearch({
      filterDays: 30,
      filterVisibility: null,
    });
    const ids = rows.map((r: any) => r.id);

    // The old note (90 days ago) should be excluded
    expect(ids).not.toContain(thoughtOldNote);
    // Recent thoughts should still be there
    expect(ids).toContain(thoughtCompany);
  });

  it('combined filters: type + person + visibility simultaneously', async () => {
    // Alice searching for meetings involving Chris
    const rows = await callHybridSearch({
      filterType: 'meeting',
      filterPerson: 'Chris',
      filterVisibility: aliceTags,
    });
    const ids = rows.map((r: any) => r.id);

    // Only the company meeting has Chris and is a meeting and visible to Alice
    expect(ids).toContain(thoughtCompany);
    // Alice's private note has Chris but is a 'note', not 'meeting'
    expect(ids).not.toContain(thoughtAlicePrivate);
    // Bob's private is not visible to Alice
    expect(ids).not.toContain(thoughtBobPrivate);
  });

  it('empty query text: graceful degradation (no error)', async () => {
    // Empty string should not cause an error — falls back to vector-only
    const rows = await callHybridSearch({
      queryText: '',
      filterVisibility: null,
    });
    // Should still return results via vector path
    expect(rows.length).toBeGreaterThan(0);
  });

  it('stop-word-only query: graceful degradation', async () => {
    // "the a an" are English stop words, plainto_tsquery returns empty/NULL
    const rows = await callHybridSearch({
      queryText: 'the a an',
      filterVisibility: null,
    });
    // Should not error, may return results via vector path
    expect(Array.isArray(rows)).toBe(true);
  });

  it('results are ordered by rrf_score descending', async () => {
    const rows = await callHybridSearch({
      queryText: 'product launch',
      filterVisibility: null,
    });

    if (rows.length >= 2) {
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].similarity).toBeGreaterThanOrEqual(rows[i].similarity);
      }
    }
  });

  it('parent thoughts have parent_id = NULL', async () => {
    const rows = await callHybridSearch({
      filterVisibility: null,
    });

    // Our test thoughts are all top-level (no parent), so parent_id should be null
    const testIds = new Set([
      thoughtAlicePrivate, thoughtBobPrivate, thoughtCompany, thoughtMeeting, thoughtOldNote,
    ]);
    for (const row of rows) {
      if (testIds.has(row.id)) {
        expect(row.parent_id).toBeNull();
      }
    }
  });
});
