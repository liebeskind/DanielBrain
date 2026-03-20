import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  describeRelationship,
  describeUndescribedRelationships,
  RELATIONSHIP_SYSTEM_PROMPT,
  CONTRADICTION_SYSTEM_PROMPT,
} from '../../src/processor/relationship-describer.js';

vi.mock('../../src/proposals/helpers.js', () => ({
  shouldCreateProposal: vi.fn().mockReturnValue(true),
  createRelationshipProposal: vi.fn().mockResolvedValue('proposal-id'),
  createLinkProposal: vi.fn(),
  createEnrichmentProposal: vi.fn(),
}));

import { createRelationshipProposal } from '../../src/proposals/helpers.js';

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  relationshipModel: 'llama3.3:70b',
};

// Helper to mock fetch
const mockFetchResponse = (content: string) => ({
  ok: true,
  json: () => Promise.resolve({ message: { content } }),
  text: () => Promise.resolve(content),
});

describe('describeRelationship', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns null when edge not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await describeRelationship('edge-1', mockPool as any, mockConfig);
    expect(result).toBeNull();
  });

  it('returns null when no thought context available', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1',
        source_id: 's1',
        target_id: 't1',
        source_name: 'Alice',
        source_type: 'person',
        target_name: 'Topia',
        target_type: 'company',
        description: null,
        weight: 3,
        source_thought_ids: [],
      }],
    });

    const result = await describeRelationship('edge-1', mockPool as any, mockConfig);
    expect(result).toBeNull();
  });

  it('generates description for undescribed edge', async () => {
    // Fetch edge
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1',
        source_id: 's1',
        target_id: 't1',
        source_name: 'Alice',
        source_type: 'person',
        target_name: 'Topia',
        target_type: 'company',
        source_profile: null,
        target_profile: null,
        description: null,
        weight: 3,
        source_thought_ids: ['t1', 't2'],
      }],
    });

    // Fetch thoughts
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { content: 'Alice discussed roadmap', summary: 'Roadmap discussion', source: 'slack', created_at: new Date() },
        { content: 'Alice presented features', summary: 'Feature presentation', source: 'fathom', created_at: new Date() },
      ],
    });

    // Update description
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const description = 'Alice is a key contributor at Topia, involved in roadmap planning and feature development.';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockFetchResponse(description));

    const result = await describeRelationship('edge-1', mockPool as any, mockConfig);

    expect(result).toBe(description);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Verify LLM was called with correct system prompt
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.messages[0].content).toBe(RELATIONSHIP_SYSTEM_PROMPT);
    expect(body.model).toBe('llama3.3:70b');

    // Verify description was saved
    const updateCall = mockPool.query.mock.calls[2];
    expect(updateCall[0]).toContain('UPDATE entity_relationships SET description');
    expect(updateCall[1][0]).toBe(description);
  });

  it('runs contradiction check when edge already has description', async () => {
    // Fetch edge with existing description
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1',
        source_id: 's1',
        target_id: 't1',
        source_name: 'Alice',
        source_type: 'person',
        target_name: 'Bob',
        target_type: 'person',
        description: 'Alice and Bob work together on Project Atlas.',
        weight: 5,
        source_thought_ids: ['t1'],
        relationship: 'co_occurs',
      }],
    });

    // Fetch thoughts
    mockPool.query.mockResolvedValueOnce({
      rows: [{ content: 'Same project work', summary: 'Project Atlas update', source: 'slack', created_at: new Date() }],
    });

    // No change detected
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse('{"changed": false, "confidence": 0.95}')
    );

    const result = await describeRelationship('edge-1', mockPool as any, mockConfig);
    expect(result).toBe('Alice and Bob work together on Project Atlas.');

    // Verify contradiction prompt was used
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.messages[0].content).toBe(CONTRADICTION_SYSTEM_PROMPT);
  });

  it('creates new edge when high-confidence change detected', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1',
        source_id: 's1',
        target_id: 't1',
        source_name: 'Alice',
        source_type: 'person',
        target_name: 'Acme',
        target_type: 'company',
        description: 'Alice is a junior engineer at Acme.',
        weight: 5,
        source_thought_ids: ['t1'],
        relationship: 'co_occurs',
      }],
    });

    mockPool.query.mockResolvedValueOnce({
      rows: [{ content: 'Alice promoted to senior', summary: 'Alice promotion', source: 'slack', created_at: new Date() }],
    });

    // Invalidate old edge
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Create new edge
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse('{"changed": true, "new_description": "Alice is a senior engineer at Acme.", "confidence": 0.9}')
    );

    const result = await describeRelationship('edge-1', mockPool as any, mockConfig);
    expect(result).toBe('Alice is a senior engineer at Acme.');

    // Verify old edge invalidated
    const invalidateCall = mockPool.query.mock.calls[2];
    expect(invalidateCall[0]).toContain('invalid_at');

    // Verify new edge created with valid_at
    const createCall = mockPool.query.mock.calls[3];
    expect(createCall[0]).toContain('valid_at');
  });

  it('creates proposal when low-confidence change detected', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1',
        source_id: 's1',
        target_id: 't1',
        source_name: 'Alice',
        source_type: 'person',
        target_name: 'Bob',
        target_type: 'person',
        description: 'Alice and Bob are co-founders.',
        weight: 3,
        source_thought_ids: ['t1'],
        relationship: 'co_occurs',
      }],
    });

    mockPool.query.mockResolvedValueOnce({
      rows: [{ content: 'Some context', summary: 'Meeting notes', source: 'fathom', created_at: new Date() }],
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse('{"changed": true, "new_description": "Alice left the company.", "confidence": 0.6}')
    );

    const result = await describeRelationship('edge-1', mockPool as any, mockConfig);
    expect(result).toBe('Alice and Bob are co-founders.'); // Keeps current description

    expect(createRelationshipProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        edgeId: 'edge-1',
        currentDescription: 'Alice and Bob are co-founders.',
        proposedDescription: 'Alice left the company.',
        confidence: 0.6,
      }),
      expect.anything(),
    );
  });
});

describe('describeUndescribedRelationships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('queries for undescribed edges with weight >= 2', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await describeUndescribedRelationships(mockPool as any, mockConfig);

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('description IS NULL');
    expect(sql).toContain('weight >= 2');
    expect(sql).toContain('invalid_at IS NULL');
  });

  it('returns count of described edges', async () => {
    // Query returns 2 edges
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'edge-1' }, { id: 'edge-2' }],
    });

    // Edge 1: found + thoughts + description + save
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1', source_id: 's1', target_id: 't1',
        source_name: 'A', source_type: 'person', target_name: 'B', target_type: 'person',
        description: null, weight: 3, source_thought_ids: ['t1'],
      }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ content: 'context', summary: 'sum', source: 'slack', created_at: new Date() }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // save description
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockFetchResponse('Description for edge 1.'));

    // Edge 2: not found
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const count = await describeUndescribedRelationships(mockPool as any, mockConfig);
    expect(count).toBe(1); // Only edge-1 succeeded
  });

  it('batch query filters by weight >= 2', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await describeUndescribedRelationships(mockPool as any, mockConfig);

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('weight >= 2');
  });

  it('batch query limits by RELATIONSHIP_DESCRIPTION_BATCH_SIZE', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await describeUndescribedRelationships(mockPool as any, mockConfig);

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('LIMIT $1');
    // RELATIONSHIP_DESCRIPTION_BATCH_SIZE = 5
    expect(params[0]).toBe(5);
  });

  it('batch continues processing when individual edge throws', async () => {
    // 2 edges
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'edge-1' }, { id: 'edge-2' }],
    });

    // Edge 1: fetch throws
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1', source_id: 's1', target_id: 't1',
        source_name: 'A', source_type: 'person', target_name: 'B', target_type: 'person',
        description: null, weight: 3, source_thought_ids: ['t1'],
      }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ content: 'ctx', summary: 'sum', source: 'slack', created_at: new Date() }],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('LLM timeout'));

    // Edge 2: succeeds
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-2', source_id: 's2', target_id: 't2',
        source_name: 'C', source_type: 'person', target_name: 'D', target_type: 'person',
        description: null, weight: 4, source_thought_ids: ['t2'],
      }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ content: 'ctx2', summary: 'sum2', source: 'fathom', created_at: new Date() }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // save
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockFetchResponse('C and D collaborate.'));

    const count = await describeUndescribedRelationships(mockPool as any, mockConfig);
    expect(count).toBe(1); // Edge 2 succeeded, edge 1 failed gracefully
  });

  it('batch orders by weight DESC', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await describeUndescribedRelationships(mockPool as any, mockConfig);

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('ORDER BY weight DESC');
  });
});

describe('describeRelationship additional cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('handles LLM timeout (fetch rejects with abort error)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1', source_id: 's1', target_id: 't1',
        source_name: 'Alice', source_type: 'person', target_name: 'Bob', target_type: 'person',
        description: null, weight: 3, source_thought_ids: ['t1'],
        source_profile: null, target_profile: null,
      }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ content: 'context', summary: 'sum', source: 'slack', created_at: new Date() }],
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DOMException('The operation was aborted', 'AbortError')
    );

    await expect(describeRelationship('edge-1', mockPool as any, mockConfig))
      .rejects.toThrow('aborted');
  });

  it('handles LLM returning non-ok response', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1', source_id: 's1', target_id: 't1',
        source_name: 'Alice', source_type: 'person', target_name: 'Bob', target_type: 'person',
        description: null, weight: 3, source_thought_ids: ['t1'],
        source_profile: null, target_profile: null,
      }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ content: 'context', summary: 'sum', source: 'slack', created_at: new Date() }],
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve('Service Unavailable'),
    });

    await expect(describeRelationship('edge-1', mockPool as any, mockConfig))
      .rejects.toThrow('Ollama relationship description failed (503)');
  });

  it('returns null when edge has no source_thought_ids', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1', source_id: 's1', target_id: 't1',
        source_name: 'Alice', source_type: 'person', target_name: 'Bob', target_type: 'person',
        description: null, weight: 3, source_thought_ids: null,
        source_profile: null, target_profile: null,
      }],
    });

    const result = await describeRelationship('edge-1', mockPool as any, mockConfig);
    expect(result).toBeNull();
  });

  it('contradiction check returns null on unparseable LLM response', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1', source_id: 's1', target_id: 't1',
        source_name: 'Alice', source_type: 'person', target_name: 'Bob', target_type: 'person',
        description: 'They work together.',
        weight: 5, source_thought_ids: ['t1'],
        relationship: 'co_occurs',
      }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ content: 'ctx', summary: 'sum', source: 'slack', created_at: new Date() }],
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse('I cannot determine the relationship. Maybe they work together?')
    );

    const result = await describeRelationship('edge-1', mockPool as any, mockConfig);
    // Unparseable contradiction response returns null
    expect(result).toBeNull();
  });

  it('uses summary over content for thought context when available', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'edge-1', source_id: 's1', target_id: 't1',
        source_name: 'Alice', source_type: 'person', target_name: 'Acme', target_type: 'company',
        description: null, weight: 3, source_thought_ids: ['t1'],
        source_profile: null, target_profile: null,
      }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        content: 'Very long raw content that is not as useful',
        summary: 'Alice joined Acme as VP',
        source: 'fathom',
        created_at: new Date(),
      }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // save

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockFetchResponse('Alice is VP at Acme.'));

    await describeRelationship('edge-1', mockPool as any, mockConfig);

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    const userMsg = body.messages[1].content;
    expect(userMsg).toContain('Alice joined Acme as VP');
  });
});
