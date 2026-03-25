import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractFactsFromContent, storeFacts, extractAndStoreFacts } from '../../src/processor/fact-extractor.js';

vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/processor/embedder.js', () => ({
  embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  extractionModel: 'llama3.3:70b',
  embeddingModel: 'nomic-embed-text',
};

const mockPool = {
  query: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractFactsFromContent', () => {
  function mockOllamaResponse(facts: any[]) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { content: JSON.stringify(facts) },
      }),
    });
  }

  it('extracts facts from content via LLM', async () => {
    mockOllamaResponse([
      { statement: 'Stride wants to add 3 schools.', fact_type: 'event', confidence: 0.9, subject: 'Stride', object: 'K12 Zone', valid_at: null },
      { statement: 'K12 Zone beta launches March 15.', fact_type: 'decision', confidence: 1.0, subject: 'K12 Zone', object: null, valid_at: '2026-03-15' },
    ]);

    const facts = await extractFactsFromContent(
      'Meeting about K12 Zone launch with Stride.',
      [{ name: 'Stride', entity_type: 'company' }, { name: 'K12 Zone', entity_type: 'product' }],
      mockConfig,
    );

    expect(facts).toHaveLength(2);
    expect(facts[0].statement).toBe('Stride wants to add 3 schools.');
    expect(facts[0].fact_type).toBe('event');
    expect(facts[0].subject).toBe('Stride');
    expect(facts[1].fact_type).toBe('decision');
    expect(facts[1].valid_at).toBe('2026-03-15');
  });

  it('validates fact_type against allowed values', async () => {
    mockOllamaResponse([
      { statement: 'A fact.', fact_type: 'invalid_type', confidence: 0.8, subject: null, object: null, valid_at: null },
    ]);

    const facts = await extractFactsFromContent('text', [], mockConfig);
    expect(facts[0].fact_type).toBe('claim'); // fallback
  });

  it('clamps confidence to 0-1 range', async () => {
    mockOllamaResponse([
      { statement: 'A fact.', fact_type: 'claim', confidence: 5.0, subject: null, object: null, valid_at: null },
    ]);

    const facts = await extractFactsFromContent('text', [], mockConfig);
    expect(facts[0].confidence).toBe(1.0);
  });

  it('caps at 15 facts max', async () => {
    const manyFacts = Array.from({ length: 20 }, (_, i) => ({
      statement: `Fact ${i}`, fact_type: 'claim', confidence: 0.8, subject: null, object: null, valid_at: null,
    }));
    mockOllamaResponse(manyFacts);

    const facts = await extractFactsFromContent('text', [], mockConfig);
    expect(facts).toHaveLength(15);
  });

  it('returns empty array for non-array LLM response', async () => {
    mockOllamaResponse({ not: 'an array' } as any);
    const facts = await extractFactsFromContent('text', [], mockConfig);
    expect(facts).toEqual([]);
  });

  it('filters out facts without statements', async () => {
    mockOllamaResponse([
      { statement: 'Valid fact.', fact_type: 'claim', confidence: 0.8, subject: null, object: null, valid_at: null },
      { statement: null, fact_type: 'claim', confidence: 0.8, subject: null, object: null, valid_at: null },
      { fact_type: 'claim', confidence: 0.8, subject: null, object: null, valid_at: null },
    ]);

    const facts = await extractFactsFromContent('text', [], mockConfig);
    expect(facts).toHaveLength(1);
  });

  it('passes entities to LLM prompt', async () => {
    mockOllamaResponse([]);

    await extractFactsFromContent('text', [{ name: 'Alice', entity_type: 'person' }], mockConfig);

    const fetchCall = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    const userMsg = body.messages[1].content;
    expect(userMsg).toContain('Alice (person)');
  });

  it('truncates long content', async () => {
    mockOllamaResponse([]);
    const longContent = 'x'.repeat(5000);

    await extractFactsFromContent(longContent, [], mockConfig);

    const fetchCall = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    const userMsg = body.messages[1].content;
    expect(userMsg).toContain('...');
    expect(userMsg.length).toBeLessThan(5000);
  });

  it('throws on non-OK response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(extractFactsFromContent('text', [], mockConfig)).rejects.toThrow('500');
  });
});

describe('storeFacts', () => {
  it('stores facts with embeddings and resolved entities', async () => {
    // resolveEntityId for subject
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'entity-1' }] });
    // resolveEntityId for object
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'entity-2' }] });
    // findContradictions
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // INSERT fact
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'fact-1' }] });

    const result = await storeFacts(
      'thought-1',
      [{ statement: 'A works at B.', fact_type: 'claim', confidence: 0.9, subject: 'A', object: 'B', valid_at: null }],
      ['company'],
      mockPool as any,
      mockConfig,
    );

    expect(result.stored).toBe(1);
    expect(result.contradictions).toBe(0);

    // Verify INSERT
    const insertCall = mockPool.query.mock.calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('INSERT INTO facts'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1][1]).toBe('A works at B.');
    expect(insertCall![1][5]).toBe('entity-1'); // subject
    expect(insertCall![1][6]).toBe('entity-2'); // object
  });

  it('skips near-duplicate facts (similarity > 0.90)', async () => {
    // resolveEntityId for subject
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'entity-1' }] });
    // object is null → resolveEntityId returns null without querying
    // findContradictions - returns high similarity fact (near-duplicate)
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'existing-fact', statement: 'Similar claim about A.', similarity: '0.92' }],
    });

    const result = await storeFacts(
      'thought-1',
      [{ statement: 'Nearly identical claim about A.', fact_type: 'claim', confidence: 0.9, subject: 'A', object: null, valid_at: null }],
      ['company'],
      mockPool as any,
      mockConfig,
    );

    expect(result.stored).toBe(0); // skipped as near-duplicate
  });

  it('skips exact duplicates (similarity > 0.95)', async () => {
    // resolveEntityId for subject
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'entity-1' }] });
    // object is null → resolveEntityId returns null without querying
    // findContradictions - returns very high similarity (exact duplicate)
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'existing-fact', statement: 'Same fact.', similarity: '0.97' }],
    });

    const result = await storeFacts(
      'thought-1',
      [{ statement: 'Same fact.', fact_type: 'claim', confidence: 0.9, subject: 'A', object: null, valid_at: null }],
      ['company'],
      mockPool as any,
      mockConfig,
    );

    expect(result.stored).toBe(0); // skipped as near-duplicate
  });

  it('handles entity resolution failure gracefully', async () => {
    // resolveEntityId for subject 'Unknown' → no match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // object is null → resolveEntityId returns null without querying
    // No contradictions query (subjectId is null → findContradictions returns [] early)
    // INSERT fact
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'fact-1' }] });

    const result = await storeFacts(
      'thought-1',
      [{ statement: 'Some fact.', fact_type: 'claim', confidence: 0.8, subject: 'Unknown', object: null, valid_at: null }],
      ['owner'],
      mockPool as any,
      mockConfig,
    );

    expect(result.stored).toBe(1); // still stored, just without entity links
  });
});

describe('extractAndStoreFacts', () => {
  it('orchestrates extraction → storage', async () => {
    // Mock LLM extraction
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: { content: JSON.stringify([
          { statement: 'Alice works at Topia.', fact_type: 'claim', confidence: 0.9, subject: 'Alice', object: 'Topia', valid_at: null },
        ]) },
      }),
    });

    // resolveEntityId × 2
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e-alice' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e-topia' }] });
    // findContradictions
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // INSERT fact
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'f-1' }] });

    await extractAndStoreFacts(
      'thought-1',
      'Alice joined Topia as CTO.',
      { people: ['Alice'], companies: ['Topia'], products: [], projects: [], topics: [], themes: [], action_items: [], dates_mentioned: [], sentiment: null, summary: null, thought_type: null, department: null, confidentiality: null, meeting_participants: [], key_decisions: [], key_insights: [], action_items_structured: [] },
      ['company'],
      mockPool as any,
      mockConfig,
    );

    // Verify LLM was called
    expect(global.fetch).toHaveBeenCalled();
    // Verify fact was inserted
    const insertCall = mockPool.query.mock.calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('INSERT INTO facts'),
    );
    expect(insertCall).toBeDefined();
  });

  it('handles LLM failure gracefully (no facts stored)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout'));

    await expect(
      extractAndStoreFacts(
        'thought-1', 'text',
        { people: [], companies: [], products: [], projects: [], topics: [], themes: [], action_items: [], dates_mentioned: [], sentiment: null, summary: null, thought_type: null, department: null, confidentiality: null, meeting_participants: [], key_decisions: [], key_insights: [], action_items_structured: [] },
        ['owner'], mockPool as any, mockConfig,
      ),
    ).rejects.toThrow('timeout');
  });
});
