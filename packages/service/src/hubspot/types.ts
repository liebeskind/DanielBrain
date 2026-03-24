import type { StructuredData } from '@danielbrain/shared';

/** Properties requested per object type */
export const CONTACT_PROPERTIES = [
  'firstname', 'lastname', 'email', 'company', 'jobtitle',
  'lifecyclestage', 'hs_lead_status', 'phone', 'lastmodifieddate',
  'num_associated_deals', 'notes_last_contacted', 'num_notes',
  'hs_sales_email_last_replied',
  'hubspot_owner_id', 'createdate', 'hs_analytics_source',
  'hs_last_sales_activity_timestamp',
] as const;

export const COMPANY_PROPERTIES = [
  'name', 'domain', 'industry', 'numberofemployees', 'annualrevenue',
  'hs_lastmodifieddate', 'description', 'hubspot_owner_id', 'createdate',
  'num_associated_contacts', 'num_associated_deals',
] as const;

export const DEAL_PROPERTIES = [
  'dealname', 'pipeline', 'dealstage', 'amount', 'closedate',
  'hubspot_owner_id', 'hs_lastmodifieddate', 'createdate', 'description',
] as const;

export const NOTE_PROPERTIES = [
  'hs_note_body', 'hs_timestamp', 'hubspot_owner_id',
] as const;

export const CALL_PROPERTIES = [
  'hs_call_title', 'hs_call_body', 'hs_call_duration_milliseconds',
  'hs_call_status', 'hs_call_source', 'hs_call_from_number', 'hs_call_to_number',
  'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate', 'createdate',
] as const;

export const EMAIL_PROPERTIES = [
  'hs_email_subject', 'hs_email_text', 'hs_email_html',
  'hs_email_from', 'hs_email_to', 'hs_email_cc',
  'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate', 'createdate',
] as const;

export const MEETING_PROPERTIES = [
  'hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time',
  'hs_meeting_end_time', 'hs_meeting_location', 'hs_meeting_outcome',
  'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate', 'createdate',
] as const;

export const TASK_PROPERTIES = [
  'hs_task_title', 'hs_task_body', 'hs_task_status', 'hs_task_type',
  'hs_task_due_date', 'hs_task_priority',
  'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate', 'createdate',
] as const;

export type HubSpotObjectType = 'contacts' | 'companies' | 'deals' | 'notes' | 'calls' | 'emails' | 'meetings' | 'tasks';

/** Simplified record from HubSpot API */
export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

export interface HubSpotListResponse {
  results: HubSpotRecord[];
  paging?: {
    next?: { after: string };
  };
}

export interface HubSpotSearchResponse {
  total: number;
  results: HubSpotRecord[];
  paging?: {
    next?: { after: string };
  };
}

export interface HubSpotAssociation {
  toObjectId: number;
  associationTypes: Array<{ typeId: number; label: string | null }>;
}

/** Direct metadata for structured CRM records (bypasses LLM extraction) */
export interface DirectMetadata {
  people?: string[];
  companies?: string[];
  topics?: string[];
  thought_type?: string;
  summary?: string;
}

/** What formatContact/formatCompany/formatDeal return */
export interface FormattedRecord {
  content: string;
  sourceId: string;
  sourceMeta: Record<string, unknown>;
  directMetadata: DirectMetadata;
  originatedAt: Date;
}

export interface HubSpotSyncState {
  lastSyncedAt: Date | null;
  contactsAfter: string | null;
  companiesAfter: string | null;
  dealsAfter: string | null;
}

export interface SyncResult {
  contacts: number;
  companies: number;
  deals: number;
  notes: number;
  calls: number;
  emails: number;
  meetings: number;
  tasks: number;
  fathomLinked: number;
  skipped: number;
  errors: number;
}
