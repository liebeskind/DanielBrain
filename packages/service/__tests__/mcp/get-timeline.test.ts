import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetTimeline } from '../../src/mcp/tools/get-timeline.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleGetTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns timeline grouped by date', async () => {
    // Resolve entity
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice' }],
    });
    // Timeline entries
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 't1', content: 'Note 1', summary: null, thought_type: 'meeting_note', relationship: 'about', source: 'slack', created_at: new Date('2026-03-02T10:00:00Z') },
        { id: 't2', content: 'Note 2', summary: null, thought_type: 'idea', relationship: 'mentions', source: 'telegram', created_at: new Date('2026-03-02T14:00:00Z') },
        { id: 't3', content: 'Note 3', summary: null, thought_type: 'task', relationship: 'assigned_to', source: 'slack', created_at: new Date('2026-03-01T09:00:00Z') },
      ],
    });

    const result = await handleGetTimeline(
      { entity_name: 'Alice', days_back: 30, limit: 50 },
      mockPool as any,
    );

    expect(result.entity_name).toBe('Alice');
    expect(result.total_entries).toBe(3);
    expect(result.timeline).toHaveLength(2); // 2 dates
    expect(result.timeline[0].date).toBe('2026-03-02'); // newest first
    expect(result.timeline[0].entries).toHaveLength(2);
    expect(result.timeline[1].date).toBe('2026-03-01');
  });

  it('fetches entity by id', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await handleGetTimeline(
      { entity_id: 'e1', days_back: 30, limit: 50 },
      mockPool as any,
    );

    expect(result.entity_id).toBe('e1');
    expect(result.entity_name).toBe('Alice');
  });

  it('throws when entity not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      handleGetTimeline(
        { entity_name: 'Nobody', days_back: 30, limit: 50 },
        mockPool as any,
      )
    ).rejects.toThrow('Entity not found');
  });

  it('filters by source', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice' }] })
      .mockResolvedValueOnce({ rows: [] });

    await handleGetTimeline(
      { entity_name: 'Alice', days_back: 30, limit: 50, sources: ['slack'] },
      mockPool as any,
    );

    const queryStr = mockPool.query.mock.calls[1][0];
    expect(queryStr).toContain('t.source = ANY');
    expect(mockPool.query.mock.calls[1][1]).toContainEqual(['slack']);
  });

  it('returns empty timeline for entity with no thoughts', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await handleGetTimeline(
      { entity_name: 'Alice', days_back: 7, limit: 50 },
      mockPool as any,
    );

    expect(result.timeline).toEqual([]);
    expect(result.total_entries).toBe(0);
  });
});
