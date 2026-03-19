import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractKeywords } from '../../src/processor/keyword-extractor.js';

vi.mock('../../src/processor/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  embed: vi.fn(),
  embedBatch: vi.fn(),
}));

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
};

describe('extractKeywords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds exact entity name matches', async () => {
    // Entity match
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Topia', entity_type: 'company', profile_summary: 'Ed-tech company' },
      ],
    });
    // Community search
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await extractKeywords('Tell me about Topia', mockPool as any, mockConfig);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('Topia');
    expect(result.themes).toHaveLength(0);
    expect(result.queryEmbedding).toHaveLength(768);
  });

  it('finds theme matches from community embeddings', async () => {
    // No entity matches
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Community search returns match above threshold
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { community_id: 'c1', title: 'Product Strategy', similarity: '0.65' },
        { community_id: 'c2', title: 'Engineering', similarity: '0.25' }, // below 0.3 threshold
      ],
    });

    const result = await extractKeywords('product roadmap planning', mockPool as any, mockConfig);

    expect(result.entities).toHaveLength(0);
    expect(result.themes).toHaveLength(1);
    expect(result.themes[0]).toEqual({
      community_id: 'c1',
      title: 'Product Strategy',
      similarity: 0.65,
    });
  });

  it('returns both entities and themes', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Chris Psiaki', entity_type: 'person', profile_summary: 'CTO' },
      ],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { community_id: 'c1', title: 'Leadership Team', similarity: '0.72' },
      ],
    });

    const result = await extractKeywords('What is Chris working on?', mockPool as any, mockConfig);

    expect(result.entities).toHaveLength(1);
    expect(result.themes).toHaveLength(1);
  });

  it('returns empty results for stop-word-only queries', async () => {
    // With only stop words, the word list is empty so no entity query
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // community search (embedding still runs)

    const result = await extractKeywords('the and but', mockPool as any, mockConfig);

    // Entity query should not have been called (words filtered out)
    // First call should be the community query
    expect(result.entities).toHaveLength(0);
    expect(result.themes).toHaveLength(0);
  });

  it('handles prefix matching for entity names', async () => {
    // The SQL LIKE query handles prefix matching
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Chris Psiaki', entity_type: 'person', profile_summary: null },
      ],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await extractKeywords('chris mentioned something', mockPool as any, mockConfig);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('Chris Psiaki');
  });
});
