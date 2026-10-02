# ReachInbox / Outbox Labs — submission record

**Status:** submitted. Private GitHub repo pushed, access granted to `Mitrajit` and
`Yadav036`, demo video recorded and included in the repo.

**One item to confirm:** the Slack OAuth flow was implemented and typechecks, but an
end-to-end run (ngrok tunnel → authorize → live alert in a channel) was never
completed.

---

## What was built

A full-stack email job scheduler. Express + TypeScript API, Postgres via Drizzle,
BullMQ delayed jobs on Redis, Ethereal SMTP across three sender mailboxes,
Elasticsearch indexing with a Postgres fallback, Bull Board at `/admin/queues`, and a
Next.js App Router dashboard with real Google OAuth.

Verified working on the dev machine: scheduling, multi-sender round-robin, per-sender
hourly caps (observed 5/5 · 5/5 · 4/5), over-limit deferral with `Failed 0`, search,
Scheduled/Sent tables, compose with CSV upload.

Test suites: 19 unit tests, plus an 11-assertion end-to-end suite that runs the real
scheduler against a real Postgres, a real Redis and a stub SMTP server.

---

## The decisions to be ready to defend

These are the design calls that an interviewer is most likely to probe. The reasoning
matters more than the implementation here — the code is on GitHub, the judgement is not.

### Why delayed jobs instead of cron

A cron tick has to ask "what is due now?" That means either polling the database on an
interval — latency equal to the interval, and a thundering herd at every tick — or
holding schedules in process memory, which is lost on restart. With a BullMQ delayed
job, the due time *is* the sorted-set score. There is nothing to poll, and it behaves
identically across however many worker processes are running.

### Postgres is the truth, Redis is only the timer

This single split is where most of the other answers come from. Postgres holds what
should be sent and what already was; Redis holds when, and the quota counters. Postgres
is always written before Redis, so the worst case is a row with no job — which the boot
reconciler repairs — rather than a job with no row, which would be an email nobody can
account for.

### Idempotency — three independent guards

1. **Deterministic job ids.** The BullMQ job id is derived from the database row id
   (`email-<uuid>`). Re-adding an existing id is a no-op in Redis, so a retried API
   call, a double-clicked Schedule button and the boot reconciler can all try to enqueue
   the same email without producing a second job.
2. **Terminal-state check.** The processor re-reads the row and returns early if it is
   already `SENT` or `CANCELLED`, before touching SMTP.
3. **The claim.** A conditional `UPDATE ... WHERE id = $1 AND status IN ('SCHEDULED',
   'QUEUED')`. Postgres serialises it, so if two workers somehow get the same job
   exactly one gets a row back. This is what makes double-sending *impossible* rather
   than merely unlikely.

Plus a belt-and-braces check at the SMTP layer: every message carries
`Message-ID: <rowId@...>` and an `X-Scheduler-Job-Id` header, so a duplicate would show
up in the received mail itself, not just in logs.

### Restart survival — two layers

Redis runs with `appendonly yes`, so a plain restart resumes every pending timer. That
covers the normal case but not two real ones: Redis being wiped or failed over to an
empty replica, and the process dying between writing the rows and enqueuing them. So on
every boot, before the HTTP listener opens, the service walks every non-terminal row and
re-arms only the jobs Redis does not have. Rows stuck in `SENDING` for more than two
minutes are released back to `SCHEDULED` — a row can only be in that state if the worker
holding it died, and the BullMQ lock has long expired.

The strong version of the demo is `redis-cli FLUSHALL` before restarting: the queue is
gone entirely and the schedule rebuilds from Postgres alone.

### Rate limiting — one Redis Lua script

Three conditions must hold before an email goes out: the sender has hourly quota, the
account has global quota, and enough time has passed since that sender's last send.
Checking them in separate round trips leaves a window where two workers both read
"199 of 200" and both send. Redis runs a script atomically on one thread, so all three
are evaluated and consumed indivisibly. Nothing is counted in process memory, which is
what lets three worker processes run with the same limits honoured.

**Why not BullMQ's built-in limiter:** it is a per-queue token bucket, and the
requirement is per *sender* inside a shared queue.

**A denied attempt consumes nothing** — the counter only increments on the allowed path.

### What happens at the limit

`job.moveToDelayed(resumeAt, token)` followed by `throw new DelayedError()`. The
`DelayedError` is BullMQ's signal that the job was parked deliberately rather than
failed, so **no attempt is burned** — a throttled email never drifts toward
`JOB_ATTEMPTS` and never ends up `FAILED`. The row's `scheduled_at` is rewritten and
`defer_count` incremented, so the dashboard shows when the recipient will actually
receive it.

### The question that will probably get asked: "why is a sender at 4/5 while emails wait?"

Sender assignment happens at plan time, per campaign, and is sticky — the recipient's
`sender_id` is written into the row and never changes. Two batches of 8 dealt
round-robin across three senders gives 6/6/4; the first two hit their cap and deferred,
the third only ever had 4 emails to send.

The alternative is work-stealing: reassign a deferred email to whichever sender has
room. It would squeeze more out of each hour, but one recipient could then receive
follow-ups from different addresses, and the row stops being self-contained — which is
exactly what keeps the idempotent claim and the reconciler simple. This is a deliberate
trade, not an oversight.

### Order preservation

When a batch of deferred jobs all wake at the top of the hour they race for the first
gap slot in arbitrary order. A `min(sequence, 2000) × 25ms` stride, keyed on the
recipient's position in the campaign, restores FIFO while staying far below any
realistic send gap. Best-effort by design — a retry or a second worker can still reorder
two adjacent emails. The brief asked for order "as much as possible", not a total order.

### Stack choices

- **Drizzle over Prisma** — a query builder with no engine binary to download and no
  codegen step between `git clone` and `npm run dev`.
- **Google Identity Services over NextAuth** — the API already has to verify the Google
  ID token itself, so NextAuth would have added a second session system, a second secret
  and a client secret for no behavioural gain. The browser gets a signed OIDC token,
  posts it to the API, and `google-auth-library` verifies the signature and `aud`
  server-side.
- **Elasticsearch indexing is best-effort** — a failed index call is logged and
  swallowed. A momentarily stale index is acceptable; an email that fails to send
  because the search cluster was down is not. Search degrades to Postgres with a visible
  "DB fallback" chip rather than silently.

### "How did you test it?"

The end-to-end suite caught a real bug before it ever ran: BullMQ 6 rejects custom job
ids containing `:`, because it builds its Redis keys as `<prefix>:<queue>:<jobId>`. The
original scheme was `email:<uuid>`, which would have failed on the very first schedule
call. That is the concrete answer to why the suite exists.

The rate-limiter tests run against a real Redis rather than a mock — one of them fires
twenty concurrent acquisitions at a limit of five and asserts exactly five winners.
Mocking Redis there would prove nothing, since atomicity is the entire point.

---

## Shortcuts to own, not hide

If asked what you would change, lead with these rather than being walked into them:

- **SMTP passwords are stored in plaintext.** They are throwaway Ethereal credentials;
  production wants KMS-backed envelope encryption or a secrets-manager reference.
- **Fixed hour window, not sliding.** 200 at 10:59 and 200 more at 11:01 is possible. A
  sliding window is more accurate and more expensive; fixed is the normal choice for
  provider-style throttling.
- **Quota is consumed on attempt, not success.** If SMTP fails after a slot is taken,
  the retry consumes another. This mirrors how real providers count, and refunding would
  need a compensating transaction that could itself be lost.
- **Offset pagination**, which would drift under concurrent inserts at much larger scale.
- **No refresh tokens** — a 7-day JWT in `localStorage`. Production wants an httpOnly
  refresh-token pair.
- **Only the infrastructure is containerised**, not the app, so that restarting the API
  during the demo is a single `Ctrl+C`.

---

## Before the interview

- Re-run the restart demo once and watch the reconciliation numbers yourself, so the
  description comes from memory rather than from the README.
- Confirm whether the Slack OAuth flow was actually exercised end to end.
- Re-read the rate-limiter Lua script — it is the densest thing in the repo and the most
  likely target for a deep question.