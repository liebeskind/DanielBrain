import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChatRoutes } from '../../src/chat/routes.js';

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
    res.write('data: {"token":"hi"}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }),
}));

import { streamChat } from '../../src/chat/ollama-stream.js';
const mockStreamChat = vi.mocked(streamChat);

const mockPool = {} as import('pg').Pool;
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

function getHandler(router: ReturnType<typeof createChatRoutes>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  // The route has middleware (express.json) + handler; get the last one
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe('chat routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when message is missing', async () => {
    const router = createChatRoutes(mockPool, mockConfig);
    const handler = getHandler(router, 'post', '/api/message');

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handler({ body: {} } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'message is required' });
  });

  it('sets SSE headers and streams response', async () => {
    const router = createChatRoutes(mockPool, mockConfig);
    const handler = getHandler(router, 'post', '/api/message');

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

    await handler({ body: { message: 'hello', history: [] } } as any, res as any);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    // Context metadata sent as first event
    expect(written[0]).toContain('"type":"context"');
  });

  it('passes chatModel to streamChat', async () => {
    const router = createChatRoutes(mockPool, mockConfig);
    const handler = getHandler(router, 'post', '/api/message');

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      writableEnded: false,
    };

    await handler({ body: { message: 'hello' } } as any, res as any);

    expect(mockStreamChat).toHaveBeenCalledWith(
      expect.any(Array),
      'llama4:scout',
      'http://localhost:11434',
      res,
    );
  });
});
