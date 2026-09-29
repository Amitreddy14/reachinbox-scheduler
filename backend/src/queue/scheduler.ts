import type { EmailJob } from '../db/schema';
import { emailQueue, queueJobIdFor, type EmailJobPayload } from './queues';
import { childLogger } from '../config/logger';

const log = childLogger('scheduler');

/**
 * Spacing applied when a batch of deferred emails wakes up at the same instant.
 * Without it every job races for the same min-gap slot and the original order
 * is lost; 25ms per position is enough to restore FIFO while staying far below
 * the configured send gap.
 */
export const ORDER_STRIDE_MS = 25;
const MAX_STRIDE_POSITIONS = 2000;

export function orderOffsetMs(sequence: number): number {
  return Math.min(sequence, MAX_STRIDE_POSITIONS) * ORDER_STRIDE_MS;
}

/** Delay in ms from now until `when`, never negative (past-due fires at once). */
export function delayUntil(when: Date, now = Date.now()): number {
  return Math.max(0, when.getTime() - now);
}

export interface EnqueueOptions {
  /** Skip if the job id already exists. Always true in practice; kept explicit. */
  idempotent?: boolean;
}

export async function enqueueEmailJob(job: EmailJob, _options: EnqueueOptions = {}): Promise<void> {
  const payload: EmailJobPayload = {
    emailJobId: job.id,
    userId: job.userId,
    campaignId: job.campaignId,
    senderId: job.senderId,
    sequence: job.sequence,
  };

  await emailQueue.add('send-email', payload, {
    jobId: job.queueJobId,
    delay: delayUntil(job.scheduledAt) + orderOffsetMs(job.sequence),
  });
}

export async function enqueueMany(jobs: EmailJob[]): Promise<number> {
  if (jobs.length === 0) return 0;

  const now = Date.now();
  const entries = jobs.map((job) => ({
    name: 'send-email',
    data: {
      emailJobId: job.id,
      userId: job.userId,
      campaignId: job.campaignId,
      senderId: job.senderId,
      sequence: job.sequence,
    } satisfies EmailJobPayload,
    opts: {
      jobId: job.queueJobId,
      delay: delayUntil(job.scheduledAt, now) + orderOffsetMs(job.sequence),
    },
  }));

  // addBulk is one pipelined round trip; adding 1000 jobs one by one is the
  // difference between ~120ms and several seconds.
  await emailQueue.addBulk(entries);
  log.info({ count: entries.length }, 'jobs enqueued');
  return entries.length;
}

export async function cancelEmailJob(emailJobId: string): Promise<boolean> {
  const job = await emailQueue.getJob(queueJobIdFor(emailJobId));
  if (!job) return false;
  const state = await job.getState();
  if (state === 'active') return false; // already sending; let it finish
  await job.remove();
  return true;
}

export interface QueueSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
}

/** Live counters behind the dashboard's throughput strip. */
export async function queueSnapshot(): Promise<QueueSnapshot> {
  const counts = await emailQueue.getJobCounts(
    'wait',
    'active',
    'delayed',
    'completed',
    'failed',
  );
  const paused = await emailQueue.isPaused();

  return {
    waiting: counts.wait ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    // BullMQ pauses the whole queue rather than individual jobs, so this is a
    // 0/1 flag rendered alongside the counters.
    paused: paused ? 1 : 0,
  };
}
