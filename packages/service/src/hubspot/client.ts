import { Client } from '@hubspot/api-client';
import type {
  HubSpotObjectType,
  HubSpotRecord,
  HubSpotListResponse,
  HubSpotSearchResponse,
} from './types.js';
import {
  CONTACT_PROPERTIES,
  COMPANY_PROPERTIES,
  DEAL_PROPERTIES,
  NOTE_PROPERTIES,
  CALL_PROPERTIES,
  EMAIL_PROPERTIES,
  MEETING_PROPERTIES,
  TASK_PROPERTIES,
} from './types.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('hubspot-client');

/** Create a configured HubSpot client with built-in rate limiting */
export function createHubSpotClient(accessToken: string): Client {
  return new Client({
    accessToken,
    numberOfApiCallRetries: 0, // We handle retries ourselves with withRetry
    limiterOptions: {
      minTime: 150,       // ~6.6 req/sec — conservative to avoid 429s
      maxConcurrent: 3,   // Low concurrency
      reservoir: 80,      // Well under HubSpot's 100/10sec free tier limit
      reservoirRefreshAmount: 80,
      reservoirRefreshInterval: 10_000, // Refill every 10 seconds
    },
  });
}

const TRANSIENT_CODES = new Set<number | string>([429, 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE']);

function isTransient(err: any): boolean {
  return TRANSIENT_CODES.has(err?.code) || TRANSIENT_CODES.has(err?.statusCode);
}

/** Retry wrapper for transient errors (429 rate limits, network errors) */
export async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 5): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!isTransient(err) || attempt === maxRetries) throw err;
      // Base delay of 10s for rate limits (clears HubSpot's 10-second rolling window)
      // Shorter 2s base for network errors
      const isRateLimit = err?.code === 429 || err?.statusCode === 429;
      const baseDelay = isRateLimit ? 10_000 : 2_000;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      const reason = isRateLimit ? 'rate limited' : err?.code ?? 'network error';
      log.info({ reason, label, delay: delay / 1000, attempt, maxRetries }, 'HubSpot retry');
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

/** Get property list for an object type */
export function getPropertiesForType(objectType: HubSpotObjectType): readonly string[] {
  switch (objectType) {
    case 'contacts': return CONTACT_PROPERTIES;
    case 'companies': return COMPANY_PROPERTIES;
    case 'deals': return DEAL_PROPERTIES;
    case 'notes': return NOTE_PROPERTIES;
    case 'calls': return CALL_PROPERTIES;
    case 'emails': return EMAIL_PROPERTIES;
    case 'meetings': return MEETING_PROPERTIES;
    case 'tasks': return TASK_PROPERTIES;
  }
}

/** The lastmodifieddate property name differs per object type */
function getLastModifiedProperty(objectType: HubSpotObjectType): string {
  return objectType === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate';
}

/** Normalize SDK response to our HubSpotRecord type */
function normalizeRecord(raw: any): HubSpotRecord {
  return {
    id: String(raw.id),
    properties: raw.properties ?? {},
    createdAt: raw.createdAt ?? raw.properties?.createdate ?? new Date().toISOString(),
    updatedAt: raw.updatedAt ?? raw.properties?.lastmodifieddate ?? new Date().toISOString(),
  };
}

/** List objects with pagination */
export async function listObjects(
  client: Client,
  objectType: HubSpotObjectType,
  after?: string,
  limit = 100,
): Promise<HubSpotListResponse> {
  const properties = [...getPropertiesForType(objectType)];
  const typeApi = (client.crm as any)[objectType]?.basicApi;

  const response = await withRetry(
    () => typeApi
      ? typeApi.getPage(limit, after, properties)
      : client.crm.objects.basicApi.getPage(objectType, limit, after, properties),
    `listObjects(${objectType})`,
  );
  return {
    results: (response.results ?? []).map(normalizeRecord),
    paging: response.paging,
  };
}

/** Search for records modified since a timestamp (milliseconds) */
export async function searchModifiedSince(
  client: Client,
  objectType: HubSpotObjectType,
  sinceMs: number,
  limit = 100,
  after?: string,
): Promise<HubSpotSearchResponse> {
  const properties = [...getPropertiesForType(objectType)];
  const lastModProp = getLastModifiedProperty(objectType);
  const typeApi = (client.crm as any)[objectType]?.searchApi;

  const searchRequest = {
    filterGroups: [{
      filters: [{
        propertyName: lastModProp,
        operator: 'GT',
        value: String(sinceMs),
      }],
    }],
    properties,
    limit,
    after: after || '0',
  };

  const response = await withRetry(
    () => typeApi
      ? typeApi.doSearch(searchRequest)
      : client.crm.objects.searchApi.doSearch(objectType, searchRequest),
    `searchModifiedSince(${objectType})`,
  );
  return {
    total: response.total ?? 0,
    results: (response.results ?? []).map(normalizeRecord),
    paging: response.paging,
  };
}

/** Get associations for an object */
export async function getAssociations(
  client: Client,
  objectType: HubSpotObjectType,
  objectId: string,
  toObjectType: HubSpotObjectType,
): Promise<string[]> {
  try {
    const response = await withRetry(
      () => client.crm.associations.v4.basicApi.getPage(
        objectType, objectId, toObjectType, undefined, 500,
      ),
      `getAssociations(${objectType}/${objectId})`,
    );
    return (response.results ?? []).map((r: any) => String(r.toObjectId));
  } catch {
    // 404 or no associations (after retries exhausted for transient errors)
    return [];
  }
}

/** Preload all owners into cache in a single paginated API call */
export async function preloadOwners(
  client: Client,
  ownerCache: Map<string, string>,
): Promise<void> {
  let after: string | undefined;
  do {
    const response = await withRetry(
      () => client.crm.owners.ownersApi.getPage(undefined, after, 100),
      'preloadOwners',
    );
    for (const owner of response.results ?? []) {
      const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || '';
      ownerCache.set(String(owner.id), name);
    }
    after = response.paging?.next?.after;
  } while (after);
}

/** Resolve a HubSpot owner ID to a display name (with per-cycle cache) */
export async function getOwnerName(
  client: Client,
  ownerId: string,
  ownerCache: Map<string, string>,
): Promise<string> {
  const cached = ownerCache.get(ownerId);
  if (cached !== undefined) return cached;

  try {
    const owner = await withRetry(
      () => client.crm.owners.ownersApi.getById(Number(ownerId)),
      `getOwnerName(${ownerId})`,
    );
    const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || '';
    ownerCache.set(ownerId, name);
    return name;
  } catch {
    ownerCache.set(ownerId, '');
    return '';
  }
}

/** Fetch a single object by ID */
export async function getObject(
  client: Client,
  objectType: HubSpotObjectType,
  objectId: string,
): Promise<HubSpotRecord> {
  const properties = [...getPropertiesForType(objectType)];
  const typeApi = (client.crm as any)[objectType]?.basicApi;

  const response = await withRetry(
    () => typeApi
      ? typeApi.getById(objectId, properties)
      : client.crm.objects.basicApi.getById(objectType, objectId, properties),
    `getObject(${objectType}/${objectId})`,
  );
  return normalizeRecord(response);
}
