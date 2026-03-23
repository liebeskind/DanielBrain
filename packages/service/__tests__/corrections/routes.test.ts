import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCorrectionRoutes } from '../../src/corrections/routes.js';
import type { Request, Response } from 'express';

vi.mock('../../src/corrections/store.js', () => ({
  createCorrectionExample: vi.fn().mockResolvedValue('ce-1'),
  listCorrectionExamples: vi.fn().mockResolvedValue({ examples: [], total: 0 }),
  deleteCorrectionExample: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { createCorrectionExample, listCorrectionExamples, deleteCorrectionExample } from '../../src/corrections/store.js';

const mockPool = { query: vi.fn() };

function mockReqRes(overrides: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
} = {}) {
  const req = {
    params: overrides.params || {},
    query: overrides.query || {},
    body: overrides.body || {},
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as Response;

  return { req, res };
}

function getHandler(router: ReturnType<typeof createCorrectionRoutes>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  return layer?.route.stack[0].handle;
}

describe('corrections/routes', () => {
  let router: ReturnType<typeof createCorrectionRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    router = createCorrectionRoutes(mockPool as any);
  });

  describe('GET /', () => {
    it('lists correction examples', async () => {
      (listCorrectionExamples as any).mockResolvedValueOnce({
        examples: [{ id: 'ce-1', category: 'linkedin_search' }],
        total: 1,
      });

      const { req, res } = mockReqRes({ query: {} });
      const handler = getHandler(router, 'get', '/');
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ total: 1 })
      );
    });

    it('passes category filter', async () => {
      const { req, res } = mockReqRes({ query: { category: 'entity_link' } });
      const handler = getHandler(router, 'get', '/');
      await handler(req, res);

      expect(listCorrectionExamples).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'entity_link' }),
        mockPool,
      );
    });

    it('returns 400 for invalid category', async () => {
      const { req, res } = mockReqRes({ query: { category: 'invalid' } });
      const handler = getHandler(router, 'get', '/');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('POST /', () => {
    it('creates a correction example', async () => {
      const { req, res } = mockReqRes({
        body: {
          category: 'linkedin_search',
          input_context: { entity_name: 'Test' },
          expected_output: { linkedin_url: 'https://linkedin.com/in/test' },
        },
      });

      const handler = getHandler(router, 'post', '/');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ id: 'ce-1' });
    });

    it('returns 400 for missing required fields', async () => {
      const { req, res } = mockReqRes({
        body: { category: 'linkedin_search' },
      });

      const handler = getHandler(router, 'post', '/');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for invalid category', async () => {
      const { req, res } = mockReqRes({
        body: {
          category: 'invalid',
          input_context: {},
          expected_output: {},
        },
      });

      const handler = getHandler(router, 'post', '/');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('DELETE /:id', () => {
    it('deletes a correction example', async () => {
      const { req, res } = mockReqRes({ params: { id: 'ce-1' } });
      const handler = getHandler(router, 'delete', '/:id');
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it('returns 404 when not found', async () => {
      (deleteCorrectionExample as any).mockResolvedValueOnce(false);

      const { req, res } = mockReqRes({ params: { id: 'ce-999' } });
      const handler = getHandler(router, 'delete', '/:id');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
