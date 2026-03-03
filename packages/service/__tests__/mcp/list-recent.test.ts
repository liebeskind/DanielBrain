import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleListRecent } from '../../src/mcp/tools/list-recent.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleListRecent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns thoughts ordered by date', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'uuid-1',
          content: 'Thought 1',
          thought_type: 'idea',
          summary: 'First idea',
          people: [],
          topics: ['AI'],
          created_at: new Date('2026-03-02'),
        },
        {
          id: 'uuid-2',
          content: 'Thought 2',
          thought_type: 'meeting_note',
          summary: 'Meeting notes',
          people: ['Alice'],
          topics: [],
          created_at: new Date('2026-03-01'),
        },
      ],
    });

    const result = await handleListRecent({ days: 7, limit: 20 }, mockPool as any);

    expect(result).toHaveLength(2);
    expect(result[0].created_at).toEqual(new Date('2026-03-02'));
  });

  it('respects day and limit filters', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleListRecent({ days: 14, limit: 50, thought_type: 'idea' }, mockPool as any);

    const queryCall = mockPool.query.mock.calls[0];
    expect(queryCall[0]).toContain('parent_id IS NULL');
    expect(queryCall[1]).toContain(14);
    expect(queryCall[1]).toContain(50);
    expect(queryCall[1]).toContain('idea');
  });

  it('excludes chunk children', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleListRecent({ days: 7, limit: 20 }, mockPool as any);

    const queryCall = mockPool.query.mock.calls[0];
    expect(queryCall[0]).toContain('parent_id IS NULL');
  });
});
