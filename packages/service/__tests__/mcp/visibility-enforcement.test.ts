import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Negative authorization tests: verify that member users cannot see owner-only thoughts.
 * Each test mocks DB queries and verifies visibility filtering is applied.
 */

// Mock embedder
vi.mock('../../src/processor/embedder.js', () => ({
  embedQuery: vi.fn(async () => new Array(768).fill(0.1)),
}));

const mockQuery = vi.fn();
const pool = { query: mockQuery } as any;
const config = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
};

describe('Visibility enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('semantic_search passes visibility to hybrid_search', async () => {
    const { handleSemanticSearch } = await import('../../src/mcp/tools/semantic-search.js');

    mockQuery.mockResolvedValue({ rows: [] });

    await handleSemanticSearch(
      { query: 'test', limit: 10, threshold: 0.5 },
      pool,
      config,
      ['company', 'user:123'],
    );

    // hybrid_search call — visibility is the 12th parameter
    const [, params] = mockQuery.mock.calls[0];
    expect(params[11]).toEqual(['company', 'user:123']);
  });

  it('list_recent filters by visibility', async () => {
    const { handleListRecent } = await import('../../src/mcp/tools/list-recent.js');

    mockQuery.mockResolvedValue({ rows: [] });

    await handleListRecent(
      { days: 7, limit: 10 },
      pool,
      ['company', 'user:123'],
    );

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('visibility && $');
    expect(params).toContainEqual(['company', 'user:123']);
  });

  it('get_entity filters linked thoughts by visibility', async () => {
    const { handleGetEntity } = await import('../../src/mcp/tools/get-entity.js');

    // Entity lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'e1', name: 'Test', canonical_name: 'test', entity_type: 'person',
        mention_count: 1, profile_summary: 'test', updated_at: new Date(),
      }],
    });
    // Linked thoughts
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Connected entities
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await handleGetEntity(
      { entity_id: 'e1' },
      pool,
      config,
      ['company'],
    );

    // Second call is the thought query — must have visibility clause
    const [thoughtSql, thoughtParams] = mockQuery.mock.calls[1];
    expect(thoughtSql).toContain('visibility && $');
    expect(thoughtParams).toContainEqual(['company']);
  });

  it('get_context filters thoughts by visibility', async () => {
    const { handleGetContext } = await import('../../src/mcp/tools/get-context.js');

    // Entity resolution
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', canonical_name: 'alice' }],
    });
    // Shared thoughts
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Relationship edges (skipped if < 2 entities)

    await handleGetContext(
      { entities: ['Alice'], days_back: 30, include_action_items: false, max_thoughts: 10 },
      pool,
      ['company', 'user:abc'],
    );

    // Second call is the thought query
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain('visibility && $');
    expect(params).toContainEqual(['company', 'user:abc']);
  });

  it('get_timeline filters by visibility', async () => {
    const { handleGetTimeline } = await import('../../src/mcp/tools/get-timeline.js');

    // Entity lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Test' }],
    });
    // Timeline entries
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await handleGetTimeline(
      { entity_id: 'e1', days_back: 30, limit: 50 },
      pool,
      ['user:456'],
    );

    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain('visibility && $');
    expect(params).toContainEqual(['user:456']);
  });

  it('stats filters by visibility', async () => {
    const { handleStats } = await import('../../src/mcp/tools/stats.js');

    // 5 queries: total, type, people, topics, action_items
    for (let i = 0; i < 5; i++) {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    }

    await handleStats(
      { period: 'month' },
      pool,
      ['company'],
    );

    // All 5 queries should use visibility parameter
    for (let i = 0; i < 5; i++) {
      const [sql, params] = mockQuery.mock.calls[i];
      expect(sql).toContain('visibility && $2');
      expect(params[1]).toEqual(['company']);
    }
  });

  it('parent context fetch filters by visibility (regression test)', async () => {
    const { fetchParentContext } = await import('../../src/db/thought-queries.js');

    mockQuery.mockResolvedValue({
      rows: [
        { id: 'p1', summary: 'visible', thought_type: 'note', people: [], topics: [] },
      ],
    });

    // With member visibility, the query must include visibility filter
    await fetchParentContext(pool, ['p1', 'p2'], ['company']);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('visibility && $2');
    expect(params[1]).toEqual(['company']);
  });

  it('parent context fetch does NOT filter for owner (null tags)', async () => {
    const { fetchParentContext } = await import('../../src/db/thought-queries.js');

    mockQuery.mockResolvedValue({ rows: [] });

    await fetchParentContext(pool, ['p1'], null);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toContain('visibility');
    expect(params).toEqual([['p1']]);
  });
});
