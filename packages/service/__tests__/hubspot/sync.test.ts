import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncHubSpot, loadSyncState, saveSyncState } from '../../src/hubspot/sync.js';

vi.mock('../../src/hubspot/client.js', () => ({
  listObjects: vi.fn(),
  searchModifiedSince: vi.fn(),
  getAssociations: vi.fn(),
  getObject: vi.fn(),
}));

import { listObjects, searchModifiedSince, getAssociations, getObject } from '../../src/hubspot/client.js';

const mockPool = {
  query: vi.fn(),
};

const mockClient = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadSyncState', () => {
  it('creates singleton row if missing', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    const state = await loadSyncState(mockPool as any);

    expect(state.lastSyncedAt).toBeNull();
    expect(mockPool.query.mock.calls[0][0]).toContain('INSERT INTO hubspot_sync_state');
  });

  it('loads existing sync state', async () => {
    const now = new Date();
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // INSERT returns no rows (already exists)
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: now, contacts_after: 'c1', companies_after: null, deals_after: null }],
    });

    const state = await loadSyncState(mockPool as any);

    expect(state.lastSyncedAt).toEqual(now);
    expect(state.contactsAfter).toBe('c1');
  });
});

describe('saveSyncState', () => {
  it('updates sync state', async () => {
    mockPool.query.mockResolvedValueOnce({});

    await saveSyncState(mockPool as any, { lastSyncedAt: new Date('2026-03-19T00:00:00Z') });

    const call = mockPool.query.mock.calls[0];
    expect(call[0]).toContain('UPDATE hubspot_sync_state');
    expect(call[0]).toContain('last_synced_at');
  });
});

describe('syncHubSpot', () => {
  it('runs initial full sync when no lastSyncedAt', async () => {
    // loadSyncState returns no previous sync
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }] })  // loadSyncState INSERT
    ;

    // listObjects for contacts
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '101', properties: { firstname: 'Alice', lastname: 'Smith', email: 'a@b.com' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: undefined,
    });

    // getAssociations for contact 101
    (getAssociations as any).mockResolvedValue([]);

    // Queue insert for contact
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    // listObjects for companies
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '201', properties: { name: 'Acme Corp' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: undefined,
    });

    // Queue insert for company
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    // listObjects for deals
    (listObjects as any).mockResolvedValueOnce({
      results: [],
      paging: undefined,
    });

    // saveSyncState
    mockPool.query.mockResolvedValueOnce({});

    const result = await syncHubSpot(mockClient, mockPool as any, ['contacts', 'companies', 'deals']);

    expect(result.contacts).toBe(1);
    expect(result.companies).toBe(1);
    expect(result.deals).toBe(0);
    expect(listObjects).toHaveBeenCalledTimes(3);
    expect(searchModifiedSince).not.toHaveBeenCalled();
  });

  it('runs incremental sync when lastSyncedAt exists', async () => {
    const lastSync = new Date('2026-03-18T00:00:00Z');
    // loadSyncState
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: lastSync, contacts_after: null, companies_after: null, deals_after: null }],
    });

    // searchModifiedSince for contacts — returns 1 updated
    (searchModifiedSince as any).mockResolvedValueOnce({
      total: 1,
      results: [
        { id: '101', properties: { firstname: 'Alice', lastname: 'Updated' }, createdAt: '2026-01-01', updatedAt: '2026-03-19' },
      ],
      paging: undefined,
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 }); // queue insert

    // searchModifiedSince for companies — returns 0
    (searchModifiedSince as any).mockResolvedValueOnce({
      total: 0,
      results: [],
      paging: undefined,
    });

    // saveSyncState
    mockPool.query.mockResolvedValueOnce({});

    const result = await syncHubSpot(mockClient, mockPool as any, ['contacts', 'companies']);

    expect(result.contacts).toBe(1);
    expect(result.companies).toBe(0);
    expect(searchModifiedSince).toHaveBeenCalledTimes(2);
    expect(listObjects).not.toHaveBeenCalled();
  });

  it('skips duplicate records (ON CONFLICT)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '101', properties: { firstname: 'Alice', lastname: 'Smith' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: undefined,
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 }); // already exists

    // saveSyncState
    mockPool.query.mockResolvedValueOnce({});

    const result = await syncHubSpot(mockClient, mockPool as any, ['contacts']);
    expect(result.contacts).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('handles pagination in full sync', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    // Page 1
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '101', properties: { firstname: 'Alice', lastname: 'A' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: { next: { after: 'cursor-2' } },
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    // Page 2
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '102', properties: { firstname: 'Bob', lastname: 'B' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: undefined,
    });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    // saveSyncState
    mockPool.query.mockResolvedValueOnce({});

    const result = await syncHubSpot(mockClient, mockPool as any, ['contacts']);
    expect(result.contacts).toBe(2);
    expect(listObjects).toHaveBeenCalledTimes(2);
  });

  it('resolves deal associations', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '301', properties: { dealname: 'Big Deal', amount: '100000' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: undefined,
    });

    // getAssociations: deal → contacts
    (getAssociations as any)
      .mockResolvedValueOnce(['101']) // contacts
      .mockResolvedValueOnce(['201']); // companies

    // getObject for contact
    (getObject as any).mockResolvedValueOnce({
      id: '101',
      properties: { firstname: 'Alice', lastname: 'Smith' },
      createdAt: '2026-01-01',
      updatedAt: '2026-03-01',
    });

    // getObject for company
    (getObject as any).mockResolvedValueOnce({
      id: '201',
      properties: { name: 'Acme Corp' },
      createdAt: '2026-01-01',
      updatedAt: '2026-03-01',
    });

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 }); // queue insert
    mockPool.query.mockResolvedValueOnce({}); // saveSyncState

    const result = await syncHubSpot(mockClient, mockPool as any, ['deals']);
    expect(result.deals).toBe(1);

    // Check the queued content includes associations
    const insertCall = mockPool.query.mock.calls.find((c: any) => c[0].includes('INSERT INTO queue'));
    const content = insertCall![1][0];
    expect(content).toContain('Contacts: Alice Smith');
    expect(content).toContain('Company: Acme Corp');
  });
});
