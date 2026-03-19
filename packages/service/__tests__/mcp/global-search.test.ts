import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGlobalSearch } from '../../src/mcp/tools/global-search.js';

vi.mock('../../src/processor/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  embed: vi.fn(),
  embedBatch: vi.fn(),
}));

import { embedQuery } from '../../src/processor/embedder.js';

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
};

describe('handleGlobalSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('embeds query and searches community embeddings', async () => {
    // Community search results
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'c1',
          title: 'Topia Leadership',
          summary: 'Core leadership team at Topia.',
          full_report: 'Detailed report...',
          member_count: 4,
          similarity: '0.85',
        },
      ],
    });

    // Members for c1
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { name: 'Daniel', entity_type: 'person' },
        { name: 'Topia', entity_type: 'company' },
      ],
    });

    const result = await handleGlobalSearch(
      { query: 'What is the team working on?', level: 0, limit: 5 },
      mockPool as any,
      mockConfig,
    );

    expect(embedQuery).toHaveBeenCalledWith('What is the team working on?', mockConfig);
    expect(result.query).toBe('What is the team working on?');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Topia Leadership');
    expect(result.results[0].similarity).toBe(0.85);
    expect(result.results[0].members).toHaveLength(2);
  });

  it('returns empty results when no communities match', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await handleGlobalSearch(
      { query: 'nonexistent topic', level: 0, limit: 5 },
      mockPool as any,
      mockConfig,
    );

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('filters by level', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleGlobalSearch(
      { query: 'test', level: 1, limit: 5 },
      mockPool as any,
      mockConfig,
    );

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('level = $2');
    expect(params[1]).toBe(1);
  });

  it('only returns communities with summaries', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleGlobalSearch(
      { query: 'test', level: 0, limit: 5 },
      mockPool as any,
      mockConfig,
    );

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('summary IS NOT NULL');
    expect(sql).toContain('embedding IS NOT NULL');
  });
});
