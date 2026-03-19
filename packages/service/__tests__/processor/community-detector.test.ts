import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectCommunities } from '../../src/processor/community-detector.js';

const mockPool = {
  query: vi.fn(),
  connect: vi.fn(),
};

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

describe('detectCommunities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
  });

  it('returns early with 0 communities when no edges exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await detectCommunities(mockPool as any);
    expect(result).toEqual({ communities: 0, changed: false });
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('detects communities from edges and persists them', async () => {
    // Edges: A-B (weight 3), B-C (weight 2) → should form 1 community
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { source_id: 'a', target_id: 'b', weight: 3 },
        { source_id: 'b', target_id: 'c', weight: 2 },
      ],
    });

    // Existing communities: none
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // Transaction queries
    mockClient.query.mockResolvedValue({ rows: [{ id: 'comm-1' }] });

    const result = await detectCommunities(mockPool as any);

    expect(result.communities).toBeGreaterThan(0);
    expect(result.changed).toBe(true);

    // Verify transaction was used
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('skips persistence when membership has not changed', async () => {
    // Same edges as before
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { source_id: 'a', target_id: 'b', weight: 3 },
      ],
    });

    // Existing communities match what Louvain would produce
    // With 1 edge (a-b), Louvain puts them in the same community
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'comm-existing', member_ids: ['a', 'b'] }],
    });

    const result = await detectCommunities(mockPool as any);
    expect(result.changed).toBe(false);
    // Should not have connected to do a transaction
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('rolls back transaction on error', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { source_id: 'a', target_id: 'b', weight: 3 },
      ],
    });

    // No existing communities → changed
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // Transaction fails
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockRejectedValueOnce(new Error('DB error')); // DELETE

    await expect(detectCommunities(mockPool as any)).rejects.toThrow('DB error');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('filters edges by minimum weight', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await detectCommunities(mockPool as any);

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('weight >= $1');
    expect(params[0]).toBe(2); // COMMUNITY_MIN_EDGE_WEIGHT
  });

  it('handles multiple distinct communities', async () => {
    // Two separate clusters: A-B and C-D (no connection between clusters)
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { source_id: 'a', target_id: 'b', weight: 5 },
        { source_id: 'c', target_id: 'd', weight: 5 },
      ],
    });

    // No existing
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    mockClient.query.mockResolvedValue({ rows: [{ id: 'comm-new' }] });

    const result = await detectCommunities(mockPool as any);
    expect(result.communities).toBe(2);
    expect(result.changed).toBe(true);
  });
});
