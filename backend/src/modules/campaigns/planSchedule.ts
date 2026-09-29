import type { Sender } from '../../db/schema';
import { HOUR_MS } from '../../utils/time';

/**
 * Pure scheduling logic, deliberately free of any Redis, queue or database
 * import so it can be reasoned about — and unit tested — on its own.
 */

export interface PlannedSend {
  toEmail: string;
  senderId: string;
  scheduledAt: Date;
  /** Position inside the campaign; restores FIFO order after a deferral. */
  sequence: number;
}

/** Hard stop on how far ahead planning will look: two weeks of hour windows. */
const MAX_WINDOWS_AHEAD = 24 * 14;

function windowStartOf(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

/**
 * Build the initial timetable.
 *
 * Two constraints shape it:
 *   - the requested spacing between consecutive emails,
 *   - the hourly ceiling of the sender a given email is assigned to.
 *
 * Recipients are dealt round-robin across the account's active senders, which
 * is what multiplies effective throughput: three senders at 200/hour give
 * 600/hour without any single one exceeding its own limit.
 *
 * This is a *plan*, not a guarantee. The Redis limiter in the worker is the
 * authority at send time — if another process has already eaten the quota, the
 * job is pushed forward there. Planning ahead simply means the dashboard shows
 * believable times instead of a thousand identical timestamps.
 */
export function planSchedule(
  recipients: string[],
  senders: Sender[],
  startAt: Date,
  delayMs: number,
  hourlyLimit: number,
): PlannedSend[] {
  if (senders.length === 0) return [];

  const perSenderWindowCount = new Map<string, number>();
  const plan: PlannedSend[] = [];
  const start = startAt.getTime();
  const key = (senderId: string, windowStart: number) => `${senderId}:${windowStart}`;

  for (let i = 0; i < recipients.length; i += 1) {
    const toEmail = recipients[i] as string;
    const sender = senders[i % senders.length] as Sender;
    const cap = Math.max(1, Math.min(sender.hourlyLimit ?? hourlyLimit, hourlyLimit));

    // The time this email would go out if nothing were throttled.
    let ts = start + i * delayMs;

    // Walk forward one hour at a time until this sender has room in the window.
    for (let guard = 0; guard < MAX_WINDOWS_AHEAD; guard += 1) {
      const windowStart = windowStartOf(ts);
      const used = perSenderWindowCount.get(key(sender.id, windowStart)) ?? 0;
      if (used < cap) {
        perSenderWindowCount.set(key(sender.id, windowStart), used + 1);
        break;
      }
      ts = windowStart + HOUR_MS;
    }

    plan.push({ toEmail, senderId: sender.id, scheduledAt: new Date(ts), sequence: i });
  }

  return plan;
}
