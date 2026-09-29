import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { redis } from '../../queue/connection';
import { asyncHandler } from '../../utils/async';
import { requireAuth, currentUser } from '../../middleware/auth';
import { ApiError } from '../../utils/errors';
import {
  buildInstallUrl,
  disconnect,
  exchangeCodeForToken,
  getIntegration,
  saveIntegration,
  sendTestMessage,
  slackConfigured,
} from '../../services/slack';

const router = Router();

const STATE_TTL_SECONDS = 600;
const stateKey = (state: string) => `slack:oauth:state:${state}`;

/**
 * GET /api/slack/status  — is this account connected?
 */
router.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const integration = await getIntegration(user.id);
    res.json({
      configured: slackConfigured(),
      integration: integration ?? { connected: false },
      fallbackWebhookConfigured: env.SLACK_FALLBACK_WEBHOOK_URL.length > 0,
    });
  }),
);

/**
 * POST /api/slack/install-url
 *
 * The browser cannot send an Authorization header on a top-level redirect, so
 * the session is pinned to a short-lived random `state` here and read back in
 * the callback. That doubles as CSRF protection for the OAuth round trip.
 */
router.post(
  '/install-url',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!slackConfigured()) {
      throw ApiError.unprocessable(
        'Slack is not configured on the server. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.',
      );
    }
    const user = currentUser(req);
    const state = randomUUID();
    await redis.set(stateKey(state), user.id, 'EX', STATE_TTL_SECONDS);
    res.json({ url: buildInstallUrl(state) });
  }),
);

/**
 * GET /api/slack/oauth/callback — Slack redirects the browser here.
 */
router.get(
  '/oauth/callback',
  asyncHandler(async (req, res) => {
    const query = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(req.query);

    const redirect = (status: string) =>
      res.redirect(`${env.FRONTEND_URL}/dashboard?slack=${encodeURIComponent(status)}`);

    if (query.error) return redirect(`error:${query.error}`);
    if (!query.code || !query.state) return redirect('error:missing_code');

    const userId = await redis.get(stateKey(query.state));
    if (!userId) return redirect('error:state_expired');
    await redis.del(stateKey(query.state));

    try {
      const payload = await exchangeCodeForToken(query.code);
      await saveIntegration(userId, payload);
      return redirect('connected');
    } catch (err) {
      return redirect(`error:${(err as Error).message}`);
    }
  }),
);

router.post(
  '/disconnect',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await disconnect(user.id);
    res.json({ connected: false });
  }),
);

/** Proves the wiring end to end without waiting for a real limit breach. */
router.post(
  '/test',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const delivered = await sendTestMessage(user.id, user.email);
    res.json({
      delivered,
      message: delivered
        ? 'Test alert posted to Slack'
        : 'No Slack destination is connected for this account',
    });
  }),
);

export default router;
