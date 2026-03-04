import type pg from 'pg';
import type { ThoughtMetadata, EntityType, EntityRelationshipType } from '@danielbrain/shared';

interface ResolverConfig {
  ollamaBaseUrl: string;
  embeddingModel: string;
}

const NAME_PREFIXES = /^(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?)\s+/i;
const COMPANY_SUFFIXES = /\s+(inc\.?|llc\.?|ltd\.?|co\.?|corp\.?)$/i;

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(NAME_PREFIXES, '')
    .replace(COMPANY_SUFFIXES, '');
}

interface EntityMatch {
  id: string;
  name: string;
  entity_type: EntityType;
  match_type: 'canonical' | 'alias' | 'new';
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

export async function resolveEntities(
  thoughtId: string,
  metadata: ThoughtMetadata,
  content: string,
  pool: pg.Pool,
  _config: ResolverConfig,
  sourceMeta?: Record<string, unknown> | null,
): Promise<void> {
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
    const match = await findOrCreateEntity(entry.name, entry.type, pool);
    const relationship = inferRelationship(entry.name, metadata, content, sourceMeta);
    await linkEntity(thoughtId, match.id, relationship, match.confidence, pool);
  }
}
