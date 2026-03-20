import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DB_URL = 'postgresql://danielbrain_test:test_password@localhost:5433/danielbrain_test';

export async function setup() {
  // Retry loop for DB readiness
  let pool: pg.Pool | null = null;
  for (let i = 0; i < 10; i++) {
    try {
      pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 2 });
      await pool.query('SELECT 1');
      break;
    } catch {
      console.log(`Waiting for test DB... (attempt ${i + 1}/10)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!pool) throw new Error('Could not connect to test database');

  // Run migrations
  const migrationsDir = path.resolve(__dirname, '../../../../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      await pool.query(sql);
    } catch (err: any) {
      // Ignore "already exists" errors from re-running migrations
      if (!err.message?.includes('already exists') && !err.message?.includes('duplicate')) {
        console.warn(`Migration ${file} warning:`, err.message);
      }
    }
  }

  await pool.end();
  console.log(`Ran ${files.length} migrations on test DB`);
}

export async function teardown() {
  // No-op — test DB is ephemeral (tmpfs in docker-compose.test.yml)
}
