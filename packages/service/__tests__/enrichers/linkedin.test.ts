import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enrichLinkedInBatch,
  resetDailyCounter,
  getDailySearchCount,
  extractProfileKeywords,
  loadLinkedInCorrections,
} from '../../src/enrichers/linkedin.js';

// Mock proposal helpers
vi.mock('../../src/proposals/helpers.js', () => ({
  createEnrichmentProposal: vi.fn().mockResolvedValue('proposal-id'),
}));

vi.mock('../../src/corrections/store.js', () => ({
  getExamplesByCategory: vi.fn().mockResolvedValue([]),
}));

import { createEnrichmentProposal } from '../../src/proposals/helpers.js';
import { getExamplesByCategory } from '../../src/corrections/store.js';

const mockPool = {
  query: vi.fn(),
};

const config = {
  serpApiKey: 'test-serp-key',
};

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('enrichLinkedInBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDailyCounter();
  });

  it('finds candidates and creates proposals for LinkedIn matches', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Alice Smith', company_name: 'Acme' },
      ],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        organic_results: [{
          link: 'https://linkedin.com/in/alice-smith',
          title: 'Alice Smith - VP Engineering at Acme | LinkedIn',
          snippet: 'View Alice Smith\u2019s profile on LinkedIn, the world\u2019s largest professional community.',
        }],
      }),
    });

    const count = await enrichLinkedInBatch(mockPool as any, config);

    expect(count).toBe(1);
    expect(createEnrichmentProposal).toHaveBeenCalledWith(
      'e1',
      'Alice Smith',
      {
        linkedin_url: 'https://linkedin.com/in/alice-smith',
        linkedin_title: 'Alice Smith - VP Engineering at Acme | LinkedIn',
        linkedin_snippet: 'View Alice Smith\u2019s profile on LinkedIn, the world\u2019s largest professional community.',
      },
      expect.stringContaining('Alice Smith'),
      mockPool,
    );
  });

  it('skips candidates when no LinkedIn result found', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Bob Jones', company_name: null }],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ organic_results: [] }),
    });

    const count = await enrichLinkedInBatch(mockPool as any, config);

    expect(count).toBe(0);
    expect(createEnrichmentProposal).not.toHaveBeenCalled();
  });

  it('rejects non-LinkedIn URLs from search results', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Carol', company_name: null }],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        organic_results: [{ link: 'https://twitter.com/carol', title: 'Carol', snippet: '' }],
      }),
    });

    const count = await enrichLinkedInBatch(mockPool as any, config);

    expect(count).toBe(0);
    expect(createEnrichmentProposal).not.toHaveBeenCalled();
  });

  it('stops when daily limit is reached', async () => {
    // SERPAPI_DAILY_LIMIT = 33, batch size = 5
    // Need 7 calls (7 * 5 = 35, capped at 33)
    for (let i = 0; i < 7; i++) {
      const remaining = 33 - i * 5;
      const batchSize = Math.min(5, remaining);
      if (batchSize <= 0) break;
      const candidates = [];
      for (let j = 0; j < batchSize; j++) {
        candidates.push({ id: `e${i * 5 + j}`, name: `Person ${i * 5 + j}`, company_name: null });
      }
      mockPool.query.mockResolvedValueOnce({ rows: candidates });
      for (let j = 0; j < batchSize; j++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ organic_results: [] }),
        });
      }
      await enrichLinkedInBatch(mockPool as any, config);
    }

    expect(getDailySearchCount()).toBe(33);

    // Next call should return 0 without querying
    const count = await enrichLinkedInBatch(mockPool as any, config);
    expect(count).toBe(0);
  });

  it('handles fetch errors gracefully', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Dan', company_name: null }],
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const count = await enrichLinkedInBatch(mockPool as any, config);

    expect(count).toBe(0);
    expect(createEnrichmentProposal).not.toHaveBeenCalled();
  });

  it('returns 0 when no candidates found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const count = await enrichLinkedInBatch(mockPool as any, config);

    expect(count).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('includes company name in search query when available', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Eve', company_name: 'TechCorp' }],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ organic_results: [] }),
    });

    await enrichLinkedInBatch(mockPool as any, config);

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain(encodeURIComponent('"TechCorp"'));
  });

  it('daily rate limit enforced: returns 0 without querying when at limit', async () => {
    // Set counter to exactly SERPAPI_DAILY_LIMIT (33)
    resetDailyCounter();
    // Run batches until we hit the limit
    for (let i = 0; i < 7; i++) {
      const remaining = 33 - getDailySearchCount();
      if (remaining <= 0) break;
      const batchSize = Math.min(5, remaining);
      const candidates = Array.from({ length: batchSize }, (_, j) => ({
        id: `e${i * 5 + j}`, name: `Person ${i * 5 + j}`, company_name: null,
      }));
      mockPool.query.mockResolvedValueOnce({ rows: candidates });
      for (let j = 0; j < batchSize; j++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ organic_results: [] }),
        });
      }
      await enrichLinkedInBatch(mockPool as any, config);
    }

    expect(getDailySearchCount()).toBe(33);

    // Now try one more batch — should return 0 immediately
    vi.clearAllMocks();
    const count = await enrichLinkedInBatch(mockPool as any, config);
    expect(count).toBe(0);
    // Should not have queried for candidates
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rate limit counter resets between different UTC days', async () => {
    resetDailyCounter();

    // Simulate using 5 searches
    mockPool.query.mockResolvedValueOnce({
      rows: Array.from({ length: 5 }, (_, i) => ({
        id: `e${i}`, name: `Person ${i}`, company_name: null,
      })),
    });
    for (let i = 0; i < 5; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ organic_results: [] }),
      });
    }
    await enrichLinkedInBatch(mockPool as any, config);
    expect(getDailySearchCount()).toBe(5);

    // Reset simulates new day
    resetDailyCounter();
    expect(getDailySearchCount()).toBe(0);
  });

  it('batch size capped by remaining daily limit', async () => {
    resetDailyCounter();

    // Use 31 searches (2 remaining)
    for (let i = 0; i < 7; i++) {
      const remaining = 31 - getDailySearchCount();
      if (remaining <= 0) break;
      const batchSize = Math.min(5, remaining);
      const candidates = Array.from({ length: batchSize }, (_, j) => ({
        id: `e${i * 5 + j}`, name: `P${i * 5 + j}`, company_name: null,
      }));
      mockPool.query.mockResolvedValueOnce({ rows: candidates });
      for (let j = 0; j < batchSize; j++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ organic_results: [] }),
        });
      }
      await enrichLinkedInBatch(mockPool as any, config);
    }

    expect(getDailySearchCount()).toBe(31);

    // Next batch: only 2 remaining
    vi.clearAllMocks();
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'ea', name: 'AA', company_name: null },
        { id: 'eb', name: 'BB', company_name: null },
      ],
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ organic_results: [] }),
    });

    await enrichLinkedInBatch(mockPool as any, config);

    // Should have made at most 2 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles SerpAPI JSON error field gracefully', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', company_name: null }],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'Rate limit exceeded' }),
    });

    const count = await enrichLinkedInBatch(mockPool as any, config);
    expect(count).toBe(0);
    expect(createEnrichmentProposal).not.toHaveBeenCalled();
  });

  it('handles individual candidate errors without stopping batch', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Fail Person', company_name: null },
        { id: 'e2', name: 'Success Person', company_name: null },
      ],
    });

    // First candidate: fetch throws
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    // Second candidate: succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        organic_results: [{
          link: 'https://linkedin.com/in/success',
          title: 'Success Person | LinkedIn',
          snippet: 'Professional profile.',
        }],
      }),
    });

    const count = await enrichLinkedInBatch(mockPool as any, config);
    expect(count).toBe(1);
    expect(createEnrichmentProposal).toHaveBeenCalledTimes(1);
  });
});

describe('extractProfileKeywords', () => {
  it('extracts role keywords from profile summary', () => {
    expect(extractProfileKeywords('Alice is a VP of Engineering at Acme.')).toContain('VP of Engineering');
  });

  it('extracts CEO role', () => {
    const result = extractProfileKeywords('Daniel is the CEO of Topia.');
    expect(result.toLowerCase()).toContain('ceo');
  });

  it('returns empty string when no role found', () => {
    expect(extractProfileKeywords('Just a person who does things.')).toBe('');
  });

  it('extracts co-founder role', () => {
    const result = extractProfileKeywords('Chris is co-founder and CTO of the company.');
    expect(result.length).toBeGreaterThan(0);
  });

  it('truncates extracted role to 60 chars', () => {
    const longProfile = 'Alice is a Director of Product and Engineering and Strategic Initiatives and Special Projects at a very large company.';
    const result = extractProfileKeywords(longProfile);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe('loadLinkedInCorrections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty corrections when no matching examples', async () => {
    vi.mocked(getExamplesByCategory).mockResolvedValueOnce([]);

    const result = await loadLinkedInCorrections('Alice Smith', mockPool as any);
    expect(result).toEqual({ badCompanies: [], excludeUrls: [] });
  });

  it('extracts bad companies from matching corrections', async () => {
    vi.mocked(getExamplesByCategory).mockResolvedValueOnce([
      {
        id: 'c1',
        category: 'linkedin_search',
        input_context: { entity_name: 'alice smith', company_context: ['WrongCorp'] },
        actual_output: { linkedin_url: 'https://linkedin.com/in/wrong-alice' },
        expected_output: {},
        explanation: null,
        entity_id: null,
        proposal_id: null,
        tags: [],
        created_at: new Date(),
      },
    ] as any);

    const result = await loadLinkedInCorrections('Alice Smith', mockPool as any);
    expect(result.badCompanies).toContain('WrongCorp');
    expect(result.excludeUrls).toContain('https://linkedin.com/in/wrong-alice');
  });

  it('returns empty corrections when store query fails', async () => {
    vi.mocked(getExamplesByCategory).mockRejectedValueOnce(new Error('DB error'));

    const result = await loadLinkedInCorrections('Alice', mockPool as any);
    expect(result).toEqual({ badCompanies: [], excludeUrls: [] });
  });
});
