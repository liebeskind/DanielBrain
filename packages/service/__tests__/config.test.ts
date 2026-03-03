import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads valid config from environment', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    vi.stubEnv('BRAIN_ACCESS_KEY', 'a'.repeat(64));
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    vi.stubEnv('EMBEDDING_MODEL', 'nomic-embed-text');
    vi.stubEnv('EXTRACTION_MODEL', 'llama3.1:8b');
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'test-secret');

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.databaseUrl).toBe('postgresql://user:pass@localhost:5432/db');
    expect(config.brainAccessKey).toBe('a'.repeat(64));
    expect(config.ollamaBaseUrl).toBe('http://localhost:11434');
    expect(config.embeddingModel).toBe('nomic-embed-text');
    expect(config.extractionModel).toBe('llama3.1:8b');
  });

  it('uses defaults for optional values', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
    vi.stubEnv('BRAIN_ACCESS_KEY', 'a'.repeat(64));
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'test-secret');

    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();

    expect(config.mcpPort).toBe(3000);
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.batchSize).toBe(5);
    expect(config.maxRetries).toBe(3);
    expect(config.ollamaBaseUrl).toBe('http://localhost:11434');
    expect(config.embeddingModel).toBe('nomic-embed-text');
    expect(config.extractionModel).toBe('llama3.1:8b');
  });

  it('throws on missing required env vars', async () => {
    // Clear all env vars
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('BRAIN_ACCESS_KEY', '');

    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow();
  });
});
