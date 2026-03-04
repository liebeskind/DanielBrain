import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeName,
  findOrCreateEntity,
  inferRelationship,
  resolveEntities,
} from '../../src/processor/entity-resolver.js';
import type { ThoughtMetadata } from '@danielbrain/shared';

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
};

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  Alice Smith  ')).toBe('alice smith');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeName('Alice   Smith')).toBe('alice smith');
  });

  it('strips name prefixes', () => {
    expect(normalizeName('Dr. Alice Smith')).toBe('alice smith');
    expect(normalizeName('Mr. Bob Jones')).toBe('bob jones');
    expect(normalizeName('Mrs. Carol')).toBe('carol');
    expect(normalizeName('Prof. Dan')).toBe('dan');
  });

  it('strips company suffixes', () => {
    expect(normalizeName('Acme Inc.')).toBe('acme');
    expect(normalizeName('WidgetCo LLC')).toBe('widgetco');
    expect(normalizeName('BigCorp Corp')).toBe('bigcorp');
  });

  it('handles already normalized names', () => {
    expect(normalizeName('alice')).toBe('alice');
  });
});

describe('findOrCreateEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing entity on exact canonical match', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-1', name: 'Alice', entity_type: 'person' }],
    });

    const result = await findOrCreateEntity('Alice', 'person', mockPool as any);

    expect(result.match_type).toBe('canonical');
    expect(result.confidence).toBe(1.0);
    expect(result.id).toBe('entity-1');
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('returns existing entity on alias match', async () => {
    // No canonical match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Alias match
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-2', name: 'Alice Smith', entity_type: 'person' }],
    });

    const result = await findOrCreateEntity('Ali', 'person', mockPool as any);

    expect(result.match_type).toBe('alias');
    expect(result.confidence).toBe(0.9);
    expect(result.id).toBe('entity-2');
  });

  it('creates new entity when no match', async () => {
    // No canonical match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // No alias match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // INSERT
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-new', name: 'Bob', entity_type: 'person' }],
    });

    const result = await findOrCreateEntity('Bob', 'person', mockPool as any);

    expect(result.match_type).toBe('new');
    expect(result.confidence).toBe(1.0);
    expect(result.id).toBe('entity-new');

    // Verify ON CONFLICT clause in INSERT
    const insertCall = mockPool.query.mock.calls[2];
    expect(insertCall[0]).toContain('ON CONFLICT');
  });
});

describe('inferRelationship', () => {
  const baseMetadata: ThoughtMetadata = {
    thought_type: 'meeting_note',
    people: ['Alice'],
    topics: ['planning'],
    action_items: [],
    dates_mentioned: [],
    sentiment: 'neutral',
    summary: 'Meeting about planning',
    companies: [],
    products: [],
    projects: [],
  };

  it('returns "from" when entity matches source author', () => {
    const result = inferRelationship(
      'Alice',
      baseMetadata,
      'Some content',
      { user_name: 'Alice' }
    );
    expect(result).toBe('from');
  });

  it('returns "assigned_to" when entity appears in action items', () => {
    const meta = { ...baseMetadata, action_items: ['Alice should draft the proposal'] };
    const result = inferRelationship('Alice', meta, 'Some content');
    expect(result).toBe('assigned_to');
  });

  it('returns "about" when entity is in summary', () => {
    const meta = { ...baseMetadata, summary: 'Discussion about Alice and her project' };
    const result = inferRelationship('Alice', meta, 'Some content');
    expect(result).toBe('about');
  });

  it('returns "mentions" as default', () => {
    const result = inferRelationship('Bob', baseMetadata, 'Bob said hello');
    expect(result).toBe('mentions');
  });

  it('handles source_meta with "from" field', () => {
    const result = inferRelationship(
      'Alice',
      baseMetadata,
      'Some content',
      { from: 'Alice' }
    );
    expect(result).toBe('from');
  });
});

describe('resolveEntities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves people, companies, products, and projects', async () => {
    // Each findOrCreateEntity: canonical match (1 query) + linkEntity (2 queries)
    mockPool.query
      // Person: Alice — canonical match
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }] })
      // Link Alice
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // Company: Acme — canonical match
      .mockResolvedValueOnce({ rows: [{ id: 'e2', name: 'Acme', entity_type: 'company' }] })
      // Link Acme
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const metadata: ThoughtMetadata = {
      thought_type: 'meeting_note',
      people: ['Alice'],
      topics: ['planning'],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Alice discussed Acme plans',
      companies: ['Acme'],
      products: [],
      projects: [],
    };

    await resolveEntities(
      'thought-1',
      metadata,
      'Alice discussed Acme plans',
      mockPool as any,
      mockConfig,
    );

    // 2 entities resolved: person + company, each with 3 queries (find + link + bump)
    expect(mockPool.query).toHaveBeenCalledTimes(6);
  });

  it('handles empty metadata gracefully', async () => {
    const metadata: ThoughtMetadata = {
      thought_type: 'observation',
      people: [],
      topics: [],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Just an observation',
      companies: [],
      products: [],
      projects: [],
    };

    await resolveEntities(
      'thought-2',
      metadata,
      'Just an observation',
      mockPool as any,
      mockConfig,
    );

    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
