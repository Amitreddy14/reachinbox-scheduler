import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes';
import emailRoutes from '../modules/emails/email.routes';
import senderRoutes from '../modules/senders/sender.routes';
import slackRoutes from '../modules/slack/slack.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/emails', emailRoutes);
router.use('/senders', senderRoutes);
router.use('/slack', slackRoutes);

export default router;
