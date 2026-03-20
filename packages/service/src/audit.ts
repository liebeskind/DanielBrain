import type pg from 'pg';

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
    console.error('Audit log failed (non-fatal):', err.message);
  });
}
