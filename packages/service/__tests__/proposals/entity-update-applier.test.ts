import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyProposal, revertProposal } from '../../src/proposals/applier.js';
import type { Proposal } from '@danielbrain/shared';

const mockPool = {
  query: vi.fn(),
};

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    proposal_type: 'entity_update',
    status: 'approved',
    entity_id: 'e1',
    title: 'Update entity',
    description: null,
    proposed_data: {},
    current_data: null,
    auto_applied: false,
    reviewer_notes: null,
    source: 'mcp',
    applied_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('applyEntityUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renames entity and adds old name as alias', async () => {
    // Get current name
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Chris' }] });
    // Update name
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Add old name as alias
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await applyProposal(
      makeProposal({
        proposed_data: { new_name: 'Chris Psiaki' },
      }),
      mockPool as any,
    );

    // Verify name update
    const nameUpdate = mockPool.query.mock.calls[1];
    expect(nameUpdate[0]).toContain('UPDATE entities SET name');
    expect(nameUpdate[1]).toEqual(['Chris Psiaki', 'chris psiaki', 'e1']);

    // Verify old name added as alias
    const aliasAdd = mockPool.query.mock.calls[2];
    expect(aliasAdd[0]).toContain('array_append');
    expect(aliasAdd[1]).toContain('chris');
  });

  it('adds aliases', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(
      makeProposal({
        proposed_data: { add_aliases: ['cp', 'christopher'] },
      }),
      mockPool as any,
    );

    // Should have 2 alias-add queries
    const aliasCalls = mockPool.query.mock.calls.filter(
      (c) => c[0].includes('array_append')
    );
    expect(aliasCalls).toHaveLength(2);
    expect(aliasCalls[0][1]).toContain('cp');
    expect(aliasCalls[1][1]).toContain('christopher');
  });

  it('removes aliases', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(
      makeProposal({
        proposed_data: { remove_aliases: ['old-alias'] },
      }),
      mockPool as any,
    );

    const removeCalls = mockPool.query.mock.calls.filter(
      (c) => c[0].includes('array_remove')
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0][1]).toContain('old-alias');
  });

  it('merges metadata', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(
      makeProposal({
        proposed_data: { metadata: { linkedin: 'https://linkedin.com/in/chris' } },
      }),
      mockPool as any,
    );

    const metadataCalls = mockPool.query.mock.calls.filter(
      (c) => c[0].includes('metadata || $1::jsonb')
    );
    expect(metadataCalls).toHaveLength(1);
  });

  it('updates entity type', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(
      makeProposal({
        proposed_data: { entity_type: 'company' },
      }),
      mockPool as any,
    );

    const typeCalls = mockPool.query.mock.calls.filter(
      (c) => c[0].includes('entity_type = $1')
    );
    expect(typeCalls).toHaveLength(1);
    expect(typeCalls[0][1]).toEqual(['company', 'e1']);
  });

  it('throws when entity_id is missing', async () => {
    await expect(
      applyProposal(
        makeProposal({ entity_id: null }),
        mockPool as any,
      )
    ).rejects.toThrow('entity_update proposal missing entity_id');
  });

  it('revert is a no-op (not auto-applied)', async () => {
    // Should not throw
    await revertProposal(
      makeProposal(),
      mockPool as any,
    );
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
