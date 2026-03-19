import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleProposeMerge } from '../../src/mcp/tools/propose-merge.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleProposeMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates merge proposal when both entities found', async () => {
    // Resolve winner (canonical)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Chris Psiaki' }] });
    // Resolve loser (canonical)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e2', name: 'Chris' }] });
    // Insert proposal
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });

    const result = await handleProposeMerge(
      { winner: 'Chris Psiaki', loser: 'Chris', reason: 'Same person' },
      mockPool as any,
    );

    expect(result).toEqual({
      proposal_id: 'p1',
      winner: 'Chris Psiaki',
      loser: 'Chris',
      status: 'pending',
    });

    // Verify proposal data
    const insertCall = mockPool.query.mock.calls[2];
    expect(insertCall[1][0]).toBe('e1'); // entity_id = winner
    const proposedData = JSON.parse(insertCall[1][3]);
    expect(proposedData).toMatchObject({
      winner_id: 'e1',
      loser_id: 'e2',
    });
  });

  it('returns error when winner not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // canonical
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // alias

    const result = await handleProposeMerge(
      { winner: 'Nonexistent', loser: 'Chris' },
      mockPool as any,
    );

    expect(result).toEqual({ error: 'Winner entity not found: Nonexistent' });
  });

  it('returns error when loser not found', async () => {
    // Winner found
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Chris Psiaki' }] });
    // Loser not found (canonical)
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Loser not found (alias)
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await handleProposeMerge(
      { winner: 'Chris Psiaki', loser: 'Nobody' },
      mockPool as any,
    );

    expect(result).toEqual({ error: 'Loser entity not found: Nobody' });
  });

  it('returns error when winner and loser are the same entity', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Chris' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Chris' }] });

    const result = await handleProposeMerge(
      { winner: 'Chris', loser: 'chris' },
      mockPool as any,
    );

    expect(result).toEqual({ error: 'Winner and loser are the same entity: Chris' });
  });

  it('resolves entities by UUID', async () => {
    const uuid1 = '00000000-0000-0000-0000-000000000001';
    const uuid2 = '00000000-0000-0000-0000-000000000002';

    // UUID lookup for winner
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: uuid1, name: 'Entity A' }] });
    // UUID lookup for loser
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: uuid2, name: 'Entity B' }] });
    // Insert proposal
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });

    const result = await handleProposeMerge(
      { winner: uuid1, loser: uuid2 },
      mockPool as any,
    );

    expect(result).toMatchObject({
      winner: 'Entity A',
      loser: 'Entity B',
      status: 'pending',
    });
  });

  it('resolves entity by alias', async () => {
    // Winner canonical not found
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Winner alias found
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Chris Psiaki' }] });
    // Loser canonical found
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e2', name: 'Chris' }] });
    // Insert proposal
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });

    const result = await handleProposeMerge(
      { winner: 'cp', loser: 'Chris' },
      mockPool as any,
    );

    expect(result).toMatchObject({
      winner: 'Chris Psiaki',
      loser: 'Chris',
    });
  });
});
