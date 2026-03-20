import type pg from 'pg';
import type { Client } from '@hubspot/api-client';
import { createContentHash } from '@danielbrain/shared';
import { getObject, getAssociations } from './client.js';
import { formatContact, formatCompany, formatDeal, formatNote } from './format.js';
import type { HubSpotObjectType, FormattedRecord } from './types.js';

interface HubSpotWebhookEvent {
  objectId: number;
  objectTypeId: string;
  propertyName?: string;
  propertyValue?: string;
  subscriptionType: string;
  eventId: number;
  portalId: number;
  occurredAt: number;
}

/** Map HubSpot objectTypeId to our object type */
function resolveObjectType(objectTypeId: string): HubSpotObjectType | null {
  switch (objectTypeId) {
    case '0-1': return 'contacts';
    case '0-2': return 'companies';
    case '0-3': return 'deals';
    case '0-4': return 'notes'; // engagements/notes
    default: return null;
  }
}

/** Fetch full object and format it based on type */
async function fetchAndFormat(
  client: Client,
  objectType: HubSpotObjectType,
  objectId: string,
): Promise<FormattedRecord | null> {
  const record = await getObject(client, objectType, objectId);

  switch (objectType) {
    case 'contacts': {
      const companyIds = await getAssociations(client, 'contacts', objectId, 'companies');
      const companyNames: string[] = [];
      for (const cid of companyIds.slice(0, 5)) {
        const company = await getObject(client, 'companies', cid);
        if (company.properties.name) companyNames.push(company.properties.name);
      }
      return formatContact(record, companyNames);
    }
    case 'companies':
      return formatCompany(record);
    case 'deals': {
      const contactIds = await getAssociations(client, 'deals', objectId, 'contacts');
      const companyIds = await getAssociations(client, 'deals', objectId, 'companies');
      const contactNames: string[] = [];
      const companyNames: string[] = [];
      for (const cid of contactIds.slice(0, 10)) {
        const contact = await getObject(client, 'contacts', cid);
        const name = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ');
        if (name) contactNames.push(name);
      }
      for (const cid of companyIds.slice(0, 5)) {
        const company = await getObject(client, 'companies', cid);
        if (company.properties.name) companyNames.push(company.properties.name);
      }
      return formatDeal(record, contactNames, companyNames);
    }
    case 'notes': {
      const contactIds = await getAssociations(client, 'notes', objectId, 'contacts');
      const companyIds = await getAssociations(client, 'notes', objectId, 'companies');
      const contactNames: string[] = [];
      const companyNames: string[] = [];
      for (const cid of contactIds.slice(0, 10)) {
        const contact = await getObject(client, 'contacts', cid);
        const name = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ');
        if (name) contactNames.push(name);
      }
      for (const cid of companyIds.slice(0, 5)) {
        const company = await getObject(client, 'companies', cid);
        if (company.properties.name) companyNames.push(company.properties.name);
      }
      return formatNote(record, contactNames, companyNames);
    }
    default:
      return null;
  }
}

/**
 * Handle a batch of HubSpot webhook events.
 * HubSpot sends up to 100 events per request.
 */
export async function handleHubSpotEvents(
  events: HubSpotWebhookEvent[],
  pool: pg.Pool,
  client: Client,
): Promise<{ processed: number; skipped: number; errors: number }> {
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // Deduplicate by objectId + objectTypeId (multiple events for same object)
  const seen = new Set<string>();
  const uniqueEvents: HubSpotWebhookEvent[] = [];
  for (const event of events) {
    const key = `${event.objectTypeId}-${event.objectId}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEvents.push(event);
    }
  }

  for (const event of uniqueEvents) {
    const objectType = resolveObjectType(event.objectTypeId);
    if (!objectType) {
      skipped++;
      continue;
    }

    // Skip deletion events
    if (event.subscriptionType.includes('.deletion')) {
      skipped++;
      continue;
    }

    try {
      const formatted = await fetchAndFormat(client, objectType, String(event.objectId));
      if (!formatted) {
        skipped++;
        continue;
      }

      const contentHash = createContentHash(formatted.content);
      await pool.query(
        `INSERT INTO queue (content, source, source_id, source_meta, originated_at, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_id) WHERE source_id IS NOT NULL
         DO UPDATE SET content = EXCLUDED.content, source_meta = EXCLUDED.source_meta,
           originated_at = EXCLUDED.originated_at, content_hash = EXCLUDED.content_hash,
           status = 'pending', error = NULL, attempts = 0`,
        [
          formatted.content,
          'hubspot',
          formatted.sourceId,
          JSON.stringify(formatted.sourceMeta),
          formatted.originatedAt,
          contentHash,
        ],
      );
      processed++;
    } catch (err) {
      console.error(`HubSpot webhook error for ${objectType}/${event.objectId}:`, err);
      errors++;
    }
  }

  return { processed, skipped, errors };
}
