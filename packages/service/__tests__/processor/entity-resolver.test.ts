import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeName,
  isJunkEntity,
  findOrCreateEntity,
  inferRelationship,
  resolveEntities,
  resolveStructuredParticipants,
} from '../../src/processor/entity-resolver.js';
import type { ThoughtMetadata } from '@danielbrain/shared';

// Mock proposal helpers
vi.mock('../../src/proposals/helpers.js', () => ({
  shouldCreateProposal: vi.fn().mockReturnValue(false),
  createLinkProposal: vi.fn().mockResolvedValue('proposal-id'),
}));

vi.mock('../../src/processor/relationship-builder.js', () => ({
  createCooccurrenceEdges: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../src/processor/relationship-extractor.js', () => ({
  extractRelationships: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/processor/relationship-applier.js', () => ({
  applyExtractedRelationships: vi.fn().mockResolvedValue(new Set()),
}));

import { shouldCreateProposal, createLinkProposal } from '../../src/proposals/helpers.js';
import { createCooccurrenceEdges } from '../../src/processor/relationship-builder.js';

const mockPool = {
  query: vi.fn(),
};

const mockConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'nomic-embed-text',
};

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  Alice Smith  ')).toBe('alice smith');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeName('Alice   Smith')).toBe('alice smith');
  });

  it('strips name prefixes', () => {
    expect(normalizeName('Dr. Alice Smith')).toBe('alice smith');
    expect(normalizeName('Mr. Bob Jones')).toBe('bob jones');
    expect(normalizeName('Mrs. Carol')).toBe('carol');
    expect(normalizeName('Prof. Dan')).toBe('dan');
  });

  it('strips company suffixes', () => {
    expect(normalizeName('Acme Inc.')).toBe('acme');
    expect(normalizeName('WidgetCo LLC')).toBe('widgetco');
    expect(normalizeName('BigCorp Corp')).toBe('bigcorp');
  });

  it('handles already normalized names', () => {
    expect(normalizeName('alice')).toBe('alice');
  });

  it('strips parenthetical annotations', () => {
    expect(normalizeName('Daniel Liebeskind (Topia)')).toBe('daniel liebeskind');
    expect(normalizeName('Rob Fisher (provocative.earth)')).toBe('rob fisher');
    expect(normalizeName('Chris (he/him/his)')).toBe('chris');
    expect(normalizeName('Sarah (Founder of NEU)')).toBe('sarah');
  });

  it('strips domain suffixes', () => {
    expect(normalizeName('Topia.io')).toBe('topia');
    expect(normalizeName('provocative.earth')).toBe('provocative');
    expect(normalizeName('example.com')).toBe('example');
    expect(normalizeName('startup.ai')).toBe('startup');
  });

  it('strips pronoun suffixes outside parens', () => {
    expect(normalizeName('Chris he/him')).toBe('chris');
    expect(normalizeName('Alex she/her')).toBe('alex');
    expect(normalizeName('Sam they/them')).toBe('sam');
  });

  it('strips expanded company suffixes', () => {
    expect(normalizeName('Siemens GmbH')).toBe('siemens');
    expect(normalizeName('BNP PLC')).toBe('bnp');
    expect(normalizeName('Total S.A.')).toBe('total');
  });

  it('handles multiple transforms at once', () => {
    expect(normalizeName('Dr. Alice Smith (MIT) Inc.')).toBe('alice smith');
  });
});

describe('isJunkEntity', () => {
  it('rejects empty or whitespace-only strings', () => {
    expect(isJunkEntity('')).toBe(true);
    expect(isJunkEntity('  ')).toBe(true);
    expect(isJunkEntity(' ')).toBe(true);
  });

  it('rejects single-character names', () => {
    expect(isJunkEntity('a')).toBe(true);
  });

  it('rejects names over 40 chars', () => {
    expect(isJunkEntity('a'.repeat(41))).toBe(true);
    expect(isJunkEntity('topia virtual school student engagement platform')).toBe(true);
  });

  it('rejects blocklisted words', () => {
    expect(isJunkEntity('You')).toBe(true);
    expect(isJunkEntity('the speaker')).toBe(true);
    expect(isJunkEntity('not specified')).toBe(true);
    expect(isJunkEntity('unknown')).toBe(true);
    expect(isJunkEntity('N/A')).toBe(true);
    expect(isJunkEntity('the team')).toBe(true);
    expect(isJunkEntity('attendees')).toBe(true);
  });

  it('rejects non-alphabetic strings', () => {
    expect(isJunkEntity('>{')).toBe(true);
    expect(isJunkEntity('],')).toBe(true);
    expect(isJunkEntity('123')).toBe(true);
  });

  it('rejects strings starting with articles', () => {
    expect(isJunkEntity('the project')).toBe(true);
    expect(isJunkEntity('a company')).toBe(true);
    expect(isJunkEntity('an idea')).toBe(true);
  });

  it('rejects email addresses', () => {
    expect(isJunkEntity('chris@topia.io')).toBe(true);
    expect(isJunkEntity('gordon.smith@topia.io')).toBe(true);
    expect(isJunkEntity('spark04@wharton.upenn.edu')).toBe(true);
  });

  it('rejects build phase names', () => {
    expect(isJunkEntity('Phase 4')).toBe(true);
    expect(isJunkEntity('phase 1')).toBe(true);
    expect(isJunkEntity('Phase 10')).toBe(true);
  });

  it('rejects CLI commands', () => {
    expect(isJunkEntity('curl')).toBe(true);
    expect(isJunkEntity('wget https://example.com')).toBe(true);
    expect(isJunkEntity('docker compose up')).toBe(true);
  });

  it('rejects descriptions with prepositions', () => {
    expect(isJunkEntity('pilot project with stride')).toBe(true);
    expect(isJunkEntity('sso setup between calops and schoolspace')).toBe(true);
    expect(isJunkEntity('curriculum integration for schools')).toBe(true);
    expect(isJunkEntity('child-to-child interactivity of virtual schools')).toBe(true);
  });

  it('rejects URLs', () => {
    expect(isJunkEntity('https://fathom.video/share/abc123')).toBe(true);
    expect(isJunkEntity('http://example.com/path')).toBe(true);
  });

  it('rejects activity/task descriptions', () => {
    expect(isJunkEntity('canvas integration')).toBe(true);
    expect(isJunkEntity('career fair planning')).toBe(true);
    expect(isJunkEntity('bare-metal experiment')).toBe(true);
    expect(isJunkEntity('personalization strategy')).toBe(true);
    expect(isJunkEntity('classroom solution')).toBe(true);
    expect(isJunkEntity('sso setup')).toBe(true);
    expect(isJunkEntity('brass ring marketing presentation')).toBe(true);
    expect(isJunkEntity('classroom one-pager')).toBe(true);
    expect(isJunkEntity('case studies and logos')).toBe(true);
    expect(isJunkEntity('asu/gsv followups')).toBe(true);
  });

  it('accepts valid entity names', () => {
    expect(isJunkEntity('Daniel Liebeskind')).toBe(false);
    expect(isJunkEntity('Topia')).toBe(false);
    expect(isJunkEntity('GPT-4')).toBe(false);
    expect(isJunkEntity('K12 Zone')).toBe(false);
    expect(isJunkEntity('AWS')).toBe(false);
    expect(isJunkEntity('College Conversations')).toBe(false);
    expect(isJunkEntity('Choose Love Academy')).toBe(false);
    // "of" in the middle — but this is a real org name
    // Illinois Institute of Technology would be rejected by preposition rule
    // That's acceptable: better to miss a few real names than let through junk
  });
});

describe('findOrCreateEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing entity on exact canonical match', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-1', name: 'Alice', entity_type: 'person' }],
    });

    const result = await findOrCreateEntity('Alice', 'person', mockPool as any);

    expect(result.match_type).toBe('canonical');
    expect(result.confidence).toBe(1.0);
    expect(result.id).toBe('entity-1');
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('returns existing entity on alias match', async () => {
    // No canonical match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Alias match
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-2', name: 'Alice Smith', entity_type: 'person' }],
    });

    const result = await findOrCreateEntity('Ali', 'person', mockPool as any);

    expect(result.match_type).toBe('alias');
    expect(result.confidence).toBe(0.9);
    expect(result.id).toBe('entity-2');
  });

  it('creates new entity when no match', async () => {
    // No canonical match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // No alias match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // No prefix match (single token "bob")
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // INSERT
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-new', name: 'Bob', entity_type: 'person' }],
    });

    const result = await findOrCreateEntity('Bob', 'person', mockPool as any);

    expect(result.match_type).toBe('new');
    expect(result.confidence).toBe(1.0);
    expect(result.id).toBe('entity-new');

    // Verify ON CONFLICT clause in INSERT
    const insertCall = mockPool.query.mock.calls[3];
    expect(insertCall[0]).toContain('ON CONFLICT');
  });

  it('matches first name prefix for person entities', async () => {
    // No canonical match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // No alias match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Prefix match: "chris" matches "chris psiaki"
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-chris', name: 'Chris Psiaki', entity_type: 'person' }],
    });
    // addAlias call
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await findOrCreateEntity('Chris', 'person', mockPool as any);

    expect(result.match_type).toBe('prefix');
    expect(result.confidence).toBe(0.7);
    expect(result.id).toBe('entity-chris');
    expect(result.name).toBe('Chris Psiaki');
  });

  it('does not try prefix match for multi-word names', async () => {
    // No canonical match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // No alias match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Should skip prefix and go straight to INSERT
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-new', name: 'Chris Smith', entity_type: 'person' }],
    });

    const result = await findOrCreateEntity('Chris Smith', 'person', mockPool as any);

    expect(result.match_type).toBe('new');
    // Should be 3 queries total: canonical, alias, insert (no prefix)
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  it('does not try prefix match for non-person entities', async () => {
    // No canonical match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // No alias match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Should skip prefix and go straight to INSERT
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-new', name: 'Docker', entity_type: 'product' }],
    });

    const result = await findOrCreateEntity('Docker', 'product', mockPool as any);

    expect(result.match_type).toBe('new');
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });
});

describe('inferRelationship', () => {
  const baseMetadata: ThoughtMetadata = {
    thought_type: 'meeting_note',
    people: ['Alice'],
    topics: ['planning'],
    action_items: [],
    dates_mentioned: [],
    sentiment: 'neutral',
    summary: 'Meeting about planning',
    companies: [],
    products: [],
    projects: [],
    department: null,
    confidentiality: 'internal',
    themes: [],
    key_decisions: [],
    key_insights: [],
    meeting_participants: [],
    action_items_structured: [],
  };

  it('returns "from" when entity matches source author', () => {
    const result = inferRelationship(
      'Alice',
      baseMetadata,
      'Some content',
      { user_name: 'Alice' }
    );
    expect(result).toBe('from');
  });

  it('returns "assigned_to" when entity appears in action items', () => {
    const meta = { ...baseMetadata, action_items: ['Alice should draft the proposal'] };
    const result = inferRelationship('Alice', meta, 'Some content');
    expect(result).toBe('assigned_to');
  });

  it('returns "about" when entity is in summary', () => {
    const meta = { ...baseMetadata, summary: 'Discussion about Alice and her project' };
    const result = inferRelationship('Alice', meta, 'Some content');
    expect(result).toBe('about');
  });

  it('returns "mentions" as default', () => {
    const result = inferRelationship('Bob', baseMetadata, 'Bob said hello');
    expect(result).toBe('mentions');
  });

  it('handles source_meta with "from" field', () => {
    const result = inferRelationship(
      'Alice',
      baseMetadata,
      'Some content',
      { from: 'Alice' }
    );
    expect(result).toBe('from');
  });
});

describe('resolveEntities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves people, companies, products, and projects', async () => {
    // Each findOrCreateEntity: canonical match (1 query) + linkEntity (2 queries)
    mockPool.query
      // Person: Alice — canonical match
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }] })
      // Link Alice
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // Company: Acme — canonical match
      .mockResolvedValueOnce({ rows: [{ id: 'e2', name: 'Acme', entity_type: 'company' }] })
      // Link Acme
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const metadata: ThoughtMetadata = {
      thought_type: 'meeting_note',
      people: ['Alice'],
      topics: ['planning'],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Alice discussed Acme plans',
      companies: ['Acme'],
      products: [],
      projects: [],
      department: null,
      confidentiality: 'internal',
      themes: [],
      key_decisions: [],
      key_insights: [],
      meeting_participants: [],
      action_items_structured: [],
    };

    await resolveEntities(
      'thought-1',
      metadata,
      'Alice discussed Acme plans',
      mockPool as any,
      mockConfig,
    );

    // 2 entities resolved: person + company, each with 3 queries (find + link + bump)
    expect(mockPool.query).toHaveBeenCalledTimes(6);
    // Co-occurrence edges created for 2 entities
    expect(createCooccurrenceEdges).toHaveBeenCalledWith(
      'thought-1',
      expect.arrayContaining(['e1', 'e2']),
      expect.anything(),
      undefined,
    );
  });

  it('skips junk entities during resolution', async () => {
    // Only "Alice" is valid; "You" and ">{"  are junk
    // Alice: canonical match + link + bump
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const metadata: ThoughtMetadata = {
      thought_type: 'conversation',
      people: ['Alice', 'You', '>{'],
      topics: [],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Chat with Alice',
      companies: [],
      products: [],
      projects: [],
      department: null,
      confidentiality: 'internal',
      themes: [],
      key_decisions: [],
      key_insights: [],
      meeting_participants: [],
      action_items_structured: [],
    };

    await resolveEntities(
      'thought-3',
      metadata,
      'Chat with Alice',
      mockPool as any,
      mockConfig,
    );

    // Only 3 queries for Alice (find + link + bump), junk entities skipped
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  it('handles empty metadata gracefully', async () => {
    const metadata: ThoughtMetadata = {
      thought_type: 'observation',
      people: [],
      topics: [],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Just an observation',
      companies: [],
      products: [],
      projects: [],
      department: null,
      confidentiality: 'internal',
      themes: [],
      key_decisions: [],
      key_insights: [],
      meeting_participants: [],
      action_items_structured: [],
    };

    await resolveEntities(
      'thought-2',
      metadata,
      'Just an observation',
      mockPool as any,
      mockConfig,
    );

    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('creates proposal for low-confidence prefix match', async () => {
    (shouldCreateProposal as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Chris: no canonical match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // No alias match
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Prefix match
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-chris', name: 'Chris Psiaki', entity_type: 'person' }],
    });
    // addAlias
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // linkEntity INSERT
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // linkEntity bump
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const metadata: ThoughtMetadata = {
      thought_type: 'conversation',
      people: ['Chris'],
      topics: [],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Chat with Chris',
      companies: [],
      products: [],
      projects: [],
      department: null,
      confidentiality: 'internal',
      themes: [],
      key_decisions: [],
      key_insights: [],
      meeting_participants: [],
      action_items_structured: [],
    };

    await resolveEntities(
      'thought-4',
      metadata,
      'Chat with Chris',
      mockPool as any,
      mockConfig,
    );

    expect(shouldCreateProposal).toHaveBeenCalledWith(0.7, 'entity_link');
    expect(createLinkProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        thoughtId: 'thought-4',
        entityId: 'entity-chris',
        entityName: 'Chris',
        matchedName: 'Chris Psiaki',
        matchType: 'prefix',
        confidence: 0.7,
        aliasAdded: 'chris',
      }),
      expect.anything(),
    );
  });

  it('does not create proposal for high-confidence matches', async () => {
    (shouldCreateProposal as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // Alice: canonical match
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }],
    });
    // linkEntity
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const metadata: ThoughtMetadata = {
      thought_type: 'conversation',
      people: ['Alice'],
      topics: [],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Chat with Alice',
      companies: [],
      products: [],
      projects: [],
      department: null,
      confidentiality: 'internal',
      themes: [],
      key_decisions: [],
      key_insights: [],
      meeting_participants: [],
      action_items_structured: [],
    };

    await resolveEntities(
      'thought-5',
      metadata,
      'Chat with Alice',
      mockPool as any,
      mockConfig,
    );

    expect(createLinkProposal).not.toHaveBeenCalled();
  });

  it('does not fail resolution if proposal creation throws', async () => {
    (shouldCreateProposal as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (createLinkProposal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

    // Chris: prefix match flow
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'entity-chris', name: 'Chris Psiaki', entity_type: 'person' }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // addAlias
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // link
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // bump

    const metadata: ThoughtMetadata = {
      thought_type: 'conversation',
      people: ['Chris'],
      topics: [],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Chat with Chris',
      companies: [],
      products: [],
      projects: [],
      department: null,
      confidentiality: 'internal',
      themes: [],
      key_decisions: [],
      key_insights: [],
      meeting_participants: [],
      action_items_structured: [],
    };

    // Should not throw
    await resolveEntities(
      'thought-6',
      metadata,
      'Chat with Chris',
      mockPool as any,
      mockConfig,
    );

    // Entity was still linked despite proposal failure
    expect(mockPool.query).toHaveBeenCalledTimes(6);
  });

  it('resolves structured participants before LLM entities and skips duplicates', async () => {
    // Structured participant: Alice (canonical match + link + bump + storeEmail)
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice Smith', entity_type: 'person' }] }) // find Alice
      .mockResolvedValueOnce({ rows: [] }) // link
      .mockResolvedValueOnce({ rows: [] }) // bump
      .mockResolvedValueOnce({ rows: [] }); // storeEmail

    // LLM resolution: Alice is skipped (already resolved), Bob gets resolved
    // Bob: canonical match + link + bump
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e2', name: 'Bob', entity_type: 'person' }] }) // find Bob
      .mockResolvedValueOnce({ rows: [] }) // link
      .mockResolvedValueOnce({ rows: [] }); // bump

    const metadata: ThoughtMetadata = {
      thought_type: 'meeting_note',
      people: ['Alice Smith', 'Bob'],
      topics: [],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Meeting notes',
      companies: [],
      products: [],
      projects: [],
      department: null,
      confidentiality: 'internal',
      themes: [],
      key_decisions: [],
      key_insights: [],
      meeting_participants: [],
      action_items_structured: [],
    };

    const sourceMeta = {
      structured: {
        participants: [
          { name: 'Alice Smith', email: 'alice@co.com', role: 'recorder' },
        ],
      },
    };

    await resolveEntities(
      'thought-7',
      metadata,
      'Meeting content',
      mockPool as any,
      mockConfig,
      sourceMeta,
    );

    // 4 queries for structured Alice (find + link + bump + email) + 3 for LLM Bob = 7
    expect(mockPool.query).toHaveBeenCalledTimes(7);
    // Co-occurrence edges created for structured Alice + LLM Bob
    expect(createCooccurrenceEdges).toHaveBeenCalledWith(
      'thought-7',
      expect.arrayContaining(['e1', 'e2']),
      expect.anything(),
      undefined,
    );

    // Verify email was stored
    const emailCall = mockPool.query.mock.calls[3];
    expect(emailCall[0]).toContain('email');
    expect(emailCall[1][0]).toContain('alice@co.com');
  });

  it('resolves structured companies from CRM at confidence 1.0', async () => {
    // Structured company: Acme (canonical match + link + bump)
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Acme Corp', entity_type: 'company' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const metadata: ThoughtMetadata = {
      thought_type: 'meeting_note',
      people: [],
      topics: [],
      action_items: [],
      dates_mentioned: [],
      sentiment: 'neutral',
      summary: 'Meeting notes',
      companies: ['Acme Corp'], // LLM also found it — should skip
      products: [],
      projects: [],
      department: null,
      confidentiality: 'internal',
      themes: [],
      key_decisions: [],
      key_insights: [],
      meeting_participants: [],
      action_items_structured: [],
    };

    const sourceMeta = {
      structured: {
        companies: [
          { name: 'Acme Corp', record_url: 'https://crm.example.com/companies/1' },
        ],
      },
    };

    await resolveEntities(
      'thought-8',
      metadata,
      'Meeting about Acme',
      mockPool as any,
      mockConfig,
      sourceMeta,
    );

    // 3 queries for structured Acme only, LLM duplicate skipped
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });
});

describe('resolveStructuredParticipants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMetadata: ThoughtMetadata = {
    thought_type: 'meeting_note',
    people: [],
    topics: [],
    action_items: [],
    dates_mentioned: [],
    sentiment: 'neutral',
    summary: 'Meeting notes',
    companies: [],
    products: [],
    projects: [],
    department: null,
    confidentiality: 'internal',
    themes: [],
    key_decisions: [],
    key_insights: [],
    meeting_participants: [],
    action_items_structured: [],
  };

  it('returns set of resolved normalized names', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const resolved = await resolveStructuredParticipants(
      'thought-1',
      { participants: [{ name: 'Alice', role: 'participant' }] },
      baseMetadata,
      'content',
      mockPool as any,
    );

    expect(resolved.resolvedNames.has('alice')).toBe(true);
    expect(resolved.resolvedEntityIds).toContain('e1');
  });

  it('stores email on entity when provided', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }] })
      .mockResolvedValueOnce({ rows: [] }) // link
      .mockResolvedValueOnce({ rows: [] }) // bump
      .mockResolvedValueOnce({ rows: [] }); // storeEmail

    await resolveStructuredParticipants(
      'thought-1',
      { participants: [{ name: 'Alice', email: 'alice@co.com', role: 'participant' }] },
      baseMetadata,
      'content',
      mockPool as any,
    );

    // 4th call is storeEmail
    const emailCall = mockPool.query.mock.calls[3];
    expect(emailCall[0]).toContain('email');
  });

  it('uses "from" relationship for author/recorder roles', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'e1', name: 'Alice', entity_type: 'person' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveStructuredParticipants(
      'thought-1',
      { participants: [{ name: 'Alice', role: 'recorder' }] },
      baseMetadata,
      'content',
      mockPool as any,
    );

    // linkEntity call — check relationship param
    const linkCall = mockPool.query.mock.calls[1];
    expect(linkCall[1][2]).toBe('from');
  });

  it('skips junk participants', async () => {
    await resolveStructuredParticipants(
      'thought-1',
      { participants: [{ name: 'You', role: 'participant' }] },
      baseMetadata,
      'content',
      mockPool as any,
    );

    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
