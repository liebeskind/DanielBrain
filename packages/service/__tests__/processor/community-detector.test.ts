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

  it('single edge graph produces single community with both nodes', async () => {
    // One edge: x-y → Louvain assigns both to community 0
    mockPool.query.mockResolvedValueOnce({
      rows: [{ source_id: 'x', target_id: 'y', weight: 4 }],
    });

    // No existing communities
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // Transaction mocks
    mockClient.query.mockResolvedValue({ rows: [{ id: 'comm-single' }] });

    const result = await detectCommunities(mockPool as any);
    expect(result.communities).toBe(1);
    expect(result.changed).toBe(true);

    // Verify both nodes are inserted as members in entity_communities
    const entityCommunityCalls = mockClient.query.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO entity_communities')
    );
    expect(entityCommunityCalls).toHaveLength(2);
    const insertedEntityIds = entityCommunityCalls.map((c: any[]) => c[1][0]);
    expect(insertedEntityIds).toContain('x');
    expect(insertedEntityIds).toContain('y');
  });

  it('hash stability: identical membership sets produce same hash (unchanged)', async () => {
    // Provide edges that produce community {a, b}
    mockPool.query.mockResolvedValueOnce({
      rows: [{ source_id: 'a', target_id: 'b', weight: 3 }],
    });

    // Existing communities have exactly {a, b} (matching what Louvain will produce)
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'existing-1', member_ids: ['a', 'b'] }],
    });

    const result = await detectCommunities(mockPool as any);
    expect(result.changed).toBe(false);
    expect(result.communities).toBe(1);
    // No transaction needed
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('hash detects change when membership differs', async () => {
    // Edges produce community {a, b, c}
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { source_id: 'a', target_id: 'b', weight: 5 },
        { source_id: 'b', target_id: 'c', weight: 5 },
        { source_id: 'a', target_id: 'c', weight: 5 },
      ],
    });

    // Existing communities only had {a, b} — different from new {a, b, c}
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'old-1', member_ids: ['a', 'b'] }],
    });

    mockClient.query.mockResolvedValue({ rows: [{ id: 'comm-new' }] });

    const result = await detectCommunities(mockPool as any);
    expect(result.changed).toBe(true);
    // Transaction was opened
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('transaction: deletes old communities before inserting new ones', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ source_id: 'a', target_id: 'b', weight: 3 }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // no existing

    mockClient.query.mockResolvedValue({ rows: [{ id: 'new-comm' }] });

    await detectCommunities(mockPool as any, 0);

    const txCalls = mockClient.query.mock.calls.map((c: any[]) => c[0]);
    const beginIdx = txCalls.indexOf('BEGIN');
    const deleteIdx = txCalls.findIndex((s: string) => typeof s === 'string' && s.includes('DELETE FROM communities'));
    const insertIdx = txCalls.findIndex((s: string) => typeof s === 'string' && s.includes('INSERT INTO communities'));
    const commitIdx = txCalls.indexOf('COMMIT');

    expect(beginIdx).toBeLessThan(deleteIdx);
    expect(deleteIdx).toBeLessThan(insertIdx);
    expect(insertIdx).toBeLessThan(commitIdx);
  });

  it('skips self-loop edges in graph construction', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { source_id: 'a', target_id: 'a', weight: 5 }, // self-loop, should be skipped
        { source_id: 'a', target_id: 'b', weight: 3 },
      ],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // no existing

    mockClient.query.mockResolvedValue({ rows: [{ id: 'comm-1' }] });

    const result = await detectCommunities(mockPool as any);
    expect(result.communities).toBe(1); // a and b in one community
    expect(result.changed).toBe(true);
  });

  it('passes custom level parameter through to queries', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ source_id: 'a', target_id: 'b', weight: 3 }],
    });
    // Existing communities query uses level
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'c1', member_ids: ['a', 'b'] }] });

    await detectCommunities(mockPool as any, 2);

    // Second query (existing communities) should filter by level=2
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('level = $1');
    expect(params[0]).toBe(2);
  });

  it('client is always released even on error', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ source_id: 'a', target_id: 'b', weight: 3 }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockRejectedValueOnce(new Error('boom'));

    await expect(detectCommunities(mockPool as any)).rejects.toThrow('boom');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});
