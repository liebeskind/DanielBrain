// --- Fathom API types (from OpenAPI spec) ---

export interface TranscriptItem {
  speaker: {
    display_name: string;
    matched_calendar_invitee_email: string | null;
  };
  text: string;
  timestamp: string; // HH:MM:SS
}

export interface MeetingSummary {
  template_name: string | null;
  markdown_formatted: string | null;
}

export interface ActionItem {
  description: string;
  user_generated: boolean;
  completed: boolean;
  recording_timestamp: string; // HH:MM:SS
  recording_playback_url: string;
  assignee: {
    name: string | null;
    email: string | null;
    team: string | null;
  };
}

export interface Invitee {
  name: string | null;
  email: string | null;
  email_domain: string | null;
  is_external: boolean;
  matched_speaker_display_name: string | null;
}

export interface FathomUser {
  name: string;
  email: string;
  email_domain: string;
  team: string | null;
}

export interface CRMMatches {
  contacts?: Array<{ name: string; email: string; record_url: string }>;
  companies?: Array<{ name: string; record_url: string }>;
  deals?: Array<{ name: string; amount: string; record_url: string }>;
  error?: string | null;
}

export interface FathomMeeting {
  title: string;
  meeting_title: string | null;
  url: string;
  share_url: string;
  created_at: string;
  recording_id: number;
  recording_start_time: string;
  recording_end_time: string;
  scheduled_start_time: string;
  scheduled_end_time: string;
  calendar_invitees_domains_type: string;
  transcript_language: string;
  transcript: TranscriptItem[] | null;
  default_summary: MeetingSummary | null;
  action_items: ActionItem[] | null;
  calendar_invitees: Invitee[];
  recorded_by: FathomUser;
  crm_matches: CRMMatches | null;
}

// --- API client ---

interface FathomConfig {
  fathomApiKey: string;
}

const BASE_URL = 'https://api.fathom.ai/external/v1';

async function fathomFetch(path: string, config: FathomConfig): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: {
      'X-Api-Key': config.fathomApiKey,
      Accept: 'application/json',
    },
  });
}

export interface FathomListResponse {
  items: FathomMeeting[];
  next_cursor: string | null;
  limit: number;
}

export async function listMeetings(
  config: FathomConfig,
  cursor?: string,
  options?: { includeTranscript?: boolean; includeSummary?: boolean; includeActionItems?: boolean; includeCrmMatches?: boolean },
): Promise<FathomListResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  // Default to including all rich data for backfill
  if (options?.includeTranscript !== false) params.set('include_transcript', 'true');
  if (options?.includeSummary !== false) params.set('include_summary', 'true');
  if (options?.includeActionItems !== false) params.set('include_action_items', 'true');
  if (options?.includeCrmMatches !== false) params.set('include_crm_matches', 'true');
  const qs = params.toString();
  const path = `/meetings?${qs}`;
  const res = await fathomFetch(path, config);
  if (!res.ok) {
    throw new Error(`Fathom API error ${res.status}: ${res.statusText}`);
  }
  return (await res.json()) as FathomListResponse;
}

// --- Formatting ---

export function formatMeeting(meeting: FathomMeeting): string {
  let duration: number | null = null;
  if (meeting.recording_start_time && meeting.recording_end_time) {
    const ms = new Date(meeting.recording_end_time).getTime() - new Date(meeting.recording_start_time).getTime();
    duration = Math.round(ms / 60000);
  }

  const title = meeting.meeting_title || meeting.title;
  let header = `Meeting: ${title}`;
  header += `\nDate: ${meeting.created_at}`;
  if (duration && duration > 0) header += `\nDuration: ${duration} minutes`;

  const inviteeNames = meeting.calendar_invitees
    .map((inv) => inv.name)
    .filter(Boolean) as string[];
  if (inviteeNames.length > 0) {
    header += `\nParticipants: ${inviteeNames.join(', ')}`;
  }

  if (meeting.recorded_by) {
    header += `\nRecorded by: ${meeting.recorded_by.name}`;
  }

  let content = header;

  // Summary
  if (meeting.default_summary?.markdown_formatted) {
    content += `\n\nSummary:\n${meeting.default_summary.markdown_formatted}`;
  }

  // Action items
  if (meeting.action_items && meeting.action_items.length > 0) {
    content += '\n\nAction Items:';
    for (const item of meeting.action_items) {
      const status = item.completed ? '[x]' : '[ ]';
      const assignee = item.assignee?.name ? ` (${item.assignee.name})` : '';
      content += `\n- ${status} ${item.description}${assignee}`;
    }
  }

  // CRM matches
  if (meeting.crm_matches) {
    const parts: string[] = [];
    if (meeting.crm_matches.contacts?.length) {
      parts.push('Contacts: ' + meeting.crm_matches.contacts.map((c) => c.name).join(', '));
    }
    if (meeting.crm_matches.companies?.length) {
      parts.push('Companies: ' + meeting.crm_matches.companies.map((c) => c.name).join(', '));
    }
    if (meeting.crm_matches.deals?.length) {
      parts.push('Deals: ' + meeting.crm_matches.deals.map((d) => `${d.name} (${d.amount})`).join(', '));
    }
    if (parts.length > 0) {
      content += `\n\nCRM:\n${parts.join('\n')}`;
    }
  }

  // Transcript
  if (meeting.transcript && meeting.transcript.length > 0) {
    content += '\n\nTranscript:';
    for (const entry of meeting.transcript) {
      content += `\n${entry.speaker.display_name}: ${entry.text}`;
    }
  }

  return content;
}
