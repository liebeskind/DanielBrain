import type pg from 'pg';
import type { Client } from '@hubspot/api-client';
import { createContentHash } from '@danielbrain/shared';
import { listObjects, searchModifiedSince, getAssociations, getObject } from './client.js';
import { formatContact, formatCompany, formatDeal } from './format.js';
import type { HubSpotObjectType, HubSpotSyncState, SyncResult, FormattedRecord } from './types.js';

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

/** Fetch associated company names for a contact */
async function getCompanyNames(client: Client, objectType: HubSpotObjectType, objectId: string): Promise<string[]> {
  const companyIds = await getAssociations(client, objectType, objectId, 'companies');
  const names: string[] = [];
  for (const cid of companyIds.slice(0, 5)) {
    const company = await getObject(client, 'companies', cid);
    if (company.properties.name) names.push(company.properties.name);
  }
  return names;
}

/** Fetch associated contact names for a deal */
async function getContactNames(client: Client, objectId: string): Promise<string[]> {
  const contactIds = await getAssociations(client, 'deals', objectId, 'contacts');
  const names: string[] = [];
  for (const cid of contactIds.slice(0, 10)) {
    const contact = await getObject(client, 'contacts', cid);
    const name = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ');
    if (name) names.push(name);
  }
  return names;
}

/** Run a full initial sync (list all records) for one object type */
async function syncObjectTypeFull(
  client: Client,
  pool: pg.Pool,
  objectType: HubSpotObjectType,
): Promise<{ queued: number; skipped: number; errors: number }> {
  let queued = 0;
  let skipped = 0;
  let errors = 0;
  let after: string | undefined;

  do {
    const page = await listObjects(client, objectType, after);

    for (const record of page.results) {
      try {
        let formatted: FormattedRecord;
        switch (objectType) {
          case 'contacts': {
            const companyNames = await getCompanyNames(client, 'contacts', record.id);
            formatted = formatContact(record, companyNames);
            break;
          }
          case 'companies':
            formatted = formatCompany(record);
            break;
          case 'deals': {
            const contactNames = await getContactNames(client, record.id);
            const companyNames = await getCompanyNames(client, 'deals', record.id);
            formatted = formatDeal(record, contactNames, companyNames);
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
        console.error(`HubSpot sync error for ${objectType}/${record.id}:`, err);
        errors++;
      }
    }

    after = page.paging?.next?.after;
  } while (after);

  return { queued, skipped, errors };
}

/** Run an incremental sync (search for modified records) for one object type */
async function syncObjectTypeIncremental(
  client: Client,
  pool: pg.Pool,
  objectType: HubSpotObjectType,
  sinceMs: number,
): Promise<{ queued: number; skipped: number; errors: number }> {
  let queued = 0;
  let skipped = 0;
  let errors = 0;
  let after: string | undefined;

  do {
    const page = await searchModifiedSince(client, objectType, sinceMs, 100, after);

    for (const record of page.results) {
      try {
        let formatted: FormattedRecord;
        switch (objectType) {
          case 'contacts': {
            const companyNames = await getCompanyNames(client, 'contacts', record.id);
            formatted = formatContact(record, companyNames);
            break;
          }
          case 'companies':
            formatted = formatCompany(record);
            break;
          case 'deals': {
            const contactNames = await getContactNames(client, record.id);
            const companyNames = await getCompanyNames(client, 'deals', record.id);
            formatted = formatDeal(record, contactNames, companyNames);
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
        console.error(`HubSpot incremental sync error for ${objectType}/${record.id}:`, err);
        errors++;
      }
    }

    after = page.paging?.next?.after;
  } while (after);

  return { queued, skipped, errors };
}

/** Main sync entry point — initial or incremental based on sync state */
export async function syncHubSpot(
  client: Client,
  pool: pg.Pool,
  objectTypes: HubSpotObjectType[],
): Promise<SyncResult> {
  const state = await loadSyncState(pool);
  const result: SyncResult = { contacts: 0, companies: 0, deals: 0, skipped: 0, errors: 0 };

  for (const objectType of objectTypes) {
    let stats: { queued: number; skipped: number; errors: number };

    if (state.lastSyncedAt) {
      // Incremental sync
      const sinceMs = state.lastSyncedAt.getTime();
      stats = await syncObjectTypeIncremental(client, pool, objectType, sinceMs);
    } else {
      // Initial full sync
      stats = await syncObjectTypeFull(client, pool, objectType);
    }

    // Accumulate per-type counts
    switch (objectType) {
      case 'contacts': result.contacts = stats.queued; break;
      case 'companies': result.companies = stats.queued; break;
      case 'deals': result.deals = stats.queued; break;
    }
    result.skipped += stats.skipped;
    result.errors += stats.errors;
  }

  // Update sync timestamp
  await saveSyncState(pool, { lastSyncedAt: new Date() });

  return result;
}
