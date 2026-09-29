/**
 * Schedules a large batch against the API so the deferral path can be observed
 * without hand-crafting a thousand rows.
 *
 *   npx tsx src/scripts/loadTest.ts <session-token> [count]
 *
 * Grab the session token from the browser devtools (localStorage key
 * `reachinbox.token`) after logging in.
 */
import { env } from '../config/env';

async function main(): Promise<void> {
  const token = process.argv[2];
  const count = Number(process.argv[3] ?? 1000);

  if (!token) {
    console.error('Usage: npx tsx src/scripts/loadTest.ts <session-token> [count]');
    process.exit(1);
  }

  const recipients = Array.from({ length: count }, (_, i) => `load-test-${i}@example.com`);

  const res = await fetch(`${env.BACKEND_URL}/api/emails/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      subject: `Load test batch of ${count}`,
      body: '<p>Throughput check for the ReachInbox scheduler.</p>',
      recipients,
      startAt: new Date(Date.now() + 5000).toISOString(),
      delayMs: 0,
      hourlyLimit: 50,
    }),
  });

  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
  console.log(
    `\nAll ${count} emails are scheduled for roughly the same moment with a 50/hour cap.`,
    '\nWatch http://localhost:4000/admin/queues: the delayed count should stay high',
    '\nwhile the sent count climbs at the configured pace.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
