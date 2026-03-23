import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rerank, resetReranker } from '../../src/processor/reranker.js';

vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Mock @huggingface/transformers
const mockTokenizer = vi.fn();
const mockModel = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: vi.fn().mockResolvedValue(mockTokenizer),
  },
  AutoModelForSequenceClassification: {
    from_pretrained: vi.fn().mockResolvedValue(mockModel),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetReranker();
});

describe('rerank', () => {
  const items = [
    { id: '1', content: 'Paris is the capital of France', summary: null },
    { id: '2', content: 'Berlin is in Germany', summary: null },
    { id: '3', content: 'France has many beautiful cities including Paris', summary: 'France cities overview' },
  ];

  function setupMockScores(scores: number[]) {
    mockTokenizer.mockReturnValue({ input_ids: 'mock' });
    mockModel.mockResolvedValue({
      logits: { data: new Float32Array(scores) },
    });
  }

  it('reranks items by cross-encoder score (highest first)', async () => {
    setupMockScores([-2.5, -8.1, 5.3]); // item 3 highest, item 1 middle, item 2 lowest

    const result = await rerank(
      'What is the capital of France?',
      items,
      (item) => item.summary || item.content,
      'Xenova/ms-marco-MiniLM-L-6-v2',
    );

    expect(result.map((r) => r.id)).toEqual(['3', '1', '2']);
  });

  it('passes query and document text to tokenizer', async () => {
    setupMockScores([1.0, 2.0, 3.0]);

    await rerank(
      'test query',
      items,
      (item) => item.summary || item.content,
      'Xenova/ms-marco-MiniLM-L-6-v2',
    );

    expect(mockTokenizer).toHaveBeenCalledWith(
      ['test query', 'test query', 'test query'],
      expect.objectContaining({
        text_pair: [
          'Paris is the capital of France',
          'Berlin is in Germany',
          'France cities overview', // uses summary when available
        ],
        padding: true,
        truncation: true,
        max_length: 512,
      }),
    );
  });

  it('returns single item unchanged', async () => {
    const single = [items[0]];
    const result = await rerank('query', single, (i) => i.content, 'model');
    expect(result).toEqual(single);
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('returns empty array unchanged', async () => {
    const result = await rerank('query', [], (i: any) => i.content, 'model');
    expect(result).toEqual([]);
  });

  it('respects topK limit', async () => {
    setupMockScores([1.0, 3.0, 2.0]); // order: item2 (3.0), item3 (2.0), item1 (1.0)

    const result = await rerank(
      'query',
      items,
      (item) => item.content,
      'Xenova/ms-marco-MiniLM-L-6-v2',
      2, // only top 2
    );

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(['2', '3']);
  });

  it('falls back to original order on model load failure', async () => {
    const { AutoModelForSequenceClassification } = await import('@huggingface/transformers');
    (AutoModelForSequenceClassification.from_pretrained as any).mockRejectedValueOnce(new Error('download failed'));

    const result = await rerank('query', items, (i) => i.content, 'bad-model');
    expect(result).toEqual(items); // unchanged order
  });

  it('falls back to original order on inference failure', async () => {
    mockTokenizer.mockReturnValue({ input_ids: 'mock' });
    mockModel.mockRejectedValue(new Error('inference error'));

    const result = await rerank('query', items, (i) => i.content, 'Xenova/ms-marco-MiniLM-L-6-v2');
    expect(result).toEqual(items);
  });

  it('loads model only once (caches)', async () => {
    setupMockScores([1.0, 2.0, 3.0]);

    await rerank('q1', items, (i) => i.content, 'Xenova/ms-marco-MiniLM-L-6-v2');
    await rerank('q2', items, (i) => i.content, 'Xenova/ms-marco-MiniLM-L-6-v2');

    const { AutoTokenizer } = await import('@huggingface/transformers');
    expect(AutoTokenizer.from_pretrained).toHaveBeenCalledTimes(1);
  });
});
