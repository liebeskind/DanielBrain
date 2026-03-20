import pg from 'pg';
import crypto from 'node:crypto';

export const TEST_DB_URL = 'postgresql://danielbrain_test:test_password@localhost:5433/danielbrain_test';

/** Create a 768-dim zero vector string for SQL */
export function dummyEmbedding(): string {
  return `[${new Array(768).fill(0).join(',')}]`;
}

/** Create a random 768-dim vector string for SQL (to differentiate results) */
export function randomEmbedding(): string {
  const values = new Array(768).fill(0).map(() => (Math.random() * 2 - 1) * 0.1);
  // Normalize to unit vector
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  const normalized = norm > 0 ? values.map(v => v / norm) : values;
  return `[${normalized.join(',')}]`;
}

/** Insert a test user and return their ID */
export async function insertTestUser(
  pool: pg.Pool,
  overrides: { email?: string; displayName?: string; role?: string; id?: string } = {},
): Promise<{ id: string; email: string; role: string }> {
  const id = overrides.id || crypto.randomUUID();
  const email = overrides.email || `test-${id.slice(0, 8)}@test.com`;
  const displayName = overrides.displayName || 'Test User';
  const role = overrides.role || 'member';

  await pool.query(
    `INSERT INTO users (id, email, display_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET id = EXCLUDED.id, role = EXCLUDED.role`,
    [id, email, displayName, role],
  );

  return { id, email, role };
}

/** Insert a test thought with minimal required fields */
export async function insertTestThought(
  pool: pg.Pool,
  overrides: {
    content?: string;
    visibility?: string[];
    ownerId?: string;
    source?: string;
    thoughtType?: string;
    embedding?: string;
    summary?: string;
    people?: string[];
    topics?: string[];
    actionItems?: string[];
    sourceId?: string;
  } = {},
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, embedding, source, visibility, owner_id, thought_type, people, topics, action_items, summary, source_id, processed_at)
     VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     RETURNING id`,
    [
      overrides.content || 'Test thought content',
      overrides.embedding || dummyEmbedding(),
      overrides.source || 'test',
      overrides.visibility || ['company'],
      overrides.ownerId || null,
      overrides.thoughtType || 'note',
      overrides.people || '{}',
      overrides.topics || '{}',
      overrides.actionItems || '{}',
      overrides.summary || null,
      overrides.sourceId || null,
    ],
  );
  return rows[0].id;
}

/** Insert a test entity */
export async function insertTestEntity(
  pool: pg.Pool,
  overrides: {
    name?: string;
    entityType?: string;
    canonicalName?: string;
    aliases?: string[];
    mentionCount?: number;
    profileSummary?: string;
    embedding?: string;
  } = {},
): Promise<string> {
  const name = overrides.name || 'Test Entity';
  const canonicalName = overrides.canonicalName || name.toLowerCase().trim();
  const { rows } = await pool.query(
    `INSERT INTO entities (name, entity_type, canonical_name, aliases, mention_count, profile_summary, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
     ON CONFLICT (canonical_name, entity_type) DO UPDATE SET
       mention_count = COALESCE($5, entities.mention_count),
       name = EXCLUDED.name
     RETURNING id`,
    [
      name,
      overrides.entityType || 'person',
      canonicalName,
      overrides.aliases || [canonicalName],
      overrides.mentionCount || 1,
      overrides.profileSummary || null,
      overrides.embedding || null,
    ],
  );
  return rows[0].id;
}

/** Link a thought to an entity */
export async function linkThoughtEntity(
  pool: pg.Pool,
  thoughtId: string,
  entityId: string,
  relationship: string = 'mentions',
): Promise<void> {
  await pool.query(
    `INSERT INTO thought_entities (thought_id, entity_id, relationship, confidence)
     VALUES ($1, $2, $3, 1.0)
     ON CONFLICT DO NOTHING`,
    [thoughtId, entityId, relationship],
  );
}

/** Create an entity relationship edge */
export async function insertEntityRelationship(
  pool: pg.Pool,
  sourceId: string,
  targetId: string,
  overrides: {
    relationship?: string;
    weight?: number;
    description?: string;
    sourceThoughtIds?: string[];
  } = {},
): Promise<void> {
  // Canonical direction
  const [s, t] = sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];
  await pool.query(
    `INSERT INTO entity_relationships (source_id, target_id, relationship, weight, description, source_thought_ids)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id, target_id, relationship) DO UPDATE SET
       weight = $4, description = COALESCE($5, entity_relationships.description)`,
    [
      s, t,
      overrides.relationship || 'co_occurs',
      overrides.weight || 1,
      overrides.description || null,
      overrides.sourceThoughtIds || '{}',
    ],
  );
}

/** Insert a proposal */
export async function insertTestProposal(
  pool: pg.Pool,
  overrides: {
    proposalType?: string;
    entityId?: string;
    title?: string;
    proposedData?: Record<string, unknown>;
    status?: string;
    autoApplied?: boolean;
  } = {},
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO proposals (proposal_type, entity_id, title, proposed_data, status, auto_applied, source)
     VALUES ($1, $2, $3, $4, $5::proposal_status, $6, 'test')
     RETURNING id`,
    [
      overrides.proposalType || 'entity_link',
      overrides.entityId || null,
      overrides.title || 'Test proposal',
      JSON.stringify(overrides.proposedData || {}),
      overrides.status || 'pending',
      overrides.autoApplied || false,
    ],
  );
  return rows[0].id;
}

/** Generate an API key for a user (returns raw key and hash) */
export async function insertTestApiKey(
  pool: pg.Pool,
  userId: string,
  overrides: { name?: string; active?: boolean } = {},
): Promise<{ rawKey: string; keyHash: string; keyId: string }> {
  const rawKey = crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const { rows } = await pool.query(
    `INSERT INTO access_keys (name, key_hash, user_id, scopes, active)
     VALUES ($1, $2, $3, '{read,write}', $4)
     RETURNING id`,
    [overrides.name || 'test-key', keyHash, userId, overrides.active !== false],
  );
  return { rawKey, keyHash, keyId: rows[0].id };
}

/** Clean up all test data (use in afterAll) */
export async function cleanupTestData(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM thought_shares WHERE thought_id IN (SELECT id FROM thoughts WHERE source = 'test')`);
  await pool.query(`DELETE FROM thought_entities WHERE thought_id IN (SELECT id FROM thoughts WHERE source = 'test')`);
  await pool.query(`DELETE FROM thoughts WHERE source = 'test'`);
  await pool.query(`DELETE FROM entity_relationships WHERE source_id IN (SELECT id FROM entities WHERE name LIKE 'Test%')`);
  await pool.query(`DELETE FROM entity_communities WHERE entity_id IN (SELECT id FROM entities WHERE name LIKE 'Test%')`);
  await pool.query(`DELETE FROM entities WHERE name LIKE 'Test%'`);
  await pool.query(`DELETE FROM proposals WHERE source = 'test'`);
  await pool.query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@test.com')`);
  await pool.query(`DELETE FROM access_keys WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@test.com')`);
  await pool.query(`DELETE FROM users WHERE email LIKE '%@test.com'`);
}

/** Create a pool connected to the test DB */
export function createTestPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DB_URL, max: 5 });
}
