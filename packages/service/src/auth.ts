import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import type { UserContext } from '@danielbrain/shared';
import { resolveUserFromApiKey, resolveUserFromEmail } from './user-context.js';
import { logAudit } from './audit.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('auth');

// Extend Express Request to carry user context
declare global {
  namespace Express {
    interface Request {
      userContext?: UserContext;
    }
  }
}

/**
 * Legacy timing-safe key comparison. Kept for backward compat with webhook routes
 * and for the transition period where BRAIN_ACCESS_KEY may not be linked to a user.
 */
export function verifyAccessKey(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!provided || provided.length === 0) return false;
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(expected),
  );
}

/**
 * Authenticate a request by checking (in order):
 * 1. Authorization: Bearer <token> header (OAuth tokens — Phase 9c)
 * 2. x-brain-key header (API key → user lookup via access_keys table)
 * 3. Cf-Access-Jwt-Assertion header (Cloudflare Zero Trust email)
 *
 * Returns UserContext or null if no valid identity found.
 */
export async function authenticateRequest(
  req: Request,
  pool: pg.Pool,
  legacyKey?: string,
): Promise<UserContext | null> {
  // 1. Bearer token (Phase 9c will add JWT verification here)
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // JWT verification will be added in Phase 9c.
    // For now, fall through to next method.
  }

  // 2. x-brain-key header → resolve to user via access_keys table
  const apiKey = req.headers['x-brain-key'] as string | undefined;
  if (apiKey) {
    const user = await resolveUserFromApiKey(apiKey, pool);
    if (user) return user;

    // Backward compat: legacy key matches BRAIN_ACCESS_KEY env but no user record yet
    if (legacyKey && verifyAccessKey(apiKey, legacyKey)) {
      return null; // Valid legacy key, no user identity
    }

    return null; // Invalid key
  }

  // 3. Cloudflare Zero Trust JWT
  const cfJwt = req.headers['cf-access-jwt-assertion'] as string | undefined;
  if (cfJwt) {
    try {
      const payloadB64 = cfJwt.split('.')[1];
      if (payloadB64) {
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
        if (payload.email) {
          return resolveUserFromEmail(payload.email, pool);
        }
      }
    } catch {
      // Invalid JWT format
    }
  }

  return null;
}

/**
 * Express middleware: requires authentication. Returns 401 if no valid identity.
 * Sets req.userContext on success.
 */
export function requireAuth(pool: pg.Pool, legacyKey?: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await authenticateRequest(req, pool, legacyKey);
      if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        logAudit(pool, {
          action: 'auth_failed',
          metadata: { reason: 'no_valid_identity', keyPrefix: (req.headers['x-brain-key'] as string)?.slice(0, 8) },
        });
        return;
      }

      req.userContext = user;
      next();
    } catch (err) {
      log.error({ err }, 'Auth middleware error');
      res.status(500).json({ error: 'Authentication error' });
    }
  };
}

/**
 * Express middleware: optional authentication. Sets req.userContext if identity found,
 * continues without if not. For MCP routes during OAuth transition.
 */
export function optionalAuth(pool: pg.Pool, legacyKey?: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const apiKey = req.headers['x-brain-key'] as string | undefined;
      if (apiKey) {
        const user = await resolveUserFromApiKey(apiKey, pool);
        if (user) {
          req.userContext = user;
        } else if (legacyKey && verifyAccessKey(apiKey, legacyKey)) {
          // Legacy key — valid but no user record. Allow through.
        } else {
          res.status(403).json({ error: 'Invalid API key' });
          return;
        }
      } else {
        const user = await authenticateRequest(req, pool, legacyKey);
        if (user) {
          req.userContext = user;
        }
      }
      next();
    } catch (err) {
      log.error({ err }, 'Optional auth error');
      next();
    }
  };
}

/**
 * Express middleware: requires admin or owner role. Must be used after requireAuth.
 */
export function requireAdmin() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.userContext) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (req.userContext.role !== 'owner' && req.userContext.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  };
}
