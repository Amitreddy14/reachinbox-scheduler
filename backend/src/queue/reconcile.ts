import { and, asc, eq, gt, inArray, lt, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { emailJobs, EmailStatus, type EmailJob } from '../db/schema';
import { childLogger } from '../config/logger';
import { emailQueue } from './queues';
import { enqueueMany } from './scheduler';

const log = childLogger('reconcile');

export interface ReconcileReport {
  inspected: number;
  requeued: number;
  alreadyArmed: number;
  releasedStuck: number;
}

/**
 * Restart safety.
 *
 * BullMQ keeps delayed jobs in a Redis sorted set, so with `appendonly yes` a
 * plain restart of the API already resumes every pending timer. That covers the
 * normal case but not two real ones:
 *
 *   - Redis itself was wiped, replaced, or failed over to an empty replica;
 *   - the process died between writing the Postgres rows and enqueuing them.
 *
 * On boot we therefore walk every non-terminal row in Postgres and re-arm only
 * the jobs Redis does not have. Because the job id is derived from the row id,
 * a job that is still armed is left untouched — re-adding it would be a no-op
 * anyway, and nothing is ever restarted "from day one".
 *
 * Rows stuck in SENDING (the process was killed mid-send) are released back to
 * SCHEDULED so they can be claimed again instead of sitting there forever.
 */
export async function reconcilePendingJobs(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    inspected: 0,
    requeued: 0,
    alreadyArmed: 0,
    releasedStuck: 0,
  };

  // A row can only be stuck in SENDING if the worker holding it died: the
  // BullMQ lock (60s) has long expired by the time a new process boots.
  const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000);
  const released = await db
    .update(emailJobs)
    .set({ status: EmailStatus.SCHEDULED, updatedAt: new Date() })
    .where(and(eq(emailJobs.status, EmailStatus.SENDING), lt(emailJobs.updatedAt, stuckCutoff)))
    .returning({ id: emailJobs.id });

  report.releasedStuck = released.length;
  if (released.length > 0) {
    log.warn({ count: released.length }, 'released rows stuck in SENDING');
  }

  const batchSize = 500;
  let cursor: string | null = null;

  for (;;) {
    const conditions: SQL[] = [
      inArray(emailJobs.status, [EmailStatus.SCHEDULED, EmailStatus.QUEUED]),
    ];
    if (cursor) conditions.push(gt(emailJobs.id, cursor));

    const batch: EmailJob[] = await db
      .select()
      .from(emailJobs)
      .where(and(...conditions))
      .orderBy(asc(emailJobs.id))
      .limit(batchSize);

    if (batch.length === 0) break;
    report.inspected += batch.length;

    const states = await Promise.all(
      batch.map(async (row) => {
        const job = await emailQueue.getJob(row.queueJobId);
        if (!job) return { row, armed: false };
        const state = await job.getState();
        // completed/failed jobs linger in Redis for the dashboard; those no
        // longer act as timers, so the row still needs a fresh job.
        const armed = state === 'delayed' || state === 'waiting' || state === 'active';
        return { row, armed };
      }),
    );

    const missing = states.filter((entry) => !entry.armed).map((entry) => entry.row);
    report.alreadyArmed += states.length - missing.length;

    if (missing.length > 0) {
      // Past-due rows get delay 0 and go out immediately, in scheduled order.
      await enqueueMany(missing);
      report.requeued += missing.length;
    }

    cursor = batch[batch.length - 1]?.id ?? null;
    if (batch.length < batchSize) break;
  }

  log.info(report, 'startup reconciliation finished');
  return report;
}
