import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processThought } from '../../src/processor/pipeline.js';
import * as embedder from '../../src/processor/embedder.js';
import * as extractor from '../../src/processor/extractor.js';
import * as chunker from '../../src/processor/chunker.js';
import * as summarizer from '../../src/processor/summarizer.js';
import type { ThoughtMetadata } from '@danielbrain/shared';

vi.mock('../../src/processor/embedder.js');
vi.mock('../../src/processor/extractor.js');
vi.mock('../../src/processor/chunker.js', async () => {
  const actual = await vi.importActual('../../src/processor/chunker.js');
  return {
    ...actual,
    // Let real chunker logic work, we test it separately
  };
});
vi.mock('../../src/processor/summarizer.js');
vi.mock('../../src/processor/entity-resolver.js', () => ({
  resolveEntities: vi.fn().mockResolvedValue(undefined),
}));

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.1:8b',
};

const sampleMetadata: ThoughtMetadata = {
  thought_type: 'idea',
  people: ['Alice'],
  topics: ['AI'],
  action_items: [],
  dates_mentioned: [],
  sentiment: 'positive',
  summary: 'An idea about AI',
  companies: [],
  products: [],
  projects: [],
};

describe('processThought', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [{ id: 'thought-uuid-1' }] });
    vi.mocked(embedder.embed).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(extractor.extractMetadata).mockResolvedValue(sampleMetadata);
    vi.mocked(summarizer.summarize).mockResolvedValue('Summary text');
  });

  it('processes short content with parallel embed + extract', async () => {
    const result = await processThought(
      'Short thought about AI',
      'manual',
      mockPool as any,
      mockConfig
    );

    expect(embedder.embed).toHaveBeenCalledWith('Short thought about AI', mockConfig);
    expect(extractor.extractMetadata).toHaveBeenCalledWith('Short thought about AI', mockConfig);
    expect(result.id).toBe('thought-uuid-1');
    expect(result.metadata).toEqual(sampleMetadata);
  });

  it('stores raw text in thoughts table', async () => {
    await processThought('My thought', 'manual', mockPool as any, mockConfig);

    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO thoughts');
    expect(insertCall[1]).toContain('My thought');
  });

  it('processes long content with chunking', async () => {
    const longText = 'This is a long sentence about various topics. '.repeat(700);

    // needsChunking will return true for this
    await processThought(longText, 'slack', mockPool as any, mockConfig);

    // Should have called summarize for long content
    expect(summarizer.summarize).toHaveBeenCalled();
    // Should embed summary for parent
    expect(embedder.embed).toHaveBeenCalled();
    // Multiple inserts: parent + chunks
    expect(mockPool.query).toHaveBeenCalled();
  });

  it('returns extracted metadata', async () => {
    const result = await processThought('Test thought', 'manual', mockPool as any, mockConfig);

    expect(result.metadata.thought_type).toBe('idea');
    expect(result.metadata.people).toEqual(['Alice']);
  });

  it('passes source through to DB insert', async () => {
    await processThought('Test', 'slack', mockPool as any, mockConfig);

    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[1]).toContain('slack');
  });
});
