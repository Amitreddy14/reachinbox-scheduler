import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { env } from './config/env';
import { logger } from './config/logger';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/error';
import { emailQueue } from './queue/queues';
import { pingDatabase } from './db/client';
import { redis } from './queue/connection';
import { isAvailable as esAvailable } from './services/search';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    helmet({
      // Bull Board serves its own inline assets.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    cors({
      origin: [env.FRONTEND_URL],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url?.startsWith('/admin/queues') === true,
      },
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Live BullMQ dashboard                                             */
  /* ---------------------------------------------------------------- */
  const bullBoard = new ExpressAdapter();
  bullBoard.setBasePath('/admin/queues');
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter: bullBoard,
  });
  app.use('/admin/queues', bullBoard.getRouter());

  /* ---------------------------------------------------------------- */
  /* Health                                                            */
  /* ---------------------------------------------------------------- */
  app.get('/health', async (_req, res) => {
    const [db, cache, search] = await Promise.allSettled([
      pingDatabase(),
      redis.ping(),
      esAvailable(),
    ]);

    const ok =
      db.status === 'fulfilled' && cache.status === 'fulfilled' && cache.value === 'PONG';

    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      postgres: db.status === 'fulfilled',
      redis: cache.status === 'fulfilled',
      elasticsearch: search.status === 'fulfilled' && search.value === true,
      queue: env.EMAIL_QUEUE_NAME,
      workerInApi: env.RUN_WORKER_IN_API,
      concurrency: env.WORKER_CONCURRENCY,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      minGapMsPerSender: env.MIN_GAP_MS_PER_SENDER,
      maxEmailsPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      maxEmailsPerHourGlobal: env.MAX_EMAILS_PER_HOUR_GLOBAL,
      workerConcurrency: env.WORKER_CONCURRENCY,
      queueDashboardUrl: `${env.BACKEND_URL}/admin/queues`,
    });
  });

  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
