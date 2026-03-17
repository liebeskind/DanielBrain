import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminRoutes } from '../../src/admin/routes.js';

const mockPool = {
  query: vi.fn(),
};

const baseConfig = {
  databaseUrl: 'postgres://localhost/test',
  brainAccessKey: 'test-key',
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
  chatModel: 'llama3.3:70b',
  mcpPort: 3000,
  pollIntervalMs: 5000,
  batchSize: 5,
  maxRetries: 3,
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
        .mockResolvedValueOnce({ rows: [{ status: 'pending', count: '3' }] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await handler({} as any, res as any);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type_counts: [{ entity_type: 'person', count: '5' }],
          entities: expect.any(Array),
          proposal_counts: expect.any(Array),
        })
      );
    });

    it('handles database errors', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('DB down'));

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await handler({} as any, res as any);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /api/integrations/stats', () => {
    it('returns integration stats for all sources', async () => {
      // Promise.all means queries interleave unpredictably.
      // Use mockImplementation to return based on query content.
      mockPool.query.mockImplementation((sql: string) => {
        if (sql.includes('COUNT(DISTINCT t.id)')) {
          return Promise.resolve({
            rows: [{
              thought_count: '10',
              entity_count: '5',
              people_count: '3',
              company_count: '2',
              first_pulled: '2025-01-01',
              last_pulled: '2025-06-01',
            }],
          });
        }
        if (sql.includes('action_item_count')) {
          return Promise.resolve({
            rows: [{ action_item_count: '4' }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const config = { ...baseConfig, fathomApiKey: 'fk_test', fathomWebhookSecret: 'whsec_test' };
      const router = createAdminRoutes(mockPool as any, config as any);
      const handler = getHandler(router, 'get', '/api/integrations/stats');

      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await handler({} as any, res as any);

      expect(res.json).toHaveBeenCalledTimes(1);
      const integrations = res.json.mock.calls[0][0];
      expect(integrations).toHaveLength(4);

      const fathom = integrations.find((i: any) => i.id === 'fathom');
      expect(fathom.enabled).toBe(true);
      expect(fathom.can_pull).toBe(true);
      expect(fathom.stats.thought_count).toBe(10);
      expect(fathom.stats.action_item_count).toBe(4);

      const slack = integrations.find((i: any) => i.id === 'slack');
      expect(slack.enabled).toBe(false);
      expect(slack.can_pull).toBe(false);

      const manual = integrations.find((i: any) => i.id === 'manual');
      expect(manual.enabled).toBe(true);
    });
  });

  describe('POST /api/integrations/:id/pull', () => {
    it('returns 400 when Fathom is not configured', async () => {
      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'post', '/api/integrations/:id/pull');

      const req = { params: { id: 'fathom' } };
      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Fathom API key not configured' });
    });

    it('returns 400 for unsupported integration pull', async () => {
      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'post', '/api/integrations/:id/pull');

      const req = { params: { id: 'slack' } };
      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Integration 'slack' does not support pull" });
    });
  });

  describe('GET /api/proposals/stats', () => {
    it('returns proposal status and type counts', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ status: 'pending', count: '5' }, { status: 'applied', count: '3' }] })
        .mockResolvedValueOnce({ rows: [{ proposal_type: 'entity_enrichment', count: '6' }] })
        .mockResolvedValueOnce({ rows: [{ total: '8', pending: '5' }] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/proposals/stats');

      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await handler({} as any, res as any);

      expect(res.json).toHaveBeenCalledWith({
        status_counts: [{ status: 'pending', count: '5' }, { status: 'applied', count: '3' }],
        type_counts: [{ proposal_type: 'entity_enrichment', count: '6' }],
        total: 8,
        pending: 5,
      });
    });
  });

  describe('GET /api/corrections/stats', () => {
    it('returns correction category counts', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ category: 'linkedin_search', count: '4' }] })
        .mockResolvedValueOnce({ rows: [{ total: '4' }] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/corrections/stats');

      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await handler({} as any, res as any);

      expect(res.json).toHaveBeenCalledWith({
        category_counts: [{ category: 'linkedin_search', count: '4' }],
        total: 4,
      });
    });
  });
});
