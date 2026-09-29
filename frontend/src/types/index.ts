/**
 * Shapes returned by the Express API. Kept in one place so a change in the
 * backend contract surfaces as a compile error rather than a runtime blank.
 */

export type EmailStatus =
  | 'SCHEDULED'
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'CANCELLED';

export interface AppUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface EmailListItem {
  id: string;
  toEmail: string;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  senderEmail: string;
  previewUrl: string | null;
  lastError: string | null;
  attempts: number;
  deferCount: number;
}

export interface EmailListResponse {
  items: EmailListItem[];
  total: number;
  page: number;
  pageSize: number;
  engine: 'elasticsearch' | 'postgres';
}

export interface Sender {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  hourlyLimit: number;
  minGapMs: number;
  usedThisHour: number;
  windowEndsAt: string;
}

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
}

export interface StatsResponse {
  counts: Record<string, number> & { scheduledTotal: number; sentTotal: number };
  queue: QueueCounts;
}

export interface ServerConfig {
  minGapMsPerSender: number;
  maxEmailsPerHourPerSender: number;
  maxEmailsPerHourGlobal: number;
  workerConcurrency: number;
  queueDashboardUrl: string;
}

export interface SlackStatus {
  configured: boolean;
  integration:
    | { connected: true; teamName: string; channelName: string | null; connectedAt: string }
    | { connected: false };
  fallbackWebhookConfigured: boolean;
}

export interface ScheduleRequest {
  subject: string;
  body: string;
  recipients: string[];
  startAt: string;
  delayMs: number;
  hourlyLimit: number;
  senderIds?: string[];
}

export interface ScheduleResponse {
  campaign: {
    id: string;
    totalRecipients: number;
    firstSendAt: string;
    lastSendAt: string;
    senders: { id: string; email: string }[];
    queue: QueueCounts;
  };
  recipientsAccepted: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
