import { describe, it, expect } from 'vitest';
import { formatMeeting } from '../../src/fathom/transcript.js';
import type { FathomMeeting } from '../../src/fathom/transcript.js';

const baseMeeting: FathomMeeting = {
  title: 'Weekly Standup',
  meeting_title: 'Weekly Standup - Alice and Bob',
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
    { speaker: { display_name: 'Alice', matched_calendar_invitee_email: 'alice@co.com' }, text: 'Good morning everyone.', timestamp: '00:00:05' },
    { speaker: { display_name: 'Bob', matched_calendar_invitee_email: 'bob@co.com' }, text: 'Morning! Let me share my update.', timestamp: '00:00:12' },
  ],
  default_summary: { template_name: 'default', markdown_formatted: 'Team discussed weekly progress.' },
  action_items: [
    { description: 'Follow up with client', user_generated: false, completed: false, recording_timestamp: '00:15:00', recording_playback_url: 'https://fathom.video/calls/123#15m', assignee: { name: 'Alice', email: 'alice@co.com', team: null } },
  ],
  calendar_invitees: [
    { name: 'Alice', email: 'alice@co.com', email_domain: 'co.com', is_external: false, matched_speaker_display_name: 'Alice' },
    { name: 'Bob', email: 'bob@co.com', email_domain: 'co.com', is_external: false, matched_speaker_display_name: 'Bob' },
  ],
  recorded_by: { name: 'Alice', email: 'alice@co.com', email_domain: 'co.com', team: 'Engineering' },
  crm_matches: {
    contacts: [{ name: 'Alice Smith', email: 'alice@co.com', record_url: 'https://crm.example.com/contact/1' }],
    companies: [{ name: 'Acme Corp', record_url: 'https://crm.example.com/company/1' }],
    deals: [],
  },
};

describe('formatMeeting', () => {
  it('formats header with title, date, duration, participants, and recorder', () => {
    const result = formatMeeting(baseMeeting);
    expect(result).toContain('Meeting: Weekly Standup - Alice and Bob');
    expect(result).toContain('Date: 2026-03-01T10:00:00Z');
    expect(result).toContain('Duration: 30 minutes');
    expect(result).toContain('Participants: Alice, Bob');
    expect(result).toContain('Recorded by: Alice');
  });

  it('includes summary, action items, CRM matches, and transcript', () => {
    const result = formatMeeting(baseMeeting);
    expect(result).toContain('Summary:\nTeam discussed weekly progress.');
    expect(result).toContain('Action Items:');
    expect(result).toContain('- [ ] Follow up with client (Alice)');
    expect(result).toContain('CRM:');
    expect(result).toContain('Contacts: Alice Smith');
    expect(result).toContain('Companies: Acme Corp');
    expect(result).toContain('Transcript:');
    expect(result).toContain('Alice: Good morning everyone.');
    expect(result).toContain('Bob: Morning! Let me share my update.');
  });

  it('handles meeting with no optional data', () => {
    const minimal: FathomMeeting = {
      ...baseMeeting,
      transcript: null,
      default_summary: null,
      action_items: null,
      crm_matches: null,
    };
    const result = formatMeeting(minimal);
    expect(result).toContain('Meeting: Weekly Standup');
    expect(result).not.toContain('Summary:');
    expect(result).not.toContain('Action Items:');
    expect(result).not.toContain('CRM:');
    expect(result).not.toContain('Transcript:');
  });

  it('falls back to title when meeting_title is null', () => {
    const result = formatMeeting({ ...baseMeeting, meeting_title: null });
    expect(result).toContain('Meeting: Weekly Standup');
  });

  it('marks completed action items', () => {
    const meeting: FathomMeeting = {
      ...baseMeeting,
      action_items: [
        { ...baseMeeting.action_items![0], completed: true },
      ],
    };
    const result = formatMeeting(meeting);
    expect(result).toContain('- [x] Follow up with client (Alice)');
  });
});
