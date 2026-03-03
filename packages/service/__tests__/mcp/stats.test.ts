import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleStats } from '../../src/mcp/tools/stats.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns correct counts by type', async () => {
    // Total count
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: '42' }] })
      // Type breakdown
      .mockResolvedValueOnce({
        rows: [
          { thought_type: 'idea', count: '15' },
          { thought_type: 'meeting_note', count: '12' },
          { thought_type: 'task', count: '8' },
          { thought_type: null, count: '7' },
        ],
      })
      // Top people
      .mockResolvedValueOnce({
        rows: [
          { person: 'Alice', count: '10' },
          { person: 'Bob', count: '8' },
        ],
      })
      // Top topics
      .mockResolvedValueOnce({
        rows: [
          { topic: 'AI', count: '15' },
          { topic: 'Product', count: '10' },
        ],
      })
      // Unresolved action items
      .mockResolvedValueOnce({ rows: [{ count: '5' }] });

    const result = await handleStats({ period: 'month' }, mockPool as any);

    expect(result.total).toBe(42);
    expect(result.by_type).toHaveLength(4);
    expect(result.top_people).toHaveLength(2);
    expect(result.top_topics).toHaveLength(2);
  });

  it('respects date range for period', async () => {
    mockPool.query
      .mockResolvedValue({ rows: [{ count: '0' }] });

    await handleStats({ period: 'week' }, mockPool as any);

    const firstQueryCall = mockPool.query.mock.calls[0];
    expect(firstQueryCall[0]).toContain('created_at');
  });
});
