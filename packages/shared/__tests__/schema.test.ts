import { describe, it, expect } from 'vitest';
import {
  metadataSchema,
  semanticSearchInputSchema,
  listRecentInputSchema,
  statsInputSchema,
  saveThoughtInputSchema,
  getEntityInputSchema,
  listEntitiesInputSchema,
  getContextInputSchema,
  getTimelineInputSchema,
} from '../src/schema.js';

describe('metadataSchema', () => {
  it('validates complete metadata', () => {
    const result = metadataSchema.safeParse({
      thought_type: 'idea',
      people: ['Alice'],
      topics: ['AI'],
      action_items: ['Research'],
      dates_mentioned: ['2026-04-01'],
      sentiment: 'positive',
      summary: 'AI research ideas',
    });

    expect(result.success).toBe(true);
  });

  it('provides defaults for missing optional fields', () => {
    const result = metadataSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.people).toEqual([]);
      expect(result.data.topics).toEqual([]);
      expect(result.data.action_items).toEqual([]);
      expect(result.data.dates_mentioned).toEqual([]);
      expect(result.data.thought_type).toBeNull();
      expect(result.data.sentiment).toBeNull();
      expect(result.data.summary).toBeNull();
      expect(result.data.companies).toEqual([]);
      expect(result.data.products).toEqual([]);
      expect(result.data.projects).toEqual([]);
    }
  });

  it('rejects invalid sentiment values', () => {
    const result = metadataSchema.safeParse({
      sentiment: 'invalid_sentiment',
    });

    expect(result.success).toBe(false);
  });

  it('accepts companies, products, and projects', () => {
    const result = metadataSchema.safeParse({
      companies: ['Acme Corp'],
      products: ['Widget Pro'],
      projects: ['Project X'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.companies).toEqual(['Acme Corp']);
      expect(result.data.products).toEqual(['Widget Pro']);
      expect(result.data.projects).toEqual(['Project X']);
    }
  });

  it('backward compat: old metadata without new fields still parses', () => {
    const oldMetadata = {
      thought_type: 'idea',
      people: ['Alice'],
      topics: ['AI'],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'positive',
      summary: 'An idea',
    };

    const result = metadataSchema.safeParse(oldMetadata);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.companies).toEqual([]);
      expect(result.data.products).toEqual([]);
      expect(result.data.projects).toEqual([]);
    }
  });
});

describe('semanticSearchInputSchema', () => {
  it('requires query field', () => {
    const result = semanticSearchInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('validates valid search input', () => {
    const result = semanticSearchInputSchema.safeParse({
      query: 'meeting notes about AI',
      limit: 5,
      threshold: 0.6,
    });

    expect(result.success).toBe(true);
  });

  it('provides defaults for optional fields', () => {
    const result = semanticSearchInputSchema.safeParse({ query: 'test' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.threshold).toBe(0.5);
    }
  });

  it('accepts filter fields', () => {
    const result = semanticSearchInputSchema.safeParse({
      query: 'test',
      thought_type: 'meeting_note',
      person: 'Alice',
      topic: 'AI',
      days_back: 30,
    });

    expect(result.success).toBe(true);
  });
});

describe('listRecentInputSchema', () => {
  it('provides defaults', () => {
    const result = listRecentInputSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.days).toBe(7);
      expect(result.data.limit).toBe(20);
    }
  });

  it('accepts thought_type filter', () => {
    const result = listRecentInputSchema.safeParse({
      days: 14,
      limit: 50,
      thought_type: 'idea',
    });

    expect(result.success).toBe(true);
  });
});

describe('statsInputSchema', () => {
  it('defaults to month period', () => {
    const result = statsInputSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.period).toBe('month');
    }
  });

  it('accepts valid periods', () => {
    const periods = ['week', 'month', 'quarter', 'year', 'all'];
    for (const period of periods) {
      const result = statsInputSchema.safeParse({ period });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid periods', () => {
    const result = statsInputSchema.safeParse({ period: 'decade' });
    expect(result.success).toBe(false);
  });
});

describe('saveThoughtInputSchema', () => {
  it('requires content', () => {
    const result = saveThoughtInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('validates valid input', () => {
    const result = saveThoughtInputSchema.safeParse({
      content: 'A new thought',
      source: 'mcp',
    });

    expect(result.success).toBe(true);
  });

  it('defaults source to mcp', () => {
    const result = saveThoughtInputSchema.safeParse({ content: 'test' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('mcp');
    }
  });
});

describe('getEntityInputSchema', () => {
  it('accepts entity_id', () => {
    const result = getEntityInputSchema.safeParse({
      entity_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('accepts name', () => {
    const result = getEntityInputSchema.safeParse({ name: 'Alice' });
    expect(result.success).toBe(true);
  });

  it('accepts name with entity_type', () => {
    const result = getEntityInputSchema.safeParse({
      name: 'Alice',
      entity_type: 'person',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when neither entity_id nor name provided', () => {
    const result = getEntityInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects invalid entity_type', () => {
    const result = getEntityInputSchema.safeParse({
      name: 'Alice',
      entity_type: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});

describe('listEntitiesInputSchema', () => {
  it('provides defaults', () => {
    const result = listEntitiesInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sort_by).toBe('mention_count');
      expect(result.data.limit).toBe(20);
    }
  });

  it('accepts entity_type filter', () => {
    const result = listEntitiesInputSchema.safeParse({ entity_type: 'person' });
    expect(result.success).toBe(true);
  });

  it('accepts query prefix filter', () => {
    const result = listEntitiesInputSchema.safeParse({ query: 'Ali' });
    expect(result.success).toBe(true);
  });

  it('accepts all sort options', () => {
    for (const sort_by of ['mention_count', 'last_seen_at', 'name']) {
      const result = listEntitiesInputSchema.safeParse({ sort_by });
      expect(result.success).toBe(true);
    }
  });
});

describe('getContextInputSchema', () => {
  it('requires at least one entity', () => {
    const result = getContextInputSchema.safeParse({ entities: [] });
    expect(result.success).toBe(false);
  });

  it('accepts valid input', () => {
    const result = getContextInputSchema.safeParse({
      entities: ['Alice', 'Project X'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.days_back).toBe(30);
      expect(result.data.include_action_items).toBe(true);
      expect(result.data.max_thoughts).toBe(20);
    }
  });

  it('rejects more than 5 entities', () => {
    const result = getContextInputSchema.safeParse({
      entities: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(result.success).toBe(false);
  });
});

describe('getTimelineInputSchema', () => {
  it('accepts entity_id', () => {
    const result = getTimelineInputSchema.safeParse({
      entity_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('accepts entity_name', () => {
    const result = getTimelineInputSchema.safeParse({ entity_name: 'Alice' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.days_back).toBe(30);
      expect(result.data.limit).toBe(50);
    }
  });

  it('rejects when neither entity_id nor entity_name provided', () => {
    const result = getTimelineInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts sources filter', () => {
    const result = getTimelineInputSchema.safeParse({
      entity_name: 'Alice',
      sources: ['slack', 'telegram'],
    });
    expect(result.success).toBe(true);
  });
});
