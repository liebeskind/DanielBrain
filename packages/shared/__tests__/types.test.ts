import { describe, it, expect } from 'vitest';
import type { Thought, QueueItem, AccessKey, ThoughtMetadata } from '../src/types.js';

describe('Thought type', () => {
  it('has required fields', () => {
    const thought: Thought = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Test thought content',
      source: 'manual',
      visibility: ['owner'],
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(thought.id).toBeDefined();
    expect(thought.content).toBe('Test thought content');
    expect(thought.source).toBe('manual');
    expect(thought.visibility).toEqual(['owner']);
  });

  it('has optional metadata fields', () => {
    const thought: Thought = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Meeting with John about Q1 roadmap',
      source: 'slack',
      visibility: ['owner'],
      created_at: new Date(),
      updated_at: new Date(),
      embedding: [0.1, 0.2, 0.3],
      thought_type: 'meeting_note',
      people: ['John'],
      topics: ['Q1 roadmap'],
      action_items: ['Draft roadmap doc'],
      dates_mentioned: [new Date('2026-03-15')],
      sentiment: 'positive',
      summary: 'Discussed Q1 priorities with John',
      parent_id: null,
      chunk_index: null,
      source_id: 'slack-msg-123',
      source_meta: { channel: 'general' },
      processed_at: new Date(),
    };

    expect(thought.thought_type).toBe('meeting_note');
    expect(thought.people).toEqual(['John']);
    expect(thought.topics).toEqual(['Q1 roadmap']);
    expect(thought.action_items).toEqual(['Draft roadmap doc']);
    expect(thought.sentiment).toBe('positive');
  });
});

describe('QueueItem type', () => {
  it('has required fields', () => {
    const item: QueueItem = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Process this thought',
      source: 'slack',
      status: 'pending',
      attempts: 0,
      created_at: new Date(),
    };

    expect(item.status).toBe('pending');
    expect(item.attempts).toBe(0);
  });

  it('supports all status values', () => {
    const statuses: QueueItem['status'][] = ['pending', 'processing', 'completed', 'failed'];
    expect(statuses).toHaveLength(4);
  });
});

describe('AccessKey type', () => {
  it('has required fields', () => {
    const key: AccessKey = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: "Daniel's full access",
      key_hash: 'abc123hash',
      scopes: ['owner'],
      active: true,
      created_at: new Date(),
    };

    expect(key.name).toBe("Daniel's full access");
    expect(key.scopes).toEqual(['owner']);
    expect(key.active).toBe(true);
  });
});

describe('ThoughtMetadata type', () => {
  it('has all extraction fields', () => {
    const meta: ThoughtMetadata = {
      thought_type: 'idea',
      people: ['Alice', 'Bob'],
      topics: ['AI', 'automation'],
      action_items: ['Research AI tools'],
      dates_mentioned: ['2026-04-01'],
      sentiment: 'neutral',
      summary: 'Brainstorming AI automation ideas',
    };

    expect(meta.thought_type).toBe('idea');
    expect(meta.people).toHaveLength(2);
    expect(meta.topics).toHaveLength(2);
  });
});
