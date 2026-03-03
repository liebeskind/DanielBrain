import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSaveThought } from '../../src/mcp/tools/save-thought.js';
import * as pipeline from '../../src/processor/pipeline.js';
import type { ThoughtMetadata } from '@danielbrain/shared';

vi.mock('../../src/processor/pipeline.js');

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
  people: [],
  topics: ['testing'],
  action_items: [],
  dates_mentioned: [],
  sentiment: 'neutral',
  summary: 'A test thought',
};

describe('handleSaveThought', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pipeline.processThought).mockResolvedValue({
      id: 'new-thought-id',
      metadata: sampleMetadata,
    });
  });

  it('processes and stores thought synchronously', async () => {
    const result = await handleSaveThought(
      { content: 'My new idea about testing', source: 'mcp' },
      mockPool as any,
      mockConfig
    );

    expect(pipeline.processThought).toHaveBeenCalledWith(
      'My new idea about testing',
      'mcp',
      mockPool,
      mockConfig
    );
    expect(result.id).toBe('new-thought-id');
  });

  it('returns extracted metadata', async () => {
    const result = await handleSaveThought(
      { content: 'Test thought', source: 'mcp' },
      mockPool as any,
      mockConfig
    );

    expect(result.metadata.thought_type).toBe('idea');
    expect(result.metadata.topics).toEqual(['testing']);
  });

  it('handles long content with chunks', async () => {
    vi.mocked(pipeline.processThought).mockResolvedValue({
      id: 'long-thought-id',
      metadata: sampleMetadata,
      chunks: 5,
    });

    const result = await handleSaveThought(
      { content: 'Very long content...', source: 'mcp' },
      mockPool as any,
      mockConfig
    );

    expect(result.id).toBe('long-thought-id');
    expect(result.chunks).toBe(5);
  });
});
