import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authenticateRequest, requireAuth, optionalAuth, requireAdmin, verifyAccessKey } from '../src/auth.js';

// Mock user-context module
vi.mock('../src/user-context.js', () => ({
  resolveUserFromApiKey: vi.fn(),
  resolveUserFromEmail: vi.fn(),
}));

vi.mock('../src/audit.js', () => ({
  logAudit: vi.fn(),
}));

import { resolveUserFromApiKey, resolveUserFromEmail } from '../src/user-context.js';

const mockPool = { query: vi.fn() };

const mockUser = {
  userId: 'u1',
  email: 'alice@test.com',
  displayName: 'Alice',
  role: 'member' as const,
  visibilityTags: ['company', 'user:u1'],
};

function mockReq(headers: Record<string, string> = {}) {
  return { headers, ip: '127.0.0.1' } as any;
}

function mockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((data: any) => { res.body = data; return res; });
  return res;
}

describe('verifyAccessKey', () => {
  it('returns true for matching keys', () => {
    expect(verifyAccessKey('abc123', 'abc123')).toBe(true);
  });

  it('returns false for missing key', () => {
    expect(verifyAccessKey(undefined, 'abc123')).toBe(false);
    expect(verifyAccessKey('', 'abc123')).toBe(false);
  });

  it('returns false for wrong key', () => {
    expect(verifyAccessKey('wrong!', 'abc123')).toBe(false);
  });
});

describe('authenticateRequest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves user from x-brain-key header', async () => {
    vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce(mockUser);

    const user = await authenticateRequest(
      mockReq({ 'x-brain-key': 'test-key' }),
      mockPool as any,
    );

    expect(user).toEqual(mockUser);
    expect(resolveUserFromApiKey).toHaveBeenCalledWith('test-key', mockPool);
  });

  it('returns null for invalid API key', async () => {
    vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce(null);

    const user = await authenticateRequest(
      mockReq({ 'x-brain-key': 'bad-key' }),
      mockPool as any,
    );

    expect(user).toBeNull();
  });

  it('resolves user from Cloudflare JWT', async () => {
    vi.mocked(resolveUserFromEmail).mockResolvedValueOnce(mockUser);

    // Create a mock JWT with email in payload
    const payload = Buffer.from(JSON.stringify({ email: 'alice@test.com' })).toString('base64url');
    const fakeJwt = `header.${payload}.signature`;

    const user = await authenticateRequest(
      mockReq({ 'cf-access-jwt-assertion': fakeJwt }),
      mockPool as any,
    );

    expect(user).toEqual(mockUser);
    expect(resolveUserFromEmail).toHaveBeenCalledWith('alice@test.com', mockPool);
  });

  it('returns null when no auth headers present', async () => {
    const user = await authenticateRequest(mockReq(), mockPool as any);
    expect(user).toBeNull();
  });

  it('returns null for legacy key with no user mapping', async () => {
    vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce(null);
    const legacyKey = 'a'.repeat(64);

    const user = await authenticateRequest(
      mockReq({ 'x-brain-key': legacyKey }),
      mockPool as any,
      legacyKey,
    );

    expect(user).toBeNull();
  });

  it('falls through Bearer token to next auth method (Phase 9c stub)', async () => {
    // Bearer token is present but JWT verification is not yet implemented.
    // With no other auth headers, should return null.
    const user = await authenticateRequest(
      mockReq({ authorization: 'Bearer some.jwt.token' }),
      mockPool as any,
    );

    expect(user).toBeNull();
    // Should NOT have tried resolveUserFromApiKey since x-brain-key is absent
    expect(resolveUserFromApiKey).not.toHaveBeenCalled();
  });

  it('Bearer token falls through to x-brain-key if both present', async () => {
    vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce(mockUser);

    const user = await authenticateRequest(
      mockReq({ authorization: 'Bearer some.jwt.token', 'x-brain-key': 'my-key' }),
      mockPool as any,
    );

    expect(user).toEqual(mockUser);
    expect(resolveUserFromApiKey).toHaveBeenCalledWith('my-key', mockPool);
  });

  it('returns null gracefully for malformed CF JWT with only 2 parts', async () => {
    const user = await authenticateRequest(
      mockReq({ 'cf-access-jwt-assertion': 'header.signature' }),
      mockPool as any,
    );

    // 'header.signature'.split('.')[1] = 'signature', which is not valid base64 JSON
    // The try/catch in authenticateRequest should catch and return null
    expect(user).toBeNull();
    expect(resolveUserFromEmail).not.toHaveBeenCalled();
  });

  it('returns null gracefully for CF JWT with invalid base64 payload', async () => {
    const user = await authenticateRequest(
      mockReq({ 'cf-access-jwt-assertion': 'aaa.!!!invalid-base64!!!.ccc' }),
      mockPool as any,
    );

    expect(user).toBeNull();
    expect(resolveUserFromEmail).not.toHaveBeenCalled();
  });

  it('returns null gracefully for CF JWT with valid base64 but no email', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-123' })).toString('base64url');
    const fakeJwt = `header.${payload}.signature`;

    const user = await authenticateRequest(
      mockReq({ 'cf-access-jwt-assertion': fakeJwt }),
      mockPool as any,
    );

    expect(user).toBeNull();
    expect(resolveUserFromEmail).not.toHaveBeenCalled();
  });
});

describe('requireAuth middleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls next and sets userContext on success', async () => {
    vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce(mockUser);
    const req = mockReq({ 'x-brain-key': 'valid' });
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockPool as any)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userContext).toEqual(mockUser);
  });

  it('returns 401 when no identity found', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockPool as any)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 500 when authenticateRequest throws', async () => {
    vi.mocked(resolveUserFromApiKey).mockRejectedValueOnce(new Error('DB connection lost'));
    const req = mockReq({ 'x-brain-key': 'some-key' });
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockPool as any)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual({ error: 'Authentication error' });
  });
});

describe('optionalAuth middleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets userContext when key is valid', async () => {
    vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce(mockUser);
    const req = mockReq({ 'x-brain-key': 'valid' });
    const res = mockRes();
    const next = vi.fn();

    await optionalAuth(mockPool as any)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userContext).toEqual(mockUser);
  });

  it('continues without userContext when no key', async () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await optionalAuth(mockPool as any)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userContext).toBeUndefined();
  });

  it('returns 403 for invalid API key', async () => {
    vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce(null);
    const req = mockReq({ 'x-brain-key': 'bad-key' });
    const res = mockRes();
    const next = vi.fn();

    await optionalAuth(mockPool as any)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows legacy key without user mapping', async () => {
    vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce(null);
    const legacyKey = 'a'.repeat(64);
    const req = mockReq({ 'x-brain-key': legacyKey });
    const res = mockRes();
    const next = vi.fn();

    await optionalAuth(mockPool as any, legacyKey)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.userContext).toBeUndefined();
  });
});

describe('requireAdmin middleware', () => {
  it('allows owner through', () => {
    const req = { userContext: { ...mockUser, role: 'owner' } } as any;
    const res = mockRes();
    const next = vi.fn();

    requireAdmin()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows admin through', () => {
    const req = { userContext: { ...mockUser, role: 'admin' } } as any;
    const res = mockRes();
    const next = vi.fn();

    requireAdmin()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects member with 403', () => {
    const req = { userContext: mockUser } as any;
    const res = mockRes();
    const next = vi.fn();

    requireAdmin()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 401 when no userContext', () => {
    const req = {} as any;
    const res = mockRes();
    const next = vi.fn();

    requireAdmin()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
