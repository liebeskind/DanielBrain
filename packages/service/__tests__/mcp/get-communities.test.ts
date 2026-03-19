import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetCommunities } from '../../src/mcp/tools/get-communities.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleGetCommunities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns communities filtered by level', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'c1', level: 0, title: 'Engineering', summary: 'The engineering team.', member_count: 5, created_at: new Date(), updated_at: new Date() },
      ],
    });

    // Members for c1
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Alice', entity_type: 'person', mention_count: 10 },
        { id: 'e2', name: 'Topia', entity_type: 'company', mention_count: 20 },
      ],
    });

    const result = await handleGetCommunities({ level: 0, limit: 20 }, mockPool as any);

    expect(result.communities).toHaveLength(1);
    expect(result.communities[0].title).toBe('Engineering');
    expect(result.communities[0].members).toHaveLength(2);
    expect(result.communities[0].members[0].name).toBe('Alice');
  });

  it('filters by entity_id', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleGetCommunities({ level: 0, entity_id: 'entity-uuid', limit: 20 }, mockPool as any);

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('entity_communities');
    expect(params).toContain('entity-uuid');
  });

  it('filters by search text', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await handleGetCommunities({ level: 0, search: 'engineering', limit: 20 }, mockPool as any);

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('ILIKE');
    expect(params).toContain('%engineering%');
  });

  it('returns empty when no communities exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await handleGetCommunities({ level: 0, limit: 20 }, mockPool as any);
    expect(result.communities).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
