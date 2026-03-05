import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyProposal, revertProposal } from '../../src/proposals/applier.js';
import type { Proposal } from '@danielbrain/shared';

const mockPool = {
  query: vi.fn(),
};

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'proposal-1',
    proposal_type: 'entity_enrichment',
    status: 'approved',
    entity_id: 'entity-1',
    title: 'Test proposal',
    description: null,
    proposed_data: {},
    current_data: null,
    auto_applied: false,
    reviewer_notes: null,
    source: 'system',
    applied_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('applyProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies entity_enrichment by merging metadata', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_enrichment',
      entity_id: 'entity-1',
      proposed_data: { linkedin_url: 'https://linkedin.com/in/alice' },
    });
    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('UPDATE entities SET metadata = metadata ||');
    expect(params[0]).toContain('linkedin_url');
    expect(params[1]).toBe('entity-1');
  });

  it('throws if entity_enrichment has no entity_id', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_enrichment',
      entity_id: null,
    });

    await expect(applyProposal(proposal, mockPool as any))
      .rejects.toThrow('entity_enrichment proposal missing entity_id');
  });

  it('no-ops for entity_link (auto-applied)', async () => {
    const proposal = makeProposal({ proposal_type: 'entity_link' });

    await applyProposal(proposal, mockPool as any);

    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('applies entity_merge by reassigning links and deleting loser', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_merge',
      proposed_data: { winner_id: 'w1', loser_id: 'l1' },
    });
    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    // 4 queries: reassign links, delete dupes, merge aliases, delete loser
    expect(mockPool.query).toHaveBeenCalledTimes(4);
  });

  it('throws for unknown proposal type', async () => {
    const proposal = makeProposal({ proposal_type: 'unknown_type' });

    await expect(applyProposal(proposal, mockPool as any))
      .rejects.toThrow('Unknown proposal type: unknown_type');
  });
});

describe('revertProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverts entity_link by deleting link and decrementing count', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_link',
      auto_applied: true,
      proposed_data: {
        thought_id: 'thought-1',
        entity_id: 'entity-1',
        relationship: 'mentions',
      },
    });
    mockPool.query.mockResolvedValue({ rows: [] });

    await revertProposal(proposal, mockPool as any);

    // 2 queries: delete link, decrement count (no alias)
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    expect(mockPool.query.mock.calls[0][0]).toContain('DELETE FROM thought_entities');
    expect(mockPool.query.mock.calls[1][0]).toContain('mention_count');
  });

  it('also removes alias when alias_added is set', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_link',
      auto_applied: true,
      proposed_data: {
        thought_id: 'thought-1',
        entity_id: 'entity-1',
        relationship: 'mentions',
        alias_added: 'chris',
      },
    });
    mockPool.query.mockResolvedValue({ rows: [] });

    await revertProposal(proposal, mockPool as any);

    // 3 queries: delete link, decrement count, remove alias
    expect(mockPool.query).toHaveBeenCalledTimes(3);
    expect(mockPool.query.mock.calls[2][0]).toContain('array_remove');
  });

  it('no-ops for entity_enrichment (not auto-applied)', async () => {
    const proposal = makeProposal({ proposal_type: 'entity_enrichment' });

    await revertProposal(proposal, mockPool as any);

    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('no-ops for entity_merge (not auto-applied)', async () => {
    const proposal = makeProposal({ proposal_type: 'entity_merge' });

    await revertProposal(proposal, mockPool as any);

    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('throws for unknown proposal type', async () => {
    const proposal = makeProposal({ proposal_type: 'unknown_type' });

    await expect(revertProposal(proposal, mockPool as any))
      .rejects.toThrow('Unknown proposal type: unknown_type');
  });
});
