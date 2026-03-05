import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminRoutes } from '../../src/admin/routes.js';

const mockPool = {
  query: vi.fn(),
};

function getHandler(router: ReturnType<typeof createAdminRoutes>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  return layer.route.stack[0].handle;
}

describe('Admin Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/entities/stats', () => {
    it('returns entity stats', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ entity_type: 'person', count: '5' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', mention_count: 10, last_seen_at: '2025-01-01' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', mention_count: 10 }] })
        .mockResolvedValueOnce({ rows: [{ status: 'pending', count: '3' }] });

      const router = createAdminRoutes(mockPool as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await handler({} as any, res as any);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type_counts: [{ entity_type: 'person', count: '5' }],
          recent_entities: expect.any(Array),
          top_entities: expect.any(Array),
          proposal_counts: expect.any(Array),
        })
      );
    });

    it('handles database errors', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('DB down'));

      const router = createAdminRoutes(mockPool as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await handler({} as any, res as any);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
