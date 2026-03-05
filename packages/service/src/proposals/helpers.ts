import type pg from 'pg';
import type { EntityRelationshipType } from '@danielbrain/shared';
import { APPROVAL_THRESHOLDS, DEFAULT_APPROVAL_THRESHOLD } from '@danielbrain/shared';

interface LinkProposalInput {
  thoughtId: string;
  entityId: string;
  entityName: string;
  matchedName: string;
  matchType: string;
  relationship: EntityRelationshipType;
  confidence: number;
  aliasAdded?: string;
}

export function shouldCreateProposal(confidence: number, operationType: string): boolean {
  const threshold = APPROVAL_THRESHOLDS[operationType] ?? DEFAULT_APPROVAL_THRESHOLD;
  if (threshold === 'always') return true;
  return confidence < threshold;
}

export async function createLinkProposal(
  input: LinkProposalInput,
  pool: pg.Pool,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO proposals (proposal_type, entity_id, title, description, proposed_data, auto_applied, source)
     VALUES ($1, $2, $3, $4, $5, TRUE, 'entity_resolver')
     RETURNING id`,
    [
      'entity_link',
      input.entityId,
      `Link "${input.entityName}" → "${input.matchedName}" (${input.matchType})`,
      `${input.matchType} match with confidence ${input.confidence}. Auto-applied — reject to undo.`,
      JSON.stringify({
        thought_id: input.thoughtId,
        entity_id: input.entityId,
        relationship: input.relationship,
        confidence: input.confidence,
        alias_added: input.aliasAdded || null,
      }),
    ]
  );
  return rows[0].id;
}

export async function createEnrichmentProposal(
  entityId: string,
  entityName: string,
  proposedData: Record<string, unknown>,
  searchQuery: string,
  pool: pg.Pool,
): Promise<string> {
  // Auto-close any needs_changes proposals for the same entity (enricher retry)
  await pool.query(
    `UPDATE proposals SET status = 'rejected', reviewer_notes = 'Superseded by new enrichment proposal'
     WHERE entity_id = $1 AND proposal_type = 'entity_enrichment' AND status = 'needs_changes'`,
    [entityId]
  );

  const { rows } = await pool.query(
    `INSERT INTO proposals (proposal_type, entity_id, title, description, proposed_data, auto_applied, source)
     VALUES ($1, $2, $3, $4, $5, FALSE, 'linkedin_enricher')
     RETURNING id`,
    [
      'entity_enrichment',
      entityId,
      `LinkedIn URL for ${entityName}`,
      `Found via SerpAPI: "${searchQuery}"`,
      JSON.stringify(proposedData),
    ]
  );
  return rows[0].id;
}
