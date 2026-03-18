import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleProposeRelationship } from '../../src/mcp/tools/propose-relationship.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleProposeRelationship', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates proposal for valid entities', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice Smith' }] }) // source
      .mockResolvedValueOnce({ rows: [{ id: 'e2', name: 'Topia' }] }) // target
      .mockResolvedValueOnce({ rows: [{ id: 'prop-1' }] }); // insert proposal

    const result = await handleProposeRelationship(
      {
        source_entity: 'Alice Smith',
        target_entity: 'Topia',
        description: 'Alice is the CTO of Topia',
        relationship_type: 'works_at',
      },
      mockPool as any,
    );

    expect(result.proposal_id).toBe('prop-1');
    expect(result.status).toBe('pending');
    expect(result.source_entity).toBe('Alice Smith');
    expect(result.target_entity).toBe('Topia');
  });

  it('returns error when source entity not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await handleProposeRelationship(
      {
        source_entity: 'Unknown',
        target_entity: 'Topia',
        description: 'test',
        relationship_type: 'works_at',
      },
      mockPool as any,
    );

    expect(result.error).toContain('Source entity not found');
  });

  it('returns error when target entity not found', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await handleProposeRelationship(
      {
        source_entity: 'Alice',
        target_entity: 'Unknown',
        description: 'test',
        relationship_type: 'works_at',
      },
      mockPool as any,
    );

    expect(result.error).toContain('Target entity not found');
  });
});
