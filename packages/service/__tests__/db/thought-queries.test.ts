import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchParentContext,
  listRecentThoughts,
  fetchThoughtsForEntity,
  fetchThoughtsForEntities,
  fetchTimelineForEntity,
} from '../../src/db/thought-queries.js';

const mockQuery = vi.fn();
const pool = { query: mockQuery } as any;

describe('thought-queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchParentContext', () => {
    it('returns empty map for empty parentIds', async () => {
      const result = await fetchParentContext(pool, [], null);
      expect(result.size).toBe(0);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('fetches parents without visibility filter for owner', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { id: 'p1', summary: 'Sum', thought_type: 'note', people: ['Alice'], topics: ['topic'] },
        ],
      });

      const result = await fetchParentContext(pool, ['p1'], null);
      expect(result.size).toBe(1);
      expect(result.get('p1')!.summary).toBe('Sum');

      // No visibility param
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).not.toContain('visibility');
      expect(params).toEqual([['p1']]);
    });

    it('applies visibility filter when tags provided', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await fetchParentContext(pool, ['p1', 'p2'], ['company', 'user:123']);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('visibility && $2');
      expect(params).toEqual([['p1', 'p2'], ['company', 'user:123']]);
    });
  });

  describe('listRecentThoughts', () => {
    it('queries with basic params', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await listRecentThoughts(pool, { days: 7, limit: 10 }, null);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('parent_id IS NULL');
      expect(params).toEqual([7, 10]);
    });

    it('adds visibility filter', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await listRecentThoughts(pool, { days: 7, limit: 10 }, ['company']);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('visibility && $3');
      expect(params).toEqual([7, 10, ['company']]);
    });

    it('includes thought_type and source filters', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await listRecentThoughts(
        pool,
        { days: 30, limit: 5, thought_type: 'note', source: 'slack' },
        ['company'],
      );

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('thought_type = $3');
      expect(sql).toContain('source = $4');
      expect(sql).toContain('visibility && $5');
      expect(params).toEqual([30, 5, 'note', 'slack', ['company']]);
    });
  });

  describe('fetchThoughtsForEntity', () => {
    it('fetches linked thoughts without visibility filter', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await fetchThoughtsForEntity(pool, 'entity-1', { limit: 20 }, null);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).not.toContain('visibility');
      expect(params).toEqual(['entity-1', 20]);
    });

    it('applies visibility filter', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await fetchThoughtsForEntity(pool, 'entity-1', { limit: 10 }, ['user:abc']);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('visibility && $2');
      expect(params).toEqual(['entity-1', ['user:abc'], 10]);
    });
  });

  describe('fetchThoughtsForEntities', () => {
    it('fetches with overlap counting', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await fetchThoughtsForEntities(
        pool,
        ['e1', 'e2'],
        { daysBack: 30, maxThoughts: 15 },
        null,
      );

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('entity_overlap');
      expect(params).toEqual([['e1', 'e2'], 30, 15]);
    });

    it('applies visibility filter', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await fetchThoughtsForEntities(
        pool,
        ['e1'],
        { daysBack: 7, maxThoughts: 5 },
        ['company'],
      );

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('visibility && $4');
      expect(params).toEqual([['e1'], 7, 5, ['company']]);
    });
  });

  describe('fetchTimelineForEntity', () => {
    it('fetches timeline entries', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await fetchTimelineForEntity(pool, 'e1', { daysBack: 30, limit: 50 }, null);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('te.entity_id = $1');
      expect(sql).toContain('parent_id IS NULL');
      expect(params).toEqual(['e1', 30, 50]);
    });

    it('adds sources and visibility filters', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await fetchTimelineForEntity(
        pool,
        'e1',
        { daysBack: 60, limit: 20, sources: ['slack', 'fathom'] },
        ['company', 'user:xyz'],
      );

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('source = ANY($3)');
      expect(sql).toContain('visibility && $4');
      expect(params).toEqual(['e1', 60, ['slack', 'fathom'], ['company', 'user:xyz'], 20]);
    });
  });
});
