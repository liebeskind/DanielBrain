import type { ParticipantIdentity, StructuredData } from '@danielbrain/shared';
import type { HubSpotRecord, DirectMetadata, FormattedRecord } from './types.js';

/** Format a HubSpot contact into a thought */
export function formatContact(
  record: HubSpotRecord,
  associatedCompanyNames: string[] = [],
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
export function formatCompany(record: HubSpotRecord): FormattedRecord {
  const p = record.properties;
  const name = p.name?.trim() || `Company ${record.id}`;

  const lines: string[] = [`HubSpot Company: ${name}`];
  if (p.domain) lines.push(`Domain: ${p.domain}`);
  if (p.industry) lines.push(`Industry: ${p.industry}`);
  if (p.numberofemployees) lines.push(`Employees: ${p.numberofemployees}`);
  if (p.annualrevenue) lines.push(`Revenue: $${Number(p.annualrevenue).toLocaleString()}`);

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
): FormattedRecord {
  const p = record.properties;
  const dealName = p.dealname?.trim() || `Deal ${record.id}`;

  const lines: string[] = [`HubSpot Deal: ${dealName}`];
  if (p.pipeline) lines.push(`Pipeline: ${p.pipeline}`);
  if (p.dealstage) lines.push(`Stage: ${p.dealstage}`);
  if (p.amount) lines.push(`Amount: $${Number(p.amount).toLocaleString()}`);
  if (p.closedate) lines.push(`Close Date: ${p.closedate.slice(0, 10)}`);
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
    originatedAt: new Date(record.updatedAt),
  };
}

/** Format a HubSpot note (unstructured — no directMetadata, needs LLM) */
export function formatNote(
  record: HubSpotRecord,
  associatedContactNames: string[] = [],
  associatedCompanyNames: string[] = [],
): FormattedRecord {
  const p = record.properties;
  const body = p.hs_note_body || '(empty note)';

  const contextParts: string[] = [];
  if (associatedContactNames.length > 0) {
    contextParts.push(associatedContactNames.join(', '));
  }
  if (associatedCompanyNames.length > 0) {
    contextParts.push(`(${associatedCompanyNames.join(', ')})`);
  }
  const contextStr = contextParts.length > 0 ? ` on ${contextParts.join(' ')}` : '';

  const content = `HubSpot Note${contextStr}:\n${body}`;

  return {
    content,
    sourceId: `hubspot-note-${record.id}`,
    sourceMeta: {
      hubspot_id: record.id,
      object_type: 'note',
      channel_type: 'crm' as const,
      owner_id: p.hubspot_owner_id ?? null,
    },
    // Notes are unstructured text — needs full LLM extraction
    directMetadata: {},
    originatedAt: p.hs_timestamp ? new Date(p.hs_timestamp) : new Date(record.updatedAt),
  };
}
