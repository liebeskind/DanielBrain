import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChatRoutes } from '../../src/chat/routes.js';

const mockPool = { query: vi.fn() } as unknown as import('pg').Pool;
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

describe('chat routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a router with conversation and project sub-routes', () => {
    const router = createChatRoutes(mockPool, mockConfig);
    expect(router).toBeDefined();
    // Router should have stack entries for static files + sub-routers
    const stack = (router as any).stack;
    expect(stack.length).toBeGreaterThanOrEqual(2);
  });
});
