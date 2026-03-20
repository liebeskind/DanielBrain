import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listObjects, searchModifiedSince, getAssociations, getObject, getPropertiesForType } from '../../src/hubspot/client.js';
import { CONTACT_PROPERTIES, COMPANY_PROPERTIES, DEAL_PROPERTIES, NOTE_PROPERTIES } from '../../src/hubspot/types.js';

// Mock the @hubspot/api-client module
vi.mock('@hubspot/api-client', () => ({
  Client: vi.fn(),
}));

function createMockClient() {
  return {
    crm: {
      contacts: {
        basicApi: { getPage: vi.fn(), getById: vi.fn() },
        searchApi: { doSearch: vi.fn() },
      },
      companies: {
        basicApi: { getPage: vi.fn(), getById: vi.fn() },
        searchApi: { doSearch: vi.fn() },
      },
      deals: {
        basicApi: { getPage: vi.fn(), getById: vi.fn() },
        searchApi: { doSearch: vi.fn() },
      },
      notes: {
        basicApi: { getPage: vi.fn(), getById: vi.fn() },
        searchApi: { doSearch: vi.fn() },
      },
      associations: {
        v4: {
          basicApi: { getPage: vi.fn() },
        },
      },
    },
  } as any;
}

describe('getPropertiesForType', () => {
  it('returns contact properties', () => {
    expect(getPropertiesForType('contacts')).toBe(CONTACT_PROPERTIES);
  });

  it('returns company properties', () => {
    expect(getPropertiesForType('companies')).toBe(COMPANY_PROPERTIES);
  });

  it('returns deal properties', () => {
    expect(getPropertiesForType('deals')).toBe(DEAL_PROPERTIES);
  });

  it('returns note properties', () => {
    expect(getPropertiesForType('notes')).toBe(NOTE_PROPERTIES);
  });
});

describe('listObjects', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('lists contacts with pagination', async () => {
    client.crm.contacts.basicApi.getPage.mockResolvedValueOnce({
      results: [
        { id: '101', properties: { firstname: 'Alice', lastname: 'Smith' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: { next: { after: 'cursor-2' } },
    });

    const result = await listObjects(client, 'contacts', undefined, 50);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('101');
    expect(result.results[0].properties.firstname).toBe('Alice');
    expect(result.paging?.next?.after).toBe('cursor-2');
    expect(client.crm.contacts.basicApi.getPage).toHaveBeenCalledWith(
      50, undefined, expect.arrayContaining(['firstname', 'lastname', 'email']),
    );
  });

  it('lists companies', async () => {
    client.crm.companies.basicApi.getPage.mockResolvedValueOnce({
      results: [
        { id: '201', properties: { name: 'Acme Corp' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: undefined,
    });

    const result = await listObjects(client, 'companies');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].properties.name).toBe('Acme Corp');
    expect(result.paging).toBeUndefined();
  });

  it('passes after cursor for pagination', async () => {
    client.crm.deals.basicApi.getPage.mockResolvedValueOnce({
      results: [],
    });

    await listObjects(client, 'deals', 'cursor-5');
    expect(client.crm.deals.basicApi.getPage).toHaveBeenCalledWith(
      100, 'cursor-5', expect.any(Array),
    );
  });
});

describe('searchModifiedSince', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('searches contacts using lastmodifieddate', async () => {
    client.crm.contacts.searchApi.doSearch.mockResolvedValueOnce({
      total: 1,
      results: [
        { id: '101', properties: { firstname: 'Bob' }, createdAt: '2026-01-01', updatedAt: '2026-03-15' },
      ],
      paging: undefined,
    });

    const result = await searchModifiedSince(client, 'contacts', 1700000000000);

    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);

    const searchArg = client.crm.contacts.searchApi.doSearch.mock.calls[0][0];
    expect(searchArg.filterGroups[0].filters[0].propertyName).toBe('lastmodifieddate');
    expect(searchArg.filterGroups[0].filters[0].value).toBe('1700000000000');
  });

  it('searches companies using hs_lastmodifieddate', async () => {
    client.crm.companies.searchApi.doSearch.mockResolvedValueOnce({
      total: 0,
      results: [],
    });

    await searchModifiedSince(client, 'companies', 1700000000000);

    const searchArg = client.crm.companies.searchApi.doSearch.mock.calls[0][0];
    expect(searchArg.filterGroups[0].filters[0].propertyName).toBe('hs_lastmodifieddate');
  });

  it('passes pagination cursor', async () => {
    client.crm.contacts.searchApi.doSearch.mockResolvedValueOnce({
      total: 200,
      results: [],
      paging: { next: { after: '100' } },
    });

    const result = await searchModifiedSince(client, 'contacts', 1700000000000, 100, '50');

    const searchArg = client.crm.contacts.searchApi.doSearch.mock.calls[0][0];
    expect(searchArg.after).toBe('50');
    expect(searchArg.limit).toBe(100);
  });
});

describe('getAssociations', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('returns associated object IDs', async () => {
    client.crm.associations.v4.basicApi.getPage.mockResolvedValueOnce({
      results: [
        { toObjectId: 201 },
        { toObjectId: 202 },
      ],
    });

    const ids = await getAssociations(client, 'contacts', '101', 'companies');
    expect(ids).toEqual(['201', '202']);
  });

  it('returns empty array on error', async () => {
    client.crm.associations.v4.basicApi.getPage.mockRejectedValueOnce(new Error('404'));

    const ids = await getAssociations(client, 'contacts', '999', 'companies');
    expect(ids).toEqual([]);
  });
});

describe('getObject', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('fetches a single contact by ID', async () => {
    client.crm.contacts.basicApi.getById.mockResolvedValueOnce({
      id: '101',
      properties: { firstname: 'Alice', lastname: 'Smith', email: 'alice@acme.com' },
      createdAt: '2026-01-01',
      updatedAt: '2026-03-01',
    });

    const record = await getObject(client, 'contacts', '101');
    expect(record.id).toBe('101');
    expect(record.properties.firstname).toBe('Alice');
  });
});
