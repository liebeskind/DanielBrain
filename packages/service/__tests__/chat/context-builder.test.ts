import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildContext, findMatchingEntities, deduplicateResults, fetchEntityRelationships } from '../../src/chat/context-builder.js';

// Mock semantic search
vi.mock('../../src/mcp/tools/semantic-search.js', () => ({
  handleSemanticSearch: vi.fn(),
}));

import { handleSemanticSearch } from '../../src/mcp/tools/semantic-search.js';
const mockSearch = vi.mocked(handleSemanticSearch);

function mockPool(entityRows: Array<Record<string, unknown>> = [], relationshipRows: Array<Record<string, unknown>> = []) {
  const queryFn = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('entity_relationships')) {
      return { rows: relationshipRows };
    }
    return { rows: entityRows };
  });
  return {
    query: queryFn,
  } as unknown as import('pg').Pool;
}

const config = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
};

function makeResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '1',
    content: 'Some content',
    summary: null,
    source: 'slack',
    similarity: 0.8,
    created_at: '2026-03-01T00:00:00Z',
    thought_type: null,
    people: [],
    topics: [],
    action_items: [],
    sentiment: 'neutral',
    parent_id: null,
    ...overrides,
  };
}

describe('buildContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty context when no results', async () => {
    mockSearch.mockResolvedValue([]);
    const pool = mockPool([]);

    const result = await buildContext('hello', pool, config);

    expect(result.contextText).toBe('');
    expect(result.sources).toHaveLength(0);
    expect(result.entities).toHaveLength(0);
  });

  it('formats search results into context text', async () => {
    mockSearch.mockResolvedValue([
      makeResult({
        id: '1',
        content: 'Meeting about project alpha',
        summary: 'Discussed alpha milestones and set Q2 targets for the engineering team with clear deliverables and timeline expectations that were agreed upon by all stakeholders present at the planning session',
        source: 'fathom',
        similarity: 0.85,
        thought_type: 'meeting',
        people: ['Alice'],
        topics: ['alpha'],
      }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('project alpha', pool, config);

    expect(result.contextText).toContain('RELEVANT THOUGHTS:');
    expect(result.contextText).toContain('fathom');
    expect(result.contextText).toContain('milestones');
    expect(result.contextText).toContain('people: Alice');
    expect(result.contextText).toContain('topics: alpha');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].similarity).toBe(0.85);
  });

  it('prefers summary over content when available', async () => {
    mockSearch.mockResolvedValue([
      makeResult({
        content: 'Very long raw content that should not appear when a long summary exists because the summary is sufficient',
        summary: 'A detailed summary that covers all the key points from the meeting including decisions about product roadmap, engineering priorities, and team allocations for Q2 which were discussed at length by all attendees',
        source: 'slack',
      }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('test', pool, config);

    expect(result.contextText).toContain('A detailed summary');
    expect(result.contextText).not.toContain('Very long raw content');
    // Long summary (>= 200 chars) should NOT have DETAIL
    expect(result.contextText).not.toContain('DETAIL:');
  });

  it('falls back to truncated content when no summary', async () => {
    const longContent = 'x'.repeat(1500);
    mockSearch.mockResolvedValue([
      makeResult({ content: longContent }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('test', pool, config);

    // Should truncate at CHAT_CONTEXT_SNIPPET_LENGTH (1000) + '...'
    expect(result.contextText).toContain('x'.repeat(1000) + '...');
    expect(result.contextText).not.toContain('x'.repeat(1001));
  });

  it('includes action items in context', async () => {
    mockSearch.mockResolvedValue([
      makeResult({
        summary: 'Sprint planning',
        source: 'fathom',
        thought_type: 'meeting',
        action_items: ['Follow up with Alice', 'Update roadmap'],
      }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('tasks', pool, config);

    expect(result.contextText).toContain('ACTION: Follow up with Alice');
    expect(result.contextText).toContain('ACTION: Update roadmap');
  });

  it('includes entity profiles when matched', async () => {
    mockSearch.mockResolvedValue([]);
    const pool = mockPool([
      { id: 'e1', name: 'Alice Smith', entity_type: 'person', profile_summary: 'VP of Engineering' },
    ]);

    const result = await buildContext('tell me about alice', pool, config);

    expect(result.contextText).toContain('KNOWN ENTITIES:');
    expect(result.contextText).toContain('Alice Smith');
    expect(result.contextText).toContain('VP of Engineering');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe('e1');
  });

  it('passes correct search params', async () => {
    mockSearch.mockResolvedValue([]);
    const pool = mockPool([]);

    await buildContext('test query', pool, config);

    expect(mockSearch).toHaveBeenCalledWith(
      { query: 'test query', limit: 15, threshold: 0.2 },
      pool,
      config,
      undefined,
    );
  });

  it('includes thought_type in bracket format', async () => {
    mockSearch.mockResolvedValue([
      makeResult({
        summary: 'Discussion notes',
        source: 'fathom',
        thought_type: 'meeting_note',
      }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('test', pool, config);

    expect(result.contextText).toMatch(/\[\d+\/\d+\/\d+, fathom, meeting_note\]/);
  });

  it('omits thought_type when null', async () => {
    mockSearch.mockResolvedValue([
      makeResult({ summary: 'Some note', source: 'slack', thought_type: null }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('test', pool, config);

    // Should have [date, slack] without trailing comma
    expect(result.contextText).toMatch(/\[\d+\/\d+\/\d+, slack\]/);
    expect(result.contextText).not.toMatch(/\[\d+\/\d+\/\d+, slack, \]/);
  });

  it('appends content excerpt when summary is short', async () => {
    mockSearch.mockResolvedValue([
      makeResult({
        summary: 'Discussed roadmap',
        content: 'Full meeting transcript with detailed discussion about Q2 roadmap priorities including K12 expansion',
      }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('test', pool, config);

    expect(result.contextText).toContain('Discussed roadmap');
    expect(result.contextText).toContain('DETAIL: Full meeting transcript');
  });

  it('does not append excerpt when summary is long', async () => {
    const longSummary = 'A'.repeat(200);
    mockSearch.mockResolvedValue([
      makeResult({
        summary: longSummary,
        content: 'Some different content',
      }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('test', pool, config);

    expect(result.contextText).toContain(longSummary);
    expect(result.contextText).not.toContain('DETAIL:');
  });

  it('does not append excerpt when content equals summary', async () => {
    mockSearch.mockResolvedValue([
      makeResult({
        summary: 'Short note',
        content: 'Short note',
      }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('test', pool, config);

    expect(result.contextText).toContain('Short note');
    expect(result.contextText).not.toContain('DETAIL:');
  });

  it('includes entity relationships in context', async () => {
    mockSearch.mockResolvedValue([]);
    const pool = mockPool(
      [{ id: 'e1', name: 'Topia', entity_type: 'company', profile_summary: 'Virtual world platform' }],
      [
        { entity_id: 'e1', name: 'K12 Zone', entity_type: 'product', weight: 15 },
        { entity_id: 'e1', name: 'Stride', entity_type: 'company', weight: 12 },
      ],
    );

    const result = await buildContext('tell me about topia', pool, config);

    expect(result.contextText).toContain('Connected: K12 Zone (product, 15x), Stride (company, 12x)');
  });

  it('surfaces key decisions and insights in context', async () => {
    mockSearch.mockResolvedValue([
      makeResult({
        summary: 'Sprint planning session',
        source: 'fathom',
        thought_type: 'meeting_note',
        key_decisions: ['Launch beta by March 15', 'Hire two engineers'],
        key_insights: ['Canvas LTI 1.3 requires SSO passthrough'],
      }),
    ]);
    const pool = mockPool([]);

    const result = await buildContext('sprint planning', pool, config);

    expect(result.contextText).toContain('DECISION: Launch beta by March 15');
    expect(result.contextText).toContain('DECISION: Hire two engineers');
    expect(result.contextText).toContain('INSIGHT: Canvas LTI 1.3 requires SSO passthrough');
  });

  it('handles entities with no relationships', async () => {
    mockSearch.mockResolvedValue([]);
    const pool = mockPool(
      [{ id: 'e1', name: 'Alice', entity_type: 'person', profile_summary: 'Engineer' }],
      [],
    );

    const result = await buildContext('alice', pool, config);

    expect(result.contextText).toContain('Alice (person) — Engineer');
    expect(result.contextText).not.toContain('Connected:');
  });
});

describe('deduplicateResults', () => {
  it('keeps highest similarity per parent_id group', () => {
    const results = [
      makeResult({ id: 'c1', parent_id: 'p1', similarity: 0.7 }),
      makeResult({ id: 'c2', parent_id: 'p1', similarity: 0.9 }),
      makeResult({ id: 'c3', parent_id: 'p1', similarity: 0.8 }),
    ];
    const deduped = deduplicateResults(results as any);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe('c2');
    expect(deduped[0].similarity).toBe(0.9);
  });

  it('keeps separate thoughts with different IDs', () => {
    const results = [
      makeResult({ id: 't1', parent_id: null, similarity: 0.8 }),
      makeResult({ id: 't2', parent_id: null, similarity: 0.7 }),
    ];
    const deduped = deduplicateResults(results as any);
    expect(deduped).toHaveLength(2);
  });

  it('groups by parent_id, keeps ungrouped separate', () => {
    const results = [
      makeResult({ id: 'c1', parent_id: 'p1', similarity: 0.6 }),
      makeResult({ id: 't1', parent_id: null, similarity: 0.9 }),
      makeResult({ id: 'c2', parent_id: 'p1', similarity: 0.8 }),
    ];
    const deduped = deduplicateResults(results as any);
    expect(deduped).toHaveLength(2);
    const ids = deduped.map((r) => r.id);
    expect(ids).toContain('c2'); // best from p1 group
    expect(ids).toContain('t1'); // standalone
  });
});

describe('findMatchingEntities', () => {
  it('filters short words', async () => {
    const pool = mockPool([]);
    const result = await findMatchingEntities('I am ok', pool);
    expect(result).toHaveLength(0);
  });

  it('queries with normalized words, filtering stop words', async () => {
    const pool = mockPool([]);
    await findMatchingEntities('Tell me about Alice', pool);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    // "tell" and "about" are stop words, only "alice" should remain
    expect(args[1][0]).toContain('alice');
    expect(args[1][0]).not.toContain('tell');
    expect(args[1][0]).not.toContain('about');
  });

  it('returns id in results', async () => {
    const pool = mockPool([{ id: 'e1', name: 'Alice', entity_type: 'person', profile_summary: null }]);
    const result = await findMatchingEntities('alice test', pool);
    expect(result[0].id).toBe('e1');
  });
});
