import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleQueryRelationships } from '../../src/mcp/tools/query-relationships.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleQueryRelationships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns relationships for an entity by name', async () => {
    // Resolve entity name
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'entity-1' }] });
    // Query relationships
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'rel-1',
          relationship: 'co_occurs',
          description: 'They work together.',
          weight: 5,
          is_explicit: false,
          valid_at: null,
          invalid_at: null,
          source_entity_id: 'entity-1',
          source_name: 'Alice',
          source_type: 'person',
          target_entity_id: 'entity-2',
          target_name: 'Topia',
          target_type: 'company',
        },
      ],
    });

    const result = await handleQueryRelationships(
      { entity_name: 'alice', min_weight: 1, limit: 20 },
      mockPool as any,
    );

    expect(result.entity_id).toBe('entity-1');
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].connected_entity.name).toBe('Topia');
  });

  it('returns relationships by entity ID', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await handleQueryRelationships(
      { entity_id: 'entity-1', min_weight: 1, limit: 20 },
      mockPool as any,
    );

    expect(result.relationships).toEqual([]);
  });

  it('returns error when entity not found by name', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await handleQueryRelationships(
      { entity_name: 'nonexistent', min_weight: 1, limit: 20 },
      mockPool as any,
    );

    expect(result.error).toContain('not found');
  });
});
