import { describe, it, expect, vi, beforeEach } from 'vitest';
import { embed, embedBatch, embedQuery } from '../../src/processor/embedder.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('embed (for storage)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('calls Ollama with search_document prefix', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ embeddings: [[0.1, 0.2, 0.3]] }),
    });

    const result = await embed('Test text', {
      ollamaBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('search_document: Test text'),
      })
    );
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws on Ollama error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal error'),
    });

    await expect(
      embed('Test', {
        ollamaBaseUrl: 'http://localhost:11434',
        embeddingModel: 'nomic-embed-text',
      })
    ).rejects.toThrow();
  });

  it('throws on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(
      embed('Test', {
        ollamaBaseUrl: 'http://localhost:11434',
        embeddingModel: 'nomic-embed-text',
      })
    ).rejects.toThrow('Connection refused');
  });
});

describe('embedBatch (for batch storage)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends each text individually with search_document prefix', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ embeddings: [[0.1, 0.2]] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ embeddings: [[0.3, 0.4]] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ embeddings: [[0.5, 0.6]] }) });

    const result = await embedBatch(['chunk 1', 'chunk 2', 'chunk 3'], {
      ollamaBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      const body = JSON.parse(mockFetch.mock.calls[i][1].body);
      expect(body.input).toBe(`search_document: chunk ${i + 1}`);
    }
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]);
  });

  it('returns empty array for empty input', async () => {
    const result = await embedBatch([], {
      ollamaBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });

    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('embedQuery (for search)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('calls Ollama with search_query prefix', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ embeddings: [[0.4, 0.5, 0.6]] }),
    });

    const result = await embedQuery('Search term', {
      ollamaBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({
        body: expect.stringContaining('search_query: Search term'),
      })
    );
    expect(result).toEqual([0.4, 0.5, 0.6]);
  });
});
