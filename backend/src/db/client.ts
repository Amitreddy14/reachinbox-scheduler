import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { env } from '../config/env';
import * as schema from './schema';

/**
 * One connection pool per process. `globalThis` caching stops `tsx watch` from
 * opening a fresh pool on every reload during development.
 */
const globalForDb = globalThis as unknown as {
  __pgPool?: Pool;
  __db?: NodePgDatabase<typeof schema>;
};

export const pool =
  globalForDb.__pgPool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

export const db = globalForDb.__db ?? drizzle(pool, { schema });

if (env.NODE_ENV !== 'production') {
  globalForDb.__pgPool = pool;
  globalForDb.__db = db;
}

export type Database = typeof db;
export { schema };

export async function pingDatabase(): Promise<boolean> {
  const result = await pool.query('SELECT 1 AS ok');
  return result.rows.length === 1;
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
