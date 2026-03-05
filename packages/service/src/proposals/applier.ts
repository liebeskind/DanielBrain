import type pg from 'pg';
import type { Proposal } from '@danielbrain/shared';

export async function applyProposal(proposal: Proposal, pool: pg.Pool): Promise<void> {
  switch (proposal.proposal_type) {
    case 'entity_enrichment':
      await applyEntityEnrichment(proposal, pool);
      break;
    case 'entity_link':
      // entity_link proposals are auto-applied; approve is a no-op
      break;
    case 'entity_merge':
      await applyEntityMerge(proposal, pool);
      break;
    default:
      throw new Error(`Unknown proposal type: ${proposal.proposal_type}`);
  }
}

export async function revertProposal(proposal: Proposal, pool: pg.Pool): Promise<void> {
  switch (proposal.proposal_type) {
    case 'entity_link':
      await revertEntityLink(proposal, pool);
      break;
    case 'entity_enrichment':
      // Not auto-applied, nothing to revert
      break;
    case 'entity_merge':
      // Not auto-applied, nothing to revert
      break;
    default:
      throw new Error(`Unknown proposal type: ${proposal.proposal_type}`);
  }
}

async function applyEntityEnrichment(proposal: Proposal, pool: pg.Pool): Promise<void> {
  if (!proposal.entity_id) {
    throw new Error('entity_enrichment proposal missing entity_id');
  }
  // Merge proposed_data into entity's metadata JSONB
  await pool.query(
    `UPDATE entities SET metadata = metadata || $1::jsonb, updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(proposal.proposed_data), proposal.entity_id]
  );

  // If LinkedIn title/snippet available, enrich the entity
  const { linkedin_title, linkedin_snippet } = proposal.proposed_data as {
    linkedin_title?: string;
    linkedin_snippet?: string;
  };
  if (linkedin_title || linkedin_snippet) {
    const { rows } = await pool.query(
      `SELECT name, profile_summary FROM entities WHERE id = $1`,
      [proposal.entity_id]
    );
    const entity = rows[0];
    if (!entity) return;

    // If LinkedIn title contains a fuller name (e.g. "Luke Rodehorst - CEO at ..."),
    // upgrade the entity name from a partial (e.g. "Luke") to the full name
    if (linkedin_title) {
      const fullName = linkedin_title.split(/\s*[-–—|]/).map(s => s.trim())[0];
      const currentName = entity.name;
      // Upgrade if: LinkedIn name starts with current name and has more words (fuller version)
      if (fullName && fullName.toLowerCase().startsWith(currentName.toLowerCase())
          && fullName.split(/\s+/).length > currentName.split(/\s+/).length) {
        await pool.query(
          `UPDATE entities
           SET name = $1, canonical_name = $2, aliases = array_append(aliases, $3), updated_at = NOW()
           WHERE id = $4`,
          [fullName, fullName.toLowerCase(), currentName.toLowerCase(), proposal.entity_id]
        );
      }
    }

    // Append LinkedIn context to profile
    const linkedinContext = [linkedin_title, linkedin_snippet].filter(Boolean).join(' — ');
    const existing = entity.profile_summary || '';
    const separator = existing ? '\n\nLinkedIn: ' : 'LinkedIn: ';
    await pool.query(
      `UPDATE entities SET profile_summary = $1, updated_at = NOW()
       WHERE id = $2`,
      [existing + separator + linkedinContext, proposal.entity_id]
    );
  }
}

async function applyEntityMerge(proposal: Proposal, pool: pg.Pool): Promise<void> {
  const { winner_id, loser_id } = proposal.proposed_data as { winner_id: string; loser_id: string };
  if (!winner_id || !loser_id) {
    throw new Error('entity_merge proposal missing winner_id or loser_id');
  }

  // Reassign all thought_entities from loser to winner
  await pool.query(
    `UPDATE thought_entities SET entity_id = $1
     WHERE entity_id = $2
     AND NOT EXISTS (
       SELECT 1 FROM thought_entities
       WHERE entity_id = $1 AND thought_id = thought_entities.thought_id AND relationship = thought_entities.relationship
     )`,
    [winner_id, loser_id]
  );

  // Delete any remaining duplicate links
  await pool.query(
    `DELETE FROM thought_entities WHERE entity_id = $1`,
    [loser_id]
  );

  // Merge aliases from loser into winner
  await pool.query(
    `UPDATE entities SET
       aliases = (SELECT array_agg(DISTINCT a) FROM unnest(e1.aliases || e2.aliases) AS a),
       mention_count = e1.mention_count + e2.mention_count,
       updated_at = NOW()
     FROM entities e1, entities e2
     WHERE entities.id = $1 AND e1.id = $1 AND e2.id = $2`,
    [winner_id, loser_id]
  );

  // Delete loser entity
  await pool.query(`DELETE FROM entities WHERE id = $1`, [loser_id]);
}

async function revertEntityLink(proposal: Proposal, pool: pg.Pool): Promise<void> {
  const { thought_id, entity_id, relationship, alias_added } = proposal.proposed_data as {
    thought_id: string;
    entity_id: string;
    relationship: string;
    alias_added?: string;
  };

  // Delete the thought_entities link
  await pool.query(
    `DELETE FROM thought_entities
     WHERE thought_id = $1 AND entity_id = $2 AND relationship = $3`,
    [thought_id, entity_id, relationship]
  );

  // Decrement mention_count
  await pool.query(
    `UPDATE entities SET mention_count = GREATEST(mention_count - 1, 0), updated_at = NOW()
     WHERE id = $1`,
    [entity_id]
  );

  // Remove auto-added alias if present
  if (alias_added) {
    await pool.query(
      `UPDATE entities SET aliases = array_remove(aliases, $1)
       WHERE id = $2`,
      [alias_added, entity_id]
    );
  }
}
