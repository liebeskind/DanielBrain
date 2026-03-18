import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCooccurrenceEdges } from '../../src/processor/relationship-builder.js';

const mockPool = {
  query: vi.fn().mockResolvedValue({ rows: [] }),
};

describe('createCooccurrenceEdges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 for fewer than 2 entities', async () => {
    const result = await createCooccurrenceEdges('thought-1', ['e1'], mockPool as any);
    expect(result).toBe(0);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 0 for empty array', async () => {
    const result = await createCooccurrenceEdges('thought-1', [], mockPool as any);
    expect(result).toBe(0);
  });

  it('creates one edge for 2 entities', async () => {
    const result = await createCooccurrenceEdges(
      'thought-1',
      ['aaa-entity', 'bbb-entity'],
      mockPool as any,
    );

    expect(result).toBe(1);
    expect(mockPool.query).toHaveBeenCalledTimes(1);

    // Verify canonical direction: smaller UUID = source_id
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('co_occurs');
    expect(params[0]).toBe('aaa-entity'); // source (smaller)
    expect(params[1]).toBe('bbb-entity'); // target (larger)
    expect(params[2]).toBe('thought-1');
  });

  it('creates 3 edges for 3 entities (all pairs)', async () => {
    const result = await createCooccurrenceEdges(
      'thought-1',
      ['ccc', 'aaa', 'bbb'],
      mockPool as any,
    );

    expect(result).toBe(3);
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  it('creates 6 edges for 4 entities', async () => {
    const result = await createCooccurrenceEdges(
      'thought-1',
      ['a', 'b', 'c', 'd'],
      mockPool as any,
    );

    expect(result).toBe(6);
  });

  it('enforces canonical direction (smaller UUID first)', async () => {
    await createCooccurrenceEdges(
      'thought-1',
      ['zzz-entity', 'aaa-entity'],
      mockPool as any,
    );

    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toBe('aaa-entity'); // source (smaller)
    expect(params[1]).toBe('zzz-entity'); // target (larger)
  });

  it('deduplicates entity IDs', async () => {
    const result = await createCooccurrenceEdges(
      'thought-1',
      ['aaa', 'bbb', 'aaa', 'bbb'],
      mockPool as any,
    );

    expect(result).toBe(1); // Only one unique pair
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when all entity IDs are the same', async () => {
    const result = await createCooccurrenceEdges(
      'thought-1',
      ['aaa', 'aaa', 'aaa'],
      mockPool as any,
    );

    expect(result).toBe(0);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('skips pairs in skipPairs set', async () => {
    const skipPairs = new Set(['aaa-entity:bbb-entity']);
    const result = await createCooccurrenceEdges(
      'thought-1',
      ['aaa-entity', 'bbb-entity', 'ccc-entity'],
      mockPool as any,
      skipPairs,
    );

    // 3 entities = 3 pairs, but 1 is skipped → 2 edges created
    expect(result).toBe(2);
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    // Verify skipped pair was not inserted
    const allParams = mockPool.query.mock.calls.map((c: any) => [c[1][0], c[1][1]]);
    for (const [source, target] of allParams) {
      expect(`${source}:${target}`).not.toBe('aaa-entity:bbb-entity');
    }
  });

  it('caps at MAX_COOCCURRENCE_ENTITIES (20) to prevent quadratic explosion', async () => {
    // 25 unique entities → should be capped to 20 → C(20,2) = 190 edges
    const entities = Array.from({ length: 25 }, (_, i) => `entity-${String(i).padStart(3, '0')}`);
    const result = await createCooccurrenceEdges('thought-1', entities, mockPool as any);

    expect(result).toBe(190); // C(20,2), not C(25,2) = 300
    expect(mockPool.query).toHaveBeenCalledTimes(190);
  });

  it('does not cap when under MAX_COOCCURRENCE_ENTITIES', async () => {
    // 15 entities → C(15,2) = 105 edges, no truncation
    const entities = Array.from({ length: 15 }, (_, i) => `entity-${String(i).padStart(3, '0')}`);
    const result = await createCooccurrenceEdges('thought-1', entities, mockPool as any);

    expect(result).toBe(105); // C(15,2) = 105
    expect(mockPool.query).toHaveBeenCalledTimes(105);
  });

  it('uses UPSERT with weight increment', async () => {
    await createCooccurrenceEdges(
      'thought-1',
      ['aaa', 'bbb'],
      mockPool as any,
    );

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('weight = entity_relationships.weight + 1');
    expect(sql).toContain('last_seen_at = NOW()');
    expect(sql).toContain('array_append');
  });
});
