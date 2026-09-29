import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/async';
import { requireAuth, currentUser } from '../../middleware/auth';
import { env } from '../../config/env';
import { extractEmails, isValidEmail } from '../../utils/csv';
import { createCampaign, listCampaigns } from '../campaigns/campaign.service';
import { cancelEmail, getEmail, listEmails, statusCounts } from './email.service';
import { queueSnapshot } from '../../queue/scheduler';
import { reindexAll } from '../../services/search';

const router = Router();
router.use(requireAuth);

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

const scheduleSchema = z
  .object({
    subject: z.string().trim().min(1, 'Subject is required').max(300),
    body: z.string().trim().min(1, 'Body is required'),
    /** Either an explicit list... */
    recipients: z.array(z.string()).optional(),
    /** ...or the raw contents of the uploaded CSV/text file. */
    csvText: z.string().optional(),
    startAt: z.coerce.date().optional(),
    delayMs: z.number().int().min(0).max(60 * 60 * 1000).optional(),
    hourlyLimit: z.number().int().positive().optional(),
    senderIds: z.array(z.string().uuid()).optional(),
  })
  .refine((value) => Boolean(value.recipients?.length) || Boolean(value.csvText?.trim()), {
    message: 'Provide recipients or the contents of a lead file',
    path: ['recipients'],
  });

router.post(
  '/schedule',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const input = scheduleSchema.parse(req.body);

    const fromCsv = input.csvText ? extractEmails(input.csvText).emails : [];
    const fromList = (input.recipients ?? []).map((value) => value.trim().toLowerCase());
    const merged = [...new Set([...fromCsv, ...fromList])].filter(isValidEmail);

    const result = await createCampaign({
      userId: user.id,
      subject: input.subject,
      bodyHtml: input.body,
      recipients: merged,
      startAt: input.startAt ?? new Date(),
      delayMs: input.delayMs ?? env.MIN_GAP_MS_PER_SENDER,
      hourlyLimit: input.hourlyLimit ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      senderIds: input.senderIds,
    });

    res.status(201).json({ campaign: result, recipientsAccepted: merged.length });
  }),
);

/** Client-side preview of a lead file before committing to a schedule. */
router.post(
  '/parse-leads',
  asyncHandler(async (req, res) => {
    const { csvText } = z.object({ csvText: z.string() }).parse(req.body);
    const parsed = extractEmails(csvText);
    res.json({
      count: parsed.emails.length,
      duplicates: parsed.duplicates,
      invalidLines: parsed.invalidLines,
      sample: parsed.emails.slice(0, 5),
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const listSchema = z.object({
  tab: z.enum(['scheduled', 'sent', 'all']).default('scheduled'),
  q: z.string().trim().optional(),
  campaignId: z.string().uuid().optional(),
  senderId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = listSchema.parse(req.query);
    res.json(await listEmails({ userId: user.id, ...query }));
  }),
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const [counts, queue] = await Promise.all([statusCounts(user.id), queueSnapshot()]);
    res.json({ counts, queue });
  }),
);

router.get(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ campaigns: await listCampaigns(user.id) });
  }),
);

router.get(
  '/:emailId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ email: await getEmail(user.id, req.params.emailId as string) });
  }),
);

router.post(
  '/:emailId/cancel',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const email = await cancelEmail(user.id, req.params.emailId as string);
    res.json({ email: { id: email.id, status: email.status } });
  }),
);

/** Rebuild the search index from Postgres. Handy after a fresh ES container. */
router.post(
  '/admin/reindex',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ indexed: await reindexAll(user.id) });
  }),
);

export default router;
