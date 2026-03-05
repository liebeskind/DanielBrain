import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enrichLinkedInBatch, resetDailyCounter, getDailySearchCount } from '../../src/enrichers/linkedin.js';

// Mock proposal helpers
vi.mock('../../src/proposals/helpers.js', () => ({
  createEnrichmentProposal: vi.fn().mockResolvedValue('proposal-id'),
}));

import { createEnrichmentProposal } from '../../src/proposals/helpers.js';

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
});
