/**
 * Provisions Ethereal mailboxes and prints them in .env form.
 *
 *   npm run seed:senders
 *
 * Paste the output into backend/.env to keep the same inboxes across database
 * resets — useful when recording the demo video, because the Ethereal message
 * list stays in one place.
 */
import { createEtherealAccount } from '../services/mailer';
import { env } from '../config/env';

async function main(): Promise<void> {
  const count = env.ETHEREAL_SENDER_COUNT;
  const accounts = await Promise.all(
    Array.from({ length: count }, () => createEtherealAccount()),
  );

  console.log('\nEthereal mailboxes created. Sign in at https://ethereal.email/login\n');
  console.log(`SMTP_HOST=${accounts[0]?.host ?? 'smtp.ethereal.email'}`);
  console.log(`SMTP_PORT=${accounts[0]?.port ?? 587}\n`);

  accounts.forEach((account, index) => {
    const n = index + 1;
    console.log(`SENDER_${n}_EMAIL=${account.email}`);
    console.log(`SENDER_${n}_USER=${account.user}`);
    console.log(`SENDER_${n}_PASSWORD=${account.password}`);
    console.log('');
  });

  console.log('Set ETHEREAL_AUTO_PROVISION=false once these are in place.\n');
}

main().catch((err) => {
  console.error('Failed to create Ethereal accounts:', err);
  process.exit(1);
});
