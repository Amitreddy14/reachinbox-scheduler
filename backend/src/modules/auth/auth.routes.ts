import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/async';
import { requireAuth, currentUser } from '../../middleware/auth';
import { ensureSendersForUser } from '../senders/sender.service';
import { issueSessionToken, upsertUser, verifyGoogleIdToken } from './auth.service';

const router = Router();

const googleSchema = z.object({
  idToken: z.string().min(20, 'A Google ID token is required'),
});

/**
 * POST /api/auth/google
 * Exchanges a verified Google ID token for this API's own session token.
 * Provisioning the account's senders happens here so the dashboard is usable
 * the moment login finishes.
 */
router.post(
  '/google',
  asyncHandler(async (req, res) => {
    const { idToken } = googleSchema.parse(req.body);

    const profile = await verifyGoogleIdToken(idToken);
    const user = await upsertUser(profile);
    await ensureSendersForUser(user.id);

    res.json({
      token: issueSessionToken(user),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
    });
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
    });
  }),
);

export default router;
