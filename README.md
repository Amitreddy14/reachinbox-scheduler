# ReachInbox — Email Job Scheduler

A production-shaped email scheduling service and dashboard. Emails are accepted
over an API, stored in Postgres, timed by **BullMQ delayed jobs** in Redis, sent
through **Ethereal SMTP** under per-sender throttling, and indexed into
**Elasticsearch** so the dashboard's search box is real search rather than a
`LIKE` query.

No cron of any kind is used — not `crontab`, not `node-cron`, not `agenda`. The
only timer in the system is Redis' delayed-job sorted set.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Running it](#3-running-it)
4. [Environment variables](#4-environment-variables)
5. [How scheduling works](#5-how-scheduling-works)
6. [How persistence across restarts works](#6-how-persistence-across-restarts-works)
7. [How idempotency works](#7-how-idempotency-works)
8. [How rate limiting and concurrency work](#8-how-rate-limiting-and-concurrency-work)
9. [Behaviour under load](#9-behaviour-under-load)
10. [Slack notifications](#10-slack-notifications)
11. [Search](#11-search)
12. [API reference](#12-api-reference)
13. [Tests](#13-tests)
14. [Feature checklist](#14-feature-checklist)
15. [Assumptions, shortcuts and trade-offs](#15-assumptions-shortcuts-and-trade-offs)

---

## 1. What it does

* Accepts a campaign — subject, body, a lead list, a start time, a delay between
  sends and an hourly ceiling — and turns it into one scheduled row per
  recipient.
* Spreads recipients round-robin across several sender mailboxes, because the
  hourly quota is enforced **per sender**: three mailboxes at 200/hour deliver
  600/hour without any one of them breaking its own limit.
* Sends through Ethereal and records the preview URL for every message.
* Throttles at send time with a Redis Lua script that is atomic across any
  number of worker processes.
* Pushes anything over the limit into the next hour window instead of dropping
  or failing it, and posts a Slack alert the moment a sender's ceiling is hit.
* Survives a restart — including a completely wiped Redis — without losing a
  pending email or re-sending a delivered one.

---

## 2. Architecture

```
                    ┌──────────────────────────────┐
  Google sign-in ──▶│  Next.js dashboard  :3000    │
                    │  compose · tables · search   │
                    └──────────────┬───────────────┘
                                   │ REST + Bearer JWT
                    ┌──────────────▼───────────────┐
                    │  Express API  :4000          │
                    │  /api/emails  /api/senders   │
                    │  /api/slack   /admin/queues  │
                    └───┬───────────┬───────────┬──┘
           writes rows  │           │ adds      │ indexes
                        ▼           ▼ delayed   ▼
                 ┌────────────┐ ┌──────────┐ ┌───────────────┐
                 │ PostgreSQL │ │  Redis   │ │ Elasticsearch │
                 │  (truth)   │ │ (timer + │ │   (search)    │
                 │            │ │  quotas) │ │               │
                 └─────▲──────┘ └────┬─────┘ └───────▲───────┘
                       │              │ job due      │
                       │        ┌─────▼─────────┐    │
                       └────────┤ BullMQ worker ├────┘
                    claim/mark  │  concurrency  │
                                │  N per process│
                                └───────┬───────┘
                                        │ SMTP
                                        ▼
                                 Ethereal Email
```

**The one idea worth stating plainly:** Postgres is the source of truth for
*what should be sent* and *what already was*; Redis is only the timer and the
quota counter. Everything in [§6](#6-how-persistence-across-restarts-works) and
[§7](#7-how-idempotency-works) follows from that split.

### Repository layout

```
backend/
  drizzle/                   generated SQL migrations
  src/
    config/                  env schema (zod) + logger
    db/                      Drizzle schema, pool, migrator
    queue/
      queues.ts              queue, deterministic job ids
      scheduler.ts           enqueue / cancel / snapshot
      worker.ts              worker bootstrap, concurrency
      reconcile.ts           startup recovery
      processors/
        sendEmail.processor.ts   the unit of work
    services/
      rateLimiter.ts         the Redis Lua script
      mailer.ts              pooled SMTP transports
      search.ts              Elasticsearch + Postgres fallback
      slack.ts               OAuth + live alerts
    modules/
      auth/ campaigns/ emails/ senders/ slack/
    middleware/  utils/  scripts/
  tests/                     unit + end-to-end suites
frontend/
  src/
    app/                     login page, dashboard, providers
    components/ui/           Button, Input, Modal, Toast, …
    components/dashboard/    Sidebar, Header, EmailTable, ComposeModal
    hooks/  lib/  types/
docker-compose.yml           Postgres, Redis, Elasticsearch
```

---

## 3. Running it

### Prerequisites

* Node.js 20 or newer
* Docker (recommended, for Postgres / Redis / Elasticsearch)
* A Google OAuth **client ID** (no client secret needed — see below)

### 3.1 Infrastructure

```bash
docker compose up -d
```

That starts Postgres on `5432`, Redis on `6379` (with `appendonly yes`, which is
what makes the delayed-job set survive a Redis restart) and Elasticsearch on
`9200`.

Running them yourself instead of via Docker is fine; just point the env vars at
them.

### 3.2 Backend

```bash
cd backend
cp .env.example .env
#   - set JWT_SECRET to a long random string
#   - set GOOGLE_CLIENT_ID (same one the frontend uses)
npm install
npm run db:migrate        # applies drizzle/0000_init.sql
npm run dev               # API + worker on http://localhost:4000
```

Useful extras:

```bash
npm run seed:senders      # provision Ethereal mailboxes, print them as .env lines
npm run dev:worker        # a second, standalone worker process
npm run typecheck         # tsc over src/ and tests/
npm test                  # unit tests
npm run test:e2e          # full scheduler proof (needs Postgres + Redis)
```

Live queue dashboard: **http://localhost:4000/admin/queues**
Health check: **http://localhost:4000/health**

### 3.3 Frontend

```bash
cd frontend
cp .env.local.example .env.local
#   - set NEXT_PUBLIC_GOOGLE_CLIENT_ID
npm install
npm run dev               # http://localhost:3000
```

### 3.4 Ethereal setup

Ethereal is a fake SMTP service: messages are accepted and rendered but never
delivered to a real inbox.

**Option A — zero setup (default).** `ETHEREAL_AUTO_PROVISION=true` creates
three mailboxes automatically the first time an account signs in. The addresses
and passwords are printed to the API log:

```
INFO: provisioned Ethereal senders — sign in at https://ethereal.email/login
  senders: [ "aaliyah.hane12@ethereal.email", … ]
```

**Option B — stable mailboxes.** Run `npm run seed:senders`, paste the printed
`SENDER_n_*` lines into `backend/.env`, and set
`ETHEREAL_AUTO_PROVISION=false`. The same inboxes then survive a database reset,
which is convenient while recording a demo.

Either way, every sent email also stores its `previewUrl`; the dashboard shows
it as an open-in-new-tab icon on each row.

### 3.5 Google OAuth

Create an **OAuth client ID** of type *Web application* at
<https://console.cloud.google.com/apis/credentials> and add
`http://localhost:3000` as an authorised JavaScript origin.

No redirect URI and no client secret are required. The browser uses Google
Identity Services to obtain a signed OIDC **ID token**, posts it to
`POST /api/auth/google`, and the API verifies the signature and the `aud` claim
with `google-auth-library` before issuing its own session JWT. The API therefore
never trusts a profile object the browser made up, and no secret ever ships to
the client.

---

## 4. Environment variables

Every tunable is declared once, in `backend/src/config/env.ts`, and validated
with zod at boot — a missing or malformed value stops the process with a
readable message instead of failing at 3 a.m. Nothing below is hardcoded
anywhere else.

### Backend (`backend/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | API port |
| `FRONTEND_URL` | `http://localhost:3000` | CORS origin and OAuth return target |
| `BACKEND_URL` | `http://localhost:4000` | Used to build the Slack `redirect_uri` |
| `JWT_SECRET` | — (required) | Signs the API session token |
| `DATABASE_URL` | — (required) | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Queue, quotas and OAuth state |
| `ELASTICSEARCH_NODE` | `http://localhost:9200` | Search cluster |
| `ELASTICSEARCH_INDEX` | `emails` | Index name |
| `ELASTICSEARCH_FALLBACK_TO_DB` | `true` | Degrade to Postgres search if ES is down |
| `EMAIL_QUEUE_NAME` | `email-send` | BullMQ queue name |
| **`WORKER_CONCURRENCY`** | `5` | Emails in flight per worker process |
| `RUN_WORKER_IN_API` | `true` | `false` runs the worker separately |
| **`MIN_GAP_MS_PER_SENDER`** | `2000` | Minimum spacing between two sends from one sender |
| **`MAX_EMAILS_PER_HOUR_PER_SENDER`** | `200` | Hard per-sender hourly ceiling |
| `MAX_EMAILS_PER_HOUR_GLOBAL` | `1000` | Account-wide hourly ceiling |
| `JOB_ATTEMPTS` | `3` | Retries before an email is marked `FAILED` |
| `JOB_BACKOFF_MS` | `5000` | Exponential backoff base |
| `GOOGLE_CLIENT_ID` | — | Audience the ID token is verified against |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | — | Slack OAuth app |
| `SLACK_SCOPES` | `incoming-webhook,chat:write` | Requested bot scopes |
| `SLACK_FALLBACK_WEBHOOK_URL` | — | Optional demo destination when no user has connected Slack |
| `ETHEREAL_AUTO_PROVISION` | `true` | Mint mailboxes on first login |
| `ETHEREAL_SENDER_COUNT` | `3` | How many to mint |
| `SENDER_1..3_EMAIL/USER/PASSWORD` | — | Static mailboxes instead of auto-provisioning |

### Frontend (`frontend/.env.local`)

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Base URL of the Express API |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Same client ID as the backend |

---

## 5. How scheduling works

**1 — Plan (`modules/campaigns/planSchedule.ts`).** A pure function turns a lead
list into one `PlannedSend` per recipient. It deals recipients round-robin
across the active senders, spaces consecutive sends by the requested delay, and
walks a send forward an hour at a time whenever the sender it was dealt to has
already filled that hour window. It is deliberately free of database, Redis and
queue imports, which is why it can be unit-tested directly.

**2 — Persist.** One `campaigns` row and one `email_jobs` row per recipient are
written in a single transaction, chunked at 500 rows so a large list does not
exceed Postgres' parameter limit. Each row is born with status `SCHEDULED`, its
planned `scheduled_at`, its `sequence` inside the campaign, and its
deterministic `queue_job_id`.

**3 — Arm.** `emailQueue.addBulk` adds one delayed job per row, with
`delay = scheduledAt − now` and `jobId = queueJobIdFor(row.id)`. `addBulk` is a
single pipelined round trip; adding a thousand jobs one at a time is the
difference between about 120 ms and several seconds.

**4 — Fire.** When the delay elapses BullMQ moves the job to the waiting list and
a worker picks it up. The processor then does five things in this order, and the
order is the design:

```
1. re-read the row from Postgres        the job payload is a hint, not the truth
2. return early if already terminal     idempotency guard #2
3. ask the rate limiter for a slot      may defer; never drops
4. conditional UPDATE → SENDING         idempotency guard #3
5. send, then record the outcome
```

Postgres is written **before** Redis at every step, so the worst case is a row
that exists with no job — which the reconciler fixes — rather than a job with no
row, which would be an email nobody can account for.

**Why not cron.** A cron tick has to ask "what is due now?", which means either
polling the database on an interval (latency equal to the interval, and a thundering
herd at every tick) or holding schedules in process memory (lost on restart).
A delayed job is a single `ZADD` into a sorted set that Redis persists; the due
time *is* the score, there is nothing to poll, and it works unchanged across
however many worker processes are running.

---

## 6. How persistence across restarts works

Two independent layers.

**Layer 1 — Redis durability.** BullMQ keeps delayed jobs in a sorted set scored
by due time. `docker-compose.yml` runs Redis with `--appendonly yes
--appendfsync everysec`, so stopping and starting the API — or Redis itself —
resumes every pending timer where it left off. A job that was due during the
downtime fires immediately on restart; one due later still fires at its original
time. Nothing restarts "from day one" because the schedule was never held in
process memory.

**Layer 2 — Reconciliation (`queue/reconcile.ts`).** Layer 1 does not cover two
real failure modes: Redis being wiped, replaced, or failed over to an empty
replica; and the process dying between writing the Postgres rows and enqueuing
them. So on every boot — before the HTTP listener opens — the service:

1. Releases rows stuck in `SENDING` whose `updated_at` is older than two minutes.
   A row can only be in that state if the worker holding it died; the BullMQ lock
   (60 s) has long expired, so the row is returned to `SCHEDULED` to be claimed
   again.
2. Walks every `SCHEDULED` / `QUEUED` row in batches of 500, looks up its job by
   the deterministic id, and re-adds **only** the ones Redis does not have in a
   `delayed`, `waiting` or `active` state. Rows whose job is still armed are left
   completely alone.
3. Logs a report: `{ inspected, requeued, alreadyArmed, releasedStuck }`.

Because the job id is derived from the row id, step 2 is safe to run at any time
— re-adding an existing job is a no-op in Redis. Terminal rows (`SENT`,
`FAILED`, `CANCELLED`) are never inspected, so a completed email cannot be
resurrected.

**Demonstrating it.** Schedule a batch a few minutes out, `Ctrl-C` the API,
optionally `docker compose restart redis` or even `redis-cli FLUSHALL`, then
`npm run dev` again. The boot log prints the reconciliation report and the
emails still go out at their original times. The automated version of this is
the `after Redis is wiped…` case in `npm run test:e2e`.

---

## 7. How idempotency works

Three independent guards. Any one of them is enough; all three are cheap.

**Guard 1 — deterministic job ids.** `queueJobIdFor(rowId)` returns
`email-<uuid>`. BullMQ treats an `add` with an existing job id as a no-op, so a
retried API call, a double-clicked *Schedule* button and the boot reconciler can
all try to enqueue the same email without ever producing a second job. (The
separator is a hyphen, not a colon: BullMQ builds its Redis keys as
`<prefix>:<queue>:<jobId>` and rejects custom ids containing `:`.)

**Guard 2 — terminal-state check.** The processor re-reads the row and returns
`{ result: 'skipped' }` if it is already `SENT` or `CANCELLED`, before touching
SMTP.

**Guard 3 — the claim.** The row is latched with a conditional update:

```sql
UPDATE email_jobs
   SET status = 'SENDING', attempts = attempts + 1
 WHERE id = $1 AND status IN ('SCHEDULED', 'QUEUED')
RETURNING id;
```

Postgres serialises this, so if two workers somehow receive the same job exactly
one gets a row back; the other sees zero rows and skips. This is what makes
delivery safe under concurrency rather than merely unlikely to double-send.

**Belt and braces at the SMTP layer.** Every message goes out with
`Message-ID: <rowId@reachinbox.local>` and an `X-Scheduler-Job-Id` header, so a
duplicate would be visible in the received mail itself and not only in our logs.
The e2e suite asserts on exactly this.

---

## 8. How rate limiting and concurrency work

### Concurrency

The worker is constructed with `concurrency: env.WORKER_CONCURRENCY`, so one
process can have N emails in flight at once. Safety under parallelism does not
come from the concurrency number: it comes from the claim in
[§7](#7-how-idempotency-works) and from the limiter below, both of which are
atomic in their respective stores. Nothing is counted in process memory, which
is what lets you run `npm run dev:worker` in three terminals and get three times
the throughput with the same limits honoured.

### The Lua script

Three conditions must hold before an email may go out:

1. the sender has hourly quota left,
2. the account has global hourly quota left,
3. enough wall-clock time has passed since that sender's previous send.

Checking them with separate round trips leaves a window where two workers both
read "199 of 200" and both send. Redis runs a script atomically on a single
thread, so `services/rateLimiter.ts` evaluates and consumes all three in one
indivisible step, keyed by:

```
rl:sender:<senderId>:<hourWindowStart>    counter, TTL 1h
rl:user:<userId>:<hourWindowStart>        counter, TTL 1h
rl:gate:<senderId>                        next-allowed timestamp
```

The window start is `floor(now / 3600000) * 3600000` — a fixed wall-clock hour,
not a rolling one. Every worker computes the same key from the same timestamp
with no coordination, and the counter expires on its own. A rolling window would
need a sorted set per sender and a read-modify-write on every send.

The script returns either *allowed* (having consumed a slot and moved the
sender's gate forward) or *denied* with a reason and a `retryAfterMs`. **A denied
attempt consumes nothing** — the counter is only incremented on the allowed
path, so a throttled email does not eat the quota of the email that eventually
goes out in its place.

### What happens when a limit is hit

```ts
await job.moveToDelayed(resumeAt, token);
throw new DelayedError();
```

`DelayedError` is BullMQ's signal that the job was deliberately parked rather
than failed, so **no attempt is burned** and the job never approaches
`JOB_ATTEMPTS`. In the same step the row's `scheduled_at` is rewritten to
`resumeAt` and `defer_count` is incremented, so the dashboard shows the time the
recipient will actually receive the email rather than a stale one, and the row
is visibly tagged `rescheduled ×N`.

`resumeAt` is:

* **min-gap denial** → `now + retryAfterMs` (milliseconds, typically).
* **hourly denial** → the start of the next hour window, plus
  `min(sequence, 2000) × 25 ms`.

That second term is the ordering trick. Without it, several hundred deferred
jobs all wake at exactly the top of the hour and race for the first gap slot in
arbitrary order. A 25 ms stride keyed on the recipient's position in the
campaign restores FIFO while staying far below any realistic send gap. It is
best-effort by design — a retry or a second worker can still reorder two
adjacent emails — and the brief asks for order "as much as possible", not a
total order.

### Trade-offs, stated plainly

* **BullMQ's built-in `limiter` was not used** for the hourly cap. It is a
  per-queue token bucket, and the requirement is per *sender* within a shared
  queue. Redis counters keyed by `sender + hour` express that directly, and the
  same script also enforces the min-gap, so one round trip covers both rules.
* **Sender assignment is sticky, not work-stealing.** A recipient is dealt to a
  sender when the campaign is planned and stays with it. So a sender can sit
  below its cap while emails assigned to a *different*, exhausted sender wait
  for the next window. Reassigning at send time would squeeze more out of each
  hour, but it would let one recipient receive follow-ups from different
  addresses, and it would stop the row being self-contained — which is what
  keeps the idempotent claim and the restart reconciler as simple as they are.
* **The minimum retry delay is floored at 250 ms.** A 0 ms delay would spin the
  worker, and a BullMQ delayed-job round trip costs more than 250 ms anyway. The
  practical effect is that a configured gap below 250 ms behaves as 250 ms.
* **Quota is consumed on attempt, not on success.** If SMTP fails after a slot
  was taken, the retry consumes a second slot. This mirrors how real providers
  count attempts, and refunding a slot would need a compensating transaction
  that could itself be lost.
* **The fixed hour window is not a sliding window.** 200 emails at 10:59 and 200
  more at 11:01 is possible. A sliding window is strictly more accurate and
  strictly more expensive; for provider-style throttling the fixed window is the
  normal choice.

---

## 9. Behaviour under load

**1000+ emails scheduled for the same moment.** They are written in chunks of
500 and armed with one `addBulk` call. The planner has already spread them
across hour windows, so the queue's `delayed` count is high and its `waiting`
count stays low — the timer, not the worker, is holding them back. As each
window opens, at most `WORKER_CONCURRENCY` are in flight at a time and each
sender's gate spaces them by `MIN_GAP_MS_PER_SENDER`.

**The rate limit would be exceeded.** Nothing is dropped and nothing fails. Each
over-quota job is parked into the next window with `moveToDelayed` +
`DelayedError`, its row is re-dated, `defer_count` is incremented, and a single
Slack alert is posted per sender per window. A job can be deferred any number of
times; `defer_count` makes that visible in the UI and in the database.

**Watching it happen.** `backend/src/scripts/loadTest.ts` schedules a large batch
against a running API:

```bash
npx tsx src/scripts/loadTest.ts <session-token> 1000
```

Take the token from the browser's `localStorage` key `reachinbox.token` after
signing in. Then watch `/admin/queues`: `delayed` stays high while `completed`
climbs at exactly the configured pace.

**Where it would break first.** Each worker holds one pooled SMTP connection per
sender (`maxConnections: 2`), so the ceiling is provider-side, not ours. Past a
few hundred thousand rows the `listEmails` offset pagination would want to
become keyset pagination. Neither is near the scale this exercise asks for.

---

## 10. Slack notifications

Real OAuth v2, per user, stored in Postgres.

1. **Connect Slack** in the dashboard calls `POST /api/slack/install-url`. The
   backend mints a random `state`, stores `state → userId` in Redis for ten
   minutes, and returns Slack's authorize URL. The `state` is needed because a
   browser cannot send an `Authorization` header on a top-level redirect; it
   doubles as CSRF protection.
2. The user approves in Slack. Slack redirects to
   `GET /api/slack/oauth/callback`, which exchanges the code via
   `oauth.v2.access`, looks the user up by `state`, and stores the team, the
   channel and the **incoming webhook URL** in `slack_integrations`.
3. The browser is bounced back to `/dashboard?slack=connected` and the dashboard
   raises a toast.

When a sender's hourly ceiling is hit, the worker calls `notifyRateLimitHit`,
which posts a Block Kit message naming the sender, the usage, the resume time
and how many emails were rescheduled.

* **Not connected?** Nothing is thrown and nothing is logged as an error — it is
  a valid state. The Redis dedupe key is released so the *next* limit hit after
  the user connects produces a notification.
* **Connects later?** No redeploy and no restart. The integration is read from
  the database on every alert.
* **Disconnects?** The row is deleted and alerts stop.
* **Burst control.** A `SET … NX EX 3900` collapses a burst of deferrals into one
  message per sender per hour window, so 900 throttled emails do not produce 900
  Slack messages.
* **Delivery order.** Incoming webhook first, then `chat.postMessage` with the
  bot token, then `SLACK_FALLBACK_WEBHOOK_URL` if one is configured.
* **Demoing it.** *Test alert* in the dashboard sends the real alert message
  through the real path immediately.

### Slack app setup — note the HTTPS requirement

Slack will not accept a plain-HTTP redirect URL, and makes no exception for
localhost: *"The `redirect_uri` must use HTTPS."* So running the service on
`http://localhost:4000` is not enough on its own — the callback has to be
reachable over HTTPS.

The simplest way to do that locally is a tunnel:

```bash
ngrok http 4000
```

Then:

1. Create an app at <https://api.slack.com/apps> (*From scratch*).
2. **OAuth & Permissions** -> *Bot Token Scopes* -> add `incoming-webhook` and
   `chat:write`.
3. Same page -> *Redirect URLs* -> add
   `https://<your-tunnel>.ngrok-free.app/api/slack/oauth/callback`.
4. **Basic Information** -> copy the Client ID and Client Secret into
   `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`.
5. Set `BACKEND_URL` to that same tunnel origin — it is what builds the
   `redirect_uri`, so it has to match what Slack has registered exactly.

Leave `FRONTEND_URL` and the frontend's `NEXT_PUBLIC_API_URL` on localhost; only
the OAuth callback goes through the tunnel. A free tunnel URL changes every time
it restarts, so if it does, update both Slack and `BACKEND_URL` again.

If the service is hosted somewhere with a real HTTPS origin, none of this
applies — register `https://<your-host>/api/slack/oauth/callback` directly.

---

## 11. Search

Every email is indexed into Elasticsearch on creation and on each status change.
The mapping indexes `to_email` twice — as a `keyword` for exact filtering and
through an edge-ngram analyser so `sar` matches `sarah@acme.io` while the user
is still typing — and applies the standard analyser to `subject` and `body_text`.

The dashboard's list **and** its search box go through the same path: ES returns
matching ids in order, Postgres hydrates them. That keeps the index small and the
rows authoritative, so an email is never displayed as "sent" because the index is
stale.

Indexing is deliberately best-effort: a failed `index` call is logged at debug
and swallowed. A momentarily stale index is acceptable; an email that fails to
send because the search cluster was down is not. `POST /api/emails/admin/reindex`
rebuilds the index from Postgres, which is also what you want after starting a
fresh Elasticsearch container.

If Elasticsearch is unreachable and `ELASTICSEARCH_FALLBACK_TO_DB=true`, search
degrades to a case-insensitive Postgres query and the dashboard shows a small
**DB fallback** chip in the header, so the degradation is visible rather than
silent.

---

## 12. API reference

All routes except `/health`, `/api/config` and the Slack OAuth callback require
`Authorization: Bearer <session token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Postgres / Redis / Elasticsearch liveness |
| `GET` | `/api/config` | Effective limits, for the UI's hints |
| `POST` | `/api/auth/google` | Exchange a Google ID token for a session token |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/emails/schedule` | Schedule a campaign |
| `POST` | `/api/emails/parse-leads` | Count addresses in a pasted list |
| `GET` | `/api/emails?tab=scheduled\|sent&q=&page=` | Paginated, searchable list |
| `GET` | `/api/emails/stats` | Status counts + live queue counters |
| `GET` | `/api/emails/campaigns` | Campaigns with a per-status breakdown |
| `GET` | `/api/emails/:id` | One email |
| `POST` | `/api/emails/:id/cancel` | Cancel a pending email |
| `POST` | `/api/emails/admin/reindex` | Rebuild the search index |
| `GET` | `/api/senders` | Senders with live hourly usage |
| `PATCH` | `/api/senders/:id` | Change limit, gap or active state |
| `GET` | `/api/slack/status` | Connection state |
| `POST` | `/api/slack/install-url` | Begin the OAuth flow |
| `GET` | `/api/slack/oauth/callback` | Slack's redirect target |
| `POST` | `/api/slack/test` | Send a real alert now |
| `POST` | `/api/slack/disconnect` | Remove the integration |
| `GET` | `/admin/queues` | Live BullMQ dashboard |

Errors are uniform: `{ "error": { "code", "message", "details"? } }`.

### Scheduling a campaign

```http
POST /api/emails/schedule
Authorization: Bearer <token>
Content-Type: application/json

{
  "subject": "Quick question about your outbound stack",
  "body": "<p>Hi there,</p><p>Noticed you're hiring SDRs…</p>",
  "recipients": ["ada@example.com", "bob@example.com"],
  "csvText": "name,email\nCarol,carol@example.com\n",
  "startAt": "2026-09-29T09:00:00.000Z",
  "delayMs": 2000,
  "hourlyLimit": 200,
  "senderIds": ["<optional: pin to one sender>"]
}
```

`recipients` and `csvText` may both be supplied; addresses are merged,
lowercased, de-duplicated and validated. The response reports
`recipientsAccepted`, the first and last planned send times, the senders used and
a queue snapshot.

---

## 13. Tests

```bash
cd backend
npm test          # 19 unit tests
npm run test:e2e  # 11 end-to-end assertions (needs Postgres + Redis)
```

**Unit** — lead-file parsing (CSV with headers, bare lists, de-duplication,
entity decoding), schedule planning (round-robin, spacing, overflow into later
windows, per-sender limits winning over campaign limits), and the rate limiter
against a **real Redis**, including a case that fires twenty concurrent
acquisitions at a limit of five and asserts exactly five winners. Mocking Redis
there would prove nothing, since atomicity is the entire point. The limiter
tests skip themselves if Redis is unreachable.

**End-to-end** — the real scheduler against a real Postgres and a real Redis,
with a local SMTP stub standing in for Ethereal so deliveries can be counted
exactly. It schedules eight recipients against a cap of five and asserts:

* exactly five are delivered and three stay `SCHEDULED` — never `FAILED`;
* every delivery carries a unique idempotency header;
* re-enqueuing the sent jobs delivers nothing extra;
* after `FLUSHDB`, reconciliation re-arms exactly the three pending rows and
  replays none of the five sent ones;
* the remainder goes out when the window resets, no recipient is emailed twice,
  and the campaign closes itself.

It truncates the configured database, so it refuses to run without `E2E=1`.

> This suite is how the `:` in the job id was caught: BullMQ 6 rejects custom
> job ids containing a colon, which would have failed the very first schedule.

---

## 14. Feature checklist

### Backend

| Requirement | Where |
| --- | --- |
| Accept scheduling requests via API | `POST /api/emails/schedule` |
| Store in a relational DB | Postgres via Drizzle, `src/db/schema.ts` |
| BullMQ delayed jobs, **no cron** | `queue/scheduler.ts`, `queue/queues.ts` |
| Send from multiple senders via Ethereal | `services/mailer.ts`, round-robin in `planSchedule.ts` |
| Searchable via Elasticsearch | `services/search.ts`, indexed on write and on status change |
| Live BullMQ dashboard | `/admin/queues` (Bull Board) |
| Future emails survive a restart | `queue/reconcile.ts` + Redis AOF |
| Not duplicated, not restarted from scratch | three guards, §7 |
| Configurable worker concurrency | `WORKER_CONCURRENCY` |
| Minimum delay between sends | `MIN_GAP_MS_PER_SENDER` (default **2 s**) |
| Per-sender hourly rate limit | `MAX_EMAILS_PER_HOUR_PER_SENDER` (default 200) |
| Account-wide hourly ceiling | `MAX_EMAILS_PER_HOUR_GLOBAL` |
| Limits configurable, never hardcoded | `config/env.ts`, zod-validated |
| Multi-worker-safe counters | Redis Lua, no in-memory state |
| Over-limit jobs delayed, order preserved | `moveToDelayed` + sequence stride, §8 |
| Slack OAuth + live alert on limit | `services/slack.ts`, `modules/slack/slack.routes.ts` |
| Reconnect without redeploy | integration read per alert |
| Idempotency | deterministic job id + terminal check + conditional claim |

### Frontend

| Requirement | Where |
| --- | --- |
| Real Google login, redirect to dashboard | `app/page.tsx`, `lib/googleIdentity.ts` |
| Header with name, email, avatar, logout | `components/dashboard/Header.tsx` |
| Scheduled / Sent tabs | `app/dashboard/page.tsx`, `components/dashboard/Sidebar.tsx` |
| Compose New Email button | header and sidebar |
| Subject and body | `ComposeModal` |
| CSV/text upload with detected count | `lib/leads.ts` + `ComposeModal` |
| Start time, delay, hourly limit | `ComposeModal` |
| Scheduled table: email, subject, time, status | `EmailTable` |
| Sent table: email, subject, sent time, status | `EmailTable` |
| Loading states | `Skeleton` / `TableSkeleton` |
| Empty states | `EmptyState`, distinct per tab and for no-results |
| Error handling / toasts | `ToastProvider`, inline field errors |
| Reusable components | `components/ui/` |
| TypeScript types for props and responses | `src/types/index.ts`, typed API client |

Extras not asked for but useful in a demo: live queue counters and per-sender
hourly usage bars, full-text search across recipient / subject / body, an
Ethereal preview link per sent row, cancelling a pending email, a `rescheduled
×N` tag on deferred rows, a **DB fallback** chip when Elasticsearch is down, and
a **Test alert** button for Slack.

---

## 15. Assumptions, shortcuts and trade-offs

**Assumptions**

1. One Google account is one tenant. Senders, campaigns, emails and the Slack
   integration all hang off `user_id`, and every query is scoped by it.
2. Hourly limits are per sender, with an account-wide ceiling above them. The
   brief allowed either; per sender is what actually models provider throttling,
   and it is what makes multiple senders meaningful.
3. The campaign's "delay between emails" is a *requested* spacing. The server's
   `MIN_GAP_MS_PER_SENDER` is a floor that a client cannot go under, and
   `MAX_EMAILS_PER_HOUR_PER_SENDER` is a ceiling a client cannot exceed.
4. Ethereal accepts everything, so `FAILED` only appears through SMTP or network
   errors. The failure path is still fully implemented: attempts, exponential
   backoff, `last_error`, and a terminal `FAILED` state surfaced in the UI.
5. Lead files are lists of addresses, not merge-field templates. Any column
   layout works because the parser scans for anything shaped like an address.

**Shortcuts, named honestly**

1. **SMTP passwords are stored in plaintext** in `senders.smtp_password`. These
   are throwaway Ethereal credentials. Production would use a KMS-backed
   envelope encryption or a secrets manager reference.
2. **No refresh tokens.** The API issues a 7-day JWT held in `localStorage`. An
   httpOnly refresh-token cookie pair would be the production answer;
   `localStorage` keeps the exchange visible and easy to inspect during a demo.
3. **Offset pagination**, not keyset. Fine at this scale, would drift under
   concurrent inserts at a much larger one.
4. **The body is stored per recipient.** Denormalised on purpose: it makes each
   `email_jobs` row self-contained, so a send needs exactly one read and editing
   a campaign cannot silently change what an already-scheduled email says. It
   costs disk, which is the cheap resource here.
5. **The compose body is a textarea**, not a rich-text editor. HTML pasted in is
   honoured and a plain-text MIME part is generated from it. A WYSIWYG editor
   would have been surface area without new backend behaviour.
6. **Elasticsearch has no authentication** in `docker-compose.yml`
   (`xpack.security.enabled=false`), which is a local-development setting only.
7. **No Docker image for the app itself.** Only the infrastructure is
   containerised, so that stopping and restarting the API — the thing the demo
   needs to show — is a single `Ctrl-C`.

**Deliberate design choices**

1. **Drizzle rather than Prisma.** A query builder with no engine binary to
   download, no code generation step between `git clone` and `npm run dev`, and
   SQL that reads like SQL.
2. **Google Identity Services rather than NextAuth.** The API already has to
   verify the Google ID token itself, so NextAuth would have added a second
   session system, a second secret and a client secret for no behavioural gain.
   The current flow is one token exchange that is easy to point at in a demo.
3. **The worker runs in the API process by default** (`RUN_WORKER_IN_API=true`)
   so `npm run dev` is enough to see the system work. Setting it to `false` and
   running `npm run dev:worker` in several terminals proves the same code scales
   horizontally, because nothing is counted in process memory.
