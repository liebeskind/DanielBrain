import type pg from 'pg';
import type { ThoughtMetadata, EntityType, EntityRelationshipType, StructuredData, ParticipantIdentity } from '@danielbrain/shared';
import { shouldCreateProposal, createLinkProposal } from '../proposals/helpers.js';
import { createCooccurrenceEdges } from './relationship-builder.js';

interface ResolverConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
}

const NAME_PREFIXES = /^(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)\s+/i;
const COMPANY_SUFFIXES = /\s+(inc\.?|llc\.?|ltd\.?|co\.?|corp\.?|gmbh|plc|s\.?a\.?)$/i;
const PARENTHETICALS = /\s*\([^)]*\)\s*/g;
const DOMAIN_SUFFIXES = /\.(io|com|org|net|co|earth|ai|dev|app|xyz|tech)$/i;
const PRONOUN_SUFFIXES = /\s+(he\/him(\/his)?|she\/her(\/hers)?|they\/them(\/theirs)?|ze\/hir|xe\/xem)$/i;

const JUNK_BLOCKLIST = new Set([
  'you', 'me', 'we', 'they', 'i', 'he', 'she', 'it',
  'someone', 'everyone', 'anyone', 'nobody',
  'the speaker', 'not specified', 'unknown', 'n/a', 'none',
  'null', 'undefined', 'your_name', 'the team', 'attendees',
  'the audience', 'participants', 'the user', 'the host',
]);

const JUNK_PATTERNS = [
  /^[^a-zA-Z]*$/,              // no alphabetic chars (e.g., `>{`, `],`)
  /^(a|an|the)\s+/i,           // starts with article
  /attendees$/i,               // ends with "attendees"
  /^(curl|wget|npm|git|docker|ssh|sudo|pip)\b/i, // CLI commands
  /^[^\s]+@[^\s]+\.[^\s]+$/,   // email addresses (user@domain.tld)
  /^phase\s+\d+/i,            // build phases (e.g., "Phase 4")
  /\b(of|for|between|with)\b/i, // prepositions indicate descriptions, not proper names
  /^https?:\/\//i,             // URLs
  /\b(integration|planning|experiment|strategy|solution|setup|presentation)\b/i, // activity/task words
  /\b(one-pager|case studies|followups?)\b/i, // deliverables, not project names
];

// Names above this length are almost always descriptions, not proper names
const MAX_ENTITY_NAME_LENGTH = 40;

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(PARENTHETICALS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(NAME_PREFIXES, '')
    .replace(COMPANY_SUFFIXES, '')
    .replace(DOMAIN_SUFFIXES, '')
    .replace(PRONOUN_SUFFIXES, '')
    .trim();
}

// Patterns checked against raw (pre-normalization) input
const RAW_JUNK_PATTERNS = [
  /^[^\s]+@[^\s]+\.[^\s]+$/,   // email addresses (user@domain.tld)
];

export function isJunkEntity(name: string): boolean {
  const trimmed = name.trim();
  if (RAW_JUNK_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;

  const normalized = normalizeName(name);
  if (normalized.length < 2 || normalized.length > MAX_ENTITY_NAME_LENGTH) return true;
  if (JUNK_BLOCKLIST.has(normalized)) return true;
  return JUNK_PATTERNS.some((pattern) => pattern.test(normalized));
}

interface EntityMatch {
  id: string;
  name: string;
  entity_type: EntityType;
  match_type: 'canonical' | 'alias' | 'prefix' | 'new';
  confidence: number;
}

export async function findOrCreateEntity(
  name: string,
  entityType: EntityType,
  pool: pg.Pool,
): Promise<EntityMatch> {
  const canonical = normalizeName(name);

  // Try exact canonical match
  const { rows: exactRows } = await pool.query(
    `SELECT id, name, entity_type FROM entities
     WHERE canonical_name = $1 AND entity_type = $2
     LIMIT 1`,
    [canonical, entityType]
  );

  if (exactRows.length > 0) {
    return {
      id: exactRows[0].id,
      name: exactRows[0].name,
      entity_type: exactRows[0].entity_type,
      match_type: 'canonical',
      confidence: 1.0,
    };
  }

  // Try alias match
  const { rows: aliasRows } = await pool.query(
    `SELECT id, name, entity_type FROM entities
     WHERE $1 = ANY(aliases) AND entity_type = $2
     LIMIT 1`,
    [canonical, entityType]
  );

  if (aliasRows.length > 0) {
    return {
      id: aliasRows[0].id,
      name: aliasRows[0].name,
      entity_type: aliasRows[0].entity_type,
      match_type: 'alias',
      confidence: 0.9,
    };
  }

  // Try first-name prefix match (person type only, single-token input)
  if (entityType === 'person' && !canonical.includes(' ')) {
    const { rows: prefixRows } = await pool.query(
      `SELECT id, name, entity_type FROM entities
       WHERE canonical_name LIKE $1 || ' %' AND entity_type = 'person'
       ORDER BY mention_count DESC
       LIMIT 1`,
      [canonical]
    );

    if (prefixRows.length > 0) {
      // Auto-add first name as alias for future lookups
      await addAlias(prefixRows[0].id, canonical, pool);
      return {
        id: prefixRows[0].id,
        name: prefixRows[0].name,
        entity_type: prefixRows[0].entity_type,
        match_type: 'prefix',
        confidence: 0.7,
      };
    }
  }

  // Create new entity — use ON CONFLICT to handle races
  const { rows: newRows } = await pool.query(
    `INSERT INTO entities (name, entity_type, canonical_name, aliases)
     VALUES ($1, $2, $3, ARRAY[$3])
     ON CONFLICT (canonical_name, entity_type) DO UPDATE SET
       last_seen_at = NOW()
     RETURNING id, name, entity_type`,
    [name, entityType, canonical]
  );

  return {
    id: newRows[0].id,
    name: newRows[0].name,
    entity_type: newRows[0].entity_type,
    match_type: 'new',
    confidence: 1.0,
  };
}

export function inferRelationship(
  entityName: string,
  metadata: ThoughtMetadata,
  content: string,
  sourceMeta?: Record<string, unknown> | null,
): EntityRelationshipType {
  // Check if this person is the message author
  if (sourceMeta) {
    const authorName = (sourceMeta.user_name as string) || (sourceMeta.from as string) || '';
    if (authorName && normalizeName(authorName) === normalizeName(entityName)) {
      return 'from';
    }
  }

  // Check if entity appears in an action item
  const normalizedEntity = normalizeName(entityName);
  const inActionItem = metadata.action_items.some(
    (item) => item.toLowerCase().includes(normalizedEntity)
  );
  if (inActionItem) {
    return 'assigned_to';
  }

  // Check if entity is dominant in summary (mentioned in summary = about)
  if (metadata.summary && metadata.summary.toLowerCase().includes(normalizedEntity)) {
    return 'about';
  }

  return 'mentions';
}

async function addAlias(
  entityId: string,
  alias: string,
  pool: pg.Pool,
): Promise<void> {
  await pool.query(
    `UPDATE entities SET aliases = array_append(aliases, $1)
     WHERE id = $2 AND NOT ($1 = ANY(aliases))`,
    [alias, entityId]
  );
}

async function linkEntity(
  thoughtId: string,
  entityId: string,
  relationship: EntityRelationshipType,
  confidence: number,
  pool: pg.Pool,
): Promise<void> {
  await pool.query(
    `INSERT INTO thought_entities (thought_id, entity_id, relationship, confidence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (thought_id, entity_id, relationship) DO NOTHING`,
    [thoughtId, entityId, relationship, confidence]
  );

  // Bump mention count and last_seen_at
  await pool.query(
    `UPDATE entities SET mention_count = mention_count + 1, last_seen_at = NOW()
     WHERE id = $1`,
    [entityId]
  );
}

async function storeEmailOnEntity(
  entityId: string,
  email: string,
  pool: pg.Pool,
): Promise<void> {
  await pool.query(
    `UPDATE entities SET metadata = jsonb_set(
       COALESCE(metadata, '{}'::jsonb),
       '{email}',
       $1::jsonb
     )
     WHERE id = $2 AND (metadata->>'email') IS NULL`,
    [JSON.stringify(email), entityId]
  );
}

/**
 * Resolve structured participants (from source envelope) before LLM resolution.
 * Returns a Set of normalized names that were already resolved.
 */
export async function resolveStructuredParticipants(
  thoughtId: string,
  structured: StructuredData,
  metadata: ThoughtMetadata,
  content: string,
  pool: pg.Pool,
  sourceMeta?: Record<string, unknown> | null,
): Promise<{ resolvedNames: Set<string>; resolvedEntityIds: string[] }> {
  const resolvedNames = new Set<string>();
  const resolvedEntityIds: string[] = [];

  // Resolve participants (people)
  if (structured.participants?.length) {
    for (const p of structured.participants) {
      if (isJunkEntity(p.name)) continue;
      const match = await findOrCreateEntity(p.name, 'person', pool);
      const relationship: EntityRelationshipType = p.role === 'author' ? 'from' : p.role === 'recorder' ? 'from' : 'mentions';
      await linkEntity(thoughtId, match.id, relationship, 1.0, pool);

      if (p.email) {
        await storeEmailOnEntity(match.id, p.email, pool);
      }

      resolvedNames.add(normalizeName(p.name));
      resolvedEntityIds.push(match.id);
    }
  }

  // Resolve structured companies
  if (structured.companies?.length) {
    for (const c of structured.companies) {
      if (isJunkEntity(c.name)) continue;
      const match = await findOrCreateEntity(c.name, 'company', pool);
      await linkEntity(thoughtId, match.id, 'mentions', 1.0, pool);
      resolvedNames.add(normalizeName(c.name));
      resolvedEntityIds.push(match.id);
    }
  }

  return { resolvedNames, resolvedEntityIds };
}

export async function resolveEntities(
  thoughtId: string,
  metadata: ThoughtMetadata,
  content: string,
  pool: pg.Pool,
  _config: ResolverConfig,
  sourceMeta?: Record<string, unknown> | null,
): Promise<void> {
  // Phase B: resolve structured participants first
  let alreadyResolved = new Set<string>();
  const allEntityIds: string[] = [];
  if (sourceMeta?.structured) {
    try {
      const result = await resolveStructuredParticipants(
        thoughtId,
        sourceMeta.structured as StructuredData,
        metadata,
        content,
        pool,
        sourceMeta,
      );
      alreadyResolved = result.resolvedNames;
      allEntityIds.push(...result.resolvedEntityIds);
    } catch (err) {
      console.error('Structured participant resolution failed (non-fatal):', err);
    }
  }

  // Collect all entities to resolve: people, companies, products, projects, topics
  const entityEntries: Array<{ name: string; type: EntityType }> = [];

  for (const person of metadata.people) {
    entityEntries.push({ name: person, type: 'person' });
  }
  for (const company of metadata.companies) {
    entityEntries.push({ name: company, type: 'company' });
  }
  for (const product of metadata.products) {
    entityEntries.push({ name: product, type: 'product' });
  }
  for (const project of metadata.projects) {
    entityEntries.push({ name: project, type: 'project' });
  }

  for (const entry of entityEntries) {
    if (isJunkEntity(entry.name)) continue;

    // Skip names already resolved via structured data
    if (alreadyResolved.has(normalizeName(entry.name))) continue;

    const match = await findOrCreateEntity(entry.name, entry.type, pool);
    const relationship = inferRelationship(entry.name, metadata, content, sourceMeta);
    await linkEntity(thoughtId, match.id, relationship, match.confidence, pool);
    allEntityIds.push(match.id);

    // Create proposal for low-confidence links (e.g., prefix matches)
    if (shouldCreateProposal(match.confidence, 'entity_link')) {
      try {
        await createLinkProposal({
          thoughtId,
          entityId: match.id,
          entityName: entry.name,
          matchedName: match.name,
          matchType: match.match_type,
          relationship,
          confidence: match.confidence,
          aliasAdded: match.match_type === 'prefix' ? normalizeName(entry.name) : undefined,
        }, pool);
      } catch (err) {
        // Non-blocking — proposal creation should never prevent entity resolution
        console.error('Failed to create link proposal:', err);
      }
    }
  }

  // Create co-occurrence edges between all resolved entities (non-blocking)
  if (allEntityIds.length >= 2) {
    try {
      await createCooccurrenceEdges(thoughtId, allEntityIds, pool);
    } catch (err) {
      console.error('Co-occurrence edge creation failed (non-fatal):', err);
    }
  }
}
