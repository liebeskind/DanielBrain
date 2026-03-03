import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pollQueue } from '../../src/processor/queue-poller.js';
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
  batchSize: 5,
  maxRetries: 3,
};

const sampleMetadata: ThoughtMetadata = {
  thought_type: 'idea',
  people: [],
  topics: [],
  action_items: [],
  dates_mentioned: [],
  sentiment: null,
  summary: 'Test summary',
};

describe('pollQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pipeline.processThought).mockResolvedValue({
      id: 'thought-uuid',
      metadata: sampleMetadata,
    });
  });

  it('claims pending items with FOR UPDATE SKIP LOCKED', async () => {
    mockPool.query
      // SELECT pending items
      .mockResolvedValueOnce({
        rows: [
          { id: 'q1', content: 'Thought 1', source: 'slack', source_meta: null, attempts: 0 },
        ],
      })
      // UPDATE status to processing
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE status to completed
      .mockResolvedValueOnce({ rows: [] });

    await pollQueue(mockPool as any, mockConfig);

    const selectCall = mockPool.query.mock.calls[0];
    expect(selectCall[0]).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('marks completed on success', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'q1', content: 'Thought 1', source: 'slack', source_meta: null, attempts: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await pollQueue(mockPool as any, mockConfig);

    // Last query should update status to completed
    const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(lastCall[0]).toContain('completed');
  });

  it('marks failed on error', async () => {
    vi.mocked(pipeline.processThought).mockRejectedValue(new Error('Ollama down'));

    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'q1', content: 'Bad thought', source: 'slack', source_meta: null, attempts: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await pollQueue(mockPool as any, mockConfig);

    const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(lastCall[0]).toContain('failed');
    expect(lastCall[1]).toContain('Ollama down');
  });

  it('does nothing when queue is empty', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await pollQueue(mockPool as any, mockConfig);

    expect(pipeline.processThought).not.toHaveBeenCalled();
  });

  it('skips items that have exceeded max retries', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'q1', content: 'Failed many times', source: 'slack', source_meta: null, attempts: 3 }],
      })
      .mockResolvedValueOnce({ rows: [] }); // marks permanently failed

    await pollQueue(mockPool as any, mockConfig);

    expect(pipeline.processThought).not.toHaveBeenCalled();
  });
});
