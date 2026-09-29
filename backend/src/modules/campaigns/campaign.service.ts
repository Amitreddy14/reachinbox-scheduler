import { randomUUID } from 'node:crypto';
import { count, desc, eq } from 'drizzle-orm';
import { env } from '../../config/env';
import { db } from '../../db/client';
import { campaigns, emailJobs, EmailStatus, type EmailJob, type NewEmailJob } from '../../db/schema';
import { childLogger } from '../../config/logger';
import { enqueueMany, queueSnapshot } from '../../queue/scheduler';
import { queueJobIdFor } from '../../queue/queues';
import { bulkIndex } from '../../services/search';
import { planSchedule } from './planSchedule';
import { getActiveSenders } from '../senders/sender.service';
import { htmlToText } from '../../utils/csv';
import { ApiError } from '../../utils/errors';

export { planSchedule } from './planSchedule';
export type { PlannedSend } from './planSchedule';

const log = childLogger('campaigns');

export interface CreateCampaignInput {
  userId: string;
  subject: string;
  bodyHtml: string;
  recipients: string[];
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
  senderIds?: string[];
}

export interface CreateCampaignResult {
  id: string;
  totalRecipients: number;
  firstSendAt: Date;
  lastSendAt: Date;
  senders: { id: string; email: string }[];
  queue: Awaited<ReturnType<typeof queueSnapshot>>;
}

export async function createCampaign(
  input: CreateCampaignInput,
): Promise<CreateCampaignResult> {
  if (input.recipients.length === 0) {
    throw ApiError.badRequest('At least one valid recipient is required');
  }

  const allSenders = await getActiveSenders(input.userId);
  const selected = input.senderIds?.length
    ? allSenders.filter((sender) => input.senderIds?.includes(sender.id))
    : allSenders;

  if (selected.length === 0) {
    throw ApiError.badRequest('None of the selected senders belong to this account');
  }

  const hourlyLimit = Math.min(input.hourlyLimit, env.MAX_EMAILS_PER_HOUR_PER_SENDER);
  const delayMs = Math.max(input.delayMs, 0);
  const bodyText = htmlToText(input.bodyHtml);

  const campaignId = randomUUID();
  const plan = planSchedule(input.recipients, selected, input.startAt, delayMs, hourlyLimit);

  const rows: NewEmailJob[] = plan.map((item) => {
    const id = randomUUID();
    return {
      id,
      campaignId,
      userId: input.userId,
      senderId: item.senderId,
      toEmail: item.toEmail,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText,
      status: EmailStatus.SCHEDULED,
      scheduledAt: item.scheduledAt,
      sequence: item.sequence,
      queueJobId: queueJobIdFor(id),
    };
  });

  // Postgres first, Redis second. If the process dies between the two, the rows
  // are still SCHEDULED and the boot-time reconciler arms them — the inverse
  // order would risk sending an email no row knows about.
  const inserted = await db.transaction(async (tx) => {
    await tx.insert(campaigns).values({
      id: campaignId,
      userId: input.userId,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText,
      startAt: input.startAt,
      delayMs,
      hourlyLimit,
      totalRecipients: rows.length,
    });

    // Chunked so a very large list does not exceed the Postgres parameter cap.
    const created: EmailJob[] = [];
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const result = await tx.insert(emailJobs).values(chunk).returning();
      created.push(...result);
    }
    return created;
  });

  await enqueueMany(inserted);

  const senderEmailById = new Map(selected.map((sender) => [sender.id, sender.email]));
  void bulkIndex(inserted, senderEmailById);

  log.info(
    { campaignId, recipients: inserted.length, senders: selected.length },
    'campaign scheduled',
  );

  const sorted = [...inserted].sort(
    (a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime(),
  );

  return {
    id: campaignId,
    totalRecipients: inserted.length,
    firstSendAt: sorted[0]?.scheduledAt ?? input.startAt,
    lastSendAt: sorted[sorted.length - 1]?.scheduledAt ?? input.startAt,
    senders: selected.map((sender) => ({ id: sender.id, email: sender.email })),
    queue: await queueSnapshot(),
  };
}

export interface CampaignSummary {
  id: string;
  subject: string;
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
  totalRecipients: number;
  status: string;
  createdAt: string;
  breakdown: Record<string, number>;
}

export async function listCampaigns(userId: string): Promise<CampaignSummary[]> {
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.userId, userId))
    .orderBy(desc(campaigns.createdAt))
    .limit(50);

  const grouped = await db
    .select({
      campaignId: emailJobs.campaignId,
      status: emailJobs.status,
      total: count(),
    })
    .from(emailJobs)
    .where(eq(emailJobs.userId, userId))
    .groupBy(emailJobs.campaignId, emailJobs.status);

  const byCampaign = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    const bucket = byCampaign.get(row.campaignId) ?? {};
    bucket[row.status] = row.total;
    byCampaign.set(row.campaignId, bucket);
  }

  return rows.map((campaign) => ({
    id: campaign.id,
    subject: campaign.subject,
    startAt: campaign.startAt.toISOString(),
    delayMs: campaign.delayMs,
    hourlyLimit: campaign.hourlyLimit,
    totalRecipients: campaign.totalRecipients,
    status: campaign.status,
    createdAt: campaign.createdAt.toISOString(),
    breakdown: byCampaign.get(campaign.id) ?? {},
  }));
}
