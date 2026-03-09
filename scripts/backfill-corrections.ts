/**
 * Backfill correction examples from existing rejected/applied enrichment proposals.
 * Run once before re-running the enricher to seed the corrections table.
 *
 * Usage: npx tsx scripts/backfill-corrections.ts
 */
import 'dotenv/config';
import pg from 'pg';
import { createCorrectionExample } from '../packages/service/src/corrections/store.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function backfill() {
  // Find all rejected enrichment proposals (negative examples)
  const { rows: rejected } = await pool.query(
    `SELECT p.*, e.name as entity_name
     FROM proposals p
     LEFT JOIN entities e ON p.entity_id = e.id
     WHERE p.proposal_type = 'entity_enrichment' AND p.status = 'rejected'`
  );

  console.log(`Found ${rejected.length} rejected enrichment proposals`);

  let created = 0;
  for (const proposal of rejected) {
    // Skip if correction already exists for this proposal
    const { rows: existing } = await pool.query(
      `SELECT id FROM correction_examples WHERE proposal_id = $1`,
      [proposal.id]
    );
    if (existing.length > 0) {
      console.log(`  Skipping ${proposal.entity_name} — correction already exists`);
      continue;
    }

    const proposedData = typeof proposal.proposed_data === 'string'
      ? JSON.parse(proposal.proposed_data) : proposal.proposed_data;
    const description = proposal.description || '';
    const entityName = proposal.title?.replace(/^LinkedIn URL for /, '') || proposal.entity_name || '';

    // Parse company context from description
    const rawQuery = description
      .replace(/^Found via SerpAPI:\s*"?/, '')
      .replace(/"?\s*$/, '');
    const companyContext: string[] = [];
    const allQuoted = rawQuery.match(/"([^"]+)"/g);
    if (allQuoted) {
      for (const m of allQuoted) {
        const term = m.replace(/"/g, '');
        if (term === entityName || !term.trim()) continue;
        companyContext.push(term);
      }
    }

    try {
      await createCorrectionExample({
        category: 'linkedin_search',
        input_context: {
          entity_name: entityName,
          search_query: description,
          company_context: companyContext,
        },
        actual_output: {
          linkedin_url: proposedData?.linkedin_url || null,
        },
        expected_output: { rejected: true },
        explanation: proposal.reviewer_notes || 'Rejected — wrong result (backfilled)',
        entity_id: proposal.entity_id,
        proposal_id: proposal.id,
        tags: ['backfilled', 'rejection'],
      }, pool);
      created++;
      console.log(`  Created correction for ${entityName}: ${proposedData?.linkedin_url || 'no url'}`);
    } catch (err) {
      console.error(`  Failed for ${entityName}:`, (err as Error).message);
    }
  }

  // Find applied proposals that might have wrong results (user can review later)
  const { rows: applied } = await pool.query(
    `SELECT p.*, e.name as entity_name
     FROM proposals p
     LEFT JOIN entities e ON p.entity_id = e.id
     WHERE p.proposal_type = 'entity_enrichment' AND p.status = 'applied'`
  );
  console.log(`\nFound ${applied.length} applied enrichment proposals (not backfilling — review these manually if needed)`);
  for (const p of applied) {
    const pd = typeof p.proposed_data === 'string' ? JSON.parse(p.proposed_data) : p.proposed_data;
    console.log(`  ${p.entity_name}: ${pd?.linkedin_url || 'no url'}`);
  }

  console.log(`\nDone. Created ${created} correction examples from ${rejected.length} rejected proposals.`);
  await pool.end();
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
