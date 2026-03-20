import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetContext } from '../../src/mcp/tools/get-context.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleGetContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves entities and returns shared thoughts', async () => {
    // Batch resolve entities (single query now)
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Alice', entity_type: 'person', canonical_name: 'alice' },
        { id: 'e2', name: 'Project X', entity_type: 'project', canonical_name: 'project x' },
      ],
    });
    // Shared thoughts
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 't1',
        content: 'Meeting about Project X with Alice',
        summary: 'Meeting note',
        thought_type: 'meeting_note',
        source: 'slack',
        created_at: new Date('2026-03-01'),
        action_items: ['Alice to send draft'],
        topics: ['planning', 'roadmap'],
        entity_overlap: '2',
        matched_entities: ['Alice', 'Project X'],
      }],
    });
    // Entity relationships between resolved entities
    mockPool.query.mockResolvedValueOnce({
      rows: [],
    });

    const result = await handleGetContext({
      entities: ['Alice', 'Project X'],
      days_back: 30,
      include_action_items: true,
      max_thoughts: 20,
    }, mockPool as any);

    expect(result.resolved_entities).toHaveLength(2);
    expect(result.shared_thoughts).toHaveLength(1);
    expect(result.shared_thoughts[0].entity_overlap).toBe(2);
    expect(result.action_items).toContain('Alice to send draft');
    expect(result.key_topics).toContain('planning');
  });

  it('returns empty result when no entities match', async () => {
    // Batch resolve returns nothing
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await handleGetContext({
      entities: ['Nobody', 'Nothing'],
      days_back: 30,
      include_action_items: true,
      max_thoughts: 20,
    }, mockPool as any);

    expect(result.resolved_entities).toEqual([]);
    expect(result.shared_thoughts).toEqual([]);
  });

  it('excludes action items when include_action_items is false', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', canonical_name: 'alice' }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 't1',
        content: 'Test',
        summary: null,
        thought_type: 'task',
        source: 'slack',
        created_at: new Date(),
        action_items: ['Do something'],
        topics: [],
        entity_overlap: '1',
        matched_entities: ['Alice'],
      }],
    });

    const result = await handleGetContext({
      entities: ['Alice'],
      days_back: 30,
      include_action_items: false,
      max_thoughts: 20,
    }, mockPool as any);

    expect(result.action_items).toEqual([]);
  });

  it('ranks key topics by frequency', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', canonical_name: 'alice' }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 't1', content: 'A', summary: null, thought_type: null, source: 'slack', created_at: new Date(), action_items: [], topics: ['AI', 'planning'], entity_overlap: '1', matched_entities: ['Alice'] },
        { id: 't2', content: 'B', summary: null, thought_type: null, source: 'slack', created_at: new Date(), action_items: [], topics: ['AI', 'design'], entity_overlap: '1', matched_entities: ['Alice'] },
      ],
    });

    const result = await handleGetContext({
      entities: ['Alice'],
      days_back: 30,
      include_action_items: false,
      max_thoughts: 20,
    }, mockPool as any);

    expect(result.key_topics[0]).toBe('AI'); // appears twice
  });

  it('passes visibilityTags as additional WHERE clause parameter', async () => {
    const visTags = ['company', 'user:u1'];

    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', canonical_name: 'alice' }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [],
    });

    await handleGetContext({
      entities: ['Alice'],
      days_back: 30,
      include_action_items: false,
      max_thoughts: 20,
    }, mockPool as any, visTags);

    // The thoughts query is the 2nd call (index 1)
    const thoughtsQuery = mockPool.query.mock.calls[1];
    const sql = thoughtsQuery[0];
    const params = thoughtsQuery[1];

    // SQL should contain the visibility clause
    expect(sql).toContain('visibility');
    // visibilityTags should be the last parameter (4th: entityIds, days_back, max_thoughts, visTags)
    expect(params).toHaveLength(4);
    expect(params[3]).toEqual(visTags);
  });

  it('omits visibility clause when visibilityTags is null (owner)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', canonical_name: 'alice' }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [],
    });

    await handleGetContext({
      entities: ['Alice'],
      days_back: 30,
      include_action_items: false,
      max_thoughts: 20,
    }, mockPool as any, null);

    const thoughtsQuery = mockPool.query.mock.calls[1];
    const sql = thoughtsQuery[0];
    const params = thoughtsQuery[1];

    // No visibility clause should be appended
    expect(sql).not.toContain('visibility &&');
    // Only 3 parameters (entityIds, days_back, max_thoughts)
    expect(params).toHaveLength(3);
  });

  it('omits visibility clause when visibilityTags is undefined', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Bob', entity_type: 'person', canonical_name: 'bob' }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [],
    });

    await handleGetContext({
      entities: ['Bob'],
      days_back: 7,
      include_action_items: false,
      max_thoughts: 10,
    }, mockPool as any);

    const thoughtsQuery = mockPool.query.mock.calls[1];
    const params = thoughtsQuery[1];

    // No visibility parameter
    expect(params).toHaveLength(3);
  });

  it('fetches entity relationships when 2+ entities are resolved', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', name: 'Alice', entity_type: 'person', canonical_name: 'alice' },
        { id: 'e2', name: 'Bob', entity_type: 'person', canonical_name: 'bob' },
      ],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [],
    });
    // Entity relationships query
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        source_name: 'Alice',
        target_name: 'Bob',
        relationship: 'co_occurs',
        description: 'Frequent collaborators',
        weight: '5',
      }],
    });

    const result = await handleGetContext({
      entities: ['Alice', 'Bob'],
      days_back: 30,
      include_action_items: false,
      max_thoughts: 20,
    }, mockPool as any);

    expect(result.entity_relationships).toHaveLength(1);
    expect(result.entity_relationships[0]).toEqual({
      source_name: 'Alice',
      target_name: 'Bob',
      relationship: 'co_occurs',
      description: 'Frequent collaborators',
      weight: 5,
    });
  });

  it('skips entity relationships query when only 1 entity is resolved', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', canonical_name: 'alice' }],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [],
    });
    // No relationship query should be made

    const result = await handleGetContext({
      entities: ['Alice'],
      days_back: 30,
      include_action_items: false,
      max_thoughts: 20,
    }, mockPool as any);

    expect(result.entity_relationships).toEqual([]);
    // Only 2 queries: entity resolve + thoughts (no relationships query)
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });
});
