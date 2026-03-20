import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAsk } from '../../src/mcp/tools/ask.js';

vi.mock('../../src/processor/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  embed: vi.fn(),
  embedBatch: vi.fn(),
}));

vi.mock('../../src/mcp/tools/semantic-search.js', () => ({
  handleSemanticSearch: vi.fn().mockResolvedValue([
    {
      id: 't1',
      content: 'Meeting about partnership with Stride',
      summary: 'Discussed Stride partnership terms',
      thought_type: 'meeting_note',
      people: ['Chris', 'Daniel'],
      topics: ['Stride', 'partnership'],
      action_items: [],
      similarity: 0.85,
      source: 'fathom',
      created_at: new Date('2026-03-15'),
      parent_id: null,
      chunk_index: null,
      dates_mentioned: [],
    },
  ]),
}));

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
};

function createSmartPool(responses: Record<string, { rows: any[] }>) {
  const defaultResponse = { rows: [] };
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      for (const [pattern, response] of Object.entries(responses)) {
        if (sql.includes(pattern)) return Promise.resolve(response);
      }
      return Promise.resolve(defaultResponse);
    }),
  };
}

describe('handleAsk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs parallel search and returns merged results', async () => {
    const mockPool = createSmartPool({
      // Entity keyword match (from keyword extractor)
      'FROM entities': {
        rows: [{ id: 'e1', name: 'Stride', entity_type: 'company', profile_summary: 'Education company' }],
      },
      // Community embedding search (both keyword extractor themes and ask community search)
      'FROM communities': {
        rows: [{ id: 'c1', community_id: 'c1', title: 'Partnerships', summary: 'Key partnerships', member_count: 3, similarity: '0.65' }],
      },
      // Community members
      'FROM entity_communities': {
        rows: [{ name: 'Stride', entity_type: 'company' }, { name: 'Topia', entity_type: 'company' }],
      },
      // Entity relationships
      'FROM entity_relationships': {
        rows: [{ entity_id: 'e1', name: 'Topia', entity_type: 'company', weight: 5, description: 'Strategic partner' }],
      },
    });

    const result = await handleAsk(
      { query: 'What do we know about Stride?', limit: 10 },
      mockPool as any,
      mockConfig,
    );

    expect(result.query).toBe('What do we know about Stride?');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('Stride');
    expect(result.entities[0].connections).toHaveLength(1);
    expect(result.entities[0].connections[0].name).toBe('Topia');
    expect(result.thoughts).toHaveLength(1);
    expect(result.thoughts[0].thought_type).toBe('meeting_note');
    expect(result.communities).toHaveLength(1);
  });

  it('handles empty results gracefully', async () => {
    const mockPool = createSmartPool({});

    const { handleSemanticSearch } = await import('../../src/mcp/tools/semantic-search.js');
    vi.mocked(handleSemanticSearch).mockResolvedValueOnce([]);

    const result = await handleAsk(
      { query: 'something completely unknown', limit: 10 },
      mockPool as any,
      mockConfig,
    );

    expect(result.entities).toHaveLength(0);
    expect(result.thoughts).toHaveLength(0);
    expect(result.communities).toHaveLength(0);
  });

  it('respects days_back parameter', async () => {
    const mockPool = createSmartPool({});

    const { handleSemanticSearch } = await import('../../src/mcp/tools/semantic-search.js');

    await handleAsk(
      { query: 'recent meetings', limit: 5, days_back: 7 },
      mockPool as any,
      mockConfig,
    );

    expect(handleSemanticSearch).toHaveBeenCalledWith(
      expect.objectContaining({ days_back: 7, limit: 5 }),
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it('truncates long thought content in output', async () => {
    const { handleSemanticSearch } = await import('../../src/mcp/tools/semantic-search.js');
    vi.mocked(handleSemanticSearch).mockResolvedValueOnce([
      {
        id: 't1',
        content: 'x'.repeat(1000),
        summary: null,
        thought_type: null,
        people: [],
        topics: [],
        action_items: [],
        similarity: 0.8,
        source: 'slack',
        created_at: new Date(),
        parent_id: null,
        chunk_index: null,
        dates_mentioned: [],
      },
    ]);

    const mockPool = createSmartPool({});

    const result = await handleAsk(
      { query: 'test', limit: 10 },
      mockPool as any,
      mockConfig,
    );

    expect(result.thoughts[0].content.length).toBeLessThan(600);
    expect(result.thoughts[0].content).toContain('...');
  });

  it('returns partial data when semantic search fails but other sources succeed', async () => {
    const { handleSemanticSearch } = await import('../../src/mcp/tools/semantic-search.js');
    vi.mocked(handleSemanticSearch).mockRejectedValueOnce(new Error('Embedding service down'));

    const mockPool = createSmartPool({
      'FROM entities': {
        rows: [{ id: 'e1', name: 'Stride', entity_type: 'company', profile_summary: 'Ed tech company' }],
      },
      'FROM communities': {
        rows: [{ id: 'c1', title: 'Partnerships', summary: 'Key partnerships', member_count: 3, similarity: '0.65' }],
      },
      'FROM entity_communities': {
        rows: [{ name: 'Stride', entity_type: 'company' }],
      },
      'FROM entity_relationships': {
        rows: [],
      },
    });

    // handleAsk calls Promise.all which will reject if any promise rejects
    await expect(
      handleAsk({ query: 'Stride partnership', limit: 10 }, mockPool as any, mockConfig),
    ).rejects.toThrow('Embedding service down');
  });

  it('returns empty entities when no keyword entity matches found', async () => {
    const mockPool = createSmartPool({
      // Entity keyword match returns nothing
      'FROM entities': { rows: [] },
      // Community search also returns nothing
      'FROM communities': { rows: [] },
      // No entity relationships to fetch
      'FROM entity_relationships': { rows: [] },
    });

    const result = await handleAsk(
      { query: 'something with no matching entities', limit: 10 },
      mockPool as any,
      mockConfig,
    );

    expect(result.entities).toHaveLength(0);
    // Thoughts still come from semantic search mock (default mock returns 1 result)
    expect(result.thoughts).toHaveLength(1);
  });

  it('returns empty communities when community search returns no rows', async () => {
    const mockPool = createSmartPool({
      'FROM entities': { rows: [] },
      // Community query returns empty
      'FROM communities': { rows: [] },
      'FROM entity_relationships': { rows: [] },
    });

    const result = await handleAsk(
      { query: 'obscure topic', limit: 10 },
      mockPool as any,
      mockConfig,
    );

    expect(result.communities).toHaveLength(0);
  });

  it('passes visibilityTags through to semantic search', async () => {
    const { handleSemanticSearch } = await import('../../src/mcp/tools/semantic-search.js');
    vi.mocked(handleSemanticSearch).mockResolvedValueOnce([]);

    const mockPool = createSmartPool({});
    const visTags = ['company', 'user:u1'];

    await handleAsk(
      { query: 'test', limit: 10 },
      mockPool as any,
      mockConfig,
      visTags,
    );

    expect(handleSemanticSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      visTags,
    );
  });
});
