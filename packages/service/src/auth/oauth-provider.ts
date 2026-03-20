import crypto from 'node:crypto';
import type { Response } from 'express';
import type pg from 'pg';
import { SignJWT, jwtVerify, importJWK } from 'jose';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { resolveUserFromApiKey } from '../user-context.js';
import { buildVisibilityTags } from '../user-context.js';
import type { Role } from '@danielbrain/shared';

const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour
const REFRESH_TOKEN_EXPIRY_SECONDS = 86400 * 30; // 30 days

interface AuthCode {
  code: string;
  clientId: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

/**
 * In-memory OAuth server provider for MCP authentication.
 * Uses JWT for access tokens (stateless verification).
 * Auth codes and refresh tokens are in-memory (lost on restart = re-auth).
 */
export class BrainOAuthProvider implements OAuthServerProvider {
  private codes = new Map<string, AuthCode>();
  private refreshTokens = new Map<string, { userId: string; email: string; displayName: string; role: Role; clientId: string; expiresAt: number }>();
  private _clientsStore: InMemoryClientsStore;
  private pool: pg.Pool;
  private jwtKey: Uint8Array;

  constructor(pool: pg.Pool, jwtSecret: string) {
    this.pool = pool;
    this.jwtKey = new TextEncoder().encode(jwtSecret);
    this._clientsStore = new InMemoryClientsStore();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  /**
   * Serve the authorization page. User enters their API key to authenticate.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Serve a simple HTML login form
    const clientName = client.client_name || client.client_id;
    const html = `<!DOCTYPE html>
<html><head><title>Authorize - TopiaBrain</title>
<style>body{font-family:system-ui;max-width:400px;margin:80px auto;padding:20px}
input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box;font-size:16px}
button{width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer}
button:hover{background:#1d4ed8}.error{color:#dc2626;margin:8px 0}</style></head>
<body><h2>Authorize ${escapeHtml(clientName)}</h2>
<p>Enter your TopiaBrain API key to authorize this application.</p>
<form method="POST" action="/authorize/callback">
<input type="hidden" name="client_id" value="${escapeHtml(client.client_id)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
<input type="hidden" name="state" value="${escapeHtml(params.state || '')}">
<input type="password" name="api_key" placeholder="Paste your API key" required autofocus>
<button type="submit">Authorize</button>
</form></body></html>`;
    res.type('html').send(html);
  }

  /**
   * Handle the authorization form submission.
   * Validates the API key, generates an auth code, and redirects.
   */
  async handleAuthorizeCallback(
    apiKey: string,
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
    state: string | undefined,
    res: Response,
  ): Promise<void> {
    // Validate API key → resolve user
    const user = await resolveUserFromApiKey(apiKey, this.pool);
    if (!user) {
      res.type('html').send(`<!DOCTYPE html><html><head><title>Error</title>
<style>body{font-family:system-ui;max-width:400px;margin:80px auto;padding:20px}.error{color:#dc2626}</style></head>
<body><h2>Authorization Failed</h2><p class="error">Invalid API key. Please try again.</p>
<a href="javascript:history.back()">Go back</a></body></html>`);
      return;
    }

    // Generate auth code
    const code = crypto.randomBytes(32).toString('hex');
    this.codes.set(code, {
      code,
      clientId,
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      codeChallenge,
      redirectUri,
      expiresAt: Date.now() + 600_000, // 10 minutes
    });

    // Redirect back with code
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new Error('Invalid or expired authorization code');
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new Error('Invalid or expired authorization code');
    }

    // Delete code (single use)
    this.codes.delete(authorizationCode);

    // Generate JWT access token
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS;
    const visibilityTags = buildVisibilityTags({ userId: entry.userId, role: entry.role });

    const accessToken = await new SignJWT({
      sub: entry.userId,
      email: entry.email,
      name: entry.displayName,
      role: entry.role,
      visibilityTags,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .setIssuer('topiabrain')
      .sign(this.jwtKey);

    // Generate refresh token
    const refreshToken = crypto.randomBytes(32).toString('hex');
    this.refreshTokens.set(refreshToken, {
      userId: entry.userId,
      email: entry.email,
      displayName: entry.displayName,
      role: entry.role,
      clientId: entry.clientId,
      expiresAt: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY_SECONDS,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_EXPIRY_SECONDS,
      refresh_token: refreshToken,
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const entry = this.refreshTokens.get(refreshToken);
    if (!entry || entry.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error('Invalid or expired refresh token');
    }

    // Issue new access token
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS;
    const visibilityTags = buildVisibilityTags({ userId: entry.userId, role: entry.role });

    const accessToken = await new SignJWT({
      sub: entry.userId,
      email: entry.email,
      name: entry.displayName,
      role: entry.role,
      visibilityTags,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .setIssuer('topiabrain')
      .sign(this.jwtKey);

    // Issue new refresh token (rotate)
    this.refreshTokens.delete(refreshToken);
    const newRefreshToken = crypto.randomBytes(32).toString('hex');
    this.refreshTokens.set(newRefreshToken, {
      ...entry,
      expiresAt: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY_SECONDS,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_EXPIRY_SECONDS,
      refresh_token: newRefreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.jwtKey, {
        issuer: 'topiabrain',
      });

      return {
        token,
        clientId: 'topiabrain',
        scopes: ['read', 'write'],
        expiresAt: payload.exp,
        extra: {
          userId: payload.sub,
          email: payload.email,
          displayName: payload.name,
          role: payload.role,
          visibilityTags: payload.visibilityTags,
        },
      };
    } catch (err) {
      throw new Error('Invalid or expired access token');
    }
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // Try deleting as refresh token
    this.refreshTokens.delete(request.token);
    // Access tokens are JWTs — can't be revoked (expire naturally)
  }

  /**
   * Periodic cleanup of expired codes and tokens.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.codes) {
      if (entry.expiresAt < now) this.codes.delete(key);
    }
    const nowSec = Math.floor(now / 1000);
    for (const [key, entry] of this.refreshTokens) {
      if (entry.expiresAt < nowSec) this.refreshTokens.delete(key);
    }
  }
}

/**
 * In-memory client registration store. Persists for the lifetime of the process.
 */
class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const clientId = crypto.randomUUID();
    const clientSecret = crypto.randomBytes(32).toString('hex');

    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };

    this.clients.set(clientId, full);
    return full;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
