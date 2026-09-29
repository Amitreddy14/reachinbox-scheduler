/**
 * End-to-end proof of the four behaviours the brief calls non-negotiable:
 * throttling, no dropped jobs, idempotency and survival across a restart.
 *
 * It runs the real scheduler against a real Postgres and a real Redis, with a
 * local stub standing in for Ethereal so the assertions can count the exact
 * number of SMTP deliveries. Nothing here is mocked except the mail server.
 *
 *   docker compose up -d postgres redis
 *   npm run db:migrate
 *   npm run test:e2e
 *
 * DESTRUCTIVE: it truncates every table in the configured database, so it
 * refuses to run unless E2E=1 is set explicitly.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { startSmtpStub, type SmtpStub } from './helpers/smtpStub';
import { db, closeDatabase } from '../src/db/client';
import { users, senders, emailJobs, campaigns, EmailStatus } from '../src/db/schema';
import { createCampaign } from '../src/modules/campaigns/campaign.service';
import { startWorker, stopWorker } from '../src/queue/worker';
import { emailQueue, closeQueues } from '../src/queue/queues';
import { enqueueMany } from '../src/queue/scheduler';
import { reconcilePendingJobs } from '../src/queue/reconcile';
import { redis, closeRedis } from '../src/queue/connection';
import { closeTransports } from '../src/services/mailer';

const HOURLY_CAP = 5;
const RECIPIENTS = 8;
const SMTP_PORT = 2525;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let smtp: SmtpStub;
let campaignId: string;

async function waitForDeliveries(count: number, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (smtp.received.length < count && Date.now() < deadline) await sleep(250);
  // A short grace period so an unexpected extra delivery is still caught.
  await sleep(1200);
}

async function statusBreakdown(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: emailJobs.status, total: sql<number>`count(*)::int` })
    .from(emailJobs)
    .where(eq(emailJobs.campaignId, campaignId))
    .groupBy(emailJobs.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
}

describe('scheduler end to end', { skip: process.env.E2E !== '1' && 'set E2E=1 to run' }, () => {
  before(async () => {
    smtp = await startSmtpStub(SMTP_PORT);

    await db.delete(emailJobs);
    await db.delete(campaigns);
    await db.delete(senders);
    await db.delete(users);
    await redis.flushdb();
    await emailQueue.obliterate({ force: true });

    const [user] = await db
      .insert(users)
      .values({ googleId: `g-${randomUUID()}`, email: 'e2e@example.com', name: 'E2E' })
      .returning();

    const [sender] = await db
      .insert(senders)
      .values({
        userId: user!.id,
        email: 'outreach1@stub.local',
        displayName: 'Outreach 1',
        smtpHost: '127.0.0.1',
        smtpPort: SMTP_PORT,
        smtpSecure: false,
        smtpUser: 'stub',
        smtpPassword: 'stub',
        hourlyLimit: HOURLY_CAP,
        minGapMs: 200,
      })
      .returning();

    const campaign = await createCampaign({
      userId: user!.id,
      subject: 'Quick question',
      bodyHtml: '<p>Hi there</p>',
      recipients: Array.from({ length: RECIPIENTS }, (_, i) => `lead${i}@example.com`),
      // In the past, so everything is immediately eligible and the limiter —
      // not the clock — is what holds emails back.
      startAt: new Date(Date.now() - 1000),
      delayMs: 0,
      hourlyLimit: HOURLY_CAP,
      senderIds: [sender!.id],
    });

    campaignId = campaign.id;
  });

  after(async () => {
    await stopWorker().catch(() => undefined);
    await closeQueues().catch(() => undefined);
    // Pooled SMTP sockets would otherwise keep the process alive after the
    // last assertion.
    closeTransports();
    await smtp?.close().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    await closeDatabase().catch(() => undefined);
  });

  test('persists every recipient even though the batch exceeds one hour of quota', async () => {
    const rows = await db.select().from(emailJobs);
    assert.equal(rows.length, RECIPIENTS);
  });

  test('the planner already spreads the batch across more than one hour window', async () => {
    const rows = await db.select().from(emailJobs);
    const windows = new Set(rows.map((row) => Math.floor(row.scheduledAt.getTime() / 3_600_000)));
    assert.ok(windows.size >= 2, `expected at least 2 hour windows, saw ${windows.size}`);
  });

  test('the worker delivers exactly the hourly cap and no more', async () => {
    startWorker();
    await waitForDeliveries(HOURLY_CAP);
    assert.equal(smtp.received.length, HOURLY_CAP);
  });

  test('each delivery carries a unique idempotency header', () => {
    const headers = new Set(smtp.received.map((message) => message.jobHeader));
    assert.equal(headers.size, smtp.received.length);
  });

  test('throttled emails stay SCHEDULED — never FAILED, never dropped', async () => {
    const breakdown = await statusBreakdown();
    assert.equal(breakdown.SENT, HOURLY_CAP, JSON.stringify(breakdown));
    assert.equal(breakdown.SCHEDULED ?? 0, RECIPIENTS - HOURLY_CAP, JSON.stringify(breakdown));
    assert.equal(breakdown.FAILED ?? 0, 0, JSON.stringify(breakdown));
  });

  test('nothing is left sitting in the past', async () => {
    const rows = await db
      .select()
      .from(emailJobs)
      .where(eq(emailJobs.status, EmailStatus.SCHEDULED));

    // Two different mechanisms can put a row here: the planner, which saw the
    // hour was full before anything ran, and the runtime limiter, which pushed
    // a job it actually picked up. Either way the row must now carry a future
    // timestamp, because that timestamp is what the dashboard shows the user.
    for (const row of rows) {
      assert.ok(row.scheduledAt.getTime() > Date.now(), `${row.toEmail} was not pushed forward`);
    }
  });

  test('re-enqueuing already-sent jobs sends nothing extra', async () => {
    const sent = await db.select().from(emailJobs).where(eq(emailJobs.status, EmailStatus.SENT));
    await enqueueMany(sent);
    await sleep(2500);
    assert.equal(smtp.received.length, HOURLY_CAP);
  });

  test('after Redis is wiped, reconciliation re-arms only the pending rows', async () => {
    await stopWorker();
    await emailQueue.obliterate({ force: true });
    await redis.flushdb();

    const emptied = await emailQueue.getJobCounts('delayed', 'wait', 'active');
    assert.equal((emptied.delayed ?? 0) + (emptied.wait ?? 0) + (emptied.active ?? 0), 0);

    const report = await reconcilePendingJobs();
    assert.equal(report.requeued, RECIPIENTS - HOURLY_CAP, JSON.stringify(report));

    const rearmed = await emailQueue.getJobCounts('delayed', 'wait');
    assert.equal((rearmed.delayed ?? 0) + (rearmed.wait ?? 0), RECIPIENTS - HOURLY_CAP);
    // The crucial half of "survives a restart": nothing is replayed.
    assert.equal(smtp.received.length, HOURLY_CAP);
  });

  test('the remainder goes out once the hour window resets', async () => {
    // Clearing the counters is exactly what the clock does at the top of the
    // hour; doing it by hand keeps the test to a few seconds.
    await redis.flushdb();
    await emailQueue.obliterate({ force: true });
    await db
      .update(emailJobs)
      .set({ scheduledAt: new Date(Date.now() - 500) })
      .where(eq(emailJobs.status, EmailStatus.SCHEDULED));

    const pending = await db
      .select()
      .from(emailJobs)
      .where(eq(emailJobs.status, EmailStatus.SCHEDULED));

    await enqueueMany(pending);
    startWorker();
    await waitForDeliveries(RECIPIENTS);

    assert.equal(smtp.received.length, RECIPIENTS);
    const breakdown = await statusBreakdown();
    assert.equal(breakdown.SENT, RECIPIENTS, JSON.stringify(breakdown));
  });

  test('no recipient was ever emailed twice', () => {
    const everyRecipient = smtp.received.flatMap((message) => message.to);
    assert.equal(new Set(everyRecipient).size, everyRecipient.length);
  });

  test('the campaign closes itself once nothing is in flight', async () => {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    assert.equal(campaign!.status, 'COMPLETED');
  });
});
