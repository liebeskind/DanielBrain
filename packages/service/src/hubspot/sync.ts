import type pg from 'pg';
import type { Client } from '@hubspot/api-client';
import { createContentHash } from '@danielbrain/shared';
import { listObjects, searchModifiedSince, getAssociations, getObject, getOwnerName, preloadOwners } from './client.js';
import { formatContact, formatCompany, formatDeal, formatNote, formatCall, formatEmail, formatMeeting, formatTask, stripHtml, classifyNote, extractFathomCallId, extractOtterUrl, extractUrls, MIN_NOTE_LENGTH } from './format.js';
import type { HubSpotObjectType, HubSpotRecord, HubSpotSyncState, SyncResult, FormattedRecord } from './types.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('hubspot-sync');

/** Contacts contacted within this window are considered active (2 years) */
const CONTACT_RECENCY_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * Check whether a HubSpot contact has meaningful engagement.
 * Strong signals: deals, email replies, active lifecycle stage.
 * Weaker signal: contacted recently (within 2 years) — avoids stale bulk imports.
 */
export function hasContactActivity(record: HubSpotRecord): boolean {
  const p = record.properties;

  // Has associated deals — strongest signal
  if (p.num_associated_deals && Number(p.num_associated_deals) > 0) return true;

  // Has replied to sales emails — real engagement
  if (p.hs_sales_email_last_replied) return true;

  // Lifecycle beyond lead — customer, opportunity, etc. indicates real relationship
  const activeStages = new Set(['customer', 'opportunity', 'salesqualifiedlead', 'evangelist']);
  if (p.lifecyclestage && activeStages.has(p.lifecyclestage.toLowerCase())) return true;

  // Contacted recently (within 2 years) — excludes stale imports with ancient dates
  if (p.notes_last_contacted) {
    const contactedAt = new Date(p.notes_last_contacted).getTime();
    if (Date.now() - contactedAt < CONTACT_RECENCY_MS) return true;
  }

  return false;
}

/**
 * Check whether a HubSpot company has meaningful engagement.
 * Requires deals — companies with only contacts but no deals are likely stale imports.
 */
export function hasCompanyActivity(record: HubSpotRecord): boolean {
  const p = record.properties;

  // Has associated deals — strongest signal for an active company relationship
  if (p.num_associated_deals && Number(p.num_associated_deals) > 0) return true;

  return false;
}

/** Load sync state from DB (creates singleton row if missing) */
export async function loadSyncState(pool: pg.Pool): Promise<HubSpotSyncState> {
  const { rows } = await pool.query(
    `INSERT INTO hubspot_sync_state (id) VALUES (1)
     ON CONFLICT (id) DO NOTHING
     RETURNING last_synced_at, contacts_after, companies_after, deals_after`,
  );

  if (rows.length > 0) {
    return {
      lastSyncedAt: rows[0].last_synced_at,
      contactsAfter: rows[0].contacts_after,
      companiesAfter: rows[0].companies_after,
      dealsAfter: rows[0].deals_after,
    };
  }

  // Row already existed
  const { rows: existing } = await pool.query(
    `SELECT last_synced_at, contacts_after, companies_after, deals_after FROM hubspot_sync_state WHERE id = 1`,
  );
  return {
    lastSyncedAt: existing[0]?.last_synced_at ?? null,
    contactsAfter: existing[0]?.contacts_after ?? null,
    companiesAfter: existing[0]?.companies_after ?? null,
    dealsAfter: existing[0]?.deals_after ?? null,
  };
}

/** Save sync state after a cycle */
export async function saveSyncState(
  pool: pg.Pool,
  state: Partial<HubSpotSyncState>,
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const values: any[] = [];
  let idx = 1;

  if (state.lastSyncedAt !== undefined) {
    sets.push(`last_synced_at = $${idx++}`);
    values.push(state.lastSyncedAt);
  }
  if (state.contactsAfter !== undefined) {
    sets.push(`contacts_after = $${idx++}`);
    values.push(state.contactsAfter);
  }
  if (state.companiesAfter !== undefined) {
    sets.push(`companies_after = $${idx++}`);
    values.push(state.companiesAfter);
  }
  if (state.dealsAfter !== undefined) {
    sets.push(`deals_after = $${idx++}`);
    values.push(state.dealsAfter);
  }

  await pool.query(
    `UPDATE hubspot_sync_state SET ${sets.join(', ')} WHERE id = 1`,
    values,
  );
}

/** Cross-reference a HubSpot Fathom-link note with its existing Fathom thought */
export async function crossReferenceFathom(
  pool: pg.Pool,
  fathomCallId: string,
  hubspotNoteId: string,
  associations: { people: string[]; companies: string[] },
): Promise<boolean> {
  const fathomSourceId = `fathom-${fathomCallId}`;

  const { rows } = await pool.query(
    `SELECT id, source_meta FROM thoughts WHERE source_id = $1`,
    [fathomSourceId],
  );

  if (rows.length === 0) {
    log.debug({ fathomCallId, hubspotNoteId }, 'Fathom thought not found for cross-reference');
    return false;
  }

  const thought = rows[0];
  const sourceMeta = (thought.source_meta as Record<string, unknown>) || {};
  sourceMeta.hubspot_crm = {
    note_id: hubspotNoteId,
    people: associations.people,
    companies: associations.companies,
    linked_at: new Date().toISOString(),
  };

  await pool.query(
    `UPDATE thoughts SET source_meta = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(sourceMeta), thought.id],
  );

  log.info({ fathomCallId, hubspotNoteId, thoughtId: thought.id }, 'Fathom thought cross-referenced with HubSpot');
  return true;
}

/** Handle a Fathom-link note: resolve HubSpot associations and cross-reference */
async function handleFathomLink(
  pool: pg.Pool,
  client: Client,
  record: HubSpotRecord,
  stripped: string,
  companyCache: Map<string, string>,
): Promise<boolean> {
  const fathomCallId = extractFathomCallId(stripped);
  if (!fathomCallId) return false;

  const noteContacts = await getContactNames(client, 'notes', record.id);
  const noteCompanies = await getCompanyNames(client, 'notes', record.id, companyCache);

  return crossReferenceFathom(pool, fathomCallId, record.id, {
    people: noteContacts,
    companies: noteCompanies,
  });
}

/** Enqueue a formatted record */
async function enqueueRecord(pool: pg.Pool, record: FormattedRecord): Promise<boolean> {
  const contentHash = createContentHash(record.content);
  const { rowCount } = await pool.query(
    `INSERT INTO queue (content, source, source_id, source_meta, originated_at, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [
      record.content,
      'hubspot',
      record.sourceId,
      JSON.stringify(record.sourceMeta),
      record.originatedAt,
      contentHash,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Fetch associated company names for a contact (with per-cycle cache) */
async function getCompanyNames(
  client: Client,
  objectType: HubSpotObjectType,
  objectId: string,
  companyCache: Map<string, string>,
): Promise<string[]> {
  const companyIds = await getAssociations(client, objectType, objectId, 'companies');
  const names: string[] = [];
  for (const cid of companyIds.slice(0, 5)) {
    const cached = companyCache.get(cid);
    if (cached !== undefined) {
      if (cached) names.push(cached);
      continue;
    }
    const company = await getObject(client, 'companies', cid);
    const name = company.properties.name ?? '';
    companyCache.set(cid, name);
    if (name) names.push(name);
  }
  return names;
}

/** Fetch associated contact names for a deal or note */
async function getContactNames(client: Client, objectType: HubSpotObjectType, objectId: string): Promise<string[]> {
  const contactIds = await getAssociations(client, objectType, objectId, 'contacts');
  const names: string[] = [];
  for (const cid of contactIds.slice(0, 10)) {
    const contact = await getObject(client, 'contacts', cid);
    const name = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ');
    if (name) names.push(name);
  }
  return names;
}

/** Resolve owner name from record's hubspot_owner_id */
async function resolveOwnerName(
  client: Client,
  record: HubSpotRecord,
  ownerCache: Map<string, string>,
): Promise<string | undefined> {
  const ownerId = record.properties.hubspot_owner_id;
  if (!ownerId) return undefined;
  const name = await getOwnerName(client, ownerId, ownerCache);
  return name || undefined;
}

/** Run a full initial sync (list all records) for one object type */
async function syncObjectTypeFull(
  client: Client,
  pool: pg.Pool,
  objectType: HubSpotObjectType,
  companyCache: Map<string, string>,
  ownerCache: Map<string, string>,
  requireContactActivity = true,
): Promise<{ queued: number; skipped: number; errors: number; fathomLinked: number }> {
  let queued = 0;
  let skipped = 0;
  let errors = 0;
  let fathomLinked = 0;
  let after: string | undefined;
  let pageNum = 0;
  let activityFiltered = 0;

  do {
    pageNum++;
    const page = await listObjects(client, objectType, after);

    for (const record of page.results) {
      try {
        let formatted: FormattedRecord;
        switch (objectType) {
          case 'contacts': {
            if (requireContactActivity && !hasContactActivity(record)) {
              activityFiltered++;
              skipped++;
              continue;
            }
            const contactCompany = record.properties.company?.trim();
            const contactOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatContact(record, contactCompany ? [contactCompany] : [], contactOwner);
            break;
          }
          case 'companies': {
            if (requireContactActivity && !hasCompanyActivity(record)) {
              activityFiltered++;
              skipped++;
              continue;
            }
            const compOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatCompany(record, compOwner);
            break;
          }
          case 'deals': {
            const contactNames = await getContactNames(client, 'deals', record.id);
            const companyNames = await getCompanyNames(client, 'deals', record.id, companyCache);
            const dealOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatDeal(record, contactNames, companyNames, dealOwner);
            break;
          }
          case 'notes': {
            const rawBody = record.properties.hs_note_body || '';
            const stripped = stripHtml(rawBody);
            if (stripped.length < MIN_NOTE_LENGTH) {
              skipped++;
              continue;
            }
            const noteType = classifyNote(stripped);
            // Fathom links: cross-reference with existing Fathom thought, skip enqueueing
            if (noteType === 'fathom_link') {
              const linked = await handleFathomLink(pool, client, record, stripped, companyCache);
              if (linked) fathomLinked++;
              skipped++;
              continue;
            }
            const noteContacts = await getContactNames(client, 'notes', record.id);
            const noteCompanies = await getCompanyNames(client, 'notes', record.id, companyCache);
            const noteOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatNote(record, noteContacts, noteCompanies, noteOwner);
            // Store classification + enrichment URLs for future processing
            const meta = formatted.sourceMeta as Record<string, unknown>;
            meta.note_type = noteType;
            const urls = extractUrls(rawBody);
            if (urls.length > 0) meta.extracted_urls = urls;
            if (noteType === 'otter_stub') {
              const otterUrl = extractOtterUrl(stripped);
              if (otterUrl) meta.otter_url = otterUrl;
              // Use directMetadata to skip LLM extraction — nothing to extract from stub
              formatted.directMetadata = {
                people: noteContacts,
                companies: noteCompanies,
                thought_type: 'meeting_note',
                summary: `Otter.ai meeting: ${noteContacts.join(', ') || 'unknown participants'}${otterUrl ? ` (${otterUrl})` : ''}`,
              };
            }
            break;
          }
          case 'calls': {
            const callContacts = await getContactNames(client, 'calls', record.id);
            const callCompanies = await getCompanyNames(client, 'calls', record.id, companyCache);
            const callOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatCall(record, callContacts, callCompanies, callOwner);
            break;
          }
          case 'emails': {
            const emailContacts = await getContactNames(client, 'emails', record.id);
            const emailCompanies = await getCompanyNames(client, 'emails', record.id, companyCache);
            const emailOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatEmail(record, emailContacts, emailCompanies, emailOwner);
            break;
          }
          case 'meetings': {
            const meetingContacts = await getContactNames(client, 'meetings', record.id);
            const meetingCompanies = await getCompanyNames(client, 'meetings', record.id, companyCache);
            const meetingOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatMeeting(record, meetingContacts, meetingCompanies, meetingOwner);
            break;
          }
          case 'tasks': {
            const taskContacts = await getContactNames(client, 'tasks', record.id);
            const taskCompanies = await getCompanyNames(client, 'tasks', record.id, companyCache);
            const taskOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatTask(record, taskContacts, taskCompanies, taskOwner);
            break;
          }
          default:
            skipped++;
            continue;
        }

        const wasQueued = await enqueueRecord(pool, formatted);
        if (wasQueued) queued++;
        else skipped++;
      } catch (err) {
        log.error({ err, objectType, recordId: record.id }, 'HubSpot sync error');
        errors++;
      }
    }

    log.info({ objectType, pageNum, queued, activityFiltered }, 'HubSpot sync page complete');
    after = page.paging?.next?.after;
  } while (after);

  if (activityFiltered > 0) {
    log.info({ objectType, activityFiltered }, `HubSpot ${objectType} skipped (no activity)`);
  }

  return { queued, skipped, errors, fathomLinked };
}

/** Run an incremental sync (search for modified records) for one object type */
async function syncObjectTypeIncremental(
  client: Client,
  pool: pg.Pool,
  objectType: HubSpotObjectType,
  sinceMs: number,
  companyCache: Map<string, string>,
  ownerCache: Map<string, string>,
  requireContactActivity = true,
): Promise<{ queued: number; skipped: number; errors: number; fathomLinked: number }> {
  let queued = 0;
  let skipped = 0;
  let errors = 0;
  let fathomLinked = 0;
  let after: string | undefined;
  let pageNum = 0;
  let activityFiltered = 0;

  do {
    pageNum++;
    const page = await searchModifiedSince(client, objectType, sinceMs, 100, after);

    for (const record of page.results) {
      try {
        let formatted: FormattedRecord;
        switch (objectType) {
          case 'contacts': {
            if (requireContactActivity && !hasContactActivity(record)) {
              activityFiltered++;
              skipped++;
              continue;
            }
            const contactCompany = record.properties.company?.trim();
            const contactOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatContact(record, contactCompany ? [contactCompany] : [], contactOwner);
            break;
          }
          case 'companies': {
            if (requireContactActivity && !hasCompanyActivity(record)) {
              activityFiltered++;
              skipped++;
              continue;
            }
            const compOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatCompany(record, compOwner);
            break;
          }
          case 'deals': {
            const contactNames = await getContactNames(client, 'deals', record.id);
            const companyNames = await getCompanyNames(client, 'deals', record.id, companyCache);
            const dealOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatDeal(record, contactNames, companyNames, dealOwner);
            break;
          }
          case 'notes': {
            const rawBody = record.properties.hs_note_body || '';
            const stripped = stripHtml(rawBody);
            if (stripped.length < MIN_NOTE_LENGTH) {
              skipped++;
              continue;
            }
            const noteType = classifyNote(stripped);
            // Fathom links: cross-reference with existing Fathom thought, skip enqueueing
            if (noteType === 'fathom_link') {
              const linked = await handleFathomLink(pool, client, record, stripped, companyCache);
              if (linked) fathomLinked++;
              skipped++;
              continue;
            }
            const noteContacts = await getContactNames(client, 'notes', record.id);
            const noteCompanies = await getCompanyNames(client, 'notes', record.id, companyCache);
            const noteOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatNote(record, noteContacts, noteCompanies, noteOwner);
            // Store classification + enrichment URLs for future processing
            const meta = formatted.sourceMeta as Record<string, unknown>;
            meta.note_type = noteType;
            const urls = extractUrls(rawBody);
            if (urls.length > 0) meta.extracted_urls = urls;
            if (noteType === 'otter_stub') {
              const otterUrl = extractOtterUrl(stripped);
              if (otterUrl) meta.otter_url = otterUrl;
              // Use directMetadata to skip LLM extraction — nothing to extract from stub
              formatted.directMetadata = {
                people: noteContacts,
                companies: noteCompanies,
                thought_type: 'meeting_note',
                summary: `Otter.ai meeting: ${noteContacts.join(', ') || 'unknown participants'}${otterUrl ? ` (${otterUrl})` : ''}`,
              };
            }
            break;
          }
          case 'calls': {
            const callContacts = await getContactNames(client, 'calls', record.id);
            const callCompanies = await getCompanyNames(client, 'calls', record.id, companyCache);
            const callOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatCall(record, callContacts, callCompanies, callOwner);
            break;
          }
          case 'emails': {
            const emailContacts = await getContactNames(client, 'emails', record.id);
            const emailCompanies = await getCompanyNames(client, 'emails', record.id, companyCache);
            const emailOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatEmail(record, emailContacts, emailCompanies, emailOwner);
            break;
          }
          case 'meetings': {
            const meetingContacts = await getContactNames(client, 'meetings', record.id);
            const meetingCompanies = await getCompanyNames(client, 'meetings', record.id, companyCache);
            const meetingOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatMeeting(record, meetingContacts, meetingCompanies, meetingOwner);
            break;
          }
          case 'tasks': {
            const taskContacts = await getContactNames(client, 'tasks', record.id);
            const taskCompanies = await getCompanyNames(client, 'tasks', record.id, companyCache);
            const taskOwner = await resolveOwnerName(client, record, ownerCache);
            formatted = formatTask(record, taskContacts, taskCompanies, taskOwner);
            break;
          }
          default:
            skipped++;
            continue;
        }

        const wasQueued = await enqueueRecord(pool, formatted);
        if (wasQueued) queued++;
        else skipped++;
      } catch (err) {
        log.error({ err, objectType, recordId: record.id }, 'HubSpot incremental sync error');
        errors++;
      }
    }

    log.info({ objectType, pageNum, queued, activityFiltered }, 'HubSpot sync page complete');
    after = page.paging?.next?.after;

  } while (after);

  if (activityFiltered > 0) {
    log.info({ objectType, activityFiltered }, `HubSpot ${objectType} skipped (no activity)`);
  }

  return { queued, skipped, errors, fathomLinked };
}

/** Main sync entry point — initial or incremental based on sync state */
export async function syncHubSpot(
  client: Client,
  pool: pg.Pool,
  objectTypes: HubSpotObjectType[],
  options?: { requireContactActivity?: boolean },
): Promise<SyncResult> {
  const requireContactActivity = options?.requireContactActivity ?? true;
  const state = await loadSyncState(pool);
  const result: SyncResult = { contacts: 0, companies: 0, deals: 0, notes: 0, calls: 0, emails: 0, meetings: 0, tasks: 0, fathomLinked: 0, skipped: 0, errors: 0 };
  const companyCache = new Map<string, string>();
  const ownerCache = new Map<string, string>();

  // Preload all owners in one batch to avoid per-record API calls
  try {
    await preloadOwners(client, ownerCache);
    log.info({ ownerCount: ownerCache.size }, 'HubSpot owners preloaded');
  } catch (err) {
    log.warn({ err }, 'Failed to preload owners (will resolve per-record)');
  }

  for (const objectType of objectTypes) {
    let stats: { queued: number; skipped: number; errors: number };

    if (state.lastSyncedAt) {
      // Incremental sync
      const sinceMs = state.lastSyncedAt.getTime();
      stats = await syncObjectTypeIncremental(client, pool, objectType, sinceMs, companyCache, ownerCache, requireContactActivity);
    } else {
      // Initial full sync
      stats = await syncObjectTypeFull(client, pool, objectType, companyCache, ownerCache, requireContactActivity);
    }

    // Accumulate per-type counts
    switch (objectType) {
      case 'contacts': result.contacts = stats.queued; break;
      case 'companies': result.companies = stats.queued; break;
      case 'deals': result.deals = stats.queued; break;
      case 'notes': result.notes = stats.queued; break;
      case 'calls': result.calls = stats.queued; break;
      case 'emails': result.emails = stats.queued; break;
      case 'meetings': result.meetings = stats.queued; break;
      case 'tasks': result.tasks = stats.queued; break;
    }
    result.fathomLinked += stats.fathomLinked;
    result.skipped += stats.skipped;
    result.errors += stats.errors;
  }

  // Update sync timestamp
  await saveSyncState(pool, { lastSyncedAt: new Date() });

  return result;
}
