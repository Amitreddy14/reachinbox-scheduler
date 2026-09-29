import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { slackIntegrations } from '../db/schema';
import { redis } from '../queue/connection';
import { env } from '../config/env';
import { childLogger } from '../config/logger';
import { currentWindowStart } from '../utils/time';

const log = childLogger('slack');

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_ACCESS_URL = 'https://slack.com/api/oauth.v2.access';
const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

export function slackConfigured(): boolean {
  return env.SLACK_CLIENT_ID.length > 0 && env.SLACK_CLIENT_SECRET.length > 0;
}

export function slackRedirectUri(): string {
  return `${env.BACKEND_URL}/api/slack/oauth/callback`;
}

/** Step 1 of the OAuth dance: where the browser should be sent. */
export function buildInstallUrl(state: string): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set('client_id', env.SLACK_CLIENT_ID);
  url.searchParams.set('scope', env.SLACK_SCOPES);
  url.searchParams.set('redirect_uri', slackRedirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  scope?: string;
  team?: { id: string; name: string };
  incoming_webhook?: { url: string; channel: string; channel_id: string };
}

/** Step 2: trade the temporary code for a token + incoming webhook. */
export async function exchangeCodeForToken(code: string): Promise<SlackOAuthResponse> {
  const body = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: slackRedirectUri(),
  });

  const res = await fetch(SLACK_ACCESS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  return (await res.json()) as SlackOAuthResponse;
}

export async function saveIntegration(userId: string, payload: SlackOAuthResponse): Promise<void> {
  if (!payload.ok || !payload.team) {
    throw new Error(payload.error ?? 'slack_oauth_failed');
  }

  const data = {
    teamId: payload.team.id,
    teamName: payload.team.name,
    channelId: payload.incoming_webhook?.channel_id ?? null,
    channelName: payload.incoming_webhook?.channel ?? null,
    webhookUrl: payload.incoming_webhook?.url ?? null,
    botToken: payload.access_token ?? null,
    scope: payload.scope ?? null,
  };

  await db
    .insert(slackIntegrations)
    .values({ userId, ...data })
    .onConflictDoUpdate({
      target: slackIntegrations.userId,
      set: { ...data, updatedAt: new Date() },
    });

  log.info({ userId, team: payload.team.name }, 'slack integration stored');
}

export async function disconnect(userId: string): Promise<void> {
  await db.delete(slackIntegrations).where(eq(slackIntegrations.userId, userId));
  log.info({ userId }, 'slack integration removed');
}

export interface RateLimitAlert {
  userId: string;
  senderEmail: string;
  limit: number;
  used: number;
  windowStart: number;
  resumesAt: Date;
  deferredCount: number;
  reason: 'SENDER_HOURLY_LIMIT' | 'GLOBAL_HOURLY_LIMIT';
}

function buildBlocks(alert: RateLimitAlert) {
  const scope =
    alert.reason === 'SENDER_HOURLY_LIMIT'
      ? `sender *${alert.senderEmail}*`
      : 'the *account-wide* hourly budget';

  return {
    text: `Hourly send limit reached for ${alert.senderEmail}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Hourly send limit reached', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Sending paused for ${scope}. Queued emails were pushed into the next hour window — nothing was dropped.`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Sender*\n${alert.senderEmail}` },
          { type: 'mrkdwn', text: `*Used this hour*\n${alert.used} / ${alert.limit}` },
          {
            type: 'mrkdwn',
            text: `*Sending resumes*\n<!date^${Math.floor(
              alert.resumesAt.getTime() / 1000,
            )}^{time}|${alert.resumesAt.toISOString()}>`,
          },
          { type: 'mrkdwn', text: `*Emails rescheduled*\n${alert.deferredCount}` },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'ReachInbox scheduler · automated alert' }],
      },
    ],
  };
}

async function postWebhook(url: string, payload: unknown): Promise<boolean> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    log.warn({ status: res.status, body: await res.text() }, 'slack webhook rejected the message');
    return false;
  }
  return true;
}

async function postChatMessage(token: string, channel: string, payload: ReturnType<typeof buildBlocks>) {
  const res = await fetch(SLACK_POST_MESSAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, ...payload }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) log.warn({ error: json.error }, 'chat.postMessage failed');
  return json.ok;
}

/**
 * Fire a Slack alert the first time a sender hits its ceiling inside a given
 * hour window.
 *
 * Three things this deliberately does NOT do:
 *   - throw when the user never connected Slack (that is a valid state),
 *   - require a redeploy after the user connects (the integration is read from
 *     the database on every alert),
 *   - spam one message per deferred email (a Redis SETNX collapses the burst
 *     into a single notification per sender per hour).
 */
export async function notifyRateLimitHit(alert: RateLimitAlert): Promise<boolean> {
  const dedupeKey = `slack:alert:${alert.userId}:${alert.senderEmail}:${alert.windowStart}`;
  const first = await redis.set(dedupeKey, '1', 'EX', 3900, 'NX');
  if (first !== 'OK') return false;

  const integration = await findIntegration(alert.userId);
  const payload = buildBlocks(alert);

  if (integration?.webhookUrl) {
    const ok = await postWebhook(integration.webhookUrl, payload);
    if (ok) {
      log.info({ userId: alert.userId, sender: alert.senderEmail }, 'slack alert delivered');
      return true;
    }
  }

  if (integration?.botToken && integration.channelId) {
    const ok = await postChatMessage(integration.botToken, integration.channelId, payload);
    if (ok) return true;
  }

  if (env.SLACK_FALLBACK_WEBHOOK_URL) {
    return postWebhook(env.SLACK_FALLBACK_WEBHOOK_URL, payload);
  }

  log.info({ userId: alert.userId }, 'rate limit hit but no Slack destination connected — skipping');
  // Release the dedupe key so the very next limit hit after the user connects
  // Slack produces a notification instead of being swallowed by this window.
  await redis.del(dedupeKey);
  return false;
}

async function findIntegration(userId: string) {
  const [integration] = await db
    .select()
    .from(slackIntegrations)
    .where(eq(slackIntegrations.userId, userId))
    .limit(1);
  return integration ?? null;
}

export async function getIntegration(userId: string) {
  const integration = await findIntegration(userId);
  if (!integration) return null;
  return {
    connected: true as const,
    teamName: integration.teamName,
    channelName: integration.channelName,
    connectedAt: integration.createdAt,
  };
}

/** Used by the dashboard's "send a test alert" button. */
export async function sendTestMessage(userId: string, senderEmail: string): Promise<boolean> {
  const now = Date.now();
  const windowStart = currentWindowStart(now);
  await redis.del(`slack:alert:${userId}:${senderEmail}:${windowStart}`);
  return notifyRateLimitHit({
    userId,
    senderEmail,
    limit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    used: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    windowStart,
    resumesAt: new Date(windowStart + 60 * 60 * 1000),
    deferredCount: 0,
    reason: 'SENDER_HOURLY_LIMIT',
  });
}
