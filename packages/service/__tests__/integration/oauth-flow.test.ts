/**
 * Integration tests for the OAuth 2.0 / MCP auth flow.
 *
 * These tests run against a real PostgreSQL database (docker-compose.test.yml on port 5433).
 * They exercise the BrainOAuthProvider class directly — client registration, authorization,
 * token exchange, refresh, revocation, and JWT verification.
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 * Prereq: docker compose -f docker/docker-compose.test.yml up -d
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';

// Polyfill globalThis.crypto for jose (Web Crypto API) in Node 18 vitest forks
if (!globalThis.crypto) {
  (globalThis as any).crypto = crypto.webcrypto;
}
import { BrainOAuthProvider } from '../../src/auth/oauth-provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  createTestPool, insertTestUser, insertTestApiKey, cleanupTestData, TEST_DB_URL,
} from './helpers.js';

let pool: pg.Pool;
let provider: BrainOAuthProvider;

const JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars-long';

// Test user + API key
let userId: string;
let rawApiKey: string;

/** Create a mock Express Response for authorize/callback tests. */
function mockRes() {
  const res: any = {
    _html: '',
    _redirectUrl: '',
    _type: '',
    _status: 200,
  };
  res.type = vi.fn((t: string) => { res._type = t; return res; });
  res.send = vi.fn((html: string) => { res._html = html; return res; });
  res.redirect = vi.fn((url: string) => { res._redirectUrl = url; return res; });
  res.status = vi.fn((code: number) => { res._status = code; return res; });
  return res;
}

/** Register a test client and return it. */
function registerTestClient(): OAuthClientInformationFull {
  return (provider.clientsStore as any).registerClient({
    redirect_uris: [new URL('http://localhost:9999/callback')],
    client_name: 'Test Client',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
  });
}

beforeAll(async () => {
  pool = createTestPool();
  await pool.query('SELECT 1');

  // Create test user + API key
  const user = await insertTestUser(pool, {
    email: 'oauth-test@test.com',
    displayName: 'OAuth Test User',
    role: 'member',
  });
  userId = user.id;

  const key = await insertTestApiKey(pool, userId, { name: 'oauth-test-key' });
  rawApiKey = key.rawKey;

  provider = new BrainOAuthProvider(pool, JWT_SECRET);
});

afterAll(async () => {
  await cleanupTestData(pool);
  await pool.end();
});

// ---------------------------------------------------------------------------
// Dynamic Client Registration
// ---------------------------------------------------------------------------

describe('Dynamic client registration', () => {
  it('registers a client and returns it with client_id', () => {
    const client = registerTestClient();

    expect(client.client_id).toBeDefined();
    expect(typeof client.client_id).toBe('string');
    expect(client.client_secret).toBeDefined();
    expect(client.client_name).toBe('Test Client');
    expect(client.client_id_issued_at).toBeDefined();
  });

  it('registered client can be retrieved from clientsStore', () => {
    const client = registerTestClient();
    const retrieved = (provider.clientsStore as any).getClient(client.client_id);

    expect(retrieved).toBeDefined();
    expect(retrieved.client_id).toBe(client.client_id);
    expect(retrieved.client_name).toBe('Test Client');
  });
});

// ---------------------------------------------------------------------------
// Authorization Flow
// ---------------------------------------------------------------------------

describe('Authorization flow', () => {
  it('authorize serves HTML login form', async () => {
    const client = registerTestClient();
    const res = mockRes();

    await provider.authorize(client, {
      redirectUri: 'http://localhost:9999/callback',
      codeChallenge: 'test-challenge',
      state: 'test-state',
    }, res);

    expect(res.type).toHaveBeenCalledWith('html');
    expect(res.send).toHaveBeenCalled();
    expect(res._html).toContain('Authorize');
    expect(res._html).toContain('api_key');
    expect(res._html).toContain(client.client_id);
  });

  it('handleAuthorizeCallback with valid API key redirects with auth code', async () => {
    const client = registerTestClient();
    const res = mockRes();

    await provider.handleAuthorizeCallback(
      rawApiKey,
      client.client_id,
      'http://localhost:9999/callback',
      'test-challenge',
      'test-state',
      res,
    );

    expect(res.redirect).toHaveBeenCalled();
    const redirectUrl = new URL(res._redirectUrl);
    expect(redirectUrl.origin).toBe('http://localhost:9999');
    expect(redirectUrl.pathname).toBe('/callback');
    expect(redirectUrl.searchParams.get('code')).toBeDefined();
    expect(redirectUrl.searchParams.get('code')!.length).toBe(64); // 32 bytes hex
    expect(redirectUrl.searchParams.get('state')).toBe('test-state');
  });

  it('handleAuthorizeCallback with invalid API key returns error HTML', async () => {
    const client = registerTestClient();
    const res = mockRes();

    await provider.handleAuthorizeCallback(
      'invalid-api-key-that-does-not-exist',
      client.client_id,
      'http://localhost:9999/callback',
      'test-challenge',
      undefined,
      res,
    );

    expect(res.type).toHaveBeenCalledWith('html');
    expect(res._html).toContain('Authorization Failed');
    expect(res._html).toContain('Invalid API key');
    // Should NOT have been redirected
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token Exchange (auth code -> access + refresh tokens)
// ---------------------------------------------------------------------------

describe('Token exchange', () => {
  /** Helper: run full auth flow and return auth code + client */
  async function getAuthCode(): Promise<{ code: string; client: OAuthClientInformationFull }> {
    const client = registerTestClient();
    const res = mockRes();
    await provider.handleAuthorizeCallback(
      rawApiKey,
      client.client_id,
      'http://localhost:9999/callback',
      'test-challenge',
      'some-state',
      res,
    );
    const redirectUrl = new URL(res._redirectUrl);
    const code = redirectUrl.searchParams.get('code')!;
    return { code, client };
  }

  it('exchanges auth code for JWT access token + refresh token', async () => {
    const { code, client } = await getAuthCode();

    const tokens = await provider.exchangeAuthorizationCode(client, code);

    expect(tokens.access_token).toBeDefined();
    expect(typeof tokens.access_token).toBe('string');
    expect(tokens.access_token.split('.').length).toBe(3); // JWT format
    expect(tokens.token_type).toBe('bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeDefined();
    expect(typeof tokens.refresh_token).toBe('string');
  });

  it('auth code is single-use (second exchange fails)', async () => {
    const { code, client } = await getAuthCode();

    // First exchange succeeds
    await provider.exchangeAuthorizationCode(client, code);

    // Second exchange should fail
    await expect(
      provider.exchangeAuthorizationCode(client, code),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it('expired auth code fails exchange', async () => {
    const client = registerTestClient();

    // Manually inject an expired code via internal state
    const expiredCode = crypto.randomBytes(32).toString('hex');
    (provider as any).codes.set(expiredCode, {
      code: expiredCode,
      clientId: client.client_id,
      userId,
      email: 'oauth-test@test.com',
      displayName: 'OAuth Test User',
      role: 'member',
      codeChallenge: 'test-challenge',
      redirectUri: 'http://localhost:9999/callback',
      expiresAt: Date.now() - 1000, // expired 1 second ago
    });

    await expect(
      provider.exchangeAuthorizationCode(client, expiredCode),
    ).rejects.toThrow(/invalid or expired/i);
  });
});

// ---------------------------------------------------------------------------
// Access Token Verification
// ---------------------------------------------------------------------------

describe('Access token verification', () => {
  async function getAccessToken(): Promise<string> {
    const client = registerTestClient();
    const res = mockRes();
    await provider.handleAuthorizeCallback(
      rawApiKey, client.client_id,
      'http://localhost:9999/callback', 'challenge', undefined, res,
    );
    const code = new URL(res._redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    return tokens.access_token;
  }

  it('verifies a valid JWT and returns AuthInfo with user details', async () => {
    const token = await getAccessToken();
    const authInfo = await provider.verifyAccessToken(token);

    expect(authInfo.token).toBe(token);
    expect(authInfo.clientId).toBe('topiabrain');
    expect(authInfo.scopes).toEqual(['read', 'write']);
    expect(authInfo.expiresAt).toBeDefined();
    expect(authInfo.extra).toBeDefined();
    expect(authInfo.extra!.userId).toBe(userId);
    expect(authInfo.extra!.email).toBe('oauth-test@test.com');
    expect(authInfo.extra!.displayName).toBe('OAuth Test User');
    expect(authInfo.extra!.role).toBe('member');
    expect(Array.isArray(authInfo.extra!.visibilityTags)).toBe(true);
    expect(authInfo.extra!.visibilityTags).toContain('company');
    expect(authInfo.extra!.visibilityTags).toContain(`user:${userId}`);
  });

  it('rejects an invalid token', async () => {
    await expect(
      provider.verifyAccessToken('not.a.valid.jwt'),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it('rejects a token signed with a different secret', async () => {
    // Create a provider with a different secret
    const otherProvider = new BrainOAuthProvider(pool, 'different-secret-that-is-also-32-chars-long');
    const client = (otherProvider.clientsStore as any).registerClient({
      redirect_uris: [new URL('http://localhost:9999/callback')],
      client_name: 'Other Client',
    });

    // Get a token from the main provider
    const token = await getAccessToken();

    // The other provider should reject it (different signing key)
    await expect(
      otherProvider.verifyAccessToken(token),
    ).rejects.toThrow(/invalid or expired/i);
  });
});

// ---------------------------------------------------------------------------
// Refresh Token Flow
// ---------------------------------------------------------------------------

describe('Refresh token flow', () => {
  async function getTokenPair(): Promise<{ tokens: any; client: OAuthClientInformationFull }> {
    const client = registerTestClient();
    const res = mockRes();
    await provider.handleAuthorizeCallback(
      rawApiKey, client.client_id,
      'http://localhost:9999/callback', 'challenge', undefined, res,
    );
    const code = new URL(res._redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    return { tokens, client };
  }

  it('exchanges refresh token for new access + refresh tokens', async () => {
    const { tokens, client } = await getTokenPair();

    const newTokens = await provider.exchangeRefreshToken(client, tokens.refresh_token);

    expect(newTokens.access_token).toBeDefined();
    expect(typeof newTokens.access_token).toBe('string');
    expect(newTokens.access_token.split('.').length).toBe(3); // JWT format
    expect(newTokens.refresh_token).toBeDefined();
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token); // rotated
    expect(newTokens.token_type).toBe('bearer');
    expect(newTokens.expires_in).toBe(3600);

    // New access token should be verifiable
    const authInfo = await provider.verifyAccessToken(newTokens.access_token);
    expect(authInfo.extra!.userId).toBe(userId);
  });

  it('old refresh token is invalid after rotation', async () => {
    const { tokens, client } = await getTokenPair();
    const oldRefresh = tokens.refresh_token;

    // Use it once (rotates)
    await provider.exchangeRefreshToken(client, oldRefresh);

    // Try using the old one again
    await expect(
      provider.exchangeRefreshToken(client, oldRefresh),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it('expired refresh token fails exchange', async () => {
    const client = registerTestClient();

    // Manually inject an expired refresh token
    const expiredRefresh = crypto.randomBytes(32).toString('hex');
    (provider as any).refreshTokens.set(expiredRefresh, {
      userId,
      email: 'oauth-test@test.com',
      displayName: 'OAuth Test User',
      role: 'member',
      clientId: client.client_id,
      expiresAt: Math.floor(Date.now() / 1000) - 1, // expired
    });

    await expect(
      provider.exchangeRefreshToken(client, expiredRefresh),
    ).rejects.toThrow(/invalid or expired/i);
  });
});

// ---------------------------------------------------------------------------
// Token Revocation
// ---------------------------------------------------------------------------

describe('Token revocation', () => {
  it('revoking a refresh token prevents further exchanges', async () => {
    const client = registerTestClient();
    const res = mockRes();
    await provider.handleAuthorizeCallback(
      rawApiKey, client.client_id,
      'http://localhost:9999/callback', 'challenge', undefined, res,
    );
    const code = new URL(res._redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    // Revoke the refresh token
    await provider.revokeToken(client, { token: tokens.refresh_token });

    // Exchange should now fail
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token),
    ).rejects.toThrow(/invalid or expired/i);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('Cleanup', () => {
  it('removes expired codes and tokens', () => {
    // Inject expired entries
    const expiredCode = crypto.randomBytes(32).toString('hex');
    (provider as any).codes.set(expiredCode, {
      code: expiredCode,
      clientId: 'test',
      userId,
      email: 'oauth-test@test.com',
      displayName: 'OAuth Test User',
      role: 'member',
      codeChallenge: 'challenge',
      redirectUri: 'http://localhost:9999/callback',
      expiresAt: Date.now() - 60_000,
    });

    const expiredRefresh = crypto.randomBytes(32).toString('hex');
    (provider as any).refreshTokens.set(expiredRefresh, {
      userId,
      email: 'oauth-test@test.com',
      displayName: 'OAuth Test User',
      role: 'member',
      clientId: 'test',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });

    // Verify they exist
    expect((provider as any).codes.has(expiredCode)).toBe(true);
    expect((provider as any).refreshTokens.has(expiredRefresh)).toBe(true);

    // Run cleanup
    provider.cleanup();

    // Should be gone
    expect((provider as any).codes.has(expiredCode)).toBe(false);
    expect((provider as any).refreshTokens.has(expiredRefresh)).toBe(false);
  });
});
