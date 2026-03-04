import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isProfileStale,
  generateProfile,
  refreshStaleProfiles,
} from '../../src/processor/profile-generator.js';
import * as embedder from '../../src/processor/embedder.js';

vi.mock('../../src/processor/embedder.js');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
  extractionModel: 'llama3.1:8b',
};

describe('isProfileStale', () => {
  it('returns true when no profile_summary exists', () => {
    expect(isProfileStale({
      profile_summary: null,
      mention_count: 0,
      updated_at: new Date(),
    })).toBe(true);
  });

  it('returns true when updated_at is older than 7 days', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 8);
    expect(isProfileStale({
      profile_summary: 'A profile',
      mention_count: 0,
      updated_at: oldDate,
    })).toBe(true);
  });

  it('returns true when mention_count exceeds threshold', () => {
    expect(isProfileStale({
      profile_summary: 'A profile',
      mention_count: 10,
      updated_at: new Date(),
    })).toBe(true);
  });

  it('returns false when profile is fresh', () => {
    expect(isProfileStale({
      profile_summary: 'A profile',
      mention_count: 3,
      updated_at: new Date(),
    })).toBe(false);
  });
});

describe('generateProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(embedder.embed).mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('generates profile from linked thoughts', async () => {
    // Entity lookup
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', metadata: {} }],
    });
    // Linked thoughts
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { content: 'Met with Alice about project', summary: 'Meeting with Alice', thought_type: 'meeting_note', relationship: 'about', source: 'slack' },
      ],
    });
    // Ollama response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        message: { content: 'Alice is a key collaborator involved in project planning.' },
      }),
    });
    // Update entity
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await generateProfile('e1', mockPool as any, mockConfig);

    expect(result).toBe('Alice is a key collaborator involved in project planning.');
    expect(embedder.embed).toHaveBeenCalled();
    // Verify the UPDATE query
    const updateCall = mockPool.query.mock.calls[2];
    expect(updateCall[0]).toContain('UPDATE entities SET profile_summary');
  });

  it('returns minimal profile when no thoughts exist', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', metadata: {} }],
      })
      .mockResolvedValueOnce({ rows: [] }); // no thoughts

    const result = await generateProfile('e1', mockPool as any, mockConfig);

    expect(result).toContain('Alice');
    expect(result).toContain('person');
    // Should not call Ollama
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when entity not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      generateProfile('nonexistent', mockPool as any, mockConfig)
    ).rejects.toThrow('Entity not found');
  });

  it('throws on Ollama error', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', metadata: {} }],
      })
      .mockResolvedValueOnce({
        rows: [{ content: 'Test', summary: null, thought_type: null, relationship: 'mentions', source: 'slack' }],
      });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Model error'),
    });

    await expect(
      generateProfile('e1', mockPool as any, mockConfig)
    ).rejects.toThrow('Ollama profile generation failed');
  });
});

describe('refreshStaleProfiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(embedder.embed).mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('refreshes stale entities', async () => {
    // Find stale entities
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', profile_summary: null, mention_count: 0, updated_at: new Date() }],
    });
    // generateProfile calls: entity lookup, thoughts, Ollama, update
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person', metadata: {} }] })
      .mockResolvedValueOnce({ rows: [] }); // no thoughts = minimal profile, no Ollama call

    const count = await refreshStaleProfiles(mockPool as any, mockConfig);

    expect(count).toBe(1);
  });

  it('continues on failure for individual entities', async () => {
    // Find 2 stale entities
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'e1', profile_summary: null, mention_count: 0, updated_at: new Date() },
        { id: 'e2', profile_summary: null, mention_count: 0, updated_at: new Date() },
      ],
    });
    // First entity fails (not found)
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Second entity succeeds
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e2', name: 'Bob', entity_type: 'person', metadata: {} }] })
      .mockResolvedValueOnce({ rows: [] }); // no thoughts

    const count = await refreshStaleProfiles(mockPool as any, mockConfig);

    expect(count).toBe(1); // only one succeeded
  });
});
