import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleListEntities } from '../../src/mcp/tools/list-entities.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleListEntities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns entities sorted by mention_count by default', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Alice', entity_type: 'person', mention_count: '10', last_seen_at: new Date(), profile_summary: null },
        { id: 'e2', name: 'Bob', entity_type: 'person', mention_count: '5', last_seen_at: new Date(), profile_summary: null },
      ],
    });

    const result = await handleListEntities(
      { sort_by: 'mention_count', limit: 20 },
      mockPool as any,
    );

    expect(result).toHaveLength(2);
    expect(result[0].mention_count).toBe(10);
    expect(result[1].mention_count).toBe(5);
  });

  it('filters by entity_type', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleListEntities(
      { entity_type: 'company', sort_by: 'mention_count', limit: 20 },
      mockPool as any,
    );

    const queryStr = mockPool.query.mock.calls[0][0];
    expect(queryStr).toContain('entity_type = $1');
    expect(mockPool.query.mock.calls[0][1]).toContain('company');
  });

  it('filters by name prefix query', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleListEntities(
      { query: 'Ali', sort_by: 'name', limit: 10 },
      mockPool as any,
    );

    const queryStr = mockPool.query.mock.calls[0][0];
    expect(queryStr).toContain('canonical_name LIKE');
    expect(mockPool.query.mock.calls[0][1]).toContain('ali%');
  });

  it('applies both entity_type and query filters', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleListEntities(
      { entity_type: 'person', query: 'Ali', sort_by: 'mention_count', limit: 20 },
      mockPool as any,
    );

    const params = mockPool.query.mock.calls[0][1];
    expect(params).toContain('person');
    expect(params).toContain('ali%');
  });

  it('respects limit parameter', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleListEntities(
      { sort_by: 'mention_count', limit: 5 },
      mockPool as any,
    );

    const queryStr = mockPool.query.mock.calls[0][0];
    expect(queryStr).toContain('LIMIT');
    expect(mockPool.query.mock.calls[0][1]).toContain(5);
  });

  it('sorts by last_seen_at', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleListEntities(
      { sort_by: 'last_seen_at', limit: 20 },
      mockPool as any,
    );

    const queryStr = mockPool.query.mock.calls[0][0];
    expect(queryStr).toContain('last_seen_at DESC');
  });
});
