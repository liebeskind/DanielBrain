import { describe, it, expect, vi, beforeEach } from 'vitest';
import { synthesizeDeal, synthesizeStaleDeals } from '../../src/processor/deal-synthesizer.js';
import * as thoughtQueries from '../../src/db/thought-queries.js';
import * as ollamaMutex from '../../src/ollama-mutex.js';

vi.mock('../../src/db/thought-queries.js', () => ({
  fetchThoughtsForEntity: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/ollama-mutex.js', () => ({
  isChatActive: vi.fn().mockReturnValue(false),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  extractionModel: 'llama3.3:70b',
};

function mockPool(overrides: Record<string, any> = {}) {
  const queryFn = vi.fn().mockImplementation((sql: string) => {
    // Load deal thought
    if (sql.includes('SELECT id, content, source_meta FROM thoughts WHERE id')) {
      return { rows: overrides.dealRows ?? [{
        id: 'deal-1',
        content: 'HubSpot Deal: Springs Charter Schools\nStage: New\nCreated: 2026-03-05',
        source_meta: {
          directMetadata: { companies: ['Springs Charter Schools'], people: ['Eric Dettman'] },
        },
      }] };
    }
    // Resolve company entity
    if (sql.includes('canonical_name') && sql.includes('company')) {
      return { rows: overrides.entityRows ?? [{ id: 'entity-1' }] };
    }
    // Alias fallback
    if (sql.includes('aliases')) {
      return { rows: [] };
    }
    // Stale deals query
    if (sql.includes('deal_synthesis')) {
      return { rows: overrides.staleRows ?? [] };
    }
    // Store synthesis (UPDATE)
    if (sql.includes('UPDATE thoughts SET source_meta')) {
      return { rowCount: 1 };
    }
    return { rows: [] };
  });
  return { query: queryFn } as unknown as import('pg').Pool;
}

function mockOllamaResponse(synthesis: any) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      message: { content: JSON.stringify(synthesis) },
    }),
  });
}

describe('synthesizeDeal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('synthesizes a deal with related thoughts', async () => {
    const pool = mockPool();

    vi.mocked(thoughtQueries.fetchThoughtsForEntity).mockResolvedValue([
      {
        id: 'fathom-1',
        content: 'Eric discussed Gallery Mode with Ben Meredith from Colearn Academy',
        summary: 'Gallery Mode demo discussion',
        thought_type: 'meeting_note',
        relationship: 'mentions',
        source: 'fathom',
        created_at: new Date('2026-03-04'),
      },
    ]);

    mockOllamaResponse({
      summary: 'Springs Charter Schools is interested in implementing Topia for ~1200 K-2 students.',
      key_facts: {
        student_count: '~1200 K-2',
        timeline: 'Close date September 2026',
        contacts: ['Eric Dettman'],
        interest: 'Gallery Mode, SchoolSpace',
      },
      call_history: [
        { date: '2026-03-04', summary: 'Gallery Mode demo discussion', source: 'fathom' },
      ],
    });

    const result = await synthesizeDeal('deal-1', pool, mockConfig);

    expect(result).not.toBeNull();
    expect(result!.summary).toContain('Springs Charter Schools');
    expect(result!.key_facts.student_count).toBe('~1200 K-2');
    expect(result!.call_history).toHaveLength(1);
    expect(result!.source_count).toBe(1);
    expect(result!.synthesized_at).toBeDefined();

    // Verify synthesis was stored
    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0].includes('UPDATE thoughts SET source_meta'),
    );
    expect(updateCall).toBeDefined();
    const storedMeta = JSON.parse(updateCall![1][0]);
    expect(storedMeta.deal_synthesis.summary).toContain('Springs Charter Schools');
  });

  it('stores minimal synthesis when no related thoughts found', async () => {
    const pool = mockPool({ entityRows: [{ id: 'entity-1' }] });
    vi.mocked(thoughtQueries.fetchThoughtsForEntity).mockResolvedValue([]);

    const result = await synthesizeDeal('deal-1', pool, mockConfig);

    expect(result).not.toBeNull();
    expect(result!.source_count).toBe(0);
    expect(result!.call_history).toEqual([]);
    // Should NOT have called Ollama
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null for nonexistent deal', async () => {
    const pool = mockPool({ dealRows: [] });

    const result = await synthesizeDeal('nonexistent', pool, mockConfig);
    expect(result).toBeNull();
  });

  it('returns null for deal with no companies', async () => {
    const pool = mockPool({
      dealRows: [{
        id: 'deal-1',
        content: 'HubSpot Deal: Unnamed',
        source_meta: { directMetadata: { companies: [], people: [] } },
      }],
    });

    const result = await synthesizeDeal('deal-1', pool, mockConfig);
    expect(result).toBeNull();
  });

  it('filters out deal-type thoughts from related results', async () => {
    const pool = mockPool();

    vi.mocked(thoughtQueries.fetchThoughtsForEntity).mockResolvedValue([
      {
        id: 'deal-dup',
        content: 'HubSpot Deal: Same deal record',
        summary: null,
        thought_type: 'deal',
        relationship: 'mentions',
        source: 'hubspot',
        created_at: new Date(),
      },
      {
        id: 'fathom-1',
        content: 'Call about the deal',
        summary: 'Call summary',
        thought_type: 'meeting_note',
        relationship: 'mentions',
        source: 'fathom',
        created_at: new Date(),
      },
    ]);

    mockOllamaResponse({
      summary: 'Test summary',
      key_facts: {},
      call_history: [],
    });

    await synthesizeDeal('deal-1', pool, mockConfig);

    // Ollama should only see the fathom transcript, not the deal record duplicate
    const ollamaCall = mockFetch.mock.calls[0];
    const body = JSON.parse(ollamaCall[1].body);
    const userContent = body.messages[1].content;
    expect(userContent).toContain('Call summary');
    expect(userContent).not.toContain('Same deal record');
  });
});

describe('synthesizeStaleDeals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes stale deals in batch', async () => {
    const pool = mockPool({
      staleRows: [{ id: 'deal-1' }, { id: 'deal-2' }],
      entityRows: [{ id: 'entity-1' }],
    });

    vi.mocked(thoughtQueries.fetchThoughtsForEntity).mockResolvedValue([]);

    const count = await synthesizeStaleDeals(pool, mockConfig);
    expect(count).toBe(2);
  });

  it('yields to chat when active', async () => {
    vi.mocked(ollamaMutex.isChatActive)
      .mockReturnValueOnce(false)   // first deal: proceed
      .mockReturnValueOnce(true);   // before second: yield

    const pool = mockPool({
      staleRows: [{ id: 'deal-1' }, { id: 'deal-2' }],
      entityRows: [{ id: 'entity-1' }],
    });

    vi.mocked(thoughtQueries.fetchThoughtsForEntity).mockResolvedValue([]);

    const count = await synthesizeStaleDeals(pool, mockConfig);
    expect(count).toBe(1); // Only first processed
  });

  it('returns 0 when no stale deals', async () => {
    const pool = mockPool({ staleRows: [] });
    const count = await synthesizeStaleDeals(pool, mockConfig);
    expect(count).toBe(0);
  });
});
