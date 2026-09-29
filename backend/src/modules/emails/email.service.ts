import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  emailJobs,
  senders,
  EmailStatus,
  type EmailStatusValue,
} from '../../db/schema';
import { searchEmails } from '../../services/search';
import { cancelEmailJob } from '../../queue/scheduler';
import { ApiError } from '../../utils/errors';

export const SCHEDULED_STATUSES: EmailStatusValue[] = [
  EmailStatus.SCHEDULED,
  EmailStatus.QUEUED,
  EmailStatus.SENDING,
];

export const SENT_STATUSES: EmailStatusValue[] = [EmailStatus.SENT, EmailStatus.FAILED];

export interface ListEmailsInput {
  userId: string;
  tab: 'scheduled' | 'sent' | 'all';
  q?: string;
  campaignId?: string;
  senderId?: string;
  page: number;
  pageSize: number;
}

export interface EmailListItem {
  id: string;
  toEmail: string;
  subject: string;
  status: EmailStatusValue;
  scheduledAt: string;
  sentAt: string | null;
  senderEmail: string;
  previewUrl: string | null;
  lastError: string | null;
  attempts: number;
  deferCount: number;
}

export interface ListEmailsResult {
  items: EmailListItem[];
  total: number;
  page: number;
  pageSize: number;
  engine: 'elasticsearch' | 'postgres';
}

/**
 * Listing always goes through the search layer so the search box and the plain
 * table share one code path. Elasticsearch returns the matching ids in order
 * and Postgres hydrates them, which keeps the index small and the rows
 * authoritative — an email is never shown as "sent" because the index is stale.
 */
export async function listEmails(input: ListEmailsInput): Promise<ListEmailsResult> {
  const statuses =
    input.tab === 'scheduled'
      ? SCHEDULED_STATUSES
      : input.tab === 'sent'
        ? SENT_STATUSES
        : undefined;

  const from = (input.page - 1) * input.pageSize;

  const outcome = await searchEmails({
    userId: input.userId,
    q: input.q,
    statuses,
    campaignId: input.campaignId,
    senderId: input.senderId,
    from,
    size: input.pageSize,
    sort: input.tab === 'sent' ? 'sentAt' : 'scheduledAt',
    order: input.tab === 'sent' ? 'desc' : 'asc',
  });

  if (outcome.ids.length === 0) {
    return {
      items: [],
      total: outcome.total,
      page: input.page,
      pageSize: input.pageSize,
      engine: outcome.engine,
    };
  }

  const rows = await db
    .select({
      id: emailJobs.id,
      toEmail: emailJobs.toEmail,
      subject: emailJobs.subject,
      status: emailJobs.status,
      scheduledAt: emailJobs.scheduledAt,
      sentAt: emailJobs.sentAt,
      previewUrl: emailJobs.previewUrl,
      lastError: emailJobs.lastError,
      attempts: emailJobs.attempts,
      deferCount: emailJobs.deferCount,
      senderEmail: senders.email,
    })
    .from(emailJobs)
    .innerJoin(senders, eq(emailJobs.senderId, senders.id))
    .where(and(inArray(emailJobs.id, outcome.ids), eq(emailJobs.userId, input.userId)));

  // Preserve the relevance/sort order the search engine returned.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const items: EmailListItem[] = outcome.ids
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => ({
      id: row.id,
      toEmail: row.toEmail,
      subject: row.subject,
      status: row.status,
      scheduledAt: row.scheduledAt.toISOString(),
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      senderEmail: row.senderEmail,
      previewUrl: row.previewUrl,
      lastError: row.lastError,
      attempts: row.attempts,
      deferCount: row.deferCount,
    }));

  return {
    items,
    total: outcome.total,
    page: input.page,
    pageSize: input.pageSize,
    engine: outcome.engine,
  };
}

export async function getEmail(userId: string, emailId: string) {
  const [row] = await db
    .select({
      email: emailJobs,
      senderEmail: senders.email,
      senderName: senders.displayName,
    })
    .from(emailJobs)
    .innerJoin(senders, eq(emailJobs.senderId, senders.id))
    .where(and(eq(emailJobs.id, emailId), eq(emailJobs.userId, userId)))
    .limit(1);

  if (!row) throw ApiError.notFound('Email not found');
  return { ...row.email, senderEmail: row.senderEmail, senderName: row.senderName };
}

export async function cancelEmail(userId: string, emailId: string) {
  const [row] = await db
    .select()
    .from(emailJobs)
    .where(and(eq(emailJobs.id, emailId), eq(emailJobs.userId, userId)))
    .limit(1);

  if (!row) throw ApiError.notFound('Email not found');
  if (row.status === EmailStatus.SENT) throw ApiError.conflict('This email has already been sent');
  if (row.status === EmailStatus.SENDING) {
    throw ApiError.conflict('This email is being sent right now and can no longer be cancelled');
  }

  await cancelEmailJob(emailId);

  const [updated] = await db
    .update(emailJobs)
    .set({ status: EmailStatus.CANCELLED, updatedAt: new Date() })
    .where(eq(emailJobs.id, emailId))
    .returning();

  if (!updated) throw ApiError.notFound('Email not found');
  return updated;
}

export interface StatusCounts extends Record<string, number> {
  scheduledTotal: number;
  sentTotal: number;
}

export async function statusCounts(userId: string): Promise<StatusCounts> {
  const grouped = await db
    .select({ status: emailJobs.status, total: count() })
    .from(emailJobs)
    .where(eq(emailJobs.userId, userId))
    .groupBy(emailJobs.status);

  const base: Record<string, number> = {
    SCHEDULED: 0,
    QUEUED: 0,
    SENDING: 0,
    SENT: 0,
    FAILED: 0,
    CANCELLED: 0,
  };
  for (const row of grouped) base[row.status] = row.total;

  return {
    ...base,
    scheduledTotal:
      (base.SCHEDULED ?? 0) + (base.QUEUED ?? 0) + (base.SENDING ?? 0),
    sentTotal: (base.SENT ?? 0) + (base.FAILED ?? 0),
  };
}
