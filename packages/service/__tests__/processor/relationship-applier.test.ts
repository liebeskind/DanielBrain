import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLog = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => mockLog,
}));

import { applyExtractedRelationships } from '../../src/processor/relationship-applier.js';

vi.mock('../../src/processor/entity-resolver.js', () => ({
  normalizeName: vi.fn((name: string) => name.toLowerCase().trim()),
}));

const mockPool = { query: vi.fn() };

describe('applyExtractedRelationships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty set for empty relationships array', async () => {
    const result = await applyExtractedRelationships([], 'thought-1', mockPool as any);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('looks up entities by canonical_name and inserts relationship', async () => {
    // Source entity lookup
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'aaa-111' }] });
    // Target entity lookup
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'bbb-222' }] });
    // Insert relationship
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const relationships = [
      { source: 'Alice', target: 'Topia', relationship: 'works_at', description: 'Alice works at Topia' },
    ];

    const result = await applyExtractedRelationships(relationships, 'thought-1', mockPool as any);

    expect(result.size).toBe(1);
    // Source lookup
    expect(mockPool.query.mock.calls[0][0]).toContain('SELECT id FROM entities WHERE canonical_name');
    expect(mockPool.query.mock.calls[0][1]).toEqual(['alice']);
    // Target lookup
    expect(mockPool.query.mock.calls[1][1]).toEqual(['topia']);
    // Insert
    expect(mockPool.query.mock.calls[2][0]).toContain('INSERT INTO entity_relationships');
  });

  it('applies canonical direction: smaller UUID = source_id', async () => {
    // Source entity has larger UUID
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'zzz-999' }] });
    // Target entity has smaller UUID
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'aaa-111' }] });
    // Insert
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const relationships = [
      { source: 'Zara', target: 'Alice', relationship: 'manages', description: 'Zara manages Alice' },
    ];

    const result = await applyExtractedRelationships(relationships, 'thought-1', mockPool as any);

    // Canonical direction: aaa-111 (smaller) should be source_id
    const insertCall = mockPool.query.mock.calls[2];
    expect(insertCall[1][0]).toBe('aaa-111'); // canonSource
    expect(insertCall[1][1]).toBe('zzz-999'); // canonTarget
    expect(result.has('aaa-111:zzz-999')).toBe(true);
  });

  it('keeps natural direction when source UUID is already smaller', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'aaa-111' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'zzz-999' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const relationships = [
      { source: 'Alice', target: 'Zara', relationship: 'reports_to', description: 'Alice reports to Zara' },
    ];

    const result = await applyExtractedRelationships(relationships, 'thought-1', mockPool as any);

    const insertCall = mockPool.query.mock.calls[2];
    expect(insertCall[1][0]).toBe('aaa-111');
    expect(insertCall[1][1]).toBe('zzz-999');
    expect(result.has('aaa-111:zzz-999')).toBe(true);
  });

  it('skips when source entity not found', async () => {
    // Source not found
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Target found
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'bbb-222' }] });

    const relationships = [
      { source: 'Unknown', target: 'Topia', relationship: 'works_at', description: 'Unknown works at Topia' },
    ];

    const result = await applyExtractedRelationships(relationships, 'thought-1', mockPool as any);

    expect(result.size).toBe(0);
    // Only 2 lookups, no insert
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('skips when target entity not found', async () => {
    // Source found
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'aaa-111' }] });
    // Target not found
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const relationships = [
      { source: 'Alice', target: 'Unknown', relationship: 'works_at', description: 'Alice works at Unknown' },
    ];

    const result = await applyExtractedRelationships(relationships, 'thought-1', mockPool as any);

    expect(result.size).toBe(0);
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('continues processing after one relationship fails', async () => {
    // First relationship: source lookup throws
    mockPool.query.mockRejectedValueOnce(new Error('DB error'));
    // Second relationship: succeeds
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'ccc-333' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'ddd-444' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const relationships = [
      { source: 'Broken', target: 'Topia', relationship: 'works_at', description: 'fails' },
      { source: 'Chris', target: 'Daniel', relationship: 'collaborates_with', description: 'they work together' },
    ];

    const result = await applyExtractedRelationships(relationships, 'thought-1', mockPool as any);

    // First failed, second succeeded
    expect(result.size).toBe(1);
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });

  it('returns correct set of applied canonical pairs', async () => {
    // First relationship
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'aaa-111' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'bbb-222' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Second relationship
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'ccc-333' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'ddd-444' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const relationships = [
      { source: 'Alice', target: 'Bob', relationship: 'manages', description: 'Alice manages Bob' },
      { source: 'Chris', target: 'Daniel', relationship: 'collaborates_with', description: 'partners' },
    ];

    const result = await applyExtractedRelationships(relationships, 'thought-1', mockPool as any);

    expect(result.size).toBe(2);
    expect(result.has('aaa-111:bbb-222')).toBe(true);
    expect(result.has('ccc-333:ddd-444')).toBe(true);
  });

  it('passes relationship type and description to the insert', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'aaa-111' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'bbb-222' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const relationships = [
      { source: 'Alice', target: 'Topia', relationship: 'works_at', description: 'Alice is an engineer at Topia' },
    ];

    await applyExtractedRelationships(relationships, 'thought-42', mockPool as any);

    const insertCall = mockPool.query.mock.calls[2];
    expect(insertCall[1][2]).toBe('works_at');       // relationship
    expect(insertCall[1][3]).toBe('Alice is an engineer at Topia'); // description
    expect(insertCall[1][4]).toBe('thought-42');     // thoughtId
  });

  it('uses ON CONFLICT upsert with source_thought_ids appending', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'aaa-111' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'bbb-222' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const relationships = [
      { source: 'Alice', target: 'Bob', relationship: 'works_at', description: 'test' },
    ];

    await applyExtractedRelationships(relationships, 'thought-1', mockPool as any);

    const insertSql = mockPool.query.mock.calls[2][0];
    expect(insertSql).toContain('ON CONFLICT');
    expect(insertSql).toContain('source_thought_ids');
    expect(insertSql).toContain('array_append');
  });
});
