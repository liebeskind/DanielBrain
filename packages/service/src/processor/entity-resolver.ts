import type pg from 'pg';
import type { ThoughtMetadata, EntityType, EntityRelationshipType, StructuredData, ParticipantIdentity } from '@danielbrain/shared';
import { shouldCreateProposal, createLinkProposal } from '../proposals/helpers.js';
import { createCooccurrenceEdges } from './relationship-builder.js';
import { extractRelationships } from './relationship-extractor.js';
import { applyExtractedRelationships } from './relationship-applier.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('entity-resolver');

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
  'enrich', 'enrich enrich',     // LinkedIn enricher metadata leak
  'metaverse',                   // CRM catchall for Topia leads without a real company
  'liz topia',                   // Fake contact (last name = product name)
  'gmail', 'gmail.com', 'yahoo', 'yahoo.com', 'hotmail', 'hotmail.com',
  'outlook', 'outlook.com', 'aol', 'aol.com', 'icloud', 'icloud.com',
  'protonmail', 'protonmail.com', 'mail', // email providers as companies
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
  /\bcampaign\b/i,              // HubSpot campaign names (e.g., "DLAC Call Only Campaign")
  /\b(list|copy|sequence)\b.*\b(list|copy|sequence)\b/i, // marketing list names (e.g., "Handpicked VS Leader List Copy")
  /\b(call only|outreach|nurture|drip|blast|follow-?up email)\b/i, // marketing automation names
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
  match_type: 'canonical' | 'alias' | 'prefix' | 'new' | 'linkedin' | 'email' | 'graph_context';
  confidence: number;
}

interface FindEntityOptions {
  email?: string;
  linkedinUrl?: string;
  /** Entity IDs already resolved from the same thought — used for graph-contextual matching */
  contextEntityIds?: string[];
}

export async function findOrCreateEntity(
  name: string,
  entityType: EntityType,
  pool: pg.Pool,
  thoughtDate?: Date,
  options?: FindEntityOptions,
): Promise<EntityMatch> {
  const canonical = normalizeName(name);

  // Step 0: LinkedIn URL match (most stable identifier — survives job changes)
  if (options?.linkedinUrl && entityType === 'person') {
    const { rows: linkedinRows } = await pool.query(
      `SELECT id, name, entity_type FROM entities
       WHERE metadata->>'linkedin_url' = $1 AND entity_type = 'person'
       LIMIT 1`,
      [options.linkedinUrl]
    );

    if (linkedinRows.length > 0) {
      // Add name as alias if different from canonical
      const existingCanonical = normalizeName(linkedinRows[0].name);
      if (existingCanonical !== canonical) {
        await addAlias(linkedinRows[0].id, canonical, pool);
      }
      return {
        id: linkedinRows[0].id,
        name: linkedinRows[0].name,
        entity_type: linkedinRows[0].entity_type,
        match_type: 'linkedin',
        confidence: 1.0,
      };
    }
  }

  // Step 1: Email match (strong but not absolute — emails can go stale on job changes)
  if (options?.email && entityType === 'person') {
    const { rows: emailRows } = await pool.query(
      `SELECT id, name, entity_type FROM entities
       WHERE (metadata->>'email' = $1 OR metadata->'emails' ? $1) AND entity_type = 'person'
       LIMIT 1`,
      [options.email]
    );

    if (emailRows.length > 0) {
      const existingCanonical = normalizeName(emailRows[0].name);
      if (existingCanonical !== canonical) {
        await addAlias(emailRows[0].id, canonical, pool);
      }
      return {
        id: emailRows[0].id,
        name: emailRows[0].name,
        entity_type: emailRows[0].entity_type,
        match_type: 'email',
        confidence: 0.95,
      };
    }
  }

  // Step 2: Exact canonical match
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

  // Step 3: Alias match
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

  // Step 4: Graph-contextual neighbor matching (persons only, needs context entities)
  if (entityType === 'person' && options?.contextEntityIds?.length) {
    const graphMatch = await findByGraphContext(canonical, options.contextEntityIds, pool);
    if (graphMatch) {
      await addAlias(graphMatch.id, canonical, pool);
      return {
        id: graphMatch.id,
        name: graphMatch.name,
        entity_type: graphMatch.entity_type,
        match_type: 'graph_context',
        confidence: 0.85,
      };
    }
  }

  // Step 5: First-name prefix match (person type only, single-token input)
  if (entityType === 'person' && !canonical.includes(' ')) {
    const { rows: prefixRows } = await pool.query(
      `SELECT id, name, entity_type FROM entities
       WHERE canonical_name LIKE $1 || ' %' AND entity_type = 'person'
       ORDER BY mention_count DESC
       LIMIT 1`,
      [canonical]
    );

    if (prefixRows.length > 0) {
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

  // Step 6: Create new entity — use ON CONFLICT to handle races
  const { rows: newRows } = await pool.query(
    `INSERT INTO entities (name, entity_type, canonical_name, aliases)
     VALUES ($1, $2, $3, ARRAY[$3])
     ON CONFLICT (canonical_name, entity_type) DO UPDATE SET
       last_seen_at = GREATEST(entities.last_seen_at, COALESCE($4, NOW()))
     RETURNING id, name, entity_type`,
    [name, entityType, canonical, thoughtDate ?? null]
  );

  return {
    id: newRows[0].id,
    name: newRows[0].name,
    entity_type: newRows[0].entity_type,
    match_type: 'new',
    confidence: 1.0,
  };
}

/**
 * Graph-contextual neighbor matching: find a person entity that shares
 * co-occurrence edges with the context entities from the same thought.
 * Requires >= 2 shared neighbors for a match.
 */
async function findByGraphContext(
  canonicalName: string,
  contextEntityIds: string[],
  pool: pg.Pool,
): Promise<{ id: string; name: string; entity_type: EntityType } | null> {
  if (contextEntityIds.length === 0) return null;

  // Find person entities whose canonical name starts with this name (prefix candidates)
  const prefix = canonicalName.includes(' ') ? canonicalName : canonicalName + ' ';
  const { rows: candidates } = await pool.query(
    `SELECT id, name, entity_type FROM entities
     WHERE (canonical_name LIKE $1 || '%' OR $2 = ANY(aliases))
       AND entity_type = 'person'
     LIMIT 10`,
    [prefix, canonicalName]
  );

  if (candidates.length === 0) return null;

  // For each candidate, count shared co-occurrence edges with context entities
  let bestCandidate: typeof candidates[0] | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(DISTINCT CASE
         WHEN source_id = $1 THEN target_id
         WHEN target_id = $1 THEN source_id
       END) as count
       FROM entity_relationships
       WHERE (source_id = $1 OR target_id = $1)
         AND (source_id = ANY($2) OR target_id = ANY($2))`,
      [candidate.id, contextEntityIds]
    );

    const score = Number(count);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  // Require >= 2 shared neighbors for a match
  return bestScore >= 2 ? bestCandidate : null;
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
  thoughtDate?: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO thought_entities (thought_id, entity_id, relationship, confidence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (thought_id, entity_id, relationship) DO NOTHING`,
    [thoughtId, entityId, relationship, confidence]
  );

  // Bump mention count and last_seen_at (only move forward, never backward)
  await pool.query(
    `UPDATE entities SET mention_count = mention_count + 1,
       last_seen_at = GREATEST(last_seen_at, COALESCE($2, NOW()))
     WHERE id = $1`,
    [entityId, thoughtDate ?? null]
  );
}

async function storeEmailOnEntity(
  entityId: string,
  email: string,
  pool: pg.Pool,
): Promise<void> {
  // Store in both legacy 'email' field (for backward compat) and 'emails' array
  await pool.query(
    `UPDATE entities SET metadata = jsonb_set(
       jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{email}',
         COALESCE(metadata->'email', $1::jsonb)
       ),
       '{emails}',
       CASE
         WHEN metadata->'emails' IS NULL THEN jsonb_build_array($1::jsonb)
         WHEN NOT (metadata->'emails' ? $2) THEN metadata->'emails' || jsonb_build_array($1::jsonb)
         ELSE metadata->'emails'
       END
     )
     WHERE id = $3`,
    [JSON.stringify(email), email, entityId]
  );
}

/**
 * Create a typed entity-to-entity edge (e.g., works_at, deal_with, involves).
 * Uses canonical direction (smaller UUID = source_id) and ON CONFLICT to upsert.
 */
async function createTypedEdge(
  entityIdA: string,
  entityIdB: string,
  relationship: string,
  thoughtId: string,
  pool: pg.Pool,
): Promise<void> {
  const [sourceId, targetId] = entityIdA < entityIdB
    ? [entityIdA, entityIdB]
    : [entityIdB, entityIdA];

  await pool.query(
    `INSERT INTO entity_relationships (source_id, target_id, relationship, source_thought_ids, weight, is_explicit, metadata)
     VALUES ($1, $2, $3, ARRAY[$4::uuid], 2, TRUE, '{"source": "hubspot_association"}'::jsonb)
     ON CONFLICT (source_id, target_id, relationship) DO UPDATE SET
       weight = GREATEST(entity_relationships.weight, 2),
       is_explicit = TRUE,
       last_seen_at = NOW(),
       source_thought_ids = CASE
         WHEN $4::uuid = ANY(entity_relationships.source_thought_ids) THEN entity_relationships.source_thought_ids
         ELSE array_append(entity_relationships.source_thought_ids, $4::uuid)
       END`,
    [sourceId, targetId, relationship, thoughtId]
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
  thoughtDate?: Date,
): Promise<{ resolvedNames: Set<string>; resolvedEntityIds: string[] }> {
  const resolvedNames = new Set<string>();
  const resolvedEntityIds: string[] = [];

  // Resolve participants (people) — use email for matching when available
  if (structured.participants?.length) {
    for (const p of structured.participants) {
      if (isJunkEntity(p.name)) continue;
      const match = await findOrCreateEntity(p.name, 'person', pool, thoughtDate, {
        email: p.email,
        contextEntityIds: resolvedEntityIds,
      });
      const relationship: EntityRelationshipType = p.role === 'author' ? 'from' : p.role === 'recorder' ? 'from' : 'mentions';
      await linkEntity(thoughtId, match.id, relationship, 1.0, pool, thoughtDate);

      if (p.email) {
        await storeEmailOnEntity(match.id, p.email, pool);
      }

      resolvedNames.add(normalizeName(p.name));
      resolvedEntityIds.push(match.id);
    }
  }

  // Resolve structured companies
  const companyEntityIds: string[] = [];
  if (structured.companies?.length) {
    for (const c of structured.companies) {
      if (isJunkEntity(c.name)) continue;
      const match = await findOrCreateEntity(c.name, 'company', pool, thoughtDate);
      await linkEntity(thoughtId, match.id, 'mentions', 1.0, pool, thoughtDate);
      resolvedNames.add(normalizeName(c.name));
      resolvedEntityIds.push(match.id);
      companyEntityIds.push(match.id);
    }
  }

  // Create typed edges from HubSpot associations (person→company = works_at, etc.)
  if (sourceMeta?.object_type && companyEntityIds.length > 0) {
    const objectType = sourceMeta.object_type as string;
    const personEntityIds = resolvedEntityIds.filter(id => !companyEntityIds.includes(id));

    for (const personId of personEntityIds) {
      for (const companyId of companyEntityIds) {
        const edgeType = objectType === 'deal' ? 'deal_with'
          : objectType === 'contact' ? 'works_at'
          : null;
        if (edgeType) {
          try {
            await createTypedEdge(personId, companyId, edgeType, thoughtId, pool);
          } catch (err) {
            log.error({ err }, 'Failed to create typed edge (non-fatal)');
          }
        }
      }
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
  thoughtDate?: Date,
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
        thoughtDate,
      );
      alreadyResolved = result.resolvedNames;
      allEntityIds.push(...result.resolvedEntityIds);
    } catch (err) {
      log.error({ err }, 'Structured participant resolution failed (non-fatal)');
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

    const match = await findOrCreateEntity(entry.name, entry.type, pool, thoughtDate, {
      contextEntityIds: allEntityIds,
    });
    const relationship = inferRelationship(entry.name, metadata, content, sourceMeta);
    await linkEntity(thoughtId, match.id, relationship, match.confidence, pool, thoughtDate);
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
        log.error({ err }, 'Failed to create link proposal');
      }
    }
  }

  // Non-blocking explicit relationship extraction (separate focused pass)
  let explicitPairs: Set<string> | undefined;
  const allEntries = entityEntries.filter(e => !isJunkEntity(e.name));
  const entityNames = [...new Set(allEntries.map(e => e.name))];
  if (entityNames.length >= 2) {
    try {
      const extracted = await extractRelationships(content, entityNames, _config);
      if (extracted.length > 0) {
        explicitPairs = await applyExtractedRelationships(extracted, thoughtId, pool);
      }
    } catch (err) {
      log.error({ err }, 'Relationship extraction failed (non-fatal)');
    }
  }

  // Create co-occurrence edges between all resolved entities (non-blocking)
  if (allEntityIds.length >= 2) {
    try {
      await createCooccurrenceEdges(thoughtId, allEntityIds, pool, explicitPairs);
    } catch (err) {
      log.error({ err }, 'Co-occurrence edge creation failed (non-fatal)');
    }
  }
}
