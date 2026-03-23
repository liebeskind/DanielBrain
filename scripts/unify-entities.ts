#!/usr/bin/env npx tsx
/**
 * Cross-source entity unification backfill.
 *
 * Finds duplicate entities across HubSpot, Fathom, and Slack by matching on
 * email addresses and LinkedIn URLs. Auto-merges high-confidence matches,
 * creates proposals for ambiguous cases.
 *
 * Usage:
 *   npx tsx scripts/unify-entities.ts --dry-run   # Preview without executing
 *   npx tsx scripts/unify-entities.ts             # Execute merges
 */
import 'dotenv/config';
import pg from 'pg';
import { normalizeName } from '../packages/service/src/processor/entity-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntityRow {
  id: string;
  name: string;
  canonical_name: string;
  entity_type: string;
  mention_count: number;
  metadata: Record<string, unknown>;
  profile_summary: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERIC_EMAIL_PREFIXES = new Set([
  'info', 'admin', 'support', 'hello', 'noreply', 'no-reply',
  'office', 'team', 'sales', 'contact', 'help', 'billing',
  'feedback', 'marketing', 'hr', 'careers', 'press', 'media',
  'webmaster', 'postmaster', 'abuse', 'security',
]);

const dryRun = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isGenericEmail(email: string): boolean {
  const local = email.toLowerCase().split('@')[0];
  return GENERIC_EMAIL_PREFIXES.has(local);
}

/** Extract all emails from an entity's metadata (both legacy and array formats) */
function extractEmails(metadata: Record<string, unknown>): string[] {
  const emails = new Set<string>();
  if (typeof metadata.email === 'string') emails.add(metadata.email.toLowerCase());
  if (Array.isArray(metadata.emails)) {
    for (const e of metadata.emails) {
      if (typeof e === 'string') emails.add(e.toLowerCase());
    }
  }
  return [...emails];
}

/**
 * Determine if two names are similar enough for auto-merge.
 * Returns 'auto' for high-confidence matches, 'review' for ambiguous.
 */
function areNamesSimilar(nameA: string, nameB: string): 'auto' | 'review' {
  const a = normalizeName(nameA);
  const b = normalizeName(nameB);

  // Exact match after normalization
  if (a === b) return 'auto';

  // One is a prefix of the other (e.g., "chris" → "chris psiaki")
  if (a.startsWith(b) || b.startsWith(a)) return 'auto';

  // Check first tokens for prefix relationship
  const tokensA = a.split(' ');
  const tokensB = b.split(' ');
  if (tokensA.length > 0 && tokensB.length > 0) {
    const firstA = tokensA[0];
    const firstB = tokensB[0];
    if (firstA.startsWith(firstB) || firstB.startsWith(firstA)) {
      // Single-token name is prefix of other's first token
      if (tokensA.length === 1 || tokensB.length === 1) return 'auto';
      // Multi-token: check if last names match
      if (tokensA.length > 1 && tokensB.length > 1 &&
          tokensA[tokensA.length - 1] === tokensB[tokensB.length - 1]) return 'auto';
    }
  }

  return 'review';
}

/** Pick winner (most mentions, then most metadata richness) */
function pickWinner(entities: EntityRow[]): { winner: EntityRow; losers: EntityRow[] } {
  const sorted = [...entities].sort((a, b) => {
    if (a.mention_count !== b.mention_count) return b.mention_count - a.mention_count;
    const metaKeysA = Object.keys(a.metadata || {}).length;
    const metaKeysB = Object.keys(b.metadata || {}).length;
    return metaKeysB - metaKeysA;
  });
  return { winner: sorted[0], losers: sorted.slice(1) };
}

/** Deep merge metadata — winner takes precedence, emails arrays combined */
function mergeMetadata(
  winnerMeta: Record<string, unknown>,
  loserMeta: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...loserMeta, ...winnerMeta };

  // Combine emails arrays (deduplicated)
  const allEmails = new Set<string>();
  for (const e of (winnerMeta.emails as string[] || [])) allEmails.add(e);
  for (const e of (loserMeta.emails as string[] || [])) allEmails.add(e);
  if (typeof winnerMeta.email === 'string') allEmails.add(winnerMeta.email);
  if (typeof loserMeta.email === 'string') allEmails.add(loserMeta.email);
  if (allEmails.size > 0) {
    merged.emails = [...allEmails];
    merged.email = merged.email || [...allEmails][0];
  }

  // Keep linkedin_url from whichever has it
  merged.linkedin_url = winnerMeta.linkedin_url || loserMeta.linkedin_url;

  return merged;
}

// ---------------------------------------------------------------------------
// Merge operations
// ---------------------------------------------------------------------------

async function mergeEntity(
  client: pg.PoolClient,
  winner: EntityRow,
  loser: EntityRow,
  reason: string,
): Promise<void> {
  const winnerId = winner.id;
  const loserId = loser.id;

  // 1. Reassign thought_entities from loser to winner (skip duplicates)
  await client.query(
    `UPDATE thought_entities SET entity_id = $1
     WHERE entity_id = $2
     AND NOT EXISTS (
       SELECT 1 FROM thought_entities te2
       WHERE te2.entity_id = $1 AND te2.thought_id = thought_entities.thought_id AND te2.relationship = thought_entities.relationship
     )`,
    [winnerId, loserId],
  );

  // 2. Delete remaining duplicate thought_entities for loser
  await client.query(`DELETE FROM thought_entities WHERE entity_id = $1`, [loserId]);

  // 3. Merge aliases, mention_count, and metadata
  const mergedMeta = mergeMetadata(winner.metadata, loser.metadata);
  const profileSummary = winner.profile_summary || loser.profile_summary;

  await client.query(
    `UPDATE entities SET
       aliases = (SELECT array_agg(DISTINCT a) FROM unnest(e1.aliases || e2.aliases || ARRAY[$3]) AS a),
       mention_count = e1.mention_count + e2.mention_count,
       metadata = $4::jsonb,
       profile_summary = COALESCE($5, entities.profile_summary),
       updated_at = NOW()
     FROM entities e1, entities e2
     WHERE entities.id = $1 AND e1.id = $1 AND e2.id = $2`,
    [winnerId, loserId, normalizeName(loser.name), JSON.stringify(mergedMeta), profileSummary],
  );

  // 4. Reassign entity_relationships source_id (skip duplicates)
  await client.query(
    `UPDATE entity_relationships SET source_id = $1
     WHERE source_id = $2
     AND NOT EXISTS (
       SELECT 1 FROM entity_relationships er2
       WHERE er2.source_id = $1 AND er2.target_id = entity_relationships.target_id AND er2.relationship = entity_relationships.relationship
     )`,
    [winnerId, loserId],
  );

  // 5. Reassign entity_relationships target_id (skip duplicates)
  await client.query(
    `UPDATE entity_relationships SET target_id = $1
     WHERE target_id = $2
     AND NOT EXISTS (
       SELECT 1 FROM entity_relationships er2
       WHERE er2.source_id = entity_relationships.source_id AND er2.target_id = $1 AND er2.relationship = entity_relationships.relationship
     )`,
    [winnerId, loserId],
  );

  // 6. Delete remaining relationship edges referencing loser
  await client.query(
    `DELETE FROM entity_relationships WHERE source_id = $1 OR target_id = $1`,
    [loserId],
  );

  // 7. Remove loser from community memberships
  await client.query(`DELETE FROM entity_communities WHERE entity_id = $1`, [loserId]);

  // 8. Clean up proposals referencing loser
  await client.query(
    `DELETE FROM proposals WHERE entity_id = $1 AND status = 'pending'`,
    [loserId],
  );

  // 9. Delete loser entity
  await client.query(`DELETE FROM entities WHERE id = $1`, [loserId]);

  console.log(`  AUTO-MERGE: "${loser.name}" (${loser.mention_count} mentions) → "${winner.name}" (${winner.mention_count} mentions) [${reason}]`);
}

async function proposalExists(
  client: pg.PoolClient,
  winnerId: string,
  loserId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT id FROM proposals
     WHERE proposal_type = 'entity_merge'
       AND status = 'pending'
       AND ((proposed_data->>'winner_id' = $1 AND proposed_data->>'loser_id' = $2)
         OR (proposed_data->>'winner_id' = $2 AND proposed_data->>'loser_id' = $1))
     LIMIT 1`,
    [winnerId, loserId],
  );
  return rows.length > 0;
}

async function createMergeProposal(
  client: pg.PoolClient,
  winner: EntityRow,
  loser: EntityRow,
  reason: string,
): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO proposals (proposal_type, entity_id, title, description, proposed_data, auto_applied, source)
     VALUES ('entity_merge', $1, $2, $3, $4, FALSE, 'unify-entities')
     RETURNING id`,
    [
      winner.id,
      `Merge "${loser.name}" into "${winner.name}"`,
      `Cross-source match: ${reason}. Names differ — review needed.`,
      JSON.stringify({
        winner_id: winner.id,
        winner_name: winner.name,
        loser_id: loser.id,
        loser_name: loser.name,
      }),
    ],
  );
  console.log(`  PROPOSAL: "${loser.name}" (${loser.mention_count}) ≠ "${winner.name}" (${winner.mention_count}) [${reason}]`);
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  let autoMerges = 0;
  let proposals = 0;
  let skippedGeneric = 0;
  let skippedTypeMismatch = 0;
  let skippedAlreadyMerged = 0;
  let skippedExistingProposal = 0;

  try {
    await client.query('BEGIN');

    // Load all entities with emails
    const { rows: emailEntities } = await client.query<EntityRow>(
      `SELECT id, name, canonical_name, entity_type, mention_count,
              COALESCE(metadata, '{}'::jsonb) as metadata,
              profile_summary
       FROM entities
       WHERE metadata->>'email' IS NOT NULL
          OR metadata->'emails' IS NOT NULL
       ORDER BY mention_count DESC`,
    );

    // Load all entities with LinkedIn URLs
    const { rows: linkedinEntities } = await client.query<EntityRow>(
      `SELECT id, name, canonical_name, entity_type, mention_count,
              COALESCE(metadata, '{}'::jsonb) as metadata,
              profile_summary
       FROM entities
       WHERE metadata->>'linkedin_url' IS NOT NULL
       ORDER BY mention_count DESC`,
    );

    console.log(`\nEntity Unification${dryRun ? ' (DRY RUN)' : ''}`);
    console.log('='.repeat(50));
    console.log(`Entities with emails: ${emailEntities.length}`);
    console.log(`Entities with LinkedIn URLs: ${linkedinEntities.length}`);

    // Build email → entities map
    const emailMap = new Map<string, EntityRow[]>();
    for (const entity of emailEntities) {
      const emails = extractEmails(entity.metadata);
      for (const email of emails) {
        if (isGenericEmail(email)) {
          skippedGeneric++;
          continue;
        }
        const group = emailMap.get(email) || [];
        group.push(entity);
        emailMap.set(email, group);
      }
    }

    // Build LinkedIn → entities map
    const linkedinMap = new Map<string, EntityRow[]>();
    for (const entity of linkedinEntities) {
      const url = (entity.metadata.linkedin_url as string).toLowerCase().replace(/\/+$/, '');
      const group = linkedinMap.get(url) || [];
      group.push(entity);
      linkedinMap.set(url, group);
    }

    // Filter to actual duplicates (2+ entities per key)
    const emailDupes = [...emailMap.entries()].filter(([, v]) => v.length >= 2);
    const linkedinDupes = [...linkedinMap.entries()].filter(([, v]) => v.length >= 2);

    console.log(`Generic emails skipped: ${skippedGeneric}`);
    console.log(`Email duplicate groups: ${emailDupes.length}`);
    console.log(`LinkedIn duplicate groups: ${linkedinDupes.length}`);
    console.log();

    // Track merged entity IDs to avoid double-processing
    const mergedIds = new Set<string>();

    // Process email groups
    if (emailDupes.length > 0) {
      console.log('Processing email groups...');
      for (const [email, entities] of emailDupes) {
        // Filter out already-merged entities
        const active = entities.filter(e => !mergedIds.has(e.id));
        if (active.length < 2) continue;

        // Check for type mismatches
        const types = new Set(active.map(e => e.entity_type));
        if (types.size > 1) {
          console.log(`  WARNING: Type mismatch for ${email}: ${[...types].join(', ')} — skipping`);
          skippedTypeMismatch++;
          continue;
        }

        const { winner, losers } = pickWinner(active);

        for (const loser of losers) {
          if (mergedIds.has(loser.id)) {
            skippedAlreadyMerged++;
            continue;
          }

          const similarity = areNamesSimilar(winner.name, loser.name);
          if (similarity === 'auto') {
            await mergeEntity(client, winner, loser, `email: ${email}`);
            mergedIds.add(loser.id);
            autoMerges++;
          } else {
            // Check for existing proposal
            if (await proposalExists(client, winner.id, loser.id)) {
              skippedExistingProposal++;
              continue;
            }
            await createMergeProposal(client, winner, loser, `email: ${email}`);
            proposals++;
          }
        }
      }
      console.log();
    }

    // Process LinkedIn groups (always auto-merge)
    if (linkedinDupes.length > 0) {
      console.log('Processing LinkedIn groups...');
      for (const [url, entities] of linkedinDupes) {
        const active = entities.filter(e => !mergedIds.has(e.id));
        if (active.length < 2) continue;

        const types = new Set(active.map(e => e.entity_type));
        if (types.size > 1) {
          console.log(`  WARNING: Type mismatch for ${url}: ${[...types].join(', ')} — skipping`);
          skippedTypeMismatch++;
          continue;
        }

        const { winner, losers } = pickWinner(active);

        for (const loser of losers) {
          if (mergedIds.has(loser.id)) {
            skippedAlreadyMerged++;
            continue;
          }

          await mergeEntity(client, winner, loser, `linkedin: ${url}`);
          mergedIds.add(loser.id);
          autoMerges++;
        }
      }
      console.log();
    }

    // Summary
    console.log('Summary:');
    console.log(`  Auto-merges: ${autoMerges}`);
    console.log(`  Proposals created: ${proposals}`);
    console.log(`  Skipped (already merged): ${skippedAlreadyMerged}`);
    console.log(`  Skipped (existing proposal): ${skippedExistingProposal}`);
    console.log(`  Skipped (type mismatch): ${skippedTypeMismatch}`);
    console.log(`  Skipped (generic email): ${skippedGeneric}`);

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('\nDry run — no changes committed.');
    } else {
      await client.query('COMMIT');
      console.log('\nChanges committed.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nError — all changes rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
