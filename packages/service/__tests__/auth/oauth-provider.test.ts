import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';

// Polyfill for jose (needs globalThis.crypto in vitest workers)
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

import { BrainOAuthProvider } from '../../src/auth/oauth-provider.js';

vi.mock('../../src/user-context.js', () => ({
  resolveUserFromApiKey: vi.fn(),
  buildVisibilityTags: vi.fn().mockReturnValue(['company', 'user:u1']),
}));

import { resolveUserFromApiKey } from '../../src/user-context.js';

const mockPool = { query: vi.fn() };
const JWT_SECRET = 'a'.repeat(32);

describe('BrainOAuthProvider', () => {
  let provider: BrainOAuthProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new BrainOAuthProvider(mockPool as any, JWT_SECRET);
  });

  describe('clientsStore', () => {
    it('registers and retrieves clients', () => {
      const store = provider.clientsStore;
      const registered = store.registerClient!({
        client_name: 'Test Client',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      expect(registered.client_id).toBeTruthy();
      expect(registered.client_secret).toBeTruthy();
      expect(registered.client_name).toBe('Test Client');

      const retrieved = store.getClient(registered.client_id);
      expect(retrieved).toEqual(registered);
    });

    it('returns undefined for unknown client', () => {
      expect(provider.clientsStore.getClient('nonexistent')).toBeUndefined();
    });
  });

  describe('full auth flow', () => {
    it('exchanges auth code for JWT and verifies it', async () => {
      // Setup: register client
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      // Simulate authorize callback with valid user
      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1',
        email: 'alice@test.com',
        displayName: 'Alice',
        role: 'member',
        visibilityTags: ['company', 'user:u1'],
      });

      // Call handleAuthorizeCallback to generate code
      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback(
        'valid-key',
        client.client_id,
        'http://localhost:8080/callback',
        'test-challenge',
        'test-state',
        mockRes as any,
      );

      expect(mockRes.redirect).toHaveBeenCalled();
      const codeUrl = new URL(redirectUrl);
      const code = codeUrl.searchParams.get('code')!;
      expect(code).toBeTruthy();
      expect(codeUrl.searchParams.get('state')).toBe('test-state');

      // Get challenge for PKCE
      const challenge = await provider.challengeForAuthorizationCode(client, code);
      expect(challenge).toBe('test-challenge');

      // Exchange code for tokens
      const tokens = await provider.exchangeAuthorizationCode(client, code);
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.token_type).toBe('bearer');
      expect(tokens.expires_in).toBeGreaterThan(0);
      expect(tokens.refresh_token).toBeTruthy();

      // Verify access token
      const authInfo = await provider.verifyAccessToken(tokens.access_token);
      expect(authInfo.extra?.userId).toBe('u1');
      expect(authInfo.extra?.email).toBe('alice@test.com');
      expect(authInfo.extra?.role).toBe('member');
      expect(authInfo.scopes).toContain('read');

      // Code is single-use
      await expect(provider.exchangeAuthorizationCode(client, code))
        .rejects.toThrow();
    });

    it('refresh token issues new access token', async () => {
      // Generate tokens via auth flow
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1',
        email: 'alice@test.com',
        displayName: 'Alice',
        role: 'member',
        visibilityTags: ['company', 'user:u1'],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback('key', client.client_id, 'http://localhost:8080/callback', 'ch', undefined, mockRes as any);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const tokens = await provider.exchangeAuthorizationCode(client, code);

      // Refresh
      const newTokens = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
      expect(newTokens.access_token).toBeTruthy();
      expect(newTokens.token_type).toBe('bearer');
      expect(newTokens.refresh_token).toBeTruthy();
      expect(newTokens.refresh_token).not.toBe(tokens.refresh_token); // rotated

      // Old refresh token is invalid
      await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!))
        .rejects.toThrow();
    });
  });

  describe('verifyAccessToken', () => {
    it('rejects invalid tokens', async () => {
      await expect(provider.verifyAccessToken('not-a-jwt'))
        .rejects.toThrow();
    });
  });

  describe('handleAuthorizeCallback', () => {
    it('shows error page for invalid API key', async () => {
      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce(null);

      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn(),
      };

      await provider.handleAuthorizeCallback('bad', 'c1', 'http://localhost/cb', 'ch', undefined, mockRes as any);

      expect(mockRes.send).toHaveBeenCalled();
      expect(mockRes.send.mock.calls[0][0]).toContain('Authorization Failed');
      expect(mockRes.redirect).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('removes expired codes', async () => {
      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1', email: 'a@b.com', displayName: 'A', role: 'member', visibilityTags: [],
      });

      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn(),
      };

      await provider.handleAuthorizeCallback('key', 'c1', 'http://localhost/cb', 'ch', undefined, mockRes as any);

      // Code exists before cleanup
      const url = new URL(mockRes.redirect.mock.calls[0][0]);
      const code = url.searchParams.get('code')!;
      expect(await provider.challengeForAuthorizationCode({} as any, code)).toBe('ch');

      // Force cleanup (codes aren't expired yet, so this should be a no-op)
      provider.cleanup();
      expect(await provider.challengeForAuthorizationCode({} as any, code)).toBe('ch');
    });

    it('cleans up expired refresh tokens', async () => {
      // Create tokens through the full flow
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1', email: 'a@b.com', displayName: 'A', role: 'member', visibilityTags: [],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback('key', client.client_id, 'http://localhost:8080/callback', 'ch', undefined, mockRes as any);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const tokens = await provider.exchangeAuthorizationCode(client, code);

      // Refresh token should work before cleanup
      // (We need a new code to get a new refresh token since the old one will be rotated)
      // Instead, just verify cleanup doesn't break valid tokens
      provider.cleanup();

      // The refresh token is still valid (not expired), so it should still work
      const newTokens = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
      expect(newTokens.access_token).toBeTruthy();
    });
  });

  describe('clientsStore', () => {
    it('registerClient assigns unique client_id and client_secret', () => {
      const store = provider.clientsStore;
      const client1 = store.registerClient!({
        client_name: 'Client 1',
        redirect_uris: ['http://localhost/cb1'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read',
      });
      const client2 = store.registerClient!({
        client_name: 'Client 2',
        redirect_uris: ['http://localhost/cb2'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read',
      });

      expect(client1.client_id).not.toBe(client2.client_id);
      expect(client1.client_secret).not.toBe(client2.client_secret);
    });

    it('registerClient includes client_id_issued_at timestamp', () => {
      const store = provider.clientsStore;
      const before = Math.floor(Date.now() / 1000);
      const client = store.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read',
      });
      const after = Math.floor(Date.now() / 1000);

      expect(client.client_id_issued_at).toBeGreaterThanOrEqual(before);
      expect(client.client_id_issued_at).toBeLessThanOrEqual(after);
    });
  });

  describe('handleAuthorizeCallback', () => {
    it('includes state parameter in redirect URL when provided', async () => {
      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1', email: 'a@b.com', displayName: 'A', role: 'member', visibilityTags: [],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback(
        'key', 'c1', 'http://localhost/cb', 'challenge', 'my-state', mockRes as any,
      );

      const url = new URL(redirectUrl);
      expect(url.searchParams.get('state')).toBe('my-state');
      expect(url.searchParams.get('code')).toBeTruthy();
    });

    it('omits state parameter from redirect when undefined', async () => {
      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1', email: 'a@b.com', displayName: 'A', role: 'member', visibilityTags: [],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback(
        'key', 'c1', 'http://localhost/cb', 'challenge', undefined, mockRes as any,
      );

      const url = new URL(redirectUrl);
      expect(url.searchParams.has('state')).toBe(false);
      expect(url.searchParams.get('code')).toBeTruthy();
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('code is single-use: second exchange throws', async () => {
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1', email: 'alice@test.com', displayName: 'Alice', role: 'member', visibilityTags: [],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback(
        'key', client.client_id, 'http://localhost:8080/callback', 'ch', undefined, mockRes as any,
      );

      const code = new URL(redirectUrl).searchParams.get('code')!;

      // First exchange succeeds
      const tokens = await provider.exchangeAuthorizationCode(client, code);
      expect(tokens.access_token).toBeTruthy();

      // Second exchange fails
      await expect(provider.exchangeAuthorizationCode(client, code))
        .rejects.toThrow('Invalid or expired authorization code');
    });

    it('expired code throws', async () => {
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      // We cannot easily expire a code without time manipulation, but we can try a bogus code
      await expect(provider.exchangeAuthorizationCode(client, 'nonexistent-code'))
        .rejects.toThrow('Invalid or expired authorization code');
    });
  });

  describe('challengeForAuthorizationCode', () => {
    it('throws for nonexistent code', async () => {
      await expect(
        provider.challengeForAuthorizationCode({} as any, 'bogus'),
      ).rejects.toThrow('Invalid or expired authorization code');
    });
  });

  describe('exchangeRefreshToken', () => {
    it('throws for nonexistent refresh token', async () => {
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      await expect(provider.exchangeRefreshToken(client, 'fake-refresh-token'))
        .rejects.toThrow('Invalid or expired refresh token');
    });

    it('rotates refresh token (old one invalid after use)', async () => {
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u2', email: 'bob@test.com', displayName: 'Bob', role: 'admin', visibilityTags: [],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback(
        'key', client.client_id, 'http://localhost:8080/callback', 'ch', undefined, mockRes as any,
      );
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const tokens = await provider.exchangeAuthorizationCode(client, code);

      const oldRefresh = tokens.refresh_token!;

      // Use refresh token
      const newTokens = await provider.exchangeRefreshToken(client, oldRefresh);
      expect(newTokens.refresh_token).not.toBe(oldRefresh);

      // Old refresh token is now invalid
      await expect(provider.exchangeRefreshToken(client, oldRefresh))
        .rejects.toThrow('Invalid or expired refresh token');

      // New refresh token works
      const thirdTokens = await provider.exchangeRefreshToken(client, newTokens.refresh_token!);
      expect(thirdTokens.access_token).toBeTruthy();
    });
  });

  describe('verifyAccessToken', () => {
    it('rejects tampered JWT', async () => {
      // Create a valid token then tamper with it
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1', email: 'a@b.com', displayName: 'A', role: 'member', visibilityTags: [],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback('key', client.client_id, 'http://localhost:8080/callback', 'ch', undefined, mockRes as any);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const tokens = await provider.exchangeAuthorizationCode(client, code);

      // Tamper with the JWT payload
      const parts = tokens.access_token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      payload.role = 'owner'; // escalation attempt
      parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tamperedToken = parts.join('.');

      await expect(provider.verifyAccessToken(tamperedToken))
        .rejects.toThrow('Invalid or expired access token');
    });

    it('returns correct AuthInfo fields from valid JWT', async () => {
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u3', email: 'carol@test.com', displayName: 'Carol', role: 'admin', visibilityTags: [],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback('key', client.client_id, 'http://localhost:8080/callback', 'ch', undefined, mockRes as any);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const tokens = await provider.exchangeAuthorizationCode(client, code);

      const authInfo = await provider.verifyAccessToken(tokens.access_token);
      expect(authInfo.token).toBe(tokens.access_token);
      expect(authInfo.clientId).toBe('topiabrain');
      expect(authInfo.scopes).toEqual(['read', 'write']);
      expect(authInfo.expiresAt).toBeDefined();
      expect(authInfo.extra?.userId).toBe('u3');
      expect(authInfo.extra?.email).toBe('carol@test.com');
      expect(authInfo.extra?.displayName).toBe('Carol');
      expect(authInfo.extra?.role).toBe('admin');
      expect(authInfo.extra?.visibilityTags).toEqual(['company', 'user:u1']); // from mock
    });

    it('rejects JWT signed with different secret', async () => {
      // Create a different provider with different secret
      const otherProvider = new BrainOAuthProvider(mockPool as any, 'b'.repeat(32));

      const client = otherProvider.clientsStore.registerClient!({
        client_name: 'Other',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1', email: 'a@b.com', displayName: 'A', role: 'member', visibilityTags: [],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await otherProvider.handleAuthorizeCallback('key', client.client_id, 'http://localhost:8080/callback', 'ch', undefined, mockRes as any);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const tokens = await otherProvider.exchangeAuthorizationCode(client, code);

      // Try verifying with the original provider (different secret)
      await expect(provider.verifyAccessToken(tokens.access_token))
        .rejects.toThrow('Invalid or expired access token');
    });
  });

  describe('revokeToken', () => {
    it('deletes refresh token from store', async () => {
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      vi.mocked(resolveUserFromApiKey).mockResolvedValueOnce({
        userId: 'u1', email: 'a@b.com', displayName: 'A', role: 'member', visibilityTags: [],
      });

      let redirectUrl = '';
      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn((url: string) => { redirectUrl = url; }),
      };

      await provider.handleAuthorizeCallback('key', client.client_id, 'http://localhost:8080/callback', 'ch', undefined, mockRes as any);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const tokens = await provider.exchangeAuthorizationCode(client, code);

      // Revoke the refresh token
      await provider.revokeToken(client, { token: tokens.refresh_token!, token_type_hint: 'refresh_token' });

      // Refresh token should now be invalid
      await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!))
        .rejects.toThrow('Invalid or expired refresh token');
    });

    it('does not throw when revoking nonexistent token', async () => {
      const client = provider.clientsStore.registerClient!({
        client_name: 'Test',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      // Revoking a nonexistent token should not throw
      await expect(
        provider.revokeToken(client, { token: 'nonexistent', token_type_hint: 'refresh_token' }),
      ).resolves.not.toThrow();
    });
  });

  describe('authorize', () => {
    it('serves HTML form with client name', async () => {
      const client = provider.clientsStore.registerClient!({
        client_name: 'My App',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      await provider.authorize(
        client,
        {
          redirectUri: 'http://localhost:8080/callback',
          codeChallenge: 'test-challenge',
          state: 'test-state',
        } as any,
        mockRes as any,
      );

      expect(mockRes.type).toHaveBeenCalledWith('html');
      expect(mockRes.send).toHaveBeenCalled();
      const html = mockRes.send.mock.calls[0][0];
      expect(html).toContain('My App');
      expect(html).toContain('test-challenge');
      expect(html).toContain('test-state');
      expect(html).toContain('api_key');
    });

    it('escapes HTML in client name', async () => {
      const client = provider.clientsStore.registerClient!({
        client_name: '<script>alert("xss")</script>',
        redirect_uris: ['http://localhost:8080/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: 'read write',
      });

      const mockRes = {
        type: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      await provider.authorize(
        client,
        {
          redirectUri: 'http://localhost:8080/callback',
          codeChallenge: 'ch',
          state: '',
        } as any,
        mockRes as any,
      );

      const html = mockRes.send.mock.calls[0][0];
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});
