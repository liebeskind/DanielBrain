import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logAudit } from '../src/audit.js';

const mockPool = {
  query: vi.fn(),
};

describe('logAudit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts audit entry with all fields', () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    logAudit(mockPool as any, {
      userId: 'u1',
      action: 'search',
      resourceType: 'thought',
      resourceId: 't1',
      metadata: { query: 'test', resultCount: 5 },
      ipAddress: '127.0.0.1',
    });

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO audit_log');
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe('search');
    expect(params[2]).toBe('thought');
    expect(params[3]).toBe('t1');
    expect(params[4]).toContain('resultCount');
    expect(params[5]).toBe('127.0.0.1');
  });

  it('handles null fields gracefully', () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    logAudit(mockPool as any, {
      action: 'auth',
    });

    const params = mockPool.query.mock.calls[0][1];
    expect(params[0]).toBeNull(); // userId
    expect(params[2]).toBeNull(); // resourceType
    expect(params[3]).toBeNull(); // resourceId
    expect(params[5]).toBeNull(); // ipAddress
  });

  it('does not throw on DB error (fire-and-forget)', () => {
    mockPool.query.mockRejectedValueOnce(new Error('DB down'));

    // Should not throw
    expect(() => {
      logAudit(mockPool as any, { action: 'test' });
    }).not.toThrow();
  });
});
