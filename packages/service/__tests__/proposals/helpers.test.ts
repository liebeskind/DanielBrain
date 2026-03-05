import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldCreateProposal, createLinkProposal, createEnrichmentProposal } from '../../src/proposals/helpers.js';

const mockPool = {
  query: vi.fn(),
};

describe('shouldCreateProposal', () => {
  it('returns true when confidence is below entity_link threshold', () => {
    expect(shouldCreateProposal(0.7, 'entity_link')).toBe(true);
  });

  it('returns false when confidence meets entity_link threshold', () => {
    expect(shouldCreateProposal(0.8, 'entity_link')).toBe(false);
  });

  it('returns false when confidence exceeds threshold', () => {
    expect(shouldCreateProposal(1.0, 'entity_link')).toBe(false);
  });

  it('returns true for "always" threshold types', () => {
    expect(shouldCreateProposal(1.0, 'entity_enrichment')).toBe(true);
    expect(shouldCreateProposal(1.0, 'entity_merge')).toBe(true);
  });

  it('uses default threshold for unknown operation types', () => {
    // DEFAULT_APPROVAL_THRESHOLD = 0.8
    expect(shouldCreateProposal(0.7, 'unknown_op')).toBe(true);
    expect(shouldCreateProposal(0.9, 'unknown_op')).toBe(false);
  });
});

describe('createLinkProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a proposal row with correct data', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'proposal-1' }] });

    const id = await createLinkProposal({
      thoughtId: 'thought-1',
      entityId: 'entity-1',
      entityName: 'Chris',
      matchedName: 'Chris Psiaki',
      matchType: 'prefix',
      relationship: 'mentions',
      confidence: 0.7,
      aliasAdded: 'chris',
    }, mockPool as any);

    expect(id).toBe('proposal-1');
    expect(mockPool.query).toHaveBeenCalledTimes(1);

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO proposals');
    expect(params[0]).toBe('entity_link');
    expect(params[1]).toBe('entity-1');
    expect(params[2]).toContain('Chris');
    expect(params[2]).toContain('Chris Psiaki');
    const proposedData = JSON.parse(params[4]);
    expect(proposedData.thought_id).toBe('thought-1');
    expect(proposedData.alias_added).toBe('chris');
  });

  it('sets alias_added to null when not provided', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'proposal-2' }] });

    await createLinkProposal({
      thoughtId: 'thought-1',
      entityId: 'entity-1',
      entityName: 'Alice',
      matchedName: 'Alice Smith',
      matchType: 'canonical',
      relationship: 'from',
      confidence: 0.7,
    }, mockPool as any);

    const proposedData = JSON.parse(mockPool.query.mock.calls[0][1][4]);
    expect(proposedData.alias_added).toBeNull();
  });
});

describe('createEnrichmentProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts enrichment proposal', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 }); // auto-close needs_changes
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'proposal-3' }] });

    const id = await createEnrichmentProposal(
      'entity-1',
      'Alice Smith',
      { linkedin_url: 'https://linkedin.com/in/alice-smith' },
      'site:linkedin.com/in "Alice Smith" "Acme"',
      mockPool as any,
    );

    expect(id).toBe('proposal-3');
    // First call is the auto-close UPDATE, second is the INSERT
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('INSERT INTO proposals');
    expect(params[0]).toBe('entity_enrichment');
    expect(params[1]).toBe('entity-1');
    const proposedData = JSON.parse(params[4]);
    expect(proposedData.linkedin_url).toContain('alice-smith');
  });
});
