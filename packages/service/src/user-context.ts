import crypto from 'node:crypto';
import type pg from 'pg';
import type { Role, UserContext } from '@danielbrain/shared';

/**
 * Build the set of visibility tags a user can see.
 * - Everyone sees 'company' tagged content
 * - Everyone sees their own 'user:<id>' tagged content
 * - Owners see all content (visibilityTags = null → no filtering)
 */
export function buildVisibilityTags(user: { userId: string; role: Role }): string[] {
  if (user.role === 'owner') {
    // Owners see everything — return empty array, interpreted as "no filtering" by query layer
    return [];
  }
  return ['company', `user:${user.userId}`];
}

/**
 * System user for background operations — full visibility, no restrictions.
 */
export const SYSTEM_USER: UserContext = {
  userId: '00000000-0000-0000-0000-000000000000',
  email: 'system@internal',
  displayName: 'System',
  role: 'owner',
  visibilityTags: [], // empty = no filtering
};

/**
 * Resolve a user from an API key. SHA-256 hash lookup in access_keys → join users.
 * Returns null if key is invalid or user is inactive.
 */
export async function resolveUserFromApiKey(
  rawKey: string,
  pool: pg.Pool,
): Promise<UserContext | null> {
  if (!rawKey || rawKey.length === 0) return null;

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role
     FROM access_keys ak
     JOIN users u ON u.id = ak.user_id
     WHERE ak.key_hash = $1
       AND ak.active = true
       AND u.active = true
       AND (ak.expires_at IS NULL OR ak.expires_at > NOW())`,
    [keyHash],
  );

  if (rows.length === 0) return null;

  const user = rows[0];

  // Update last_used (fire-and-forget)
  pool.query(`UPDATE access_keys SET last_used = NOW() WHERE key_hash = $1`, [keyHash]).catch(() => {});

  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role as Role,
    visibilityTags: buildVisibilityTags({ userId: user.id, role: user.role as Role }),
  };
}

/**
 * Resolve a user from an email address (Cloudflare Zero Trust JWT).
 */
export async function resolveUserFromEmail(
  email: string,
  pool: pg.Pool,
): Promise<UserContext | null> {
  if (!email) return null;

  const { rows } = await pool.query(
    `SELECT id, email, display_name, role FROM users WHERE email = $1 AND active = true`,
    [email.toLowerCase()],
  );

  if (rows.length === 0) return null;

  const user = rows[0];
  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role as Role,
    visibilityTags: buildVisibilityTags({ userId: user.id, role: user.role as Role }),
  };
}

/**
 * Generate a new API key, store its SHA-256 hash linked to a user.
 * Returns the raw key (shown once) and the record ID.
 */
export async function generateApiKey(
  userId: string,
  name: string,
  pool: pg.Pool,
): Promise<{ rawKey: string; keyId: string }> {
  const rawKey = crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const { rows } = await pool.query(
    `INSERT INTO access_keys (name, key_hash, user_id, scopes)
     VALUES ($1, $2, $3, '{owner}')
     RETURNING id`,
    [name, keyHash, userId],
  );

  return { rawKey, keyId: rows[0].id };
}
