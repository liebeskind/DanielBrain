import type { ParticipantIdentity, StructuredData } from '@danielbrain/shared';
import type { HubSpotRecord, DirectMetadata, FormattedRecord } from './types.js';

/** Strip HTML tags from a string */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export type NoteClassification = 'fathom_link' | 'otter_stub' | 'rich_note' | 'short_note' | 'email_followup';

/** Extract Fathom call ID from a note body, if present */
export function extractFathomCallId(body: string): string | null {
  const match = body.match(/fathom\.video\/calls\/(\d+)/);
  return match ? match[1] : null;
}

/** Extract Otter.ai note URL from a note body, if present */
export function extractOtterUrl(body: string): string | null {
  const match = body.match(/(https?:\/\/otter\.ai\/note\/[A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

// --- URL extraction and classification ---

export type UrlType = 'google_doc' | 'notion' | 'otter' | 'fathom' | 'loom' | 'video' | 'calendar' | 'pdf' | 'web_page';

export interface UrlInventoryItem {
  url: string;
  type: UrlType;
  fetchable: boolean;
  anchor_text?: string;
  processed?: string; // 'success' | 'auth_required' | 'error' | 'too_large' | 'unsupported_type'
  details?: string;
}

const URL_TYPE_RULES: Array<{ pattern: RegExp; type: UrlType; fetchable: boolean }> = [
  { pattern: /docs\.google\.com\/document/, type: 'google_doc', fetchable: true },
  { pattern: /drive\.google\.com/, type: 'google_doc', fetchable: false },
  { pattern: /notion\.so|notion\.site/, type: 'notion', fetchable: false },
  { pattern: /otter\.ai\/note\//, type: 'otter', fetchable: true },
  { pattern: /fathom\.video/, type: 'fathom', fetchable: false },
  { pattern: /loom\.com\/share\//, type: 'loom', fetchable: false },
  { pattern: /youtube\.com|youtu\.be|vimeo\.com/, type: 'video', fetchable: false },
  { pattern: /meet\.google\.com|zoom\.us|calendly\.com/, type: 'calendar', fetchable: false },
  { pattern: /\.pdf(\?|$|#)/, type: 'pdf', fetchable: true },
];

const IGNORED_DOMAINS = /app\.hubspot\.com|api\.hubspot\.com|track\.hubspot\.com|email\.hubspot\.com|unsubscribe|list-manage\.com|mailchimp\.com/i;

function classifyUrl(url: string): { type: UrlType; fetchable: boolean } {
  for (const rule of URL_TYPE_RULES) {
    if (rule.pattern.test(url)) return { type: rule.type, fetchable: rule.fetchable };
  }
  return { type: 'web_page', fetchable: true };
}

/** Extract and classify all URLs from raw HTML note body */
export function extractUrls(rawHtml: string): UrlInventoryItem[] {
  const seen = new Set<string>();
  const items: UrlInventoryItem[] = [];

  // Extract from <a href="...">anchor text</a> tags
  const hrefPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(rawHtml)) !== null) {
    const url = match[1].trim();
    const anchor = match[2].trim() || undefined;
    if (url && !seen.has(url) && /^https?:\/\//.test(url) && !IGNORED_DOMAINS.test(url)) {
      seen.add(url);
      const { type, fetchable } = classifyUrl(url);
      items.push({ url, type, fetchable, anchor_text: anchor });
    }
  }

  // Extract bare URLs from text (after stripping tags)
  const stripped = rawHtml.replace(/<[^>]*>/g, ' ');
  const barePattern = /https?:\/\/[^\s<>"')\]]+/gi;
  while ((match = barePattern.exec(stripped)) !== null) {
    const url = match[0].replace(/[.,;:!?)]+$/, ''); // strip trailing punctuation
    if (url && !seen.has(url) && !IGNORED_DOMAINS.test(url)) {
      seen.add(url);
      const { type, fetchable } = classifyUrl(url);
      items.push({ url, type, fetchable });
    }
  }

  return items;
}

/** Classify a note body to determine processing strategy */
export function classifyNote(strippedBody: string): NoteClassification {
  const lower = strippedBody.toLowerCase();

  // Fathom link only — just a URL, no real content
  if (/^\s*https?:\/\/fathom\.video\//.test(lower.trim()) && strippedBody.trim().split(/\s+/).length < 10) {
    return 'fathom_link';
  }

  // Otter.ai stub — has URL but empty summary sections
  if (lower.includes('otter.ai/note/') && lower.includes('meeting summary: summary')) {
    return 'otter_stub';
  }

  // Email followup — starts with greeting patterns
  if (/^(hi |hey |hello |dear |thanks |thank you)/i.test(strippedBody.trim())) {
    return 'email_followup';
  }

  // Short vs rich based on length
  return strippedBody.length < 200 ? 'short_note' : 'rich_note';
}

/** Format an ISO date string to YYYY-MM-DD, safely */
function formatDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** Format a HubSpot contact into a thought */
export function formatContact(
  record: HubSpotRecord,
  associatedCompanyNames: string[] = [],
  ownerName?: string,
): FormattedRecord {
  const p = record.properties;
  const firstName = p.firstname?.trim() || '';
  const lastName = p.lastname?.trim() || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || `Contact ${record.id}`;

  const lines: string[] = [`HubSpot Contact: ${fullName}`];
  if (p.email) lines.push(`Email: ${p.email}`);
  if (p.jobtitle) lines.push(`Title: ${p.jobtitle}`);
  if (p.company || associatedCompanyNames.length > 0) {
    const company = associatedCompanyNames[0] || p.company;
    lines.push(`Company: ${company}`);
  }
  if (p.lifecyclestage) lines.push(`Lifecycle: ${p.lifecyclestage}`);
  if (p.hs_lead_status) lines.push(`Lead Status: ${p.hs_lead_status}`);
  if (p.phone) lines.push(`Phone: ${p.phone}`);
  if (ownerName) lines.push(`Owner: ${ownerName}`);
  if (p.hs_analytics_source) lines.push(`Source: ${p.hs_analytics_source}`);
  const created = formatDate(p.createdate);
  if (created) lines.push(`Created: ${created}`);
  if (p.notes_last_contacted) lines.push(`Last Contacted: ${new Date(p.notes_last_contacted).toISOString().slice(0, 10)}`);
  const lastActivity = formatDate(p.hs_last_sales_activity_timestamp);
  if (lastActivity) lines.push(`Last Activity: ${lastActivity}`);
  if (p.num_associated_deals) lines.push(`Deals: ${p.num_associated_deals}`);

  const content = lines.join('\n');

  const participants: ParticipantIdentity[] = [{
    name: fullName,
    email: p.email ?? undefined,
    role: 'participant',
  }];

  const structured: StructuredData = { participants };
  if (associatedCompanyNames.length > 0) {
    structured.companies = associatedCompanyNames.map(name => ({ name }));
  }

  const topics: string[] = [];
  if (p.lifecyclestage) topics.push(p.lifecyclestage);
  if (p.hs_lead_status) topics.push(p.hs_lead_status);

  const companies = associatedCompanyNames.length > 0
    ? associatedCompanyNames
    : p.company ? [p.company] : [];

  return {
    content,
    sourceId: `hubspot-contact-${record.id}`,
    sourceMeta: {
      hubspot_id: record.id,
      object_type: 'contact',
      channel_type: 'crm' as const,
      structured,
      directMetadata: {
        people: [fullName],
        companies,
        topics,
        thought_type: 'contact',
        summary: content,
      },
    },
    directMetadata: {
      people: [fullName],
      companies,
      topics,
      thought_type: 'contact',
      summary: content,
    },
    originatedAt: new Date(record.updatedAt),
  };
}

/** Format a HubSpot company into a thought */
export function formatCompany(record: HubSpotRecord, ownerName?: string): FormattedRecord {
  const p = record.properties;
  const name = p.name?.trim() || `Company ${record.id}`;

  const lines: string[] = [`HubSpot Company: ${name}`];
  if (p.domain) lines.push(`Domain: ${p.domain}`);
  if (p.industry) lines.push(`Industry: ${p.industry}`);
  if (p.numberofemployees) lines.push(`Employees: ${p.numberofemployees}`);
  if (p.annualrevenue) lines.push(`Revenue: $${Number(p.annualrevenue).toLocaleString()}`);
  if (ownerName) lines.push(`Owner: ${ownerName}`);
  const created = formatDate(p.createdate);
  if (created) lines.push(`Created: ${created}`);
  if (p.description) lines.push(`Description: ${p.description.slice(0, 500)}`);
  if (p.num_associated_contacts && Number(p.num_associated_contacts) > 0) lines.push(`Contacts: ${p.num_associated_contacts}`);
  if (p.num_associated_deals && Number(p.num_associated_deals) > 0) lines.push(`Deals: ${p.num_associated_deals}`);

  const content = lines.join('\n');

  const topics: string[] = [];
  if (p.industry) topics.push(p.industry);

  return {
    content,
    sourceId: `hubspot-company-${record.id}`,
    sourceMeta: {
      hubspot_id: record.id,
      object_type: 'company',
      channel_type: 'crm' as const,
      directMetadata: {
        companies: [name],
        topics,
        thought_type: 'company_profile',
        summary: content,
      },
    },
    directMetadata: {
      companies: [name],
      topics,
      thought_type: 'company_profile',
      summary: content,
    },
    originatedAt: new Date(record.updatedAt),
  };
}

/** Format a HubSpot deal into a thought */
export function formatDeal(
  record: HubSpotRecord,
  associatedContactNames: string[] = [],
  associatedCompanyNames: string[] = [],
  ownerName?: string,
): FormattedRecord {
  const p = record.properties;
  const dealName = p.dealname?.trim() || `Deal ${record.id}`;

  const lines: string[] = [`HubSpot Deal: ${dealName}`];
  if (p.pipeline) lines.push(`Pipeline: ${p.pipeline}`);
  if (p.dealstage) lines.push(`Stage: ${p.dealstage}`);
  if (p.amount) lines.push(`Amount: $${Number(p.amount).toLocaleString()}`);
  if (p.closedate) lines.push(`Close Date: ${p.closedate.slice(0, 10)}`);
  if (ownerName) lines.push(`Owner: ${ownerName}`);
  const created = formatDate(p.createdate);
  if (created) lines.push(`Created: ${created}`);
  if (p.description) lines.push(`Description: ${p.description.slice(0, 500)}`);
  if (associatedContactNames.length > 0) {
    lines.push(`Contacts: ${associatedContactNames.join(', ')}`);
  }
  if (associatedCompanyNames.length > 0) {
    lines.push(`Company: ${associatedCompanyNames.join(', ')}`);
  }

  const content = lines.join('\n');

  const topics: string[] = [];
  if (p.pipeline) topics.push(p.pipeline);
  if (p.dealstage) topics.push(p.dealstage);

  return {
    content,
    sourceId: `hubspot-deal-${record.id}`,
    sourceMeta: {
      hubspot_id: record.id,
      object_type: 'deal',
      channel_type: 'crm' as const,
      directMetadata: {
        people: associatedContactNames,
        companies: associatedCompanyNames,
        topics,
        thought_type: 'deal',
        summary: content,
      },
    },
    directMetadata: {
      people: associatedContactNames,
      companies: associatedCompanyNames,
      topics,
      thought_type: 'deal',
      summary: content,
    },
    // Use close date when available — more meaningful for temporal context
    originatedAt: p.closedate ? new Date(p.closedate) : new Date(record.updatedAt),
  };
}

/** Minimum note body length after HTML stripping (skip "left voicemail" etc.) */
export const MIN_NOTE_LENGTH = 20;

/** Format a HubSpot note (hybrid: LLM extracts topics/summary, associations override people/companies) */
export function formatNote(
  record: HubSpotRecord,
  associatedContactNames: string[] = [],
  associatedCompanyNames: string[] = [],
  ownerName?: string,
): FormattedRecord {
  const p = record.properties;
  const rawBody = p.hs_note_body || '';
  const body = stripHtml(rawBody) || '(empty note)';

  const contextParts: string[] = [];
  if (associatedContactNames.length > 0) {
    contextParts.push(associatedContactNames.join(', '));
  }
  if (associatedCompanyNames.length > 0) {
    contextParts.push(`(${associatedCompanyNames.join(', ')})`);
  }
  const contextStr = contextParts.length > 0 ? ` on ${contextParts.join(' ')}` : '';

  const lines: string[] = [`HubSpot Note${contextStr}:`];
  if (ownerName) lines.push(`Author: ${ownerName}`);
  lines.push(body);

  const content = lines.join('\n');

  return {
    content,
    sourceId: `hubspot-note-${record.id}`,
    sourceMeta: {
      hubspot_id: record.id,
      object_type: 'note',
      channel_type: 'crm' as const,
      owner_id: p.hubspot_owner_id ?? null,
      // Pipeline overrides LLM-extracted people/companies with these known associations
      hubspotAssociations: {
        people: associatedContactNames,
        companies: associatedCompanyNames,
      },
    },
    // Empty directMetadata → triggers LLM extraction for topics/summary/action_items
    directMetadata: {},
    originatedAt: p.hs_timestamp ? new Date(p.hs_timestamp) : new Date(record.updatedAt),
  };
}

// --- Engagement type formatters ---

/** Format a HubSpot call into a thought */
export function formatCall(
  record: HubSpotRecord,
  associatedContactNames: string[] = [],
  associatedCompanyNames: string[] = [],
  ownerName?: string,
): FormattedRecord {
  const p = record.properties;
  const title = p.hs_call_title?.trim() || `Call ${record.id}`;
  const durationMs = p.hs_call_duration_milliseconds ? Number(p.hs_call_duration_milliseconds) : 0;
  const duration = durationMs > 0 ? `${Math.round(durationMs / 60000)} min` : '';

  const lines: string[] = [`HubSpot Call: ${title}`];
  if (p.hs_call_status) lines.push(`Status: ${p.hs_call_status}`);
  if (duration) lines.push(`Duration: ${duration}`);
  if (p.hs_call_source) lines.push(`Source: ${p.hs_call_source}`);
  if (ownerName) lines.push(`Owner: ${ownerName}`);
  if (associatedContactNames.length > 0) lines.push(`Contacts: ${associatedContactNames.join(', ')}`);
  if (associatedCompanyNames.length > 0) lines.push(`Company: ${associatedCompanyNames.join(', ')}`);
  if (p.hs_call_body) lines.push(p.hs_call_body.slice(0, 1000));

  const content = lines.join('\n');

  return {
    content,
    sourceId: `hubspot-call-${record.id}`,
    sourceMeta: {
      hubspot_id: record.id,
      object_type: 'call',
      channel_type: 'crm' as const,
      owner_id: p.hubspot_owner_id ?? null,
      hubspotAssociations: { people: associatedContactNames, companies: associatedCompanyNames },
    },
    directMetadata: {},
    originatedAt: p.hs_timestamp ? new Date(p.hs_timestamp) : new Date(record.updatedAt),
  };
}

/** Format a HubSpot email into a thought */
export function formatEmail(
  record: HubSpotRecord,
  associatedContactNames: string[] = [],
  associatedCompanyNames: string[] = [],
  ownerName?: string,
): FormattedRecord {
  const p = record.properties;
  const subject = p.hs_email_subject?.trim() || `Email ${record.id}`;

  const lines: string[] = [`HubSpot Email: ${subject}`];
  if (p.hs_email_from) lines.push(`From: ${p.hs_email_from}`);
  if (p.hs_email_to) lines.push(`To: ${p.hs_email_to}`);
  if (p.hs_email_cc) lines.push(`CC: ${p.hs_email_cc}`);
  if (ownerName) lines.push(`Owner: ${ownerName}`);
  if (associatedContactNames.length > 0) lines.push(`Contacts: ${associatedContactNames.join(', ')}`);
  if (associatedCompanyNames.length > 0) lines.push(`Company: ${associatedCompanyNames.join(', ')}`);
  if (p.hs_email_text) lines.push(p.hs_email_text.slice(0, 1000));
  else if (p.hs_email_html) lines.push(stripHtml(p.hs_email_html).slice(0, 1000));

  const content = lines.join('\n');

  return {
    content,
    sourceId: `hubspot-email-${record.id}`,
    sourceMeta: {
      hubspot_id: record.id,
      object_type: 'email',
      channel_type: 'crm' as const,
      owner_id: p.hubspot_owner_id ?? null,
      hubspotAssociations: { people: associatedContactNames, companies: associatedCompanyNames },
    },
    directMetadata: {},
    originatedAt: p.hs_timestamp ? new Date(p.hs_timestamp) : new Date(record.updatedAt),
  };
}

/** Format a HubSpot meeting into a thought */
export function formatMeeting(
  record: HubSpotRecord,
  associatedContactNames: string[] = [],
  associatedCompanyNames: string[] = [],
  ownerName?: string,
): FormattedRecord {
  const p = record.properties;
  const title = p.hs_meeting_title?.trim() || `Meeting ${record.id}`;

  const lines: string[] = [`HubSpot Meeting: ${title}`];
  if (p.hs_meeting_start_time) lines.push(`Start: ${new Date(p.hs_meeting_start_time).toISOString().slice(0, 16)}`);
  if (p.hs_meeting_end_time) lines.push(`End: ${new Date(p.hs_meeting_end_time).toISOString().slice(0, 16)}`);
  if (p.hs_meeting_location) lines.push(`Location: ${p.hs_meeting_location}`);
  if (p.hs_meeting_outcome) lines.push(`Outcome: ${p.hs_meeting_outcome}`);
  if (ownerName) lines.push(`Owner: ${ownerName}`);
  if (associatedContactNames.length > 0) lines.push(`Attendees: ${associatedContactNames.join(', ')}`);
  if (associatedCompanyNames.length > 0) lines.push(`Company: ${associatedCompanyNames.join(', ')}`);
  if (p.hs_meeting_body) lines.push(stripHtml(p.hs_meeting_body).slice(0, 1000));

  const content = lines.join('\n');

  return {
    content,
    sourceId: `hubspot-meeting-${record.id}`,
    sourceMeta: {
      hubspot_id: record.id,
      object_type: 'meeting',
      channel_type: 'crm' as const,
      owner_id: p.hubspot_owner_id ?? null,
      hubspotAssociations: { people: associatedContactNames, companies: associatedCompanyNames },
    },
    directMetadata: {},
    originatedAt: p.hs_meeting_start_time ? new Date(p.hs_meeting_start_time) : (p.hs_timestamp ? new Date(p.hs_timestamp) : new Date(record.updatedAt)),
  };
}

/** Format a HubSpot task into a thought */
export function formatTask(
  record: HubSpotRecord,
  associatedContactNames: string[] = [],
  associatedCompanyNames: string[] = [],
  ownerName?: string,
): FormattedRecord {
  const p = record.properties;
  const title = p.hs_task_title?.trim() || `Task ${record.id}`;

  const lines: string[] = [`HubSpot Task: ${title}`];
  if (p.hs_task_status) lines.push(`Status: ${p.hs_task_status}`);
  if (p.hs_task_type) lines.push(`Type: ${p.hs_task_type}`);
  if (p.hs_task_priority) lines.push(`Priority: ${p.hs_task_priority}`);
  if (p.hs_task_due_date) lines.push(`Due: ${new Date(p.hs_task_due_date).toISOString().slice(0, 10)}`);
  if (ownerName) lines.push(`Owner: ${ownerName}`);
  if (associatedContactNames.length > 0) lines.push(`Contacts: ${associatedContactNames.join(', ')}`);
  if (associatedCompanyNames.length > 0) lines.push(`Company: ${associatedCompanyNames.join(', ')}`);
  if (p.hs_task_body) lines.push(stripHtml(p.hs_task_body).slice(0, 1000));

  const content = lines.join('\n');

  return {
    content,
    sourceId: `hubspot-task-${record.id}`,
    sourceMeta: {
      hubspot_id: record.id,
      object_type: 'task',
      channel_type: 'crm' as const,
      owner_id: p.hubspot_owner_id ?? null,
      hubspotAssociations: { people: associatedContactNames, companies: associatedCompanyNames },
    },
    directMetadata: {},
    originatedAt: p.hs_task_due_date ? new Date(p.hs_task_due_date) : (p.hs_timestamp ? new Date(p.hs_timestamp) : new Date(record.updatedAt)),
  };
}
