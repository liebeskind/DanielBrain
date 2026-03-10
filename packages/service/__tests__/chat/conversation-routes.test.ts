import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConversationRoutes, generateTitle } from '../../src/chat/conversation-routes.js';

// Mock dependencies
vi.mock('../../src/chat/context-builder.js', () => ({
  buildContext: vi.fn().mockResolvedValue({
    contextText: 'test context',
    sources: [{ id: '1', summary: 'test', source: 'slack', similarity: 0.8 }],
    entities: [],
  }),
}));

vi.mock('../../src/chat/ollama-stream.js', () => ({
  streamChat: vi.fn(async (_msgs: unknown, _model: unknown, _url: unknown, res: { write: (d: string) => void; end: () => void }) => {
    res.write('data: {"token":"hello"}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return { fullResponse: 'hello' };
  }),
}));

const mockQuery = vi.fn();
const mockPool = { query: mockQuery } as unknown as import('pg').Pool;
const mockConfig = {
  databaseUrl: 'postgres://test',
  brainAccessKey: 'test',
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.1:8b',
  chatModel: 'llama4:scout',
  mcpPort: 3000,
  pollIntervalMs: 5000,
  batchSize: 5,
  maxRetries: 3,
} as import('../../src/config.js').Config;

function getHandler(router: ReturnType<typeof createConversationRoutes>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe('conversation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it('lists active conversations sorted by recency', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'get', '/');
      const conversations = [
        { id: '1', title: 'Chat 1', project_id: null, created_at: new Date(), updated_at: new Date() },
      ];
      mockQuery.mockResolvedValueOnce({ rows: conversations });

      const res = { json: vi.fn() };
      await handler({ query: {} } as any, res as any);

      expect(mockQuery).toHaveBeenCalled();
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('is_deleted = FALSE');
      expect(sql).toContain('ORDER BY updated_at DESC');
      expect(res.json).toHaveBeenCalledWith(conversations);
    });

    it('filters by project_id when provided', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'get', '/');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = { json: vi.fn() };
      await handler({ query: { project_id: 'proj-1' } } as any, res as any);

      const params = mockQuery.mock.calls[0][1];
      expect(params).toContain('proj-1');
    });
  });

  describe('POST /', () => {
    it('creates a conversation', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/');
      const newConv = { id: '1', title: null, project_id: null, created_at: new Date(), updated_at: new Date() };
      mockQuery.mockResolvedValueOnce({ rows: [newConv] });

      const res = { json: vi.fn() };
      await handler({ body: {} } as any, res as any);

      expect(res.json).toHaveBeenCalledWith(newConv);
    });
  });

  describe('GET /:id/messages', () => {
    it('returns messages in chronological order', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'get', '/:id/messages');
      const messages = [
        { id: 'm1', role: 'user', content: 'hi', context_data: null, created_at: new Date() },
        { id: 'm2', role: 'assistant', content: 'hello', context_data: { sources: [], entities: [] }, created_at: new Date() },
      ];
      mockQuery.mockResolvedValueOnce({ rows: messages });

      const res = { json: vi.fn() };
      await handler({ params: { id: 'conv-1' } } as any, res as any);

      expect(mockQuery.mock.calls[0][1]).toContain('conv-1');
      expect(res.json).toHaveBeenCalledWith(messages);
    });
  });

  describe('PATCH /:id', () => {
    it('renames a conversation', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'patch', '/:id');
      const updated = { id: '1', title: 'New Title', project_id: null, created_at: new Date(), updated_at: new Date() };
      mockQuery.mockResolvedValueOnce({ rows: [updated] });

      const res = { json: vi.fn() };
      await handler({ params: { id: '1' }, body: { title: 'New Title' } } as any, res as any);

      expect(res.json).toHaveBeenCalledWith(updated);
    });

    it('returns 400 when no fields provided', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'patch', '/:id');

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { id: '1' }, body: {} } as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 404 when conversation not found', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'patch', '/:id');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { id: 'nonexistent' }, body: { title: 'x' } } as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /:id', () => {
    it('soft deletes a conversation', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'delete', '/:id');
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = { json: vi.fn() };
      await handler({ params: { id: '1' } } as any, res as any);

      expect(res.json).toHaveBeenCalledWith({ ok: true });
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('is_deleted = TRUE');
    });

    it('returns 404 when already deleted', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'delete', '/:id');
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { id: '1' } } as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /:id/messages', () => {
    it('returns 400 when message is missing', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/:id/messages');

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { id: '1' }, body: {} } as any, res as any);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 404 when conversation not found', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/:id/messages');
      mockQuery.mockResolvedValueOnce({ rows: [] }); // conversation check

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { id: 'nonexistent' }, body: { message: 'hi' } } as any, res as any);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('saves messages and streams response', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/:id/messages');

      // Mock sequence: conv check, save user msg, load history, save assistant msg, count msgs, update conv
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] }) // conv exists
        .mockResolvedValueOnce({ rows: [] }) // insert user msg
        .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'hi' }] }) // history
        .mockResolvedValueOnce({ rows: [] }) // insert assistant msg
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // message count
        .mockResolvedValueOnce({ rows: [] }) // update title
        .mockResolvedValueOnce({ rows: [] }); // update conv timestamp

      const written: string[] = [];
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn((d: string) => written.push(d)),
        end: vi.fn(),
        writableEnded: false,
      };

      await handler({ params: { id: 'conv-1' }, body: { message: 'hi' } } as any, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(written[0]).toContain('"type":"context"');
    });
  });
});

describe('generateTitle', () => {
  it('returns short messages as-is', () => {
    expect(generateTitle('Hello world')).toBe('Hello world');
  });

  it('truncates long messages at word boundary', () => {
    const long = 'This is a very long message that should be truncated at a word boundary somewhere around sixty characters';
    const result = generateTitle(long);
    expect(result.length).toBeLessThanOrEqual(63); // 60 + '...'
    expect(result).toContain('...');
  });

  it('collapses whitespace', () => {
    expect(generateTitle('  hello   world  ')).toBe('hello world');
  });
});
