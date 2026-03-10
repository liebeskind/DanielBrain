import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProjectRoutes } from '../../src/chat/project-routes.js';

const mockQuery = vi.fn();
const mockPool = { query: mockQuery } as unknown as import('pg').Pool;

function getHandler(router: ReturnType<typeof createProjectRoutes>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe('project routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it('lists active projects sorted by name', async () => {
      const router = createProjectRoutes(mockPool);
      const handler = getHandler(router, 'get', '/');
      const projects = [{ id: '1', name: 'Alpha', created_at: new Date(), updated_at: new Date() }];
      mockQuery.mockResolvedValueOnce({ rows: projects });

      const res = { json: vi.fn() };
      await handler({} as any, res as any);

      expect(res.json).toHaveBeenCalledWith(projects);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('is_deleted = FALSE');
    });
  });

  describe('POST /', () => {
    it('creates a project', async () => {
      const router = createProjectRoutes(mockPool);
      const handler = getHandler(router, 'post', '/');
      const newProj = { id: '1', name: 'My Project', created_at: new Date(), updated_at: new Date() };
      mockQuery.mockResolvedValueOnce({ rows: [newProj] });

      const res = { json: vi.fn() };
      await handler({ body: { name: 'My Project' } } as any, res as any);

      expect(res.json).toHaveBeenCalledWith(newProj);
    });

    it('returns 400 when name is missing', async () => {
      const router = createProjectRoutes(mockPool);
      const handler = getHandler(router, 'post', '/');

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ body: {} } as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('PATCH /:id', () => {
    it('renames a project', async () => {
      const router = createProjectRoutes(mockPool);
      const handler = getHandler(router, 'patch', '/:id');
      const updated = { id: '1', name: 'New Name', created_at: new Date(), updated_at: new Date() };
      mockQuery.mockResolvedValueOnce({ rows: [updated] });

      const res = { json: vi.fn() };
      await handler({ params: { id: '1' }, body: { name: 'New Name' } } as any, res as any);

      expect(res.json).toHaveBeenCalledWith(updated);
    });

    it('returns 404 when not found', async () => {
      const router = createProjectRoutes(mockPool);
      const handler = getHandler(router, 'patch', '/:id');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { id: 'x' }, body: { name: 'x' } } as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /:id', () => {
    it('soft deletes and unassigns conversations', async () => {
      const router = createProjectRoutes(mockPool);
      const handler = getHandler(router, 'delete', '/:id');
      mockQuery
        .mockResolvedValueOnce({ rowCount: 2 }) // unassign conversations
        .mockResolvedValueOnce({ rowCount: 1 }); // delete project

      const res = { json: vi.fn() };
      await handler({ params: { id: '1' } } as any, res as any);

      expect(res.json).toHaveBeenCalledWith({ ok: true });
      // Should unassign conversations first
      const unassignSql = mockQuery.mock.calls[0][0];
      expect(unassignSql).toContain('project_id = NULL');
    });

    it('returns 404 when not found', async () => {
      const router = createProjectRoutes(mockPool);
      const handler = getHandler(router, 'delete', '/:id');
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0 }) // unassign
        .mockResolvedValueOnce({ rowCount: 0 }); // delete

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { id: 'x' } } as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
