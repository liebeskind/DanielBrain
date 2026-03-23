import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUserRoutes } from '../../src/admin/user-routes.js';

vi.mock('../../src/user-context.js', () => ({
  generateApiKey: vi.fn().mockResolvedValue({ rawKey: 'a'.repeat(64), keyId: 'key-1' }),
}));
vi.mock('../../src/audit.js', () => ({
  logAudit: vi.fn(),
  getClientIp: vi.fn(() => null),
}));
vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })) },
  createChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));

const mockPool = { query: vi.fn() };

/** Helper: build a mock Express Request */
function mockReq(overrides: Record<string, any> = {}) {
  return {
    body: {},
    params: {},
    headers: {},
    userContext: undefined,
    ...overrides,
  };
}

/** Helper: build a mock Express Response with chainable status/json */
function mockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
  };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((data: any) => { res.body = data; return res; });
  return res;
}

describe('createUserRoutes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a router with routes', () => {
    const router = createUserRoutes(mockPool as any);
    expect(router).toBeDefined();
    // Router has .stack with route definitions
    expect(router.stack.length).toBeGreaterThan(0);
  });
});

describe('GET / (list users)', () => {
  let handler: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const router = createUserRoutes(mockPool as any);
    // Find the GET / handler in the router stack
    const layer = router.stack.find(
      (l: any) => l.route?.path === '/' && l.route?.methods?.get,
    );
    handler = layer?.route?.stack[0]?.handle;
  });

  it('returns list of users', async () => {
    const users = [
      { id: 'u1', email: 'a@test.com', display_name: 'Alice', role: 'member', active_key_count: 1 },
    ];
    mockPool.query.mockResolvedValueOnce({ rows: users });
    const req = mockReq();
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(users);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('returns 500 on database error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPool.query.mockRejectedValueOnce(new Error('connection lost'));
    const req = mockReq();
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal error' });
    consoleSpy.mockRestore();
  });
});

describe('POST / (create user)', () => {
  let handler: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const router = createUserRoutes(mockPool as any);
    const layer = router.stack.find(
      (l: any) => l.route?.path === '/' && l.route?.methods?.post,
    );
    handler = layer?.route?.stack[0]?.handle;
  });

  it('creates a user with valid input', async () => {
    const createdUser = {
      id: 'u1', email: 'alice@test.com', display_name: 'Alice', role: 'member',
      active: true, created_at: new Date(),
    };
    mockPool.query.mockResolvedValueOnce({ rows: [createdUser] });
    const req = mockReq({ body: { email: 'alice@test.com', display_name: 'Alice' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(createdUser);
    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toBe('alice@test.com'); // lowercased, trimmed
    expect(params[2]).toBe('member');         // default role
  });

  it('normalizes email to lowercase', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'u1', email: 'alice@test.com', display_name: 'Alice', role: 'member' }],
    });
    const req = mockReq({ body: { email: 'ALICE@TEST.COM', display_name: 'Alice' } });
    const res = mockRes();

    await handler(req, res);

    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toBe('alice@test.com');
  });

  it('rejects missing email', async () => {
    const req = mockReq({ body: { display_name: 'Alice' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toContain('email');
  });

  it('rejects email without @', async () => {
    const req = mockReq({ body: { email: 'not-an-email', display_name: 'Alice' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toContain('email');
  });

  it('rejects missing display_name', async () => {
    const req = mockReq({ body: { email: 'alice@test.com' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toContain('display_name');
  });

  it('rejects blank display_name', async () => {
    const req = mockReq({ body: { email: 'alice@test.com', display_name: '   ' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toContain('display_name');
  });

  it('rejects invalid role', async () => {
    const req = mockReq({ body: { email: 'alice@test.com', display_name: 'Alice', role: 'superuser' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toContain('role');
  });

  it('accepts valid roles: owner, admin, member', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      vi.clearAllMocks();
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'u1', email: 'a@test.com', display_name: 'A', role }],
      });
      const req = mockReq({ body: { email: 'a@test.com', display_name: 'A', role } });
      const res = mockRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    }
  });

  it('returns 409 on duplicate email', async () => {
    mockPool.query.mockRejectedValueOnce({ code: '23505' });
    const req = mockReq({ body: { email: 'dup@test.com', display_name: 'Dup' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error).toContain('already exists');
  });

  it('returns 500 on unexpected database error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPool.query.mockRejectedValueOnce(new Error('unexpected'));
    const req = mockReq({ body: { email: 'a@test.com', display_name: 'A' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    consoleSpy.mockRestore();
  });
});

describe('PATCH /:id (update user)', () => {
  let handler: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const router = createUserRoutes(mockPool as any);
    const layer = router.stack.find(
      (l: any) => l.route?.path === '/:id' && l.route?.methods?.patch,
    );
    handler = layer?.route?.stack[0]?.handle;
  });

  it('updates display_name', async () => {
    const updated = { id: 'u1', email: 'a@test.com', display_name: 'Alice Updated', role: 'member' };
    mockPool.query.mockResolvedValueOnce({ rows: [updated] });
    const req = mockReq({ params: { id: 'u1' }, body: { display_name: 'Alice Updated' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(updated);
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('display_name');
  });

  it('updates role', async () => {
    const updated = { id: 'u1', role: 'admin' };
    mockPool.query.mockResolvedValueOnce({ rows: [updated] });
    const req = mockReq({ params: { id: 'u1' }, body: { role: 'admin' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('rejects invalid role', async () => {
    const req = mockReq({ params: { id: 'u1' }, body: { role: 'superuser' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toContain('role');
  });

  it('updates active flag', async () => {
    const updated = { id: 'u1', active: false };
    mockPool.query.mockResolvedValueOnce({ rows: [updated] });
    const req = mockReq({ params: { id: 'u1' }, body: { active: false } });
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('returns 400 when no fields to update', async () => {
    const req = mockReq({ params: { id: 'u1' }, body: {} });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toContain('No fields to update');
  });

  it('returns 404 when user not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const req = mockReq({ params: { id: 'nonexistent' }, body: { display_name: 'New' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toContain('User not found');
  });

  it('supports updating multiple fields at once', async () => {
    const updated = { id: 'u1', display_name: 'New', role: 'admin', active: true };
    mockPool.query.mockResolvedValueOnce({ rows: [updated] });
    const req = mockReq({
      params: { id: 'u1' },
      body: { display_name: 'New', role: 'admin', active: true },
    });
    const res = mockRes();

    await handler(req, res);

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('display_name');
    expect(sql).toContain('role');
    expect(sql).toContain('active');
    // Params: display_name, role, active, then id
    expect(params.length).toBe(4);
  });

  it('supports slack_user_id update', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'u1' }] });
    const req = mockReq({ params: { id: 'u1' }, body: { slack_user_id: 'U12345' } });
    const res = mockRes();

    await handler(req, res);

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('slack_user_id');
  });

  it('supports entity_id update', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'u1' }] });
    const req = mockReq({ params: { id: 'u1' }, body: { entity_id: 'entity-123' } });
    const res = mockRes();

    await handler(req, res);

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('entity_id');
  });

  it('returns 500 on database error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPool.query.mockRejectedValueOnce(new Error('db error'));
    const req = mockReq({ params: { id: 'u1' }, body: { display_name: 'X' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    consoleSpy.mockRestore();
  });
});

describe('POST /:id/keys (generate API key)', () => {
  let handler: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const router = createUserRoutes(mockPool as any);
    const layer = router.stack.find(
      (l: any) => l.route?.path === '/:id/keys' && l.route?.methods?.post,
    );
    handler = layer?.route?.stack[0]?.handle;
  });

  it('generates a key for existing user', async () => {
    // User exists check
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'u1' }] });
    const req = mockReq({ params: { id: 'u1' }, body: { name: 'My key' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        key_id: 'key-1',
        raw_key: 'a'.repeat(64),
        message: expect.stringContaining('Save this key'),
      }),
    );
  });

  it('uses default name when none provided', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'u1' }] });
    const req = mockReq({ params: { id: 'u1' }, body: {} });
    const res = mockRes();

    await handler(req, res);

    const { generateApiKey } = await import('../../src/user-context.js');
    expect(generateApiKey).toHaveBeenCalledWith('u1', 'Default key', expect.anything());
  });

  it('returns 404 when user not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const req = mockReq({ params: { id: 'nonexistent' }, body: {} });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toContain('User not found');
  });

  it('returns 500 on error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPool.query.mockRejectedValueOnce(new Error('db error'));
    const req = mockReq({ params: { id: 'u1' }, body: {} });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    consoleSpy.mockRestore();
  });
});

describe('GET /:id/keys (list keys)', () => {
  let handler: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const router = createUserRoutes(mockPool as any);
    // Find the GET /:id/keys handler
    const layer = router.stack.find(
      (l: any) => l.route?.path === '/:id/keys' && l.route?.methods?.get,
    );
    handler = layer?.route?.stack[0]?.handle;
  });

  it('returns keys for user', async () => {
    const keys = [
      { id: 'k1', name: 'Key 1', active: true, scopes: ['owner'], created_at: new Date() },
    ];
    mockPool.query.mockResolvedValueOnce({ rows: keys });
    const req = mockReq({ params: { id: 'u1' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(keys);
    expect(mockPool.query.mock.calls[0][1]).toEqual(['u1']);
  });

  it('returns empty array when user has no keys', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const req = mockReq({ params: { id: 'u1' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('returns 500 on database error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPool.query.mockRejectedValueOnce(new Error('db error'));
    const req = mockReq({ params: { id: 'u1' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    consoleSpy.mockRestore();
  });
});

describe('DELETE /:userId/keys/:keyId (deactivate key)', () => {
  let handler: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const router = createUserRoutes(mockPool as any);
    const layer = router.stack.find(
      (l: any) => l.route?.path === '/:userId/keys/:keyId' && l.route?.methods?.delete,
    );
    handler = layer?.route?.stack[0]?.handle;
  });

  it('deactivates a key', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
    const req = mockReq({ params: { userId: 'u1', keyId: 'k1' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('active = false');
    expect(params).toEqual(['k1', 'u1']);
  });

  it('returns 404 when key not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 });
    const req = mockReq({ params: { userId: 'u1', keyId: 'nonexistent' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toContain('Key not found');
  });

  it('returns 500 on database error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPool.query.mockRejectedValueOnce(new Error('db error'));
    const req = mockReq({ params: { userId: 'u1', keyId: 'k1' } });
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    consoleSpy.mockRestore();
  });
});
