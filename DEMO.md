# Demo script (target: under 5 minutes)

A shot list for the submission video. Timings are a guide, not a rule.

## Before you hit record

```bash
docker compose up -d                       # Postgres, Redis, Elasticsearch
cd backend && npm run db:migrate && npm run dev
cd frontend && npm run dev
```

Have four things open: the dashboard (`localhost:3000`), the queue dashboard
(`localhost:4000/admin/queues`), the backend terminal, and a Slack channel.

For a tighter recording, lower the limits in `backend/.env` first so throttling
is visible in seconds rather than minutes:

```
MIN_GAP_MS_PER_SENDER=2000
MAX_EMAILS_PER_HOUR_PER_SENDER=5
```

Say out loud that these are env values, not code changes.

---

## 0:00 — Login (~25s)

Click **Continue with Google**, complete the real consent screen, land on the
dashboard. Point at the header: name, email, avatar. Open the account menu to
show **Log out**.

## 0:25 — Compose and schedule (~60s)

**Compose New Email** →

* subject and body;
* **Upload List** with a CSV — call out the detected address count, and that
  duplicates were removed;
* start time a minute out, delay between emails, hourly limit;
* the summary line: *"N emails across M senders, nothing dropped."*

Click **Schedule**. The toast confirms, the Scheduled tab fills, and the
sidebar counter moves.

## 1:25 — Scheduled and Sent (~45s)

Show the Scheduled table: recipient, subject, scheduled time, status, and the
relative "in 2 min" line. Type in the search box to show Elasticsearch filtering
live.

Wait for the first sends, switch to **Sent**: sent time, `SENT` status, and the
preview icon. Open one — the actual email on Ethereal.

## 2:10 — Throttling under load (~50s)

Schedule a batch larger than the hourly limit (or run
`npx tsx src/scripts/loadTest.ts <token> 1000`).

* `/admin/queues`: **delayed** climbs, **completed** rises at a steady pace.
* Dashboard: the per-sender usage bar fills; rows pick up a `rescheduled ×N`
  tag; their scheduled time moves to the next hour.
* Say the key sentence: *nothing was dropped and nothing failed — over-limit
  jobs were moved into the next window.*

## 3:00 — Slack alert (~30s)

Cut to Slack: the alert that fired the moment the cap was reached — sender,
usage, resume time, how many were rescheduled. If it has already fired this
hour, press **Test alert** and show the message land live.

## 3:30 — Restart (~60s)

The important one. With emails still scheduled:

1. `Ctrl-C` the backend. Note the pending count on screen first.
2. *(Optional, and worth doing)* `redis-cli FLUSHALL` — "not just a restart; the
   queue itself is gone."
3. `npm run dev`. Read the boot log aloud:
   `startup reconciliation finished { inspected, requeued, alreadyArmed }`.
4. Refresh the dashboard: the same emails, the same times, none re-sent.
5. Wait for one to go out after the restart.

Land the point: Postgres holds what must be sent, Redis is only the timer, so
the schedule is rebuilt from the database.

## 4:30 — Close (~20s)

Optional and quick: `npm run test:e2e` passing, or the Bull Board queue view.
State the trade-offs in one line and mention that the README covers them.

---

## Things worth saying while the screen is busy

* Scheduling is BullMQ delayed jobs — there is no cron anywhere.
* The rate limiter is a single Redis Lua script, so it is atomic across any
  number of worker processes.
* Job ids are derived from the database row id, so re-adding a job is a no-op —
  that is why a restart cannot double-send.
* Every limit is an environment variable; nothing is hardcoded.
