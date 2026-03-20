import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyProposal, revertProposal } from '../../src/proposals/applier.js';
import type { Proposal } from '@danielbrain/shared';

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

const mockPool = {
  query: vi.fn(),
  connect: vi.fn().mockResolvedValue(mockClient),
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
    mockClient.query.mockResolvedValue({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    // Transaction: BEGIN + 7 operations + COMMIT = 9 queries via client
    // reassign thought links, delete thought dupes, merge aliases,
    // reassign relationship source_ids, reassign relationship target_ids,
    // delete remaining relationship edges, delete community memberships, delete loser
    expect(mockPool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalled();
    expect(mockClient.query.mock.calls[0][0]).toBe('BEGIN');
    expect(mockClient.query.mock.calls[mockClient.query.mock.calls.length - 1][0]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('throws for unknown proposal type', async () => {
    const proposal = makeProposal({ proposal_type: 'unknown_type' });

    await expect(applyProposal(proposal, mockPool as any))
      .rejects.toThrow('Unknown proposal type: unknown_type');
  });

  // --- entity_relationship tests ---

  it('applies entity_relationship by invalidating old edge and creating successor', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_relationship',
      proposed_data: {
        edge_id: 'edge-1',
        new_description: 'Updated: they are now competitors',
      },
    });

    // First call: invalidate old edge
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Second call: fetch old edge
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        source_id: 'src-1',
        target_id: 'tgt-1',
        relationship: 'co_occurs',
        weight: 5,
        source_thought_ids: ['t1', 't2'],
      }],
    });
    // Third call: insert successor edge
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    // Invalidate old edge
    expect(mockPool.query.mock.calls[0][0]).toContain('invalid_at = NOW()');
    expect(mockPool.query.mock.calls[0][1]).toEqual(['edge-1']);

    // Fetch old edge
    expect(mockPool.query.mock.calls[1][0]).toContain('SELECT source_id, target_id');
    expect(mockPool.query.mock.calls[1][1]).toEqual(['edge-1']);

    // Insert successor with new description
    const insertSql = mockPool.query.mock.calls[2][0];
    expect(insertSql).toContain('INSERT INTO entity_relationships');
    const insertParams = mockPool.query.mock.calls[2][1];
    expect(insertParams[0]).toBe('src-1');
    expect(insertParams[1]).toBe('tgt-1');
    expect(insertParams[2]).toBe('co_occurs');
    expect(insertParams[3]).toBe('Updated: they are now competitors');
    expect(insertParams[4]).toBe(5);
    expect(insertParams[5]).toEqual(['t1', 't2']);
  });

  it('entity_relationship throws if edge_id missing', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_relationship',
      proposed_data: { new_description: 'some desc' },
    });

    await expect(applyProposal(proposal, mockPool as any))
      .rejects.toThrow('entity_relationship proposal missing edge_id or new_description');
  });

  it('entity_relationship throws if new_description missing', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_relationship',
      proposed_data: { edge_id: 'edge-1' },
    });

    await expect(applyProposal(proposal, mockPool as any))
      .rejects.toThrow('entity_relationship proposal missing edge_id or new_description');
  });

  it('entity_relationship skips successor insert when old edge not found', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_relationship',
      proposed_data: { edge_id: 'edge-gone', new_description: 'new desc' },
    });

    // Invalidate (succeeds even if edge is gone)
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Fetch returns empty
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    // Only 2 queries: invalidate + fetch; no insert
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  // --- entity_update tests ---

  it('applies entity_update with name change, adds old name as alias', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_update',
      entity_id: 'entity-1',
      proposed_data: { new_name: 'Chris Psiaki' },
    });

    // Fetch current name
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Chris' }] });
    // Update name + canonical_name
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Add old name as alias
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    // Name update
    const updateCall = mockPool.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE entities SET name');
    expect(updateCall[1][0]).toBe('Chris Psiaki');
    expect(updateCall[1][1]).toBe('chris psiaki'); // lowercased canonical
    expect(updateCall[1][2]).toBe('entity-1');

    // Old name added as alias
    const aliasCall = mockPool.query.mock.calls[2];
    expect(aliasCall[0]).toContain('array_append');
    expect(aliasCall[1][0]).toBe('chris'); // old name lowercased
  });

  it('applies entity_update adding aliases', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_update',
      entity_id: 'entity-1',
      proposed_data: { add_aliases: ['Christopher', 'CP'] },
    });

    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    // One query per alias
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    expect(mockPool.query.mock.calls[0][1][0]).toBe('christopher');
    expect(mockPool.query.mock.calls[1][1][0]).toBe('cp');
  });

  it('applies entity_update removing aliases', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_update',
      entity_id: 'entity-1',
      proposed_data: { remove_aliases: ['old-alias'] },
    });

    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('array_remove');
    expect(params[0]).toBe('old-alias');
  });

  it('applies entity_update merging metadata', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_update',
      entity_id: 'entity-1',
      proposed_data: { metadata: { linkedin_url: 'https://linkedin.com/in/foo' } },
    });

    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('metadata = metadata ||');
    expect(JSON.parse(params[0])).toEqual({ linkedin_url: 'https://linkedin.com/in/foo' });
  });

  it('applies entity_update changing entity_type', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_update',
      entity_id: 'entity-1',
      proposed_data: { entity_type: 'company' },
    });

    mockPool.query.mockResolvedValue({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('entity_type = $1');
    expect(params[0]).toBe('company');
  });

  it('entity_update throws if entity_id missing', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_update',
      entity_id: null,
      proposed_data: { new_name: 'X' },
    });

    await expect(applyProposal(proposal, mockPool as any))
      .rejects.toThrow('entity_update proposal missing entity_id');
  });

  it('applies entity_update with combined changes', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_update',
      entity_id: 'entity-1',
      proposed_data: {
        new_name: 'Topia Inc',
        add_aliases: ['topia'],
        metadata: { website: 'https://topia.com' },
        entity_type: 'company',
      },
    });

    // Fetch current name for rename
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Topia' }] });
    // Update name
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Add old name as alias
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Add alias 'topia'
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Merge metadata
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Update entity_type
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    expect(mockPool.query).toHaveBeenCalledTimes(6);
  });

  // --- entity_merge rollback test ---

  it('entity_merge calls ROLLBACK and releases client on DB error', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_merge',
      proposed_data: { winner_id: 'w1', loser_id: 'l1' },
    });

    // BEGIN succeeds
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    // First operation fails
    mockClient.query.mockRejectedValueOnce(new Error('FK violation'));
    // ROLLBACK succeeds
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    await expect(applyProposal(proposal, mockPool as any)).rejects.toThrow('FK violation');

    // Verify ROLLBACK was called
    const rollbackCall = mockClient.query.mock.calls.find(
      (call: any[]) => call[0] === 'ROLLBACK',
    );
    expect(rollbackCall).toBeDefined();

    // Verify client was released
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('entity_merge throws when winner_id is missing', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_merge',
      proposed_data: { loser_id: 'l1' },
    });

    await expect(applyProposal(proposal, mockPool as any))
      .rejects.toThrow('entity_merge proposal missing winner_id or loser_id');
  });

  it('entity_merge throws when loser_id is missing', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_merge',
      proposed_data: { winner_id: 'w1' },
    });

    await expect(applyProposal(proposal, mockPool as any))
      .rejects.toThrow('entity_merge proposal missing winner_id or loser_id');
  });

  // --- entity_enrichment LinkedIn upgrade tests ---

  it('entity_enrichment upgrades entity name from LinkedIn title', async () => {
    const proposal = makeProposal({
      proposal_type: 'entity_enrichment',
      entity_id: 'entity-1',
      proposed_data: {
        linkedin_url: 'https://linkedin.com/in/luke',
        linkedin_title: 'Luke Rodehorst - CEO at SomeCompany',
        linkedin_snippet: 'Experienced leader in tech.',
      },
    });

    // metadata merge
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // fetch entity for LinkedIn enrichment
    mockPool.query.mockResolvedValueOnce({
      rows: [{ name: 'Luke', profile_summary: 'Known engineer.' }],
    });
    // name upgrade
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // profile append
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await applyProposal(proposal, mockPool as any);

    // Name upgraded from "Luke" to "Luke Rodehorst"
    const nameUpgradeCall = mockPool.query.mock.calls[2];
    expect(nameUpgradeCall[1][0]).toBe('Luke Rodehorst');
    expect(nameUpgradeCall[1][1]).toBe('luke rodehorst');
    expect(nameUpgradeCall[1][2]).toBe('luke'); // old name as alias

    // Profile appended
    const profileCall = mockPool.query.mock.calls[3];
    expect(profileCall[1][0]).toContain('LinkedIn:');
    expect(profileCall[1][0]).toContain('Luke Rodehorst - CEO at SomeCompany');
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

  it('no-ops for entity_relationship (not auto-applied)', async () => {
    const proposal = makeProposal({ proposal_type: 'entity_relationship' });

    await revertProposal(proposal, mockPool as any);

    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('no-ops for entity_update (not auto-applied)', async () => {
    const proposal = makeProposal({ proposal_type: 'entity_update' });

    await revertProposal(proposal, mockPool as any);

    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('throws for unknown proposal type', async () => {
    const proposal = makeProposal({ proposal_type: 'unknown_type' });

    await expect(revertProposal(proposal, mockPool as any))
      .rejects.toThrow('Unknown proposal type: unknown_type');
  });
});
