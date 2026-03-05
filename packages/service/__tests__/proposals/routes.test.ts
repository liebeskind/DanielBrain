import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProposalRoutes } from '../../src/proposals/routes.js';
import type { Request, Response } from 'express';

// Mock applier
vi.mock('../../src/proposals/applier.js', () => ({
  applyProposal: vi.fn(),
  revertProposal: vi.fn(),
}));

import { applyProposal, revertProposal } from '../../src/proposals/applier.js';

const mockPool = {
  query: vi.fn(),
};

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

// Extract route handlers from the router
function getHandler(router: ReturnType<typeof createProposalRoutes>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  return layer.route.stack[0].handle;
}

describe('Proposal Routes', () => {
  let router: ReturnType<typeof createProposalRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    router = createProposalRoutes(mockPool as any);
  });

  describe('GET /', () => {
    it('lists proposals with defaults and entity context', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{
            id: 'p-1', status: 'pending', entity_id: 'e-1',
            entity_name: 'Alice', entity_type: 'person', entity_profile: 'A person',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        // Thought excerpts query
        .mockResolvedValueOnce({
          rows: [{
            entity_id: 'e-1',
            entity_name: 'Alice',
            content: 'Met with Alice about the project to discuss next steps',
            summary: 'Discussion about project planning',
            source: 'slack',
            source_meta: { channel_name: 'general' },
            created_at: '2026-03-01T10:00:00Z',
          }],
        });

      const handler = getHandler(router, 'get', '/');
      const { req, res } = mockReqRes();

      await handler(req, res);

      const response = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.proposals[0].entity_context).toEqual({
        name: 'Alice',
        type: 'person',
        profile: 'A person',
        recent_excerpts: [{
          excerpt: 'Met with Alice about the project to discuss next steps',
          summary: 'Discussion about project planning',
          source: 'slack',
          source_meta: { channel_name: 'general' },
          created_at: '2026-03-01T10:00:00Z',
        }],
      });
    });

    it('filters by status', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      const handler = getHandler(router, 'get', '/');
      const { req, res } = mockReqRes({ query: { status: 'approved' } });

      await handler(req, res);

      const queryCall = mockPool.query.mock.calls[0];
      expect(queryCall[0]).toContain('p.status = $1');
      expect(queryCall[1][0]).toBe('approved');
    });

    it('filters by proposal_type', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      const handler = getHandler(router, 'get', '/');
      const { req, res } = mockReqRes({ query: { proposal_type: 'entity_link' } });

      await handler(req, res);

      const queryCall = mockPool.query.mock.calls[0];
      expect(queryCall[0]).toContain('p.proposal_type = $1');
    });
  });

  describe('GET /:id', () => {
    it('returns single proposal with entity info', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'p-1', entity_name: 'Alice', entity_type: 'person' }],
      });

      const handler = getHandler(router, 'get', '/:id');
      const { req, res } = mockReqRes({ params: { id: 'p-1' } });

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ entity_name: 'Alice' })
      );
    });

    it('returns 404 for unknown proposal', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const handler = getHandler(router, 'get', '/:id');
      const { req, res } = mockReqRes({ params: { id: 'nonexistent' } });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /:id/approve', () => {
    it('approves and applies non-auto-applied proposal', async () => {
      const proposal = {
        id: 'p-1',
        proposal_type: 'entity_enrichment',
        status: 'pending',
        auto_applied: false,
        proposed_data: { linkedin_url: 'https://linkedin.com/in/alice' },
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [proposal] }) // transition
        .mockResolvedValueOnce({ rows: [] }); // mark applied

      const handler = getHandler(router, 'post', '/:id/approve');
      const { req, res } = mockReqRes({ params: { id: 'p-1' } });

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'applied' })
      );
      expect(applyProposal).toHaveBeenCalledOnce();
    });

    it('approves auto-applied proposal without re-applying', async () => {
      const proposal = {
        id: 'p-1',
        proposal_type: 'entity_link',
        status: 'pending',
        auto_applied: true,
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [proposal] })
        .mockResolvedValueOnce({ rows: [] });

      const handler = getHandler(router, 'post', '/:id/approve');
      const { req, res } = mockReqRes({ params: { id: 'p-1' } });

      await handler(req, res);

      expect(applyProposal).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'applied' })
      );
    });

    it('returns 404 if proposal does not exist', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // transition fails
        .mockResolvedValueOnce({ rows: [] }); // not found

      const handler = getHandler(router, 'post', '/:id/approve');
      const { req, res } = mockReqRes({ params: { id: 'nonexistent' } });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 409 if proposal already processed', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // transition fails
        .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }); // exists

      const handler = getHandler(router, 'post', '/:id/approve');
      const { req, res } = mockReqRes({ params: { id: 'p-1' } });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('marks failed if apply throws', async () => {
      const proposal = {
        id: 'p-1',
        proposal_type: 'entity_enrichment',
        status: 'pending',
        auto_applied: false,
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [proposal] })
        .mockResolvedValueOnce({ rows: [] }); // mark failed

      (applyProposal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const handler = getHandler(router, 'post', '/:id/approve');
      const { req, res } = mockReqRes({ params: { id: 'p-1' } });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /:id/reject', () => {
    it('rejects non-auto-applied proposal without reverting', async () => {
      const proposal = {
        id: 'p-1',
        proposal_type: 'entity_enrichment',
        auto_applied: false,
      };

      mockPool.query.mockResolvedValueOnce({ rows: [proposal] });

      const handler = getHandler(router, 'post', '/:id/reject');
      const { req, res } = mockReqRes({
        params: { id: 'p-1' },
        body: { reviewer_notes: 'Wrong person' },
      });

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rejected' })
      );
      expect(revertProposal).not.toHaveBeenCalled();
    });

    it('rejects auto-applied proposal and reverts', async () => {
      const proposal = {
        id: 'p-1',
        proposal_type: 'entity_link',
        auto_applied: true,
      };

      mockPool.query.mockResolvedValueOnce({ rows: [proposal] });

      const handler = getHandler(router, 'post', '/:id/reject');
      const { req, res } = mockReqRes({ params: { id: 'p-1' } });

      await handler(req, res);

      expect(revertProposal).toHaveBeenCalledOnce();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rejected' })
      );
    });

    it('returns 404 if proposal does not exist', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const handler = getHandler(router, 'post', '/:id/reject');
      const { req, res } = mockReqRes({ params: { id: 'nonexistent' } });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /:id/needs-changes', () => {
    it('marks proposal as needs_changes', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'p-1' }] });

      const handler = getHandler(router, 'post', '/:id/needs-changes');
      const { req, res } = mockReqRes({
        params: { id: 'p-1' },
        body: { reviewer_notes: 'Please verify' },
      });

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'needs_changes' })
      );
    });

    it('returns 409 if already processed', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ status: 'rejected' }] });

      const handler = getHandler(router, 'post', '/:id/needs-changes');
      const { req, res } = mockReqRes({ params: { id: 'p-1' } });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
    });
  });
});
