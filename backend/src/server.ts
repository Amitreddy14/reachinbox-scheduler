import { createApp } from './app';
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

  // Runs before the HTTP listener so a restarted process never serves a
  // dashboard that claims emails are scheduled while nothing is armed.
  await reconcilePendingJobs();

  if (env.RUN_WORKER_IN_API) {
    startWorker();
    logger.info('worker started inside the API process');
  } else {
    logger.info('RUN_WORKER_IN_API=false — start the worker with `npm run dev:worker`');
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, dashboard: `${env.BACKEND_URL}/admin/queues` },
      'API listening',
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    // Order matters: stop accepting jobs, then drop the connections.
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
  logger.error({ err }, 'failed to start the API');
  process.exit(1);
});
