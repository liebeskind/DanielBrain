import { describe, it, expect } from 'vitest';
import {
  metadataSchema,
  semanticSearchInputSchema,
  listRecentInputSchema,
  statsInputSchema,
  saveThoughtInputSchema,
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
    }
  });

  it('rejects invalid sentiment values', () => {
    const result = metadataSchema.safeParse({
      sentiment: 'invalid_sentiment',
    });

    expect(result.success).toBe(false);
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
