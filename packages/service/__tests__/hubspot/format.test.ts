import { describe, it, expect } from 'vitest';
import { formatContact, formatCompany, formatDeal, formatNote } from '../../src/hubspot/format.js';
import type { HubSpotRecord } from '../../src/hubspot/types.js';

const baseRecord: HubSpotRecord = {
  id: '101',
  properties: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-03-01T12:00:00Z',
};

describe('formatContact', () => {
  it('formats a full contact record', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      properties: {
        firstname: 'Alice',
        lastname: 'Smith',
        email: 'alice@acme.com',
        jobtitle: 'VP Engineering',
        company: 'Acme Corp',
        lifecyclestage: 'customer',
        hs_lead_status: 'open',
        phone: '+1-555-0100',
      },
    };

    const result = formatContact(record, ['Acme Corp']);

    expect(result.content).toContain('HubSpot Contact: Alice Smith');
    expect(result.content).toContain('Email: alice@acme.com');
    expect(result.content).toContain('Title: VP Engineering');
    expect(result.content).toContain('Company: Acme Corp');
    expect(result.content).toContain('Lifecycle: customer');
    expect(result.content).toContain('Lead Status: open');
    expect(result.content).toContain('Phone: +1-555-0100');

    expect(result.sourceId).toBe('hubspot-contact-101');
    expect(result.sourceMeta.object_type).toBe('contact');
    expect(result.sourceMeta.channel_type).toBe('crm');

    expect(result.directMetadata.people).toEqual(['Alice Smith']);
    expect(result.directMetadata.companies).toEqual(['Acme Corp']);
    expect(result.directMetadata.topics).toEqual(['customer', 'open']);
    expect(result.directMetadata.thought_type).toBe('contact');
  });

  it('uses company property when no associations', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      properties: {
        firstname: 'Bob',
        lastname: null,
        email: null,
        jobtitle: null,
        company: 'Widgets Inc',
        lifecyclestage: null,
        hs_lead_status: null,
        phone: null,
      },
    };

    const result = formatContact(record, []);
    expect(result.content).toContain('HubSpot Contact: Bob');
    expect(result.directMetadata.companies).toEqual(['Widgets Inc']);
  });

  it('handles minimal contact (no names)', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      properties: { firstname: null, lastname: null, email: null },
    };

    const result = formatContact(record);
    expect(result.content).toContain('Contact 101');
    expect(result.directMetadata.people).toEqual(['Contact 101']);
  });

  it('includes structured participants with email', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      properties: {
        firstname: 'Alice',
        lastname: 'Smith',
        email: 'alice@acme.com',
      },
    };

    const result = formatContact(record);
    const structured = result.sourceMeta.structured as any;
    expect(structured.participants).toEqual([
      { name: 'Alice Smith', email: 'alice@acme.com', role: 'participant' },
    ]);
  });
});

describe('formatCompany', () => {
  it('formats a full company record', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      id: '201',
      properties: {
        name: 'Acme Corp',
        domain: 'acme.com',
        industry: 'Technology',
        numberofemployees: '150',
        annualrevenue: '10000000',
      },
    };

    const result = formatCompany(record);

    expect(result.content).toContain('HubSpot Company: Acme Corp');
    expect(result.content).toContain('Domain: acme.com');
    expect(result.content).toContain('Industry: Technology');
    expect(result.content).toContain('Employees: 150');
    expect(result.content).toContain('Revenue: $10,000,000');

    expect(result.sourceId).toBe('hubspot-company-201');
    expect(result.directMetadata.companies).toEqual(['Acme Corp']);
    expect(result.directMetadata.topics).toEqual(['Technology']);
    expect(result.directMetadata.thought_type).toBe('company_profile');
  });

  it('handles minimal company', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      id: '202',
      properties: { name: null },
    };

    const result = formatCompany(record);
    expect(result.content).toContain('Company 202');
  });
});

describe('formatDeal', () => {
  it('formats a deal with associations', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      id: '301',
      properties: {
        dealname: 'Enterprise License',
        pipeline: 'Sales',
        dealstage: 'Contract Sent',
        amount: '50000',
        closedate: '2026-04-15T00:00:00Z',
      },
    };

    const result = formatDeal(record, ['Alice Smith'], ['Acme Corp']);

    expect(result.content).toContain('HubSpot Deal: Enterprise License');
    expect(result.content).toContain('Pipeline: Sales');
    expect(result.content).toContain('Stage: Contract Sent');
    expect(result.content).toContain('Amount: $50,000');
    expect(result.content).toContain('Close Date: 2026-04-15');
    expect(result.content).toContain('Contacts: Alice Smith');
    expect(result.content).toContain('Company: Acme Corp');

    expect(result.sourceId).toBe('hubspot-deal-301');
    expect(result.directMetadata.people).toEqual(['Alice Smith']);
    expect(result.directMetadata.companies).toEqual(['Acme Corp']);
    expect(result.directMetadata.topics).toEqual(['Sales', 'Contract Sent']);
    expect(result.directMetadata.thought_type).toBe('deal');
  });

  it('handles deal without associations', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      id: '302',
      properties: { dealname: 'Starter Plan', pipeline: null, dealstage: null, amount: null, closedate: null },
    };

    const result = formatDeal(record);
    expect(result.content).toContain('HubSpot Deal: Starter Plan');
    expect(result.content).not.toContain('Contacts:');
    expect(result.content).not.toContain('Company:');
  });
});

describe('formatNote', () => {
  it('formats a note with context', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      id: '401',
      properties: {
        hs_note_body: 'Follow up on the pricing discussion.',
        hs_timestamp: '2026-03-15T14:00:00Z',
        hubspot_owner_id: 'owner-1',
      },
    };

    const result = formatNote(record, ['Alice Smith'], ['Acme Corp']);

    expect(result.content).toContain('HubSpot Note on Alice Smith (Acme Corp):');
    expect(result.content).toContain('Follow up on the pricing discussion.');

    expect(result.sourceId).toBe('hubspot-note-401');
    expect(result.sourceMeta.object_type).toBe('note');
    expect(result.sourceMeta.owner_id).toBe('owner-1');

    // Notes have empty directMetadata (needs LLM extraction)
    expect(result.directMetadata).toEqual({});
  });

  it('handles empty note body', () => {
    const record: HubSpotRecord = {
      ...baseRecord,
      id: '402',
      properties: { hs_note_body: null, hs_timestamp: null, hubspot_owner_id: null },
    };

    const result = formatNote(record);
    expect(result.content).toContain('(empty note)');
    expect(result.sourceMeta.owner_id).toBeNull();
  });
});
