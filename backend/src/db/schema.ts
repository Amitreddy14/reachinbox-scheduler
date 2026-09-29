import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Postgres is the source of truth for *what* should be sent and *what already
 * was*. Redis/BullMQ is only the timer. That split is deliberate: Redis can be
 * flushed entirely and the system still rebuilds every pending job from these
 * tables (see src/queue/reconcile.ts).
 */

export const emailStatus = pgEnum('email_status', [
  'SCHEDULED', // row exists, a delayed job is armed in BullMQ
  'QUEUED', // delay elapsed, waiting for a free worker slot
  'SENDING', // latched by exactly one worker
  'SENT',
  'FAILED',
  'CANCELLED',
]);

export const campaignStatus = pgEnum('campaign_status', ['ACTIVE', 'COMPLETED', 'CANCELLED']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    googleId: text('google_id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    googleIdIdx: uniqueIndex('users_google_id_key').on(table.googleId),
    emailIdx: uniqueIndex('users_email_key').on(table.email),
  }),
);

/**
 * A sender is one outbound SMTP identity (one Ethereal mailbox). Hourly quotas
 * and the minimum gap between sends are enforced per sender, because that is
 * how real email providers throttle.
 */
export const senders = pgTable(
  'senders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    smtpHost: text('smtp_host').notNull(),
    smtpPort: integer('smtp_port').notNull(),
    smtpSecure: boolean('smtp_secure').notNull().default(false),
    smtpUser: text('smtp_user').notNull(),
    smtpPassword: text('smtp_password').notNull(),
    /** Null falls back to the global env defaults. */
    hourlyLimit: integer('hourly_limit'),
    minGapMs: integer('min_gap_ms'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userEmailIdx: uniqueIndex('senders_user_email_key').on(table.userId, table.email),
    activeIdx: index('senders_user_active_idx').on(table.userId, table.isActive),
  }),
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    bodyText: text('body_text').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    /** Requested spacing between two consecutive emails of this campaign. */
    delayMs: integer('delay_ms').notNull(),
    /** Requested per-sender hourly ceiling for this campaign. */
    hourlyLimit: integer('hourly_limit').notNull(),
    totalRecipients: integer('total_recipients').notNull(),
    status: campaignStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('campaigns_user_created_idx').on(table.userId, table.createdAt),
  }),
);

export const emailJobs = pgTable(
  'email_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => senders.id, { onDelete: 'restrict' }),

    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    bodyText: text('body_text').notNull(),

    status: emailStatus('status').notNull().default('SCHEDULED'),
    /**
     * When this row is *supposed* to go out. Rewritten whenever the rate
     * limiter pushes it into a later window, so the dashboard always shows the
     * time the recipient will actually receive it.
     */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    /** Position inside the campaign; restores FIFO order after a deferral. */
    sequence: integer('sequence').notNull(),

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    messageId: text('message_id'),
    previewUrl: text('preview_url'),
    /**
     * Deterministic BullMQ job id derived from this row's id. Re-adding a job
     * with the same id is a no-op in Redis — idempotency guard #1.
     */
    queueJobId: text('queue_job_id').notNull(),
    deferCount: integer('defer_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    queueJobIdKey: uniqueIndex('email_jobs_queue_job_id_key').on(table.queueJobId),
    userStatusIdx: index('email_jobs_user_status_idx').on(
      table.userId,
      table.status,
      table.scheduledAt,
    ),
    campaignSeqIdx: index('email_jobs_campaign_sequence_idx').on(table.campaignId, table.sequence),
    senderStatusIdx: index('email_jobs_sender_status_idx').on(table.senderId, table.status),
  }),
);

export const slackIntegrations = pgTable(
  'slack_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    teamId: text('team_id').notNull(),
    teamName: text('team_name').notNull(),
    channelId: text('channel_id'),
    channelName: text('channel_name'),
    /** Incoming webhook captured during the OAuth grant — preferred path. */
    webhookUrl: text('webhook_url'),
    /** Bot token, used as the chat.postMessage fallback. */
    botToken: text('bot_token'),
    scope: text('scope'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: uniqueIndex('slack_integrations_user_key').on(table.userId),
  }),
);

/* ------------------------------------------------------------------ */
/* Relations (used by the query builder's `with` joins)                */
/* ------------------------------------------------------------------ */

export const usersRelations = relations(users, ({ many, one }) => ({
  senders: many(senders),
  campaigns: many(campaigns),
  emailJobs: many(emailJobs),
  slack: one(slackIntegrations),
}));

export const sendersRelations = relations(senders, ({ one, many }) => ({
  user: one(users, { fields: [senders.userId], references: [users.id] }),
  emailJobs: many(emailJobs),
}));

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  user: one(users, { fields: [campaigns.userId], references: [users.id] }),
  emailJobs: many(emailJobs),
}));

export const emailJobsRelations = relations(emailJobs, ({ one }) => ({
  campaign: one(campaigns, { fields: [emailJobs.campaignId], references: [campaigns.id] }),
  user: one(users, { fields: [emailJobs.userId], references: [users.id] }),
  sender: one(senders, { fields: [emailJobs.senderId], references: [senders.id] }),
}));

export const slackIntegrationsRelations = relations(slackIntegrations, ({ one }) => ({
  user: one(users, { fields: [slackIntegrations.userId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ */
/* Inferred row types — the single source of truth for the whole app   */
/* ------------------------------------------------------------------ */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Sender = typeof senders.$inferSelect;
export type NewSender = typeof senders.$inferInsert;
export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type EmailJob = typeof emailJobs.$inferSelect;
export type NewEmailJob = typeof emailJobs.$inferInsert;
export type SlackIntegration = typeof slackIntegrations.$inferSelect;

export type EmailStatusValue = (typeof emailStatus.enumValues)[number];
export type CampaignStatusValue = (typeof campaignStatus.enumValues)[number];

export const EmailStatus = {
  SCHEDULED: 'SCHEDULED',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const satisfies Record<string, EmailStatusValue>;
