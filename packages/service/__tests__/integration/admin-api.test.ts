/**
 * Integration tests for admin user management API.
 *
 * These tests run against a real PostgreSQL database (docker-compose.test.yml on port 5433).
 * They verify HTTP routes for user CRUD and API key management via supertest.
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 * Prereq: docker compose -f docker/docker-compose.test.yml up -d
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import express from 'express';
import request from 'supertest';
import { createUserRoutes } from '../../src/admin/user-routes.js';
import { createTestPool, cleanupTestData, TEST_DB_URL } from './helpers.js';

let pool: pg.Pool;
let app: express.Express;

// Track created user IDs for cleanup
const createdUserIds: string[] = [];

beforeAll(async () => {
  pool = createTestPool();
  await pool.query('SELECT 1');

  // Build minimal Express app with user routes
  app = express();
  app.use(express.json());
  app.use('/api/users', createUserRoutes(pool));
});

afterAll(async () => {
  // Clean up users created during tests
  for (const id of createdUserIds) {
    await pool.query(`DELETE FROM audit_log WHERE user_id = $1 OR metadata->>'for_user' = $1::text`, [id]);
    await pool.query(`DELETE FROM access_keys WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// POST /api/users (create user)
// ---------------------------------------------------------------------------

describe('POST /api/users', () => {
  it('creates a user with valid input and returns correct shape', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({
        email: 'admin-test-create@test.com',
        display_name: 'Admin Test User',
        role: 'member',
      })
      .expect(200);

    expect(res.body.id).toBeDefined();
    expect(res.body.email).toBe('admin-test-create@test.com');
    expect(res.body.display_name).toBe('Admin Test User');
    expect(res.body.role).toBe('member');
    expect(res.body.active).toBe(true);
    expect(res.body.created_at).toBeDefined();
    createdUserIds.push(res.body.id);
  });

  it('defaults role to member when not specified', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({
        email: 'admin-test-default-role@test.com',
        display_name: 'Default Role User',
      })
      .expect(200);

    expect(res.body.role).toBe('member');
    createdUserIds.push(res.body.id);
  });

  it('returns 400 for missing email', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({ display_name: 'No Email' })
      .expect(400);

    expect(res.body.error).toMatch(/email/i);
  });

  it('returns 400 for invalid email (no @)', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({ email: 'not-an-email', display_name: 'Bad Email' })
      .expect(400);

    expect(res.body.error).toMatch(/email/i);
  });

  it('returns 400 for missing display_name', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({ email: 'admin-test-noname@test.com' })
      .expect(400);

    expect(res.body.error).toMatch(/display_name/i);
  });

  it('returns 409 for duplicate email', async () => {
    // First create a user
    const first = await request(app)
      .post('/api/users')
      .send({
        email: 'admin-test-dup@test.com',
        display_name: 'Original',
      })
      .expect(200);
    createdUserIds.push(first.body.id);

    // Try creating another with the same email
    const res = await request(app)
      .post('/api/users')
      .send({
        email: 'admin-test-dup@test.com',
        display_name: 'Duplicate',
      })
      .expect(409);

    expect(res.body.error).toMatch(/already exists/i);
  });

  it('returns 400 for invalid role', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({
        email: 'admin-test-badrole@test.com',
        display_name: 'Bad Role',
        role: 'superadmin',
      })
      .expect(400);

    expect(res.body.error).toMatch(/role/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/users (list users)
// ---------------------------------------------------------------------------

describe('GET /api/users', () => {
  it('returns a list including created users', async () => {
    const res = await request(app)
      .get('/api/users')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);

    // Verify shape of each user
    const first = res.body[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('email');
    expect(first).toHaveProperty('display_name');
    expect(first).toHaveProperty('role');
    expect(first).toHaveProperty('active');
    expect(first).toHaveProperty('created_at');
    expect(first).toHaveProperty('active_key_count');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id (update user)
// ---------------------------------------------------------------------------

describe('PATCH /api/users/:id', () => {
  let targetUserId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/users')
      .send({
        email: 'admin-test-patch@test.com',
        display_name: 'Patch Target',
        role: 'member',
      });
    targetUserId = res.body.id;
    createdUserIds.push(targetUserId);
  });

  it('updates role successfully', async () => {
    const res = await request(app)
      .patch(`/api/users/${targetUserId}`)
      .send({ role: 'admin' })
      .expect(200);

    expect(res.body.role).toBe('admin');
    expect(res.body.id).toBe(targetUserId);
  });

  it('updates display_name', async () => {
    const res = await request(app)
      .patch(`/api/users/${targetUserId}`)
      .send({ display_name: 'Updated Name' })
      .expect(200);

    expect(res.body.display_name).toBe('Updated Name');
  });

  it('returns 400 for empty update body', async () => {
    const res = await request(app)
      .patch(`/api/users/${targetUserId}`)
      .send({})
      .expect(400);

    expect(res.body.error).toMatch(/no fields/i);
  });

  it('returns 400 for invalid role', async () => {
    const res = await request(app)
      .patch(`/api/users/${targetUserId}`)
      .send({ role: 'superadmin' })
      .expect(400);

    expect(res.body.error).toMatch(/role/i);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await request(app)
      .patch(`/api/users/00000000-0000-0000-0000-000000000099`)
      .send({ role: 'admin' })
      .expect(404);

    expect(res.body.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/users/:id/keys (generate API key)
// ---------------------------------------------------------------------------

describe('POST /api/users/:id/keys', () => {
  let keyUserId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/users')
      .send({
        email: 'admin-test-keys@test.com',
        display_name: 'Key Target',
      });
    keyUserId = res.body.id;
    createdUserIds.push(keyUserId);
  });

  it('generates an API key and returns raw_key', async () => {
    const res = await request(app)
      .post(`/api/users/${keyUserId}/keys`)
      .send({ name: 'Test Key' })
      .expect(200);

    expect(res.body.key_id).toBeDefined();
    expect(res.body.raw_key).toBeDefined();
    expect(typeof res.body.raw_key).toBe('string');
    expect(res.body.raw_key.length).toBe(64); // 32 bytes hex-encoded
    expect(res.body.message).toMatch(/save this key/i);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await request(app)
      .post(`/api/users/00000000-0000-0000-0000-000000000099/keys`)
      .send({ name: 'Ghost Key' })
      .expect(404);

    expect(res.body.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/:id/keys (list keys)
// ---------------------------------------------------------------------------

describe('GET /api/users/:id/keys', () => {
  let listKeyUserId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/users')
      .send({
        email: 'admin-test-listkeys@test.com',
        display_name: 'List Keys Target',
      });
    listKeyUserId = res.body.id;
    createdUserIds.push(listKeyUserId);

    // Generate 2 keys
    await request(app).post(`/api/users/${listKeyUserId}/keys`).send({ name: 'Key A' });
    await request(app).post(`/api/users/${listKeyUserId}/keys`).send({ name: 'Key B' });
  });

  it('returns keys for a user', async () => {
    const res = await request(app)
      .get(`/api/users/${listKeyUserId}/keys`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);

    const first = res.body[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('active');
    expect(first).toHaveProperty('scopes');
    expect(first).toHaveProperty('created_at');
    // raw_key should NOT be returned in list (security)
    expect(first.raw_key).toBeUndefined();
    expect(first.key_hash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/users/:userId/keys/:keyId (deactivate key)
// ---------------------------------------------------------------------------

describe('DELETE /api/users/:userId/keys/:keyId', () => {
  let deactivateUserId: string;
  let deactivateKeyId: string;

  beforeAll(async () => {
    const userRes = await request(app)
      .post('/api/users')
      .send({
        email: 'admin-test-deactivate@test.com',
        display_name: 'Deactivate Target',
      });
    deactivateUserId = userRes.body.id;
    createdUserIds.push(deactivateUserId);

    const keyRes = await request(app)
      .post(`/api/users/${deactivateUserId}/keys`)
      .send({ name: 'To Deactivate' });
    deactivateKeyId = keyRes.body.key_id;
  });

  it('deactivates an API key', async () => {
    const res = await request(app)
      .delete(`/api/users/${deactivateUserId}/keys/${deactivateKeyId}`)
      .expect(200);

    expect(res.body.ok).toBe(true);

    // Verify key is now inactive
    const { rows } = await pool.query(
      `SELECT active FROM access_keys WHERE id = $1`,
      [deactivateKeyId],
    );
    expect(rows[0].active).toBe(false);
  });

  it('returns 404 for already deactivated / non-existent key', async () => {
    const res = await request(app)
      .delete(`/api/users/${deactivateUserId}/keys/00000000-0000-0000-0000-000000000099`)
      .expect(404);

    expect(res.body.error).toMatch(/not found/i);
  });
});
