import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCorrectionExample, listCorrectionExamples, deleteCorrectionExample, getExamplesByCategory } from '../../src/corrections/store.js';

const mockPool = {
  query: vi.fn(),
};

describe('corrections/store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createCorrectionExample', () => {
    it('inserts a correction example and returns id', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'ce-1' }] });

      const id = await createCorrectionExample({
        category: 'linkedin_search',
        input_context: { entity_name: 'Jamie Farrell', search_query: 'test' },
        actual_output: { linkedin_url: 'https://linkedin.com/in/wrong' },
        expected_output: { linkedin_url: 'https://linkedin.com/in/correct' },
        explanation: 'Wrong person found',
        entity_id: 'e-1',
        proposal_id: 'p-1',
        tags: ['auto-captured'],
      }, mockPool as any);

      expect(id).toBe('ce-1');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO correction_examples'),
        expect.arrayContaining([
          'linkedin_search',
          expect.stringContaining('Jamie Farrell'),
          expect.stringContaining('wrong'),
          expect.stringContaining('correct'),
          'Wrong person found',
          'e-1',
          'p-1',
          ['auto-captured'],
        ])
      );
    });

    it('handles nullable fields', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'ce-2' }] });

      const id = await createCorrectionExample({
        category: 'entity_extraction',
        input_context: { text: 'test' },
        expected_output: { people: ['Alice'] },
      }, mockPool as any);

      expect(id).toBe('ce-2');
      const args = mockPool.query.mock.calls[0][1];
      expect(args[2]).toBeNull(); // actual_output
      expect(args[4]).toBeNull(); // explanation
      expect(args[5]).toBeNull(); // entity_id
      expect(args[6]).toBeNull(); // proposal_id
      expect(args[7]).toEqual([]); // tags
    });
  });

  describe('listCorrectionExamples', () => {
    it('lists with no filters', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'ce-1', category: 'linkedin_search' }] })
        .mockResolvedValueOnce({ rows: [{ total: '1' }] });

      const result = await listCorrectionExamples({}, mockPool as any);

      expect(result.examples).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockPool.query.mock.calls[0][0]).toContain('ORDER BY created_at DESC');
    });

    it('filters by category', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      await listCorrectionExamples({ category: 'entity_link' }, mockPool as any);

      expect(mockPool.query.mock.calls[0][0]).toContain('category = $1');
      expect(mockPool.query.mock.calls[0][1]).toContain('entity_link');
    });

    it('filters by entity_id', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      await listCorrectionExamples({ entity_id: 'e-1' }, mockPool as any);

      expect(mockPool.query.mock.calls[0][0]).toContain('entity_id = $1');
    });

    it('filters by tags', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      await listCorrectionExamples({ tags: ['auto-captured'] }, mockPool as any);

      expect(mockPool.query.mock.calls[0][0]).toContain('tags @> $1');
    });

    it('supports pagination', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '10' }] });

      await listCorrectionExamples({ limit: 5, offset: 5 }, mockPool as any);

      const params = mockPool.query.mock.calls[0][1];
      expect(params).toContain(5); // limit
      expect(params).toContain(5); // offset
    });
  });

  describe('deleteCorrectionExample', () => {
    it('returns true when deleted', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      const result = await deleteCorrectionExample('ce-1', mockPool as any);
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 0 });

      const result = await deleteCorrectionExample('ce-999', mockPool as any);
      expect(result).toBe(false);
    });
  });

  describe('getExamplesByCategory', () => {
    it('fetches examples by category with limit', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'ce-1', category: 'linkedin_search' },
          { id: 'ce-2', category: 'linkedin_search' },
        ],
      });

      const result = await getExamplesByCategory('linkedin_search', mockPool as any, 5);

      expect(result).toHaveLength(2);
      expect(mockPool.query.mock.calls[0][1]).toEqual(['linkedin_search', 5]);
    });

    it('defaults to limit 10', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await getExamplesByCategory('entity_extraction', mockPool as any);

      expect(mockPool.query.mock.calls[0][1]).toEqual(['entity_extraction', 10]);
    });
  });
});
