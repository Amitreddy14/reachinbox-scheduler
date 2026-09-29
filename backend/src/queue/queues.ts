import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { env } from '../config/env';
import { queueConnection } from './connection';

export interface EmailJobPayload {
  emailJobId: string;
  userId: string;
  campaignId: string;
  senderId: string;
  /** Position inside the campaign; used to restore FIFO order after a deferral. */
  sequence: number;
}

/**
 * The BullMQ job id is derived from the database row id, never generated.
 * Adding the same id twice is a no-op in Redis, so a retried API call, a
 * double-click on "Schedule" or a restart reconciliation can never produce a
 * second copy of the same email.
 *
 * The separator is a hyphen, not a colon: BullMQ builds its Redis keys as
 * `<prefix>:<queue>:<jobId>` and rejects a custom id containing `:`.
 */
export function queueJobIdFor(emailJobId: string): string {
  return `email-${emailJobId}`;
}

export const defaultJobOptions: JobsOptions = {
  attempts: env.JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: env.JOB_BACKOFF_MS },
  removeOnComplete: { count: env.KEEP_COMPLETED_JOBS },
  removeOnFail: { count: env.KEEP_FAILED_JOBS },
};

export const emailQueue = new Queue<EmailJobPayload>(env.EMAIL_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions,
});

export const emailQueueEvents = new QueueEvents(env.EMAIL_QUEUE_NAME, {
  connection: queueConnection.duplicate(),
});

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([emailQueue.close(), emailQueueEvents.close()]);
}
