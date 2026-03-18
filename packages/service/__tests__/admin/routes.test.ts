import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminRoutes } from '../../src/admin/routes.js';

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

import { parseFile } from '../../src/parsers/index.js';
const mockParseFile = vi.mocked(parseFile);

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

describe('Admin Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/entities/stats', () => {
    it('returns entity stats with pagination', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ entity_type: 'person', count: '5' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', mention_count: 10, last_seen_at: '2025-01-01', relationship_count: 3, input_count: 7 }] })
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [{ status: 'pending', count: '3' }] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const req = { query: {} };
      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type_counts: [{ entity_type: 'person', count: '5' }],
          entities: expect.arrayContaining([
            expect.objectContaining({ relationship_count: 3, input_count: 7 }),
          ]),
          total: 1,
          limit: 30,
          proposal_counts: expect.any(Array),
        })
      );
    });

    it('filters by entity_type', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ entity_type: 'person', count: '5' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const req = { query: { entity_type: 'person' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      // The entity query (2nd call) should include entity_type filter
      const entityQuery = mockPool.query.mock.calls[1][0];
      expect(entityQuery).toContain('e.entity_type = $1');
      const entityParams = mockPool.query.mock.calls[1][1];
      expect(entityParams[0]).toBe('person');
    });

    it('ignores invalid entity_type filter', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const req = { query: { entity_type: 'invalid_type' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      const entityQuery = mockPool.query.mock.calls[1][0];
      expect(entityQuery).not.toContain('e.entity_type = $');
    });

    it('sorts by relationships', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const req = { query: { sort: 'relationships' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      const entityQuery = mockPool.query.mock.calls[1][0];
      expect(entityQuery).toContain('ORDER BY relationship_count DESC');
    });

    it('sorts by inputs', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const req = { query: { sort: 'inputs' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      const entityQuery = mockPool.query.mock.calls[1][0];
      expect(entityQuery).toContain('ORDER BY input_count DESC');
    });

    it('handles database errors', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('DB down'));

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/stats');

      const req = { query: {} };
      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await handler(req as any, res as any);

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
        if (sql.includes('pending_count')) {
          return Promise.resolve({
            rows: [{ pending_count: '2' }],
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

  describe('GET /api/health/stats', () => {
    it('returns queue status counts and failed items', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ status: 'pending', count: '2' }, { status: 'failed', count: '1' }, { status: 'completed', count: '50' }] })
        .mockResolvedValueOnce({ rows: [{ count: '3' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'f1', source: 'fathom', source_id: 'rec-1', error: 'timeout', attempts: 3, created_at: '2026-03-17', processed_at: '2026-03-17' }] })
        .mockResolvedValueOnce({ rows: [] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/health/stats');

      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await handler({} as any, res as any);

      const data = res.json.mock.calls[0][0];
      expect(data.queue.pending).toBe(2);
      expect(data.queue.failed).toBe(1);
      expect(data.queue.completed).toBe(50);
      expect(data.extraction_gaps).toBe(3);
      expect(data.failed_items).toHaveLength(1);
      expect(data.failed_items[0].source).toBe('fathom');
      expect(typeof data.ollama_available).toBe('boolean');
    });
  });

  describe('POST /api/health/retry-all', () => {
    it('resets all failed items to pending', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 5 });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'post', '/api/health/retry-all');

      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await handler({} as any, res as any);

      expect(res.json).toHaveBeenCalledWith({ ok: true, count: 5 });
      const sql = mockPool.query.mock.calls[0][0];
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain('retry_after = NULL');
    });
  });

  describe('POST /api/health/retry/:id', () => {
    it('retries a single failed item', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'post', '/api/health/retry/:id');

      const req = { params: { id: 'q-uuid-1' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it('returns 404 for non-existent item', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 0 });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'post', '/api/health/retry/:id');

      const req = { params: { id: 'nonexistent' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
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

  describe('POST /api/ingest/file', () => {
    function getFileHandler(router: ReturnType<typeof createAdminRoutes>) {
      // The file upload route has multer middleware, so we get the last handler in the stack
      const layer = (router as any).stack.find(
        (l: any) => l.route && l.route.path === '/api/ingest/file' && l.route.methods.post
      );
      if (!layer) throw new Error('No route POST /api/ingest/file');
      // Return the last handler (after multer middleware)
      const handlers = layer.route.stack;
      return handlers[handlers.length - 1].handle;
    }

    it('queues a successfully parsed file', async () => {
      mockParseFile.mockResolvedValueOnce({
        text: 'Extracted document text content here.',
        title: 'My Report',
        pageCount: 5,
        author: 'Alice',
      });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'q-123' }] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getFileHandler(router);

      const req = {
        file: {
          buffer: Buffer.from('fake-pdf'),
          originalname: 'report.pdf',
          mimetype: 'application/pdf',
          size: 1024,
        },
        body: {},
      };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'q-123',
          status: 'queued',
          title: 'My Report',
          pageCount: 5,
        })
      );

      // Verify queue insert was called with parsed text
      const insertCall = mockPool.query.mock.calls[0];
      expect(insertCall[0]).toContain('INSERT INTO queue');
      expect(insertCall[1][0]).toBe('Extracted document text content here.');
      const meta = JSON.parse(insertCall[1][1]);
      expect(meta.title).toBe('My Report');
      expect(meta.author).toBe('Alice');
      expect(meta.file_type).toBe('pdf');
    });

    it('returns 400 when no file is provided', async () => {
      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getFileHandler(router);

      const req = { file: undefined, body: {} };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No file provided' });
    });

    it('returns 400 when parsed text is empty', async () => {
      mockParseFile.mockResolvedValueOnce({ text: '   ' });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getFileHandler(router);

      const req = {
        file: { buffer: Buffer.from('empty'), originalname: 'empty.pdf', mimetype: 'application/pdf', size: 100 },
        body: {},
      };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No text content extracted from file' });
    });

    it('returns 400 for scanned PDF error', async () => {
      mockParseFile.mockRejectedValueOnce(new Error('This PDF appears to be scanned/image-only.'));

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getFileHandler(router);

      const req = {
        file: { buffer: Buffer.from('scanned'), originalname: 'scan.pdf', mimetype: 'application/pdf', size: 100 },
        body: {},
      };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].error).toContain('scanned');
    });

    it('prepends context note to content', async () => {
      mockParseFile.mockResolvedValueOnce({ text: 'Document content.' });
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'q-456' }] });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getFileHandler(router);

      const req = {
        file: { buffer: Buffer.from('data'), originalname: 'doc.docx', mimetype: 'application/octet-stream', size: 200 },
        body: { context_note: 'Board deck from Q4 meeting' },
      };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      const insertedContent = mockPool.query.mock.calls[0][1][0];
      expect(insertedContent).toBe('[Context: Board deck from Q4 meeting]\n\nDocument content.');
    });
  });

  describe('GET /api/entities/search', () => {
    it('returns matching entities', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'e1', name: 'Chris Psiaki', entity_type: 'person' },
          { id: 'e2', name: 'Christine Lee', entity_type: 'person' },
        ],
      });

      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/search');

      const req = { query: { q: 'chris' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith([
        { id: 'e1', name: 'Chris Psiaki', entity_type: 'person' },
        { id: 'e2', name: 'Christine Lee', entity_type: 'person' },
      ]);
    });

    it('returns empty array for short query', async () => {
      const router = createAdminRoutes(mockPool as any, baseConfig as any);
      const handler = getHandler(router, 'get', '/api/entities/search');

      const req = { query: { q: 'a' } };
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

      await handler(req as any, res as any);

      expect(res.json).toHaveBeenCalledWith([]);
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });
});
