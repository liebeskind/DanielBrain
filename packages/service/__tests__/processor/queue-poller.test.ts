import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pollQueue, calculateRetryAfter } from '../../src/processor/queue-poller.js';
import * as pipeline from '../../src/processor/pipeline.js';
import type { ThoughtMetadata } from '@danielbrain/shared';

vi.mock('../../src/processor/pipeline.js');

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
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
  companies: [],
  products: [],
  projects: [],
  department: null,
  confidentiality: 'internal',
  themes: [],
  key_decisions: [],
  key_insights: [],
  meeting_participants: [],
  action_items_structured: [],
};

describe('calculateRetryAfter', () => {
  it('returns ~30s for attempt 1', () => {
    const result = calculateRetryAfter(1);
    const diffMs = result.getTime() - Date.now();
    // 30s ±20% = 24s to 36s
    expect(diffMs).toBeGreaterThan(23000);
    expect(diffMs).toBeLessThan(37000);
  });

  it('returns ~2min for attempt 2', () => {
    const result = calculateRetryAfter(2);
    const diffMs = result.getTime() - Date.now();
    // 120s ±20% = 96s to 144s
    expect(diffMs).toBeGreaterThan(95000);
    expect(diffMs).toBeLessThan(145000);
  });

  it('returns ~10min for attempt 3', () => {
    const result = calculateRetryAfter(3);
    const diffMs = result.getTime() - Date.now();
    // 600s ±20% = 480s to 720s
    expect(diffMs).toBeGreaterThan(479000);
    expect(diffMs).toBeLessThan(721000);
  });

  it('caps at 10min for attempts beyond 3', () => {
    const result = calculateRetryAfter(5);
    const diffMs = result.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(479000);
    expect(diffMs).toBeLessThan(721000);
  });
});

describe('pollQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pipeline.processThought).mockResolvedValue({
      id: 'thought-uuid',
      metadata: sampleMetadata,
    });
  });

  it('claims pending items with FOR UPDATE SKIP LOCKED and retry_after filter', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 'q1', content: 'Thought 1', source: 'slack', source_id: null, source_meta: null, originated_at: null, attempts: 0 },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await pollQueue(mockPool as any, mockConfig);

    const selectCall = mockPool.query.mock.calls[0];
    expect(selectCall[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(selectCall[0]).toContain('retry_after IS NULL OR retry_after <= NOW()');
  });

  it('marks completed on success', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'q1', content: 'Thought 1', source: 'slack', source_id: null, source_meta: null, originated_at: null, attempts: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await pollQueue(mockPool as any, mockConfig);

    const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(lastCall[0]).toContain('completed');
  });

  it('passes source_id and originated_at as createdAt to processThought', async () => {
    const ts = '2026-03-01T10:00:00.000Z';
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'q1', content: 'Meeting notes', source: 'fathom', source_id: 'fathom-rec-123', source_meta: null, originated_at: ts, attempts: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await pollQueue(mockPool as any, mockConfig);

    expect(pipeline.processThought).toHaveBeenCalledWith(
      'Meeting notes',
      'fathom',
      mockPool,
      mockConfig,
      null,
      'fathom-rec-123',
      new Date(ts),
    );
  });

  it('passes null createdAt when originated_at is not set', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'q1', content: 'Old item', source: 'slack', source_id: null, source_meta: null, originated_at: null, attempts: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await pollQueue(mockPool as any, mockConfig);

    expect(pipeline.processThought).toHaveBeenCalledWith(
      'Old item',
      'slack',
      mockPool,
      mockConfig,
      null,
      null,
      null,
    );
  });

  it('retries with backoff on first failure (attempts < maxRetries)', async () => {
    vi.mocked(pipeline.processThought).mockRejectedValue(new Error('Ollama timeout'));

    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'q1', content: 'Bad thought', source: 'slack', source_id: null, source_meta: null, originated_at: null, attempts: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] }) // mark processing (attempts becomes 1)
      .mockResolvedValueOnce({ rows: [] }); // set back to pending with retry_after

    await pollQueue(mockPool as any, mockConfig);

    const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    // Should set status back to 'pending' with retry_after
    expect(lastCall[0]).toContain('pending');
    expect(lastCall[0]).toContain('retry_after');
    expect(lastCall[1][0]).toBe('Ollama timeout'); // error message
    expect(lastCall[1][1]).toBeInstanceOf(Date); // retry_after timestamp
  });

  it('marks permanently failed when max retries exceeded on error', async () => {
    vi.mocked(pipeline.processThought).mockRejectedValue(new Error('Ollama down'));

    mockPool.query
      .mockResolvedValueOnce({
        // attempts=2, will become 3 after processing UPDATE — equals maxRetries
        rows: [{ id: 'q1', content: 'Bad thought', source: 'slack', source_id: null, source_meta: null, originated_at: null, attempts: 2 }],
      })
      .mockResolvedValueOnce({ rows: [] }) // mark processing
      .mockResolvedValueOnce({ rows: [] }); // mark failed

    await pollQueue(mockPool as any, mockConfig);

    const lastCall = mockPool.query.mock.calls[mockPool.query.mock.calls.length - 1];
    expect(lastCall[0]).toContain('failed');
    expect(lastCall[0]).toContain('processed_at');
    expect(lastCall[1]).toContain('Ollama down');
  });

  it('does nothing when queue is empty', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await pollQueue(mockPool as any, mockConfig);

    expect(pipeline.processThought).not.toHaveBeenCalled();
  });

  it('skips items that have exceeded max retries at claim time', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'q1', content: 'Failed many times', source: 'slack', source_id: null, source_meta: null, originated_at: null, attempts: 3 }],
      })
      .mockResolvedValueOnce({ rows: [] }); // marks permanently failed

    await pollQueue(mockPool as any, mockConfig);

    expect(pipeline.processThought).not.toHaveBeenCalled();
    const failCall = mockPool.query.mock.calls[1];
    expect(failCall[0]).toContain('failed');
    expect(failCall[0]).toContain('retry_after = NULL');
  });
});
