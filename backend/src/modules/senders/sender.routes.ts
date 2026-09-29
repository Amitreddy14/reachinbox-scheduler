import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/async';
import { requireAuth, currentUser } from '../../middleware/auth';
import { listSenders, updateSender, ensureSendersForUser } from './sender.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await ensureSendersForUser(user.id);
    res.json({ senders: await listSenders(user.id) });
  }),
);

const patchSchema = z.object({
  hourlyLimit: z.number().int().positive().optional(),
  minGapMs: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  displayName: z.string().min(1).max(80).optional(),
});

router.patch(
  '/:senderId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const patch = patchSchema.parse(req.body);
    const sender = await updateSender(user.id, req.params.senderId as string, patch);
    res.json({ sender: { id: sender.id, email: sender.email, isActive: sender.isActive } });
  }),
);

export default router;
