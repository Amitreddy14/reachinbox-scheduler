/**
 * Standalone worker entry point.
 *
 * Run `RUN_WORKER_IN_API=false npm run dev` in one shell and this in one or
 * more others to demonstrate that concurrency and rate limiting hold across
 * processes — every counter and lock lives in Redis, none in process memory.
 */
import { env } from './config/env';
import { logger } from './config/logger';
import { pingDatabase, closeDatabase } from './db/client';
import { ensureIndex } from './services/search';
import { reconcilePendingJobs } from './queue/reconcile';
import { startWorker, stopWorker } from './queue/worker';
import { closeQueues } from './queue/queues';
import { closeRedis } from './queue/connection';
import { closeTransports } from './services/mailer';

async function main(): Promise<void> {
  await pingDatabase();
  await ensureIndex();
  await reconcilePendingJobs();

  startWorker();
  logger.info(
    { queue: env.EMAIL_QUEUE_NAME, concurrency: env.WORKER_CONCURRENCY },
    'standalone worker running',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await stopWorker();
    await closeQueues();
    closeTransports();
    await closeRedis();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
