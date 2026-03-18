import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdateThought } from '../../src/mcp/tools/update-thought.js';

const mockPool = {
  query: vi.fn(),
};

describe('handleUpdateThought', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates only provided fields', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 't1', summary: 'New summary', thought_type: 'idea', people: ['Alice'], topics: [], action_items: [], sentiment: 'positive', updated_at: new Date() }],
    });

    const result = await handleUpdateThought(
      { thought_id: 't1', summary: 'New summary' },
      mockPool as any,
    );

    expect(result.summary).toBe('New summary');
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('summary = $1');
    // Only summary in SET clause (not people = $N)
    expect(sql).not.toContain('people = $');
  });

  it('returns error when no fields provided', async () => {
    const result = await handleUpdateThought(
      { thought_id: 't1' },
      mockPool as any,
    );

    expect(result.error).toBe('No fields to update');
  });

  it('returns error when thought not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await handleUpdateThought(
      { thought_id: 't1', summary: 'x' },
      mockPool as any,
    );

    expect(result.error).toBe('Thought not found');
  });

  it('updates multiple fields at once', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 't1', summary: 'S', thought_type: 'meeting_note', people: ['Bob'], topics: ['AI'], action_items: [], sentiment: 'neutral', updated_at: new Date() }],
    });

    await handleUpdateThought(
      { thought_id: 't1', summary: 'S', people: ['Bob'], thought_type: 'meeting_note' },
      mockPool as any,
    );

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain('summary');
    expect(sql).toContain('people');
    expect(sql).toContain('thought_type');
  });
});
