import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdateEntity } from '../../src/mcp/tools/update-entity.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleUpdateEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves entity by ID and creates proposal', async () => {
    // Find entity by ID
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Chris', canonical_name: 'chris', entity_type: 'person', aliases: [], metadata: {} }],
    });
    // No name collision
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Insert proposal
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });

    const result = await handleUpdateEntity(
      { entity_id: 'e1', new_name: 'Chris Psiaki' },
      mockPool as any,
    );

    expect(result).toEqual({
      proposal_id: 'p1',
      entity_id: 'e1',
      entity_name: 'Chris',
      changes: { new_name: 'Chris Psiaki' },
      status: 'pending',
    });
  });

  it('resolves entity by name', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Topia', canonical_name: 'topia', entity_type: 'company', aliases: ['topia.io'], metadata: {} }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });

    const result = await handleUpdateEntity(
      { name: 'Topia', add_aliases: ['topia inc'] },
      mockPool as any,
    );

    expect(result).toEqual({
      proposal_id: 'p1',
      entity_id: 'e1',
      entity_name: 'Topia',
      changes: { add_aliases: ['topia inc'] },
      status: 'pending',
    });
  });

  it('resolves entity by alias when canonical name not found', async () => {
    // Canonical name not found
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Alias match
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Topia', canonical_name: 'topia', entity_type: 'company', aliases: ['topia.io'], metadata: {} }],
    });
    // Insert proposal
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });

    const result = await handleUpdateEntity(
      { name: 'topia.io', metadata: { website: 'https://topia.io' } },
      mockPool as any,
    );

    expect(result).toEqual({
      proposal_id: 'p1',
      entity_id: 'e1',
      entity_name: 'Topia',
      changes: { metadata: { website: 'https://topia.io' } },
      status: 'pending',
    });
  });

  it('returns error when entity not found by ID', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await handleUpdateEntity(
      { entity_id: 'e-missing' },
      mockPool as any,
    );

    expect(result).toEqual({ error: 'Entity not found: e-missing' });
  });

  it('returns error when entity not found by name', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // canonical
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // alias

    const result = await handleUpdateEntity(
      { name: 'Nonexistent' },
      mockPool as any,
    );

    expect(result).toEqual({ error: 'Entity not found: Nonexistent' });
  });

  it('returns error when no identifier provided', async () => {
    const result = await handleUpdateEntity({}, mockPool as any);
    expect(result).toEqual({ error: 'Either entity_id or name must be provided' });
  });

  it('returns error when no changes specified', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Chris', canonical_name: 'chris', entity_type: 'person', aliases: [], metadata: {} }],
    });

    const result = await handleUpdateEntity(
      { entity_id: 'e1' },
      mockPool as any,
    );

    expect(result).toEqual({ error: 'No changes specified' });
  });

  it('detects name collision', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Chris', canonical_name: 'chris', entity_type: 'person', aliases: [], metadata: {} }],
    });
    // Name collision found
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'e2' }] });

    const result = await handleUpdateEntity(
      { entity_id: 'e1', new_name: 'Daniel' },
      mockPool as any,
    );

    expect(result).toEqual({ error: 'Name collision: an entity with name "Daniel" already exists' });
  });

  it('creates proposal with multiple changes', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Chris', canonical_name: 'chris', entity_type: 'person', aliases: ['cp'], metadata: { role: 'cto' } }],
    });
    // No name collision
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Insert proposal
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }] });

    const result = await handleUpdateEntity(
      {
        entity_id: 'e1',
        new_name: 'Chris Psiaki',
        add_aliases: ['christopher'],
        metadata: { linkedin: 'https://linkedin.com/in/chris' },
      },
      mockPool as any,
    );

    expect(result).toMatchObject({
      proposal_id: 'p1',
      changes: {
        new_name: 'Chris Psiaki',
        add_aliases: ['christopher'],
        metadata: { linkedin: 'https://linkedin.com/in/chris' },
      },
    });

    // Verify proposal stores current state
    const insertCall = mockPool.query.mock.calls[2];
    const currentData = JSON.parse(insertCall[1][4]); // $5 = current_data
    expect(currentData).toMatchObject({
      name: 'Chris',
      aliases: ['cp'],
      metadata: { role: 'cto' },
    });
  });
});
