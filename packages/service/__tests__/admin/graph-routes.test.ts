import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/parsers/index.js', () => ({
  parseFile: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual as object,
    default: {
      ...(actual as any),
      promises: {
        ...(actual as any).promises,
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    },
    promises: {
      ...(actual as any).promises,
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

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
  rawFilesDir: '/tmp/test-raw-files',
};

function getHandler(router: ReturnType<typeof createAdminRoutes>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  return layer.route.stack[0].handle;
}

describe('Graph API Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/graph/:entityId', () => {
    it('returns neighborhood graph for entity', async () => {
      const entityId = '11111111-1111-1111-1111-111111111111';
      const neighborId = '22222222-2222-2222-2222-222222222222';
      const edgeId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

      mockPool.query
        // Entity exists check
        .mockResolvedValueOnce({ rows: [{ id: entityId }] })
        // CTE query for top neighbors + edges
        .mockResolvedValueOnce({
          rows: [{
            id: edgeId, source_id: entityId, target_id: neighborId,
            weight: 5, description: 'works with',
          }]
        })
        // Nodes
        .mockResolvedValueOnce({
          rows: [
            { id: entityId, name: 'Alice', entity_type: 'person', mention_count: 10, profile_summary: 'A person', community_id: null },
            { id: neighborId, name: 'Topia', entity_type: 'company', mention_count: 20, profile_summary: 'A company', community_id: 'c1' },
          ]
        });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/graph/:entityId');

      const req = { params: { entityId }, query: {} };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith({
        center: entityId,
        nodes: expect.arrayContaining([
          expect.objectContaining({ name: 'Alice' }),
          expect.objectContaining({ name: 'Topia' }),
        ]),
        edges: [{ id: edgeId, source: entityId, target: neighborId, weight: 5, description: 'works with' }],
      });
    });

    it('returns 404 for missing entity', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/graph/:entityId');

      const req = { params: { entityId: 'nonexistent' }, query: {} };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('supports depth=2', async () => {
      const entityId = '11111111-1111-1111-1111-111111111111';

      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: entityId }] })
        .mockResolvedValueOnce({ rows: [] }) // CTE query for 2-hop
        .mockResolvedValueOnce({ rows: [{ id: entityId, name: 'Alice', entity_type: 'person', mention_count: 1, profile_summary: null, community_id: null }] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/graph/:entityId');

      const req = { params: { entityId }, query: { depth: '2' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ center: entityId }));
      // Both 1-hop and 2-hop use CTEs now; depth=2 uses 'hop1' CTE
      const secondCall = mockPool.query.mock.calls[1][0];
      expect(secondCall).toContain('hop1');
    });
  });

  describe('GET /api/graph (full)', () => {
    it('returns entities and edges above weight threshold', async () => {
      mockPool.query
        // Edges above min_weight
        .mockResolvedValueOnce({
          rows: [{ id: 'e1', source_id: 'n1', target_id: 'n2', weight: 3, description: null }]
        })
        // Nodes for those edges
        .mockResolvedValueOnce({
          rows: [
            { id: 'n1', name: 'Alice', entity_type: 'person', mention_count: 5, profile_summary: null, community_id: null },
            { id: 'n2', name: 'Topia', entity_type: 'company', mention_count: 10, profile_summary: null, community_id: null },
          ]
        });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/graph');

      const req = { query: { full: 'true' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith({
        center: null,
        nodes: expect.arrayContaining([
          expect.objectContaining({ name: 'Alice' }),
        ]),
        edges: [{ id: 'e1', source: 'n1', target: 'n2', weight: 3, description: null }],
      });
    });
  });

  describe('GET /api/entity/:entityId/detail', () => {
    it('returns entity detail with thoughts and connections', async () => {
      const entityId = '11111111-1111-1111-1111-111111111111';

      mockPool.query
        // Entity
        .mockResolvedValueOnce({
          rows: [{
            id: entityId, name: 'Alice', entity_type: 'person',
            canonical_name: 'alice', aliases: ['al'],
            profile_summary: 'A key person', mention_count: 15,
            last_seen_at: '2026-03-18', metadata: {},
            created_at: '2026-01-01', updated_at: '2026-03-18',
          }]
        })
        // Recent thoughts
        .mockResolvedValueOnce({
          rows: [{
            id: 't1', summary: 'Met with team', content_preview: 'Meeting notes...',
            thought_type: 'meeting_transcript', source: 'fathom',
            relationship: 'mentions', created_at: '2026-03-18',
          }]
        })
        // Connected entities
        .mockResolvedValueOnce({
          rows: [{
            id: 'n2', name: 'Topia', entity_type: 'company',
            shared_thought_count: '8', relationship_weight: '5',
            relationship_description: 'Alice works at Topia',
          }]
        })
        // Communities
        .mockResolvedValueOnce({
          rows: [{ id: 'c1', title: 'Engineering Team' }]
        });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entity/:entityId/detail');

      const req = { params: { entityId } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith({
        entity: expect.objectContaining({ name: 'Alice', entity_type: 'person' }),
        recent_thoughts: expect.arrayContaining([
          expect.objectContaining({ summary: 'Met with team' }),
        ]),
        connected_entities: expect.arrayContaining([
          expect.objectContaining({ name: 'Topia' }),
        ]),
        communities: [{ id: 'c1', title: 'Engineering Team' }],
      });
    });

    it('returns 404 for missing entity', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entity/:entityId/detail');

      const req = { params: { entityId: 'nonexistent' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
