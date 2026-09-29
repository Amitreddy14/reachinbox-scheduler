import { and, count, eq, gte, inArray } from 'drizzle-orm';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { db } from '../../db/client';
import { campaigns, emailJobs, senders, EmailStatus } from '../../db/schema';
import { env } from '../../config/env';
import { childLogger } from '../../config/logger';
import { acquireSendSlot } from '../../services/rateLimiter';
import { HOUR_MS } from '../../utils/time';
import { notifyRateLimitHit } from '../../services/slack';
import { sendEmail } from '../../services/mailer';
import { indexEmail } from '../../services/search';
import { orderOffsetMs } from '../scheduler';
import type { EmailJobPayload } from '../queues';

const log = childLogger('worker');

export type ProcessOutcome =
  | { result: 'sent'; messageId: string; previewUrl: string | null }
  | { result: 'skipped'; reason: string };

/**
 * The single unit of work. The ordering inside this function is the design:
 *
 *   1. re-read the row  — Postgres is the truth, not the job payload
 *   2. bail out if it is already terminal            -> idempotency guard #2
 *   3. ask the rate limiter for a slot               -> may defer, never drop
 *   4. atomically latch the row to SENDING           -> idempotency guard #3
 *   5. send, then record the outcome
 *
 * Guard #1 is the deterministic BullMQ job id set at enqueue time.
 */
export async function processSendEmail(
  job: Job<EmailJobPayload>,
  token?: string,
): Promise<ProcessOutcome> {
  const { emailJobId } = job.data;

  const [row] = await db
    .select({ email: emailJobs, sender: senders })
    .from(emailJobs)
    .innerJoin(senders, eq(emailJobs.senderId, senders.id))
    .where(eq(emailJobs.id, emailJobId))
    .limit(1);

  if (!row) {
    // The campaign was deleted while this job sat in the delayed set. Retrying
    // can never help, so fail it permanently instead of burning attempts.
    throw new UnrecoverableError(`email job ${emailJobId} no longer exists`);
  }

  const { email, sender } = row;

  if (email.status === EmailStatus.SENT) return { result: 'skipped', reason: 'already-sent' };
  if (email.status === EmailStatus.CANCELLED) return { result: 'skipped', reason: 'cancelled' };

  if (!sender.isActive) {
    await db
      .update(emailJobs)
      .set({ status: EmailStatus.FAILED, lastError: 'sender is disabled', updatedAt: new Date() })
      .where(eq(emailJobs.id, email.id));
    throw new UnrecoverableError(`sender ${sender.id} is disabled`);
  }

  /* ---- 3. rate limiting ------------------------------------------------- */
  const senderHourlyLimit = sender.hourlyLimit ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const minGapMs = sender.minGapMs ?? env.MIN_GAP_MS_PER_SENDER;

  const slot = await acquireSendSlot({
    userId: email.userId,
    senderId: email.senderId,
    senderHourlyLimit,
    minGapMs,
  });

  if (!slot.allowed) {
    const hourlyReason =
      slot.reason === 'SENDER_HOURLY_LIMIT' || slot.reason === 'GLOBAL_HOURLY_LIMIT'
        ? slot.reason
        : null;

    // Emails are never dropped or failed because of a limit: they move to the
    // next moment they are allowed out. The stride keeps a whole batch in its
    // original order when it wakes up together at the top of the hour.
    const resumeAt =
      Date.now() + slot.retryAfterMs + (hourlyReason ? orderOffsetMs(email.sequence) : 0);

    await db
      .update(emailJobs)
      .set({
        status: EmailStatus.SCHEDULED,
        scheduledAt: new Date(resumeAt),
        deferCount: email.deferCount + 1,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(emailJobs.id, email.id));

    if (hourlyReason) {
      const [deferred] = await db
        .select({ total: count() })
        .from(emailJobs)
        .where(
          and(
            eq(emailJobs.senderId, email.senderId),
            eq(emailJobs.status, EmailStatus.SCHEDULED),
            gte(emailJobs.scheduledAt, new Date(slot.windowStart + HOUR_MS)),
          ),
        );

      // Fire and forget: a Slack outage must never stall the queue.
      void notifyRateLimitHit({
        userId: email.userId,
        senderEmail: sender.email,
        limit: slot.limit,
        used: slot.used,
        windowStart: slot.windowStart,
        resumesAt: new Date(slot.windowStart + HOUR_MS),
        deferredCount: deferred?.total ?? 0,
        reason: hourlyReason,
      }).catch((err) => log.warn({ err }, 'slack notification failed'));
    }

    log.info(
      { emailJobId: email.id, reason: slot.reason, retryAfterMs: slot.retryAfterMs },
      'send deferred by rate limiter',
    );

    // moveToDelayed + DelayedError hands the job back to Redis without burning
    // an attempt — the difference between "throttled" and "failed".
    await job.moveToDelayed(resumeAt, token);
    throw new DelayedError();
  }

  /* ---- 4. claim --------------------------------------------------------- */
  // Conditional update: only one worker can move the row out of
  // SCHEDULED/QUEUED, so a duplicate delivery of the same job is a no-op.
  const claimed = await db
    .update(emailJobs)
    .set({
      status: EmailStatus.SENDING,
      attempts: email.attempts + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(emailJobs.id, email.id),
        inArray(emailJobs.status, [EmailStatus.SCHEDULED, EmailStatus.QUEUED]),
      ),
    )
    .returning({ id: emailJobs.id });

  if (claimed.length === 0) {
    return { result: 'skipped', reason: 'claimed-by-another-worker' };
  }

  /* ---- 5. send ---------------------------------------------------------- */
  try {
    const sent = await sendEmail({
      sender,
      to: email.toEmail,
      subject: email.subject,
      html: email.bodyHtml,
      text: email.bodyText,
      idempotencyKey: email.id,
    });

    const [updated] = await db
      .update(emailJobs)
      .set({
        status: EmailStatus.SENT,
        sentAt: new Date(),
        messageId: sent.messageId,
        previewUrl: sent.previewUrl,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(emailJobs.id, email.id))
      .returning();

    if (updated) void indexEmail(updated, sender.email);
    await maybeCompleteCampaign(email.campaignId);

    log.info({ emailJobId: email.id, to: email.toEmail }, 'email sent');
    return { result: 'sent', messageId: sent.messageId, previewUrl: sent.previewUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attemptsMade = job.attemptsMade + 1;
    const willRetry = attemptsMade < (job.opts.attempts ?? env.JOB_ATTEMPTS);

    const [updated] = await db
      .update(emailJobs)
      .set({
        // Back to a re-runnable state so the retry can claim the row again.
        status: willRetry ? EmailStatus.SCHEDULED : EmailStatus.FAILED,
        lastError: message.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(emailJobs.id, email.id))
      .returning();

    if (!willRetry) {
      if (updated) void indexEmail(updated, sender.email);
      await maybeCompleteCampaign(email.campaignId);
    }

    log.warn({ emailJobId: email.id, attemptsMade, willRetry, err: message }, 'send failed');
    throw err;
  }
}

/** Flip a campaign to COMPLETED once nothing is left in flight. */
async function maybeCompleteCampaign(campaignId: string): Promise<void> {
  const [pending] = await db
    .select({ total: count() })
    .from(emailJobs)
    .where(
      and(
        eq(emailJobs.campaignId, campaignId),
        inArray(emailJobs.status, [
          EmailStatus.SCHEDULED,
          EmailStatus.QUEUED,
          EmailStatus.SENDING,
        ]),
      ),
    );

  if ((pending?.total ?? 0) > 0) return;

  await db
    .update(campaigns)
    .set({ status: 'COMPLETED', updatedAt: new Date() })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, 'ACTIVE')));
}
