import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { buildVisibilityTags, resolveUserFromApiKey, resolveUserFromEmail, generateApiKey, SYSTEM_USER } from '../src/user-context.js';

const mockPool = {
  query: vi.fn(),
};

describe('buildVisibilityTags', () => {
  it('returns company + user tag for member', () => {
    const tags = buildVisibilityTags({ userId: 'u1', role: 'member' });
    expect(tags).toContain('company');
    expect(tags).toContain('user:u1');
    expect(tags).not.toContain('owner');
  });

  it('returns company + user tag for admin', () => {
    const tags = buildVisibilityTags({ userId: 'u2', role: 'admin' });
    expect(tags).toContain('company');
    expect(tags).toContain('user:u2');
  });

  it('returns empty array for owner (no filtering)', () => {
    const tags = buildVisibilityTags({ userId: 'u3', role: 'owner' });
    expect(tags).toEqual([]);
  });
});

describe('SYSTEM_USER', () => {
  it('has owner role and empty visibility tags', () => {
    expect(SYSTEM_USER.role).toBe('owner');
    expect(SYSTEM_USER.visibilityTags).toEqual([]);
    expect(SYSTEM_USER.email).toBe('system@internal');
  });
});

describe('resolveUserFromApiKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for empty key', async () => {
    expect(await resolveUserFromApiKey('', mockPool as any)).toBeNull();
  });

  it('resolves user from valid key hash', async () => {
    const rawKey = 'a'.repeat(64);
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    // First call: resolve key → user
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'u1', email: 'alice@test.com', display_name: 'Alice', role: 'member' }],
    });
    // Second call: update last_used (fire-and-forget)
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const user = await resolveUserFromApiKey(rawKey, mockPool as any);

    expect(user).not.toBeNull();
    expect(user!.userId).toBe('u1');
    expect(user!.email).toBe('alice@test.com');
    expect(user!.role).toBe('member');
    expect(user!.visibilityTags).toContain('company');
    expect(user!.visibilityTags).toContain('user:u1');

    // Verify hash was used in query
    expect(mockPool.query.mock.calls[0][1][0]).toBe(keyHash);
  });

  it('returns null when key not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const user = await resolveUserFromApiKey('invalid-key', mockPool as any);
    expect(user).toBeNull();
  });

  it('returns null when user is inactive (active=false in users table)', async () => {
    // The SQL query JOINs users WHERE active=true, so an inactive user means
    // the JOIN returns no rows even though the key hash exists in access_keys.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const user = await resolveUserFromApiKey('valid-key-inactive-user', mockPool as any);
    expect(user).toBeNull();
  });

  it('returns null when key is inactive (active=false in access_keys table)', async () => {
    // The SQL query filters WHERE ak.active = true, so an inactive key
    // returns no rows even though the user exists.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const user = await resolveUserFromApiKey('inactive-key', mockPool as any);
    expect(user).toBeNull();
  });

  it('fires last_used update as fire-and-forget', async () => {
    const rawKey = 'b'.repeat(64);
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'u5', email: 'eve@test.com', display_name: 'Eve', role: 'member' }],
      })
      // The last_used update is fire-and-forget; even if it rejects, resolveUserFromApiKey should still return
      .mockRejectedValueOnce(new Error('last_used update failed'));

    const user = await resolveUserFromApiKey(rawKey, mockPool as any);

    // User should be resolved despite the fire-and-forget failure
    expect(user).not.toBeNull();
    expect(user!.userId).toBe('u5');
    // Verify update last_used was called
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    expect(mockPool.query.mock.calls[1][0]).toContain('last_used');
  });
});

describe('resolveUserFromEmail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for empty email', async () => {
    expect(await resolveUserFromEmail('', mockPool as any)).toBeNull();
  });

  it('resolves user by email', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'u2', email: 'bob@test.com', display_name: 'Bob', role: 'admin' }],
    });

    const user = await resolveUserFromEmail('Bob@Test.com', mockPool as any);
    expect(user!.userId).toBe('u2');
    expect(user!.role).toBe('admin');

    // Verify lowercase email
    expect(mockPool.query.mock.calls[0][1][0]).toBe('bob@test.com');
  });
});

describe('generateApiKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates 64-char hex key and stores hash', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'key-1' }] });

    const { rawKey, keyId } = await generateApiKey('u1', 'test key', mockPool as any);

    expect(rawKey).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(rawKey)).toBe(true);
    expect(keyId).toBe('key-1');

    // Verify hash is stored, not raw key
    const storedHash = mockPool.query.mock.calls[0][1][1];
    const expectedHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    expect(storedHash).toBe(expectedHash);
    expect(storedHash).not.toBe(rawKey);
  });

  it('stores the key with the correct user_id and name', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'key-42' }] });

    await generateApiKey('user-abc', 'My CLI Key', mockPool as any);

    const insertCall = mockPool.query.mock.calls[0];
    const sql = insertCall[0];
    const params = insertCall[1];

    // Verify SQL inserts into access_keys with correct positional params
    expect(sql).toContain('INSERT INTO access_keys');
    expect(params[0]).toBe('My CLI Key');    // $1 = name
    // params[1] is the hash (tested above)
    expect(params[2]).toBe('user-abc');      // $3 = user_id
  });

  it('returns unique keys on successive calls', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'key-1' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'key-2' }] });

    const first = await generateApiKey('u1', 'key1', mockPool as any);
    const second = await generateApiKey('u1', 'key2', mockPool as any);

    expect(first.rawKey).not.toBe(second.rawKey);
  });
});
