import { and, asc, eq } from 'drizzle-orm';
import { env, staticSenders } from '../../config/env';
import { db } from '../../db/client';
import { senders, type NewSender, type Sender } from '../../db/schema';
import { childLogger } from '../../config/logger';
import { createEtherealAccount } from '../../services/mailer';
import { senderUsage } from '../../services/rateLimiter';
import { ApiError } from '../../utils/errors';

const log = childLogger('senders');

/**
 * Every account needs at least one outbound identity before it can schedule
 * anything. Two ways to get there:
 *
 *   - SENDER_n_* in .env, for a stable demo where the same Ethereal inboxes
 *     survive a database reset,
 *   - ETHEREAL_AUTO_PROVISION, which mints fresh Ethereal mailboxes on first
 *     login so the project runs with zero manual setup.
 *
 * Several senders exist because the hourly quota is enforced per sender; with a
 * single mailbox there is nothing to demonstrate and no way to scale out.
 */
export async function ensureSendersForUser(userId: string): Promise<Sender[]> {
  const existing = await db
    .select()
    .from(senders)
    .where(eq(senders.userId, userId))
    .orderBy(asc(senders.createdAt));

  if (existing.length > 0) return existing;

  const configured = staticSenders();

  const rows: NewSender[] = configured.length
    ? configured.map((sender, index) => ({
        userId,
        email: sender.email,
        displayName: `Outreach ${index + 1}`,
        smtpHost: env.SMTP_HOST,
        smtpPort: env.SMTP_PORT,
        smtpSecure: env.SMTP_PORT === 465,
        smtpUser: sender.user,
        smtpPassword: sender.password,
      }))
    : await provisionEthereal(userId);

  const created = await db.insert(senders).values(rows).returning();

  log.info(
    { userId, senders: created.map((sender) => sender.email) },
    configured.length
      ? 'senders created from environment config'
      : 'provisioned Ethereal senders — sign in at https://ethereal.email/login to read them',
  );

  return created;
}

async function provisionEthereal(userId: string): Promise<NewSender[]> {
  if (!env.ETHEREAL_AUTO_PROVISION) {
    throw ApiError.unprocessable(
      'No senders configured. Set SENDER_1_* in .env or enable ETHEREAL_AUTO_PROVISION.',
    );
  }

  const accounts = await Promise.all(
    Array.from({ length: env.ETHEREAL_SENDER_COUNT }, () => createEtherealAccount()),
  );

  return accounts.map((account, index) => ({
    userId,
    email: account.email,
    displayName: `Outreach ${index + 1}`,
    smtpHost: account.host,
    smtpPort: account.port,
    smtpSecure: account.secure,
    smtpUser: account.user,
    smtpPassword: account.password,
  }));
}

export interface SenderSummary {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  hourlyLimit: number;
  minGapMs: number;
  usedThisHour: number;
  windowEndsAt: string;
}

export async function listSenders(userId: string): Promise<SenderSummary[]> {
  const rows = await db
    .select()
    .from(senders)
    .where(eq(senders.userId, userId))
    .orderBy(asc(senders.createdAt));

  return Promise.all(
    rows.map(async (sender) => {
      const usage = await senderUsage(userId, sender.id);
      return {
        id: sender.id,
        email: sender.email,
        displayName: sender.displayName,
        isActive: sender.isActive,
        hourlyLimit: sender.hourlyLimit ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        minGapMs: sender.minGapMs ?? env.MIN_GAP_MS_PER_SENDER,
        usedThisHour: usage.used,
        windowEndsAt: new Date(usage.windowEndsAt).toISOString(),
      };
    }),
  );
}

export async function getActiveSenders(userId: string): Promise<Sender[]> {
  const rows = await db
    .select()
    .from(senders)
    .where(and(eq(senders.userId, userId), eq(senders.isActive, true)))
    .orderBy(asc(senders.createdAt));

  if (rows.length === 0) {
    throw ApiError.unprocessable('This account has no active sender to send from');
  }
  return rows;
}

export interface SenderPatch {
  hourlyLimit?: number;
  minGapMs?: number;
  isActive?: boolean;
  displayName?: string;
}

export async function updateSender(
  userId: string,
  senderId: string,
  patch: SenderPatch,
): Promise<Sender> {
  const [existing] = await db
    .select()
    .from(senders)
    .where(and(eq(senders.id, senderId), eq(senders.userId, userId)))
    .limit(1);

  if (!existing) throw ApiError.notFound('Sender not found');

  const [updated] = await db
    .update(senders)
    .set({
      ...(patch.hourlyLimit !== undefined
        ? { hourlyLimit: Math.min(patch.hourlyLimit, env.MAX_EMAILS_PER_HOUR_PER_SENDER) }
        : {}),
      ...(patch.minGapMs !== undefined ? { minGapMs: patch.minGapMs } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      updatedAt: new Date(),
    })
    .where(eq(senders.id, senderId))
    .returning();

  if (!updated) throw ApiError.notFound('Sender not found');
  return updated;
}
