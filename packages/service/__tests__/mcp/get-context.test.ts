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
    // Resolve "Alice"
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }],
    });
    // Resolve "Project X"
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e2', name: 'Project X', entity_type: 'project' }],
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
    mockPool.query.mockResolvedValueOnce({ rows: [] });
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
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }],
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
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }],
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
});
