import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleHubSpotEvents } from '../../src/hubspot/webhook.js';

vi.mock('../../src/hubspot/client.js', () => ({
  getObject: vi.fn(),
  getAssociations: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { getObject, getAssociations } from '../../src/hubspot/client.js';

const mockPool = {
  query: vi.fn(),
};

const mockClient = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleHubSpotEvents', () => {
  it('processes a contact creation event', async () => {
    (getObject as any).mockResolvedValue({
      id: '101',
      properties: { firstname: 'Alice', lastname: 'Smith', email: 'alice@acme.com', num_associated_deals: '1' },
      createdAt: '2026-01-01',
      updatedAt: '2026-03-01',
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const events = [{
      objectId: 101,
      objectTypeId: '0-1', // contact
      subscriptionType: 'contact.creation',
      eventId: 1,
      portalId: 12345,
      occurredAt: Date.now(),
    }];

    const result = await handleHubSpotEvents(events, mockPool as any, mockClient);

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO queue');
    expect(insertCall[1][1]).toBe('hubspot');
    expect(insertCall[1][2]).toBe('hubspot-contact-101');
  });

  it('processes a company update event', async () => {
    (getObject as any).mockResolvedValue({
      id: '201',
      properties: { name: 'Acme Corp', domain: 'acme.com' },
      createdAt: '2026-01-01',
      updatedAt: '2026-03-01',
    });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const events = [{
      objectId: 201,
      objectTypeId: '0-2', // company
      subscriptionType: 'company.propertyChange',
      eventId: 2,
      portalId: 12345,
      occurredAt: Date.now(),
    }];

    const result = await handleHubSpotEvents(events, mockPool as any, mockClient);
    expect(result.processed).toBe(1);

    const insertCall = mockPool.query.mock.calls[0];
    expect(insertCall[1][2]).toBe('hubspot-company-201');
  });

  it('deduplicates multiple events for same object', async () => {
    (getObject as any).mockResolvedValue({
      id: '101',
      properties: { firstname: 'Alice', lastname: 'Smith', num_associated_deals: '2' },
      createdAt: '2026-01-01',
      updatedAt: '2026-03-01',
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValue({ rowCount: 1 });

    const events = [
      { objectId: 101, objectTypeId: '0-1', subscriptionType: 'contact.creation', eventId: 1, portalId: 12345, occurredAt: Date.now() },
      { objectId: 101, objectTypeId: '0-1', subscriptionType: 'contact.propertyChange', eventId: 2, portalId: 12345, occurredAt: Date.now() },
    ];

    const result = await handleHubSpotEvents(events, mockPool as any, mockClient);
    expect(result.processed).toBe(1); // Only processed once
  });

  it('skips unknown object types', async () => {
    const events = [{
      objectId: 501,
      objectTypeId: '0-99', // unknown
      subscriptionType: 'unknown.creation',
      eventId: 5,
      portalId: 12345,
      occurredAt: Date.now(),
    }];

    const result = await handleHubSpotEvents(events, mockPool as any, mockClient);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('skips deletion events', async () => {
    const events = [{
      objectId: 101,
      objectTypeId: '0-1',
      subscriptionType: 'contact.deletion',
      eventId: 3,
      portalId: 12345,
      occurredAt: Date.now(),
    }];

    const result = await handleHubSpotEvents(events, mockPool as any, mockClient);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('handles API errors gracefully', async () => {
    (getObject as any).mockRejectedValue(new Error('API error'));
    (getAssociations as any).mockResolvedValue([]);

    const events = [{
      objectId: 101,
      objectTypeId: '0-1',
      subscriptionType: 'contact.creation',
      eventId: 1,
      portalId: 12345,
      occurredAt: Date.now(),
    }];

    const result = await handleHubSpotEvents(events, mockPool as any, mockClient);
    expect(result.errors).toBe(1);
    expect(result.processed).toBe(0);
  });

  it('skips inactive contacts via webhook', async () => {
    (getObject as any).mockResolvedValue({
      id: '101',
      properties: { firstname: 'Stale', lastname: 'Import' }, // no activity signals
      createdAt: '2020-01-01',
      updatedAt: '2020-01-01',
    });
    (getAssociations as any).mockResolvedValue([]);

    const events = [{
      objectId: 101,
      objectTypeId: '0-1',
      subscriptionType: 'contact.creation',
      eventId: 1,
      portalId: 12345,
      occurredAt: Date.now(),
    }];

    const result = await handleHubSpotEvents(events, mockPool as any, mockClient);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    // No queue insert should have been called
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('allows inactive contacts via webhook when requireContactActivity is false', async () => {
    (getObject as any).mockResolvedValue({
      id: '101',
      properties: { firstname: 'Stale', lastname: 'Import' }, // no activity signals
      createdAt: '2020-01-01',
      updatedAt: '2020-01-01',
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const events = [{
      objectId: 101,
      objectTypeId: '0-1',
      subscriptionType: 'contact.creation',
      eventId: 1,
      portalId: 12345,
      occurredAt: Date.now(),
    }];

    const result = await handleHubSpotEvents(events, mockPool as any, mockClient, { requireContactActivity: false });
    expect(result.processed).toBe(1);
  });

  it('updates existing queue entries on webhook re-delivery', async () => {
    (getObject as any).mockResolvedValue({
      id: '101',
      properties: { firstname: 'Alice', lastname: 'Updated', num_associated_deals: '2' },
      createdAt: '2026-01-01',
      updatedAt: '2026-03-15',
    });
    (getAssociations as any).mockResolvedValue([]);
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

    const events = [{
      objectId: 101,
      objectTypeId: '0-1',
      subscriptionType: 'contact.propertyChange',
      eventId: 10,
      portalId: 12345,
      occurredAt: Date.now(),
    }];

    await handleHubSpotEvents(events, mockPool as any, mockClient);

    const sql = mockPool.query.mock.calls[0][0];
    // Should use DO UPDATE for webhook re-deliveries
    expect(sql).toContain('DO UPDATE SET');
  });
});
