import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncHubSpot, loadSyncState, saveSyncState, hasContactActivity, hasCompanyActivity, crossReferenceFathom } from '../../src/hubspot/sync.js';
import type { HubSpotRecord } from '../../src/hubspot/types.js';

vi.mock('../../src/hubspot/client.js', () => ({
  listObjects: vi.fn(),
  searchModifiedSince: vi.fn(),
  getAssociations: vi.fn(),
  getObject: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
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

describe('hasContactActivity', () => {
  const makeRecord = (props: Record<string, string | null>): HubSpotRecord => ({
    id: '1', properties: props, createdAt: '2026-01-01', updatedAt: '2026-03-01',
  });

  it('returns false for contact with no activity signals', () => {
    expect(hasContactActivity(makeRecord({
      firstname: 'Stale', lastname: 'Import', email: 'stale@old.com',
    }))).toBe(false);
  });

  it('returns true for contact with associated deals', () => {
    expect(hasContactActivity(makeRecord({ num_associated_deals: '2' }))).toBe(true);
  });

  it('returns false for num_associated_deals = 0', () => {
    expect(hasContactActivity(makeRecord({ num_associated_deals: '0' }))).toBe(false);
  });

  it('returns false for contact with only notes (too weak a signal)', () => {
    expect(hasContactActivity(makeRecord({ num_notes: '3' }))).toBe(false);
  });

  it('returns true for contact contacted recently (within 2 years)', () => {
    expect(hasContactActivity(makeRecord({ notes_last_contacted: '2026-03-01T00:00:00Z' }))).toBe(true);
  });

  it('returns false for contact contacted long ago (over 2 years)', () => {
    expect(hasContactActivity(makeRecord({ notes_last_contacted: '2022-01-01T00:00:00Z' }))).toBe(false);
  });

  it('returns true for contact with sales email reply', () => {
    expect(hasContactActivity(makeRecord({ hs_sales_email_last_replied: '2026-02-15T00:00:00Z' }))).toBe(true);
  });

  it('returns true for customer lifecycle stage', () => {
    expect(hasContactActivity(makeRecord({ lifecyclestage: 'customer' }))).toBe(true);
  });

  it('returns true for opportunity lifecycle stage', () => {
    expect(hasContactActivity(makeRecord({ lifecyclestage: 'opportunity' }))).toBe(true);
  });

  it('returns false for lead lifecycle stage', () => {
    expect(hasContactActivity(makeRecord({ lifecyclestage: 'lead' }))).toBe(false);
  });

  it('returns false when all activity fields are null', () => {
    expect(hasContactActivity(makeRecord({
      num_associated_deals: null, hs_sales_email_last_replied: null,
      lifecyclestage: null,
    }))).toBe(false);
  });
});

describe('hasCompanyActivity', () => {
  const makeRecord = (props: Record<string, string | null>): HubSpotRecord => ({
    id: '1', properties: props, createdAt: '2026-01-01', updatedAt: '2026-03-01',
  });

  it('returns false for company with no associations', () => {
    expect(hasCompanyActivity(makeRecord({ name: 'Empty Corp' }))).toBe(false);
  });

  it('returns false for company with only contacts (too weak)', () => {
    expect(hasCompanyActivity(makeRecord({ num_associated_contacts: '5' }))).toBe(false);
  });

  it('returns true for company with associated deals', () => {
    expect(hasCompanyActivity(makeRecord({ num_associated_deals: '1' }))).toBe(true);
  });

  it('returns false for zero associations', () => {
    expect(hasCompanyActivity(makeRecord({
      num_associated_contacts: '0', num_associated_deals: '0',
    }))).toBe(false);
  });
});

describe('syncHubSpot', () => {
  it('runs initial full sync when no lastSyncedAt', async () => {
    // loadSyncState returns no previous sync
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }] })  // loadSyncState INSERT
    ;

    // listObjects for contacts — contact has activity (deals)
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '101', properties: { firstname: 'Alice', lastname: 'Smith', email: 'a@b.com', num_associated_deals: '1' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: undefined,
    });

    // getAssociations for contact 101
    (getAssociations as any).mockResolvedValue([]);

    // Queue insert for contact
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    // listObjects for companies — company has associated contacts
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '201', properties: { name: 'Acme Corp', num_associated_deals: '1' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
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

    // searchModifiedSince for contacts — returns 1 updated (has activity)
    (searchModifiedSince as any).mockResolvedValueOnce({
      total: 1,
      results: [
        { id: '101', properties: { firstname: 'Alice', lastname: 'Updated', num_associated_deals: '1' }, createdAt: '2026-01-01', updatedAt: '2026-03-19' },
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
        { id: '101', properties: { firstname: 'Alice', lastname: 'Smith', num_associated_deals: '1' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
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
        { id: '101', properties: { firstname: 'Alice', lastname: 'A', lifecyclestage: 'customer' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: { next: { after: 'cursor-2' } },
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    // Page 2
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '102', properties: { firstname: 'Bob', lastname: 'B', num_associated_deals: '1' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
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

  it('uses contact company property instead of association lookup', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    // Two contacts with company property set (both have activity)
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '101', properties: { firstname: 'Alice', lastname: 'A', email: 'a@b.com', company: 'Acme Corp', num_associated_deals: '1' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
        { id: '102', properties: { firstname: 'Bob', lastname: 'B', email: 'b@b.com', company: 'Acme Corp', hs_sales_email_last_replied: '2026-03-01' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: undefined,
    });

    mockPool.query.mockResolvedValueOnce({ rowCount: 1 }); // queue insert contact 1
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 }); // queue insert contact 2
    mockPool.query.mockResolvedValueOnce({}); // saveSyncState

    const result = await syncHubSpot(mockClient, mockPool as any, ['contacts']);
    expect(result.contacts).toBe(2);
    // No association or getObject calls needed for contacts
    expect(getAssociations).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();
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

  it('skips contacts with no activity signals', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    // 3 contacts: 1 active (has deal), 2 inactive (no activity)
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '101', properties: { firstname: 'Active', lastname: 'User', num_associated_deals: '1' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
        { id: '102', properties: { firstname: 'Stale', lastname: 'Import' }, createdAt: '2020-01-01', updatedAt: '2020-01-01' },
        { id: '103', properties: { firstname: 'Old', lastname: 'Lead', num_associated_deals: '0', lifecyclestage: 'lead' }, createdAt: '2019-06-01', updatedAt: '2019-06-01' },
      ],
      paging: undefined,
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 }); // queue insert for active contact only
    mockPool.query.mockResolvedValueOnce({}); // saveSyncState

    const result = await syncHubSpot(mockClient, mockPool as any, ['contacts']);
    expect(result.contacts).toBe(1);
    expect(result.skipped).toBe(2); // 2 inactive contacts skipped
  });

  it('allows all contacts when requireContactActivity is false', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    // Contact with no activity signals
    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '101', properties: { firstname: 'Stale', lastname: 'Import' }, createdAt: '2020-01-01', updatedAt: '2020-01-01' },
      ],
      paging: undefined,
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 }); // queue insert
    mockPool.query.mockResolvedValueOnce({}); // saveSyncState

    const result = await syncHubSpot(mockClient, mockPool as any, ['contacts'], { requireContactActivity: false });
    expect(result.contacts).toBe(1); // not filtered
    expect(result.skipped).toBe(0);
  });

  it('skips companies with no associated contacts or deals', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '201', properties: { name: 'Active Corp', num_associated_deals: '2' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
        { id: '202', properties: { name: 'Stale Corp' }, createdAt: '2019-01-01', updatedAt: '2019-01-01' },
        { id: '203', properties: { name: 'Empty Corp', num_associated_contacts: '0', num_associated_deals: '0' }, createdAt: '2020-01-01', updatedAt: '2020-01-01' },
      ],
      paging: undefined,
    });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 }); // queue insert for Active Corp only
    mockPool.query.mockResolvedValueOnce({}); // saveSyncState

    const result = await syncHubSpot(mockClient, mockPool as any, ['companies']);
    expect(result.companies).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('does not filter deals', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    (listObjects as any).mockResolvedValueOnce({
      results: [
        { id: '301', properties: { dealname: 'Some Deal', amount: '5000' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' },
      ],
      paging: undefined,
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 }); // queue insert
    mockPool.query.mockResolvedValueOnce({}); // saveSyncState

    const result = await syncHubSpot(mockClient, mockPool as any, ['deals']);
    expect(result.deals).toBe(1);
  });

  it('cross-references Fathom-link notes with existing Fathom thoughts', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    // Note that is a Fathom link
    (listObjects as any).mockResolvedValueOnce({
      results: [
        {
          id: 'note-99',
          properties: { hs_note_body: 'https://fathom.video/calls/12345', hubspot_owner_id: null },
          createdAt: '2026-01-01', updatedAt: '2026-03-01',
        },
      ],
      paging: undefined,
    });

    // Resolve note associations
    (getAssociations as any)
      .mockResolvedValueOnce(['c1']) // contacts
      .mockResolvedValueOnce(['co1']); // companies
    (getObject as any)
      .mockResolvedValueOnce({ id: 'c1', properties: { firstname: 'Alice', lastname: 'Smith' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' })
      .mockResolvedValueOnce({ id: 'co1', properties: { name: 'Acme Corp' }, createdAt: '2026-01-01', updatedAt: '2026-03-01' });

    // crossReferenceFathom: find existing Fathom thought
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'thought-abc', source_meta: { recording_id: 12345, title: 'Product Call' } }],
    });
    // crossReferenceFathom: update source_meta
    mockPool.query.mockResolvedValueOnce({});

    // saveSyncState
    mockPool.query.mockResolvedValueOnce({});

    const result = await syncHubSpot(mockClient, mockPool as any, ['notes']);
    expect(result.notes).toBe(0); // not enqueued
    expect(result.fathomLinked).toBe(1);
    expect(result.skipped).toBe(1); // still counted as skipped from queue perspective

    // Verify the UPDATE query was called with hubspot_crm data
    const updateCall = mockPool.query.mock.calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('UPDATE thoughts SET source_meta'),
    );
    expect(updateCall).toBeDefined();
    const updatedMeta = JSON.parse(updateCall![1][0]);
    expect(updatedMeta.hubspot_crm.people).toEqual(['Alice Smith']);
    expect(updatedMeta.hubspot_crm.companies).toEqual(['Acme Corp']);
    expect(updatedMeta.hubspot_crm.note_id).toBe('note-99');
    expect(updatedMeta.recording_id).toBe(12345); // original meta preserved
  });

  it('skips cross-reference when Fathom thought not found', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ last_synced_at: null, contacts_after: null, companies_after: null, deals_after: null }],
    });

    (listObjects as any).mockResolvedValueOnce({
      results: [
        {
          id: 'note-88',
          properties: { hs_note_body: 'https://fathom.video/calls/99999', hubspot_owner_id: null },
          createdAt: '2026-01-01', updatedAt: '2026-03-01',
        },
      ],
      paging: undefined,
    });

    (getAssociations as any).mockResolvedValue([]);

    // crossReferenceFathom: no matching thought
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // saveSyncState
    mockPool.query.mockResolvedValueOnce({});

    const result = await syncHubSpot(mockClient, mockPool as any, ['notes']);
    expect(result.fathomLinked).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe('crossReferenceFathom', () => {
  it('updates source_meta with HubSpot associations', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 'th-1', source_meta: { recording_id: 123, title: 'Call' } }],
      })
      .mockResolvedValueOnce({}); // UPDATE

    const linked = await crossReferenceFathom(
      mockPool as any, '123', 'hs-note-1',
      { people: ['Bob'], companies: ['Widgets Inc'] },
    );

    expect(linked).toBe(true);
    const updateCall = mockPool.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE thoughts SET source_meta');
    const meta = JSON.parse(updateCall[1][0]);
    expect(meta.recording_id).toBe(123);
    expect(meta.hubspot_crm.note_id).toBe('hs-note-1');
    expect(meta.hubspot_crm.people).toEqual(['Bob']);
    expect(meta.hubspot_crm.companies).toEqual(['Widgets Inc']);
    expect(meta.hubspot_crm.linked_at).toBeDefined();
  });

  it('returns false when no Fathom thought exists', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const linked = await crossReferenceFathom(
      mockPool as any, '999', 'hs-note-2',
      { people: [], companies: [] },
    );

    expect(linked).toBe(false);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // only the SELECT, no UPDATE
  });

  it('handles null source_meta gracefully', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'th-2', source_meta: null }] })
      .mockResolvedValueOnce({});

    const linked = await crossReferenceFathom(
      mockPool as any, '456', 'hs-note-3',
      { people: ['Alice'], companies: [] },
    );

    expect(linked).toBe(true);
    const meta = JSON.parse(mockPool.query.mock.calls[1][1][0]);
    expect(meta.hubspot_crm.people).toEqual(['Alice']);
  });
});
