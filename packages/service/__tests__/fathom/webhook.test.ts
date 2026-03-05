import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleFathomEvent } from '../../src/fathom/webhook.js';
import type { FathomMeeting } from '../../src/fathom/transcript.js';

const mockPool = {
  query: vi.fn(),
};

const meeting: FathomMeeting = {
  title: 'Team Sync',
  meeting_title: 'Team Sync - Alice and Bob',
  url: 'https://fathom.video/calls/123',
  share_url: 'https://fathom.video/share/abc',
  created_at: '2026-03-01T10:00:00Z',
  recording_id: 123,
  recording_start_time: '2026-03-01T10:00:00Z',
  recording_end_time: '2026-03-01T10:30:00Z',
  scheduled_start_time: '2026-03-01T10:00:00Z',
  scheduled_end_time: '2026-03-01T11:00:00Z',
  calendar_invitees_domains_type: 'only_internal',
  transcript_language: 'en',
  transcript: [
    { speaker: { display_name: 'Alice', matched_calendar_invitee_email: null }, text: 'Hello', timestamp: '00:00:02' },
    { speaker: { display_name: 'Bob', matched_calendar_invitee_email: null }, text: 'Hi', timestamp: '00:00:05' },
  ],
  default_summary: { template_name: 'default', markdown_formatted: 'Quick sync call.' },
  action_items: [],
  calendar_invitees: [
    { name: 'Alice', email: 'alice@co.com', email_domain: 'co.com', is_external: false, matched_speaker_display_name: 'Alice' },
    { name: 'Bob', email: 'bob@co.com', email_domain: 'co.com', is_external: false, matched_speaker_display_name: 'Bob' },
  ],
  recorded_by: { name: 'Alice', email: 'alice@co.com', email_domain: 'co.com', team: 'Engineering' },
  crm_matches: null,
};

describe('handleFathomEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts meeting into queue with formatted content', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await handleFathomEvent(meeting, mockPool as any);

    expect(result.ok).toBe(true);
    expect(result.queued).toBe(true);

    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO queue');
    expect(insertCall[0]).toContain('ON CONFLICT');
    // content
    expect(insertCall[1][0]).toContain('Meeting: Team Sync - Alice and Bob');
    expect(insertCall[1][0]).toContain('Alice: Hello');
    // source
    expect(insertCall[1][1]).toBe('fathom');
    // source_id
    expect(insertCall[1][2]).toBe('fathom-123');
    // source_meta
    const meta = JSON.parse(insertCall[1][3]);
    expect(meta.recording_id).toBe(123);
    expect(meta.participants).toEqual(['Alice', 'Bob']);
  });

  it('deduplicates already-queued recordings', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 });

    const result = await handleFathomEvent(meeting, mockPool as any);

    expect(result.ok).toBe(true);
    expect(result.queued).toBe(false);
  });

  it('includes summary and action item metadata', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const meetingWithActions: FathomMeeting = {
      ...meeting,
      action_items: [
        { description: 'Send report', user_generated: false, completed: false, recording_timestamp: '00:10:00', recording_playback_url: 'https://fathom.video/calls/123#10m', assignee: { name: 'Bob', email: null, team: null } },
      ],
    };

    await handleFathomEvent(meetingWithActions, mockPool as any);

    const meta = JSON.parse(mockPool.query.mock.calls[0][1][3]);
    expect(meta.has_summary).toBe(true);
    expect(meta.action_item_count).toBe(1);
  });
});
