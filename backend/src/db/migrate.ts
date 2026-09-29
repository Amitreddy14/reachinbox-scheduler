/**
 * Applies the SQL files in ./drizzle to the configured database.
 *
 *   npm run db:migrate
 *
 * `npm run db:generate` writes a new migration whenever src/db/schema.ts
 * changes; `npm run db:push` is the faster no-migration path for local work.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, closeDatabase } from './client';
import { logger } from '../config/logger';

async function main(): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
  logger.info('migrations applied');
  await closeDatabase();
}

main().catch(async (err) => {
  logger.error({ err }, 'migration failed');
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
