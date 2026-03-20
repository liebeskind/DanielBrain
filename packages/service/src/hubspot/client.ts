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
} from './types.js';

/** Create a configured HubSpot client with built-in rate limiting */
export function createHubSpotClient(accessToken: string): Client {
  return new Client({ accessToken });
}

/** Get property list for an object type */
export function getPropertiesForType(objectType: HubSpotObjectType): readonly string[] {
  switch (objectType) {
    case 'contacts': return CONTACT_PROPERTIES;
    case 'companies': return COMPANY_PROPERTIES;
    case 'deals': return DEAL_PROPERTIES;
    case 'notes': return NOTE_PROPERTIES;
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
  const api = (client.crm as any)[objectType]?.basicApi;

  if (!api) {
    throw new Error(`Unsupported object type: ${objectType}`);
  }

  const response = await api.getPage(limit, after, properties);
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
  const api = (client.crm as any)[objectType]?.searchApi;

  if (!api) {
    throw new Error(`Unsupported object type for search: ${objectType}`);
  }

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

  const response = await api.doSearch(searchRequest);
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
    const response = await client.crm.associations.v4.basicApi.getPage(
      objectType, objectId, toObjectType, undefined, 500,
    );
    return (response.results ?? []).map((r: any) => String(r.toObjectId));
  } catch {
    // 404 or no associations
    return [];
  }
}

/** Fetch a single object by ID */
export async function getObject(
  client: Client,
  objectType: HubSpotObjectType,
  objectId: string,
): Promise<HubSpotRecord> {
  const properties = [...getPropertiesForType(objectType)];
  const api = (client.crm as any)[objectType]?.basicApi;

  if (!api) {
    throw new Error(`Unsupported object type: ${objectType}`);
  }

  const response = await api.getById(objectId, properties);
  return normalizeRecord(response);
}
