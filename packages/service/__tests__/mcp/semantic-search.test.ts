import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSemanticSearch } from '../../src/mcp/tools/semantic-search.js';
import * as embedder from '../../src/processor/embedder.js';

vi.mock('../../src/processor/embedder.js');

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.1:8b',
};

describe('handleSemanticSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(embedder.embedQuery).mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('embeds query and calls match_thoughts', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'uuid-1',
          content: 'Meeting about AI',
          thought_type: 'meeting_note',
          people: ['Alice'],
          topics: ['AI'],
          action_items: [],
          dates_mentioned: [],
          summary: 'AI meeting summary',
          similarity: 0.85,
          parent_id: null,
          chunk_index: null,
          source: 'slack',
          created_at: new Date('2026-03-01'),
        },
      ],
    });

    const result = await handleSemanticSearch(
      { query: 'AI meetings', limit: 10, threshold: 0.5 },
      mockPool as any,
      mockConfig
    );

    expect(embedder.embedQuery).toHaveBeenCalledWith('AI meetings', mockConfig);
    expect(mockPool.query).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].similarity).toBe(0.85);
  });

  it('applies filters correctly', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleSemanticSearch(
      {
        query: 'test',
        limit: 5,
        threshold: 0.6,
        thought_type: 'idea',
        person: 'Alice',
        topic: 'AI',
        days_back: 30,
      },
      mockPool as any,
      mockConfig
    );

    const queryCall = mockPool.query.mock.calls[0];
    expect(queryCall[1]).toContain('idea');
    expect(queryCall[1]).toContain('Alice');
    expect(queryCall[1]).toContain('AI');
    expect(queryCall[1]).toContain(30);
  });

  it('fetches parent context for chunk results', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'chunk-1',
            content: 'Chunk content',
            thought_type: null,
            people: [],
            topics: [],
            action_items: [],
            dates_mentioned: [],
            summary: null,
            similarity: 0.9,
            parent_id: 'parent-1',
            chunk_index: 0,
            source: 'slack',
            created_at: new Date('2026-03-01'),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'parent-1',
            summary: 'Parent summary',
            thought_type: 'meeting_note',
            people: ['Bob'],
            topics: ['Planning'],
          },
        ],
      });

    const result = await handleSemanticSearch(
      { query: 'test', limit: 10, threshold: 0.5 },
      mockPool as any,
      mockConfig
    );

    expect(result[0].parent_context).toBeDefined();
    expect(result[0].parent_context!.summary).toBe('Parent summary');
  });
});
