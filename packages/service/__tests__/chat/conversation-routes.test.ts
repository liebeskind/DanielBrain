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

vi.mock('../../src/ollama-mutex.js', () => ({
  acquireOllama: vi.fn().mockReturnValue(true),
  releaseOllama: vi.fn(),
}));

import { acquireOllama, releaseOllama } from '../../src/ollama-mutex.js';
const mockAcquire = vi.mocked(acquireOllama);
const mockRelease = vi.mocked(releaseOllama);

const mockQuery = vi.fn();
const mockPool = { query: mockQuery } as unknown as import('pg').Pool;
const mockConfig = {
  databaseUrl: 'postgres://test',
  brainAccessKey: 'test',
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
  chatModel: 'llama3.3:70b',
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

      // Verify mutex is acquired and released
      expect(mockAcquire).toHaveBeenCalledWith('chat');
      expect(mockRelease).toHaveBeenCalledWith('chat');
    });
  });

  describe('POST /:id/messages (SSE)', () => {
    it('sets correct SSE headers', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/:id/messages');

      // Conversation exists
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] }) // conv check
        .mockResolvedValueOnce({ rows: [] }) // insert user msg
        .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'hi' }] }) // history
        .mockResolvedValueOnce({ rows: [] }) // insert assistant msg
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // count
        .mockResolvedValueOnce({ rows: [] }) // update title
        .mockResolvedValueOnce({ rows: [] }); // update timestamp

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
      };

      await handler({ params: { id: 'conv-1' }, body: { message: 'test' } } as any, res as any);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
      expect(res.flushHeaders).toHaveBeenCalled();
    });

    it('auto-titles on first exchange (2 messages)', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/:id/messages');

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] }) // conv check
        .mockResolvedValueOnce({ rows: [] }) // insert user msg
        .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'What are the Q1 priorities for the engineering team?' }] }) // history
        .mockResolvedValueOnce({ rows: [] }) // insert assistant msg
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // count = 2 → first exchange
        .mockResolvedValueOnce({ rows: [] }) // update title
        .mockResolvedValueOnce({ rows: [] }); // update timestamp

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
      };

      await handler({
        params: { id: 'conv-1' },
        body: { message: 'What are the Q1 priorities for the engineering team?' },
      } as any, res as any);

      // Find the UPDATE conversations SET title call
      const titleUpdateCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('SET title') && call[0].includes('title IS NULL')
      );
      expect(titleUpdateCall).toBeDefined();
      // Title should be the user message (or truncated)
      expect(titleUpdateCall![1][0]).toContain('Q1 priorities');
    });

    it('does not auto-title on subsequent exchanges', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/:id/messages');

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] }) // conv check
        .mockResolvedValueOnce({ rows: [] }) // insert user msg
        .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }] }) // history
        .mockResolvedValueOnce({ rows: [] }) // insert assistant msg
        .mockResolvedValueOnce({ rows: [{ count: '4' }] }) // count = 4 → not first exchange
        .mockResolvedValueOnce({ rows: [] }); // update timestamp

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
      };

      await handler({ params: { id: 'conv-1' }, body: { message: 'more' } } as any, res as any);

      // Should NOT find a title update call
      const titleUpdateCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('SET title') && call[0].includes('title IS NULL')
      );
      expect(titleUpdateCall).toBeUndefined();
    });

    it('sends LLM busy error when mutex unavailable', async () => {
      mockAcquire.mockReturnValueOnce(false);
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/:id/messages');

      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] }); // conv check

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

      expect(written.some(w => w.includes('LLM is busy'))).toBe(true);
      expect(res.end).toHaveBeenCalled();
    });

    it('releases ollama mutex even on error', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/:id/messages');

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'conv-1' }] }) // conv check
        .mockRejectedValueOnce(new Error('DB insert failed')); // save user msg fails

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        writableEnded: false,
      };

      await handler({ params: { id: 'conv-1' }, body: { message: 'hi' } } as any, res as any);

      expect(mockRelease).toHaveBeenCalledWith('chat');
    });
  });

  describe('GET / (list)', () => {
    it('caps limit at 100', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'get', '/');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = { json: vi.fn() };
      await handler({ query: { limit: '999' } } as any, res as any);

      const params = mockQuery.mock.calls[0][1];
      // Last param is the limit, capped at 100
      const limitParam = params[params.length - 1];
      expect(limitParam).toBeLessThanOrEqual(100);
    });

    it('scopes to user when userContext is present', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'get', '/');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = { json: vi.fn() };
      await handler({
        query: {},
        userContext: { userId: 'u1', role: 'member', visibilityTags: ['company', 'user:u1'] },
      } as any, res as any);

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('user_id = $');
    });
  });

  describe('POST / (create)', () => {
    it('passes title and project_id to insert', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/');
      const newConv = { id: '1', title: 'My Chat', project_id: 'proj-1', created_at: new Date(), updated_at: new Date() };
      mockQuery.mockResolvedValueOnce({ rows: [newConv] });

      const res = { json: vi.fn() };
      await handler({ body: { title: 'My Chat', project_id: 'proj-1' } } as any, res as any);

      const params = mockQuery.mock.calls[0][1];
      expect(params[0]).toBe('My Chat');
      expect(params[1]).toBe('proj-1');
    });

    it('handles null title and project_id', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'post', '/');
      const newConv = { id: '2', title: null, project_id: null, created_at: new Date(), updated_at: new Date() };
      mockQuery.mockResolvedValueOnce({ rows: [newConv] });

      const res = { json: vi.fn() };
      await handler({ body: {} } as any, res as any);

      const params = mockQuery.mock.calls[0][1];
      expect(params[0]).toBeNull();
      expect(params[1]).toBeNull();
    });
  });

  describe('PATCH /:id', () => {
    it('updates project_id', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'patch', '/:id');
      const updated = { id: '1', title: 'Chat', project_id: 'proj-2', created_at: new Date(), updated_at: new Date() };
      mockQuery.mockResolvedValueOnce({ rows: [updated] });

      const res = { json: vi.fn() };
      await handler({ params: { id: '1' }, body: { project_id: 'proj-2' } } as any, res as any);

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('project_id');
      expect(res.json).toHaveBeenCalledWith(updated);
    });

    it('handles server error gracefully', async () => {
      const router = createConversationRoutes(mockPool, mockConfig);
      const handler = getHandler(router, 'patch', '/:id');
      mockQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ params: { id: '1' }, body: { title: 'x' } } as any, res as any);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Internal error' });
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

  it('handles exactly 60 character message', () => {
    const exact = 'a'.repeat(60);
    expect(generateTitle(exact)).toBe(exact);
    expect(generateTitle(exact)).not.toContain('...');
  });

  it('handles 61 character message (just over limit)', () => {
    // 61 chars total — should truncate
    const msg = 'a'.repeat(25) + ' ' + 'b'.repeat(35);
    const result = generateTitle(msg);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(63);
  });

  it('falls back to hard cut when no space after position 20', () => {
    // A single long word with no spaces after position 20
    const longWord = 'a'.repeat(70);
    const result = generateTitle(longWord);
    expect(result).toBe('a'.repeat(60) + '...');
  });

  it('handles empty string', () => {
    expect(generateTitle('')).toBe('');
  });

  it('handles single word', () => {
    expect(generateTitle('Hello')).toBe('Hello');
  });
});
