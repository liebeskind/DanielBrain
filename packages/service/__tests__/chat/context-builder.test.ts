import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildContext, findMatchingEntities } from '../../src/chat/context-builder.js';

// Mock semantic search
vi.mock('../../src/mcp/tools/semantic-search.js', () => ({
  handleSemanticSearch: vi.fn(),
}));

import { handleSemanticSearch } from '../../src/mcp/tools/semantic-search.js';
const mockSearch = vi.mocked(handleSemanticSearch);

function mockPool(entityRows: Array<Record<string, unknown>> = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows: entityRows }),
  } as unknown as import('pg').Pool;
}

const config = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
};

describe('buildContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty context when no results', async () => {
    mockSearch.mockResolvedValue([]);
    const pool = mockPool([]);

    const result = await buildContext('hello', pool, config);

    expect(result.contextText).toBe('');
    expect(result.sources).toHaveLength(0);
    expect(result.entities).toHaveLength(0);
  });

  it('formats search results into context text', async () => {
    mockSearch.mockResolvedValue([
      {
        id: '1',
        content: 'Meeting about project alpha',
        summary: 'Discussed alpha milestones',
        source: 'fathom',
        similarity: 0.85,
        created_at: '2026-03-01T00:00:00Z',
        thought_type: 'meeting',
        people: ['Alice'],
        topics: ['alpha'],
        action_items: [],
        sentiment: 'neutral',
        parent_id: null,
      },
    ]);
    const pool = mockPool([]);

    const result = await buildContext('project alpha', pool, config);

    expect(result.contextText).toContain('RELEVANT THOUGHTS:');
    expect(result.contextText).toContain('fathom');
    expect(result.contextText).toContain('Discussed alpha milestones');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].similarity).toBe(0.85);
  });

  it('includes entity profiles when matched', async () => {
    mockSearch.mockResolvedValue([]);
    const pool = mockPool([
      { name: 'Alice Smith', entity_type: 'person', profile_summary: 'VP of Engineering' },
    ]);

    const result = await buildContext('tell me about alice', pool, config);

    expect(result.contextText).toContain('KNOWN ENTITIES:');
    expect(result.contextText).toContain('Alice Smith');
    expect(result.contextText).toContain('VP of Engineering');
    expect(result.entities).toHaveLength(1);
  });

  it('passes correct search params', async () => {
    mockSearch.mockResolvedValue([]);
    const pool = mockPool([]);

    await buildContext('test query', pool, config);

    expect(mockSearch).toHaveBeenCalledWith(
      { query: 'test query', limit: 5, threshold: 0.3 },
      pool,
      config,
    );
  });
});

describe('findMatchingEntities', () => {
  it('filters short words', async () => {
    const pool = mockPool([]);
    const result = await findMatchingEntities('I am ok', pool);
    // "am" and "ok" are < 3 chars, only "I" filtered too
    expect(result).toHaveLength(0);
  });

  it('queries with normalized words', async () => {
    const pool = mockPool([]);
    await findMatchingEntities('Tell me about Alice', pool);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args[1][0]).toContain('tell');
    expect(args[1][0]).toContain('about');
    expect(args[1][0]).toContain('alice');
  });
});
