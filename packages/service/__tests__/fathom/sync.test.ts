import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncFathomMeetings } from '../../src/fathom/sync.js';

// Mock the transcript module
vi.mock('../../src/fathom/transcript.js', () => ({
  listMeetings: vi.fn(),
  formatMeeting: vi.fn(() => 'formatted meeting content'),
}));

// Mock the webhook module for buildStructuredData
vi.mock('../../src/fathom/webhook.js', () => ({
  buildStructuredData: vi.fn(() => ({ summary: 'test summary' })),
}));

// Mock createContentHash from shared
vi.mock('@danielbrain/shared', () => ({
  createContentHash: vi.fn(() => 'hash123'),
}));

import { listMeetings } from '../../src/fathom/transcript.js';

const mockListMeetings = vi.mocked(listMeetings);

function makeMeeting(id: number) {
  return {
    title: `Meeting ${id}`,
    meeting_title: null,
    url: `https://fathom.ai/m/${id}`,
    share_url: `https://fathom.ai/s/${id}`,
    created_at: '2025-06-01T10:00:00Z',
    recording_id: id,
    recording_start_time: '2025-06-01T10:00:00Z',
    recording_end_time: '2025-06-01T11:00:00Z',
    scheduled_start_time: '2025-06-01T10:00:00Z',
    scheduled_end_time: '2025-06-01T11:00:00Z',
    calendar_invitees_domains_type: 'internal',
    transcript_language: 'en',
    transcript: null,
    default_summary: null,
    action_items: null,
    calendar_invitees: [],
    recorded_by: { name: 'Test User', email: 'test@example.com', email_domain: 'example.com', team: null },
    crm_matches: null,
  };
}

const mockPool = {
  query: vi.fn(),
};

describe('syncFathomMeetings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips already-imported meetings', async () => {
    mockListMeetings.mockResolvedValueOnce({
      items: [makeMeeting(1), makeMeeting(2)],
      next_cursor: null,
      limit: 20,
    });

    // Meeting 1: already exists in thoughts
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // Meeting 2: not in thoughts or queue
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Meeting 2: queue insert
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await syncFathomMeetings(mockPool as any, { fathomApiKey: 'fk_test' });

    expect(result).toEqual({ queued: 1, skipped: 1, errors: 0 });
  });

  it('queues new meetings correctly', async () => {
    mockListMeetings.mockResolvedValueOnce({
      items: [makeMeeting(10)],
      next_cursor: null,
      limit: 20,
    });

    // Not already imported
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Queue insert
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await syncFathomMeetings(mockPool as any, { fathomApiKey: 'fk_test' });

    expect(result).toEqual({ queued: 1, skipped: 0, errors: 0 });

    // Verify the queue insert was called with correct params
    const insertCall = mockPool.query.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO queue');
    expect(insertCall[1][0]).toBe('formatted meeting content');
    expect(insertCall[1][1]).toBe('fathom');
    expect(insertCall[1][2]).toBe('fathom-10');
  });

  it('handles API pagination', async () => {
    mockListMeetings
      .mockResolvedValueOnce({
        items: [makeMeeting(1)],
        next_cursor: 'cursor-2',
        limit: 1,
      })
      .mockResolvedValueOnce({
        items: [makeMeeting(2)],
        next_cursor: null,
        limit: 1,
      });

    // Page 1: meeting 1 not imported, queue it
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
    // Page 2: meeting 2 not imported, queue it
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await syncFathomMeetings(mockPool as any, { fathomApiKey: 'fk_test' });

    expect(result).toEqual({ queued: 2, skipped: 0, errors: 0 });
    expect(mockListMeetings).toHaveBeenCalledTimes(2);
    expect(mockListMeetings).toHaveBeenCalledWith({ fathomApiKey: 'fk_test' }, undefined);
    expect(mockListMeetings).toHaveBeenCalledWith({ fathomApiKey: 'fk_test' }, 'cursor-2');
  });

  it('handles API errors gracefully', async () => {
    mockListMeetings.mockRejectedValueOnce(new Error('API rate limit'));

    const result = await syncFathomMeetings(mockPool as any, { fathomApiKey: 'fk_test' });

    expect(result).toEqual({ queued: 0, skipped: 0, errors: 1 });
  });

  it('handles individual meeting processing errors', async () => {
    mockListMeetings.mockResolvedValueOnce({
      items: [makeMeeting(1), makeMeeting(2)],
      next_cursor: null,
      limit: 20,
    });

    // Meeting 1: DB error on check
    mockPool.query.mockRejectedValueOnce(new Error('connection lost'));
    // Meeting 2: success
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await syncFathomMeetings(mockPool as any, { fathomApiKey: 'fk_test' });

    expect(result).toEqual({ queued: 1, skipped: 0, errors: 1 });
  });
});
