import { Worker, type Job } from 'bullmq';
import { env } from '../config/env';
import { childLogger } from '../config/logger';
import { queueConnection } from './connection';
import { processSendEmail } from './processors/sendEmail.processor';
import type { EmailJobPayload } from './queues';

const log = childLogger('worker');

let worker: Worker<EmailJobPayload> | null = null;

export function startWorker(): Worker<EmailJobPayload> {
  if (worker) return worker;

  worker = new Worker<EmailJobPayload>(
    env.EMAIL_QUEUE_NAME,
    // The token is required by moveToDelayed, so the processor takes both args.
    (job: Job<EmailJobPayload>, token?: string) => processSendEmail(job, token),
    {
      connection: queueConnection.duplicate(),
      concurrency: env.WORKER_CONCURRENCY,
      // Pull a small batch of delayed jobs at a time; the real pacing is done
      // by the Redis rate limiter, not by starving the worker.
      maxStalledCount: 2,
      stalledInterval: 30_000,
      lockDuration: 60_000,
    },
  );

  worker.on('ready', () =>
    log.info({ queue: env.EMAIL_QUEUE_NAME, concurrency: env.WORKER_CONCURRENCY }, 'worker ready'),
  );
  worker.on('failed', (job, err) =>
    log.warn({ jobId: job?.id, err: err.message }, 'job failed'),
  );
  worker.on('error', (err) => log.error({ err }, 'worker error'));
  worker.on('stalled', (jobId) => log.warn({ jobId }, 'job stalled and will be retried'));

  return worker;
}

export async function stopWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
}
