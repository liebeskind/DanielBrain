import 'dotenv/config';
import pg from 'pg';
import { loadConfig } from '../packages/service/src/config.js';
import { createHubSpotClient } from '../packages/service/src/hubspot/client.js';
import { syncHubSpot } from '../packages/service/src/hubspot/sync.js';
import type { HubSpotObjectType } from '../packages/service/src/hubspot/types.js';

const config = loadConfig();

if (!config.hubspotAccessToken) {
  console.error('HUBSPOT_ACCESS_TOKEN is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl });

async function main(): Promise<void> {
  const client = createHubSpotClient(config.hubspotAccessToken!);
  const objectTypes = config.hubspotObjectTypes.split(',').map(s => s.trim()) as HubSpotObjectType[];

  console.log(`Starting HubSpot backfill for: ${objectTypes.join(', ')}`);

  // Reset sync state to force full sync
  await pool.query(
    `INSERT INTO hubspot_sync_state (id) VALUES (1)
     ON CONFLICT (id) DO UPDATE SET last_synced_at = NULL, contacts_after = NULL,
       companies_after = NULL, deals_after = NULL, updated_at = NOW()`,
  );

  const result = await syncHubSpot(client, pool, objectTypes);

  console.log(`\nBackfill complete:`);
  console.log(`  Contacts: ${result.contacts} queued`);
  console.log(`  Companies: ${result.companies} queued`);
  console.log(`  Deals: ${result.deals} queued`);
  console.log(`  Skipped (dedup): ${result.skipped}`);
  console.log(`  Errors: ${result.errors}`);

  console.log('\nRecords are in the queue. Start the service to process them.');
  console.log('Run: npm run dev');

  await pool.end();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
