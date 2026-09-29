import nodemailer, { type Transporter } from 'nodemailer';
import type { Sender } from '../db/schema';
import { childLogger } from '../config/logger';

const log = childLogger('mailer');

/**
 * One pooled SMTP connection per sender, created lazily and reused for the
 * lifetime of the process. Opening a fresh connection per email is the usual
 * reason a "fast" scheduler turns out to be slow.
 */
const transports = new Map<string, Transporter>();

export function getTransport(sender: Sender): Transporter {
  const key = `${sender.id}:${sender.smtpUser}`;
  const existing = transports.get(key);
  if (existing) return existing;

  const transport = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    auth: { user: sender.smtpUser, pass: sender.smtpPassword },
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  transports.set(key, transport);
  return transport;
}

export interface SendResult {
  messageId: string;
  previewUrl: string | null;
  accepted: string[];
  rejected: string[];
}

export interface SendInput {
  sender: Sender;
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Stable per-email identifier. It travels as the SMTP Message-ID and as an
   * X-header, so a duplicate would be visible in the received mail itself and
   * not only in our logs.
   */
  idempotencyKey: string;
}

export async function sendEmail(input: SendInput): Promise<SendResult> {
  const transport = getTransport(input.sender);

  const info = await transport.sendMail({
    from: `"${input.sender.displayName}" <${input.sender.email}>`,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    messageId: `<${input.idempotencyKey}@reachinbox.local>`,
    headers: { 'X-Scheduler-Job-Id': input.idempotencyKey },
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);

  return {
    messageId: info.messageId,
    previewUrl: typeof previewUrl === 'string' ? previewUrl : null,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}

/** Creates a throwaway Ethereal mailbox. Used by the provisioning script. */
export async function createEtherealAccount(): Promise<{
  email: string;
  user: string;
  password: string;
  host: string;
  port: number;
  secure: boolean;
}> {
  const account = await nodemailer.createTestAccount();
  return {
    email: account.user,
    user: account.user,
    password: account.pass,
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
  };
}

export async function verifyTransport(sender: Sender): Promise<boolean> {
  try {
    await getTransport(sender).verify();
    return true;
  } catch (err) {
    log.warn({ err, sender: sender.email }, 'SMTP verification failed');
    return false;
  }
}

export function closeTransports(): void {
  for (const transport of transports.values()) transport.close();
  transports.clear();
}
