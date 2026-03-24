import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetEntity } from '../../src/mcp/tools/get-entity.js';

vi.mock('../../src/db/fact-queries.js', () => ({
  getFactsForEntity: vi.fn().mockResolvedValue([]),
}));

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.3:70b',
};

const sampleEntity = {
  id: 'entity-1',
  name: 'Alice',
  entity_type: 'person',
  aliases: ['alice'],
  canonical_name: 'alice',
  profile_summary: null,
  metadata: {},
  mention_count: 5,
  visibility: ['owner'],
  first_seen_at: new Date('2026-01-01'),
  last_seen_at: new Date('2026-03-01'),
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

describe('handleGetEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches entity by id', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [sampleEntity] }) // entity lookup
      .mockResolvedValueOnce({ rows: [] }) // thoughts
      .mockResolvedValueOnce({ rows: [] }); // connected entities

    const result = await handleGetEntity(
      { entity_id: 'entity-1' },
      mockPool as any,
      mockConfig,
    );

    expect(result.entity.name).toBe('Alice');
    expect(result.recent_thoughts).toEqual([]);
    expect(result.connected_entities).toEqual([]);
  });

  it('fetches entity by name', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [sampleEntity] }) // canonical match
      .mockResolvedValueOnce({ rows: [] }) // thoughts
      .mockResolvedValueOnce({ rows: [] }); // connected

    const result = await handleGetEntity(
      { name: 'Alice' },
      mockPool as any,
      mockConfig,
    );

    expect(result.entity.name).toBe('Alice');
  });

  it('falls back to alias match when canonical not found', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }) // no canonical match
      .mockResolvedValueOnce({ rows: [sampleEntity] }) // alias match
      .mockResolvedValueOnce({ rows: [] }) // thoughts
      .mockResolvedValueOnce({ rows: [] }); // connected

    const result = await handleGetEntity(
      { name: 'ali' },
      mockPool as any,
      mockConfig,
    );

    expect(result.entity.name).toBe('Alice');
  });

  it('throws when entity not found by id', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      handleGetEntity({ entity_id: 'nonexistent' }, mockPool as any, mockConfig)
    ).rejects.toThrow('Entity not found');
  });

  it('throws when entity not found by name', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }) // no canonical
      .mockResolvedValueOnce({ rows: [] }); // no alias

    await expect(
      handleGetEntity({ name: 'Nobody' }, mockPool as any, mockConfig)
    ).rejects.toThrow('Entity not found');
  });

  it('returns linked thoughts and connected entities', async () => {
    const thought = {
      id: 't1',
      content: 'Met with Alice',
      summary: 'Meeting note',
      thought_type: 'meeting_note',
      relationship: 'about',
      source: 'slack',
      created_at: new Date(),
    };
    const connectedEntity = {
      id: 'e2',
      name: 'Bob',
      entity_type: 'person',
      shared_thought_count: '3',
    };

    mockPool.query
      .mockResolvedValueOnce({ rows: [sampleEntity] })
      .mockResolvedValueOnce({ rows: [thought] })
      .mockResolvedValueOnce({ rows: [connectedEntity] });

    const result = await handleGetEntity(
      { entity_id: 'entity-1' },
      mockPool as any,
      mockConfig,
    );

    expect(result.recent_thoughts).toHaveLength(1);
    expect(result.connected_entities).toHaveLength(1);
    expect(result.connected_entities[0].shared_thought_count).toBe(3);
  });

  it('detects when profile refresh is needed', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [sampleEntity] }) // no profile_summary
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await handleGetEntity(
      { entity_id: 'entity-1' },
      mockPool as any,
      mockConfig,
    );

    expect(result.needs_profile_refresh).toBe(true);
  });
});
