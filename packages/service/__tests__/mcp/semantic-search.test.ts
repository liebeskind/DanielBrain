import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSemanticSearch } from '../../src/mcp/tools/semantic-search.js';
import * as embedder from '../../src/processor/embedder.js';
import { RRF_K, HYBRID_VECTOR_WEIGHT, HYBRID_BM25_WEIGHT } from '@danielbrain/shared';

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

  it('embeds query and calls hybrid_search', async () => {
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
    const queryCall = mockPool.query.mock.calls[0];
    expect(queryCall[0]).toContain('hybrid_search');
    expect(queryCall[1]).toHaveLength(11);
    // Params: vectorStr, query_text, threshold, limit, filters..., rrf_k, vector_weight, bm25_weight
    expect(queryCall[1][1]).toBe('AI meetings'); // raw query text for BM25
    expect(queryCall[1][8]).toBe(RRF_K);
    expect(queryCall[1][9]).toBe(HYBRID_VECTOR_WEIGHT);
    expect(queryCall[1][10]).toBe(HYBRID_BM25_WEIGHT);
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
    expect(queryCall[1]).toHaveLength(11);
    expect(queryCall[1][1]).toBe('test'); // query text
    expect(queryCall[1][2]).toBe(0.6);   // threshold
    expect(queryCall[1][3]).toBe(5);     // limit
    expect(queryCall[1][4]).toBe('idea');
    expect(queryCall[1][5]).toBe('Alice');
    expect(queryCall[1][6]).toBe('AI');
    expect(queryCall[1][7]).toBe(30);
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
