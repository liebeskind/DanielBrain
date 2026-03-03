import pg from 'pg';

let pool: pg.Pool | null = null;

export function getPool(connectionString?: string): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString ?? process.env.DATABASE_URL,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
