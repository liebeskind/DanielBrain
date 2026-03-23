import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSemanticSearch } from '../../src/mcp/tools/semantic-search.js';
import * as embedder from '../../src/processor/embedder.js';
import * as reranker from '../../src/processor/reranker.js';
import { RRF_K, HYBRID_VECTOR_WEIGHT, HYBRID_BM25_WEIGHT } from '@danielbrain/shared';

vi.mock('../../src/processor/embedder.js');
vi.mock('../../src/processor/reranker.js');

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
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
    expect(queryCall[1]).toHaveLength(12);
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
    expect(queryCall[1]).toHaveLength(12);
    expect(queryCall[1][1]).toBe('test'); // query text
    expect(queryCall[1][2]).toBe(0.6);   // threshold
    expect(queryCall[1][3]).toBe(5);     // limit
    expect(queryCall[1][4]).toBe('idea');
    expect(queryCall[1][5]).toBe('Alice');
    expect(queryCall[1][6]).toBe('AI');
    expect(queryCall[1][7]).toBe(30);
  });

  it('filters results by source', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: '1', content: 'Slack msg', source: 'slack', parent_id: null, similarity: 0.9 },
        { id: '2', content: 'Fathom msg', source: 'fathom', parent_id: null, similarity: 0.8 },
      ],
    });

    const result = await handleSemanticSearch(
      { query: 'test', limit: 10, threshold: 0.5, source: 'slack' },
      mockPool as any,
      mockConfig,
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('slack');
  });

  it('filters results by sources array', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: '1', content: 'Slack msg', source: 'slack', parent_id: null, similarity: 0.9 },
        { id: '2', content: 'Fathom msg', source: 'fathom', parent_id: null, similarity: 0.8 },
        { id: '3', content: 'Telegram msg', source: 'telegram', parent_id: null, similarity: 0.7 },
      ],
    });

    const result = await handleSemanticSearch(
      { query: 'test', limit: 10, threshold: 0.5, sources: ['slack', 'fathom'] },
      mockPool as any,
      mockConfig,
    );

    expect(result).toHaveLength(2);
    const sources = result.map(r => r.source);
    expect(sources).toContain('slack');
    expect(sources).toContain('fathom');
    expect(sources).not.toContain('telegram');
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

  it('calls reranker when rerankerModel is configured', async () => {
    const rows = [
      { id: '1', content: 'First', summary: 'Sum1', source: 'slack', parent_id: null, similarity: 0.9 },
      { id: '2', content: 'Second', summary: null, source: 'slack', parent_id: null, similarity: 0.8 },
    ];
    mockPool.query.mockResolvedValueOnce({ rows });

    // Mock rerank to reverse order
    vi.mocked(reranker.rerank).mockImplementation(async (_q, items) => [...items].reverse());

    const configWithReranker = { ...mockConfig, rerankerModel: 'Xenova/ms-marco-MiniLM-L-6-v2' };
    const result = await handleSemanticSearch(
      { query: 'test', limit: 10, threshold: 0.5 },
      mockPool as any,
      configWithReranker,
    );

    expect(reranker.rerank).toHaveBeenCalledWith(
      'test',
      expect.any(Array),
      expect.any(Function),
      'Xenova/ms-marco-MiniLM-L-6-v2',
    );
    // Reranker reversed the order
    expect(result[0].id).toBe('2');
    expect(result[1].id).toBe('1');
  });

  it('skips reranking when rerankerModel not configured', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: '1', content: 'First', source: 'slack', parent_id: null, similarity: 0.9 }],
    });

    await handleSemanticSearch(
      { query: 'test', limit: 10, threshold: 0.5 },
      mockPool as any,
      mockConfig, // no rerankerModel
    );

    expect(reranker.rerank).not.toHaveBeenCalled();
  });
});
