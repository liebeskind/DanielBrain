import type pg from 'pg';
import { logger } from './logger.js';

export interface AuditEntry {
  userId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * Log a permission-sensitive operation to the audit table.
 * Fire-and-forget — never blocks the request, never propagates errors.
 */
export function logAudit(pool: pg.Pool, entry: AuditEntry): void {
  pool.query(
    `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.userId ?? null,
      entry.action,
      entry.resourceType ?? null,
      entry.resourceId ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : '{}',
      entry.ipAddress ?? null,
    ],
  ).catch((err) => {
    logger.warn({ err }, 'Audit log failed (non-fatal)');
  });
}

/** Extract client IP from an Express request */
export function getClientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}
