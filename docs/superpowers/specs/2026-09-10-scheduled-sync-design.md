# Scheduled Acumatica sync — design

**What it is.** A Vercel cron that reads both Acumatica tenants once a day, a guard that stops two
syncs running at once, a line on the dashboard that says when Acumatica was last read, and two
defects in `SyncRun` fixed on the way.

**Why now.** Client decision, 2026-09-10: the spreadsheet register is retired. The Acumatica sync
is therefore the only way a cheque enters this system, and it runs only when someone clicks
SYNC NOW. A sync nobody ran no longer means stale data with a paper fallback; it means the cheque
does not exist anywhere Finance can see it. CLAUDE.md has ranked this first since that decision:
*"a scheduled sync is a prerequisite for switching the team off the spreadsheet, not an improvement
for later."*

Every figure here was measured against production on 2026-09-10.

## What the existing machinery already gives us

- `runSync` in `lib/sync/run.ts` is incremental, per tenant, with a 120-minute overlap watermark.
  Both tenants are watermarked: GOLIVE to `2026-09-10 00:54Z`, MANUFACTURING to `2026-09-08 02:58Z`.
  Thirteen manual runs since 4 September; today's two updated 2 and 3 rows.
- The FULL path — no watermark — reads 11,417 rows. **The first FULL run of GOLIVE was killed by
  Vercel's timeout after ~29 minutes.** The cron never takes that path.
- Every `SyncRun` writes its own row before the feed is read, so a hung run is one with `finishedAt`
  null. One such row exists, from 4 September 14:07.

## Constraints from the Vercel plan

The project is on **Hobby**. Two things follow and neither is negotiable in code:

- **A cron may fire at most once per day**, and Vercel lands it at a minute of its choosing inside
  the hour named. The design is therefore daily, at 18:00 Manila — the client's choice — which is
  `0 10 * * *` UTC. The Philippines has no daylight saving, so that never drifts.
- **Function time is 60 seconds** without Fluid Compute and 300 with it. Whether Fluid Compute is
  enabled is a dashboard setting nobody has verified. The route declares `maxDuration = 60`, which
  Hobby honours either way; an incremental run is seconds.

Daily is the ceiling, not the goal. What makes daily acceptable is that the dashboard will state
how old its Acumatica data is — see *Staleness* — so a cheque cut after six in the evening is
known to be off the board until tomorrow evening or until an admin clicks SYNC NOW, rather than
silently absent.

## Components

### The route — `app/api/cron/sync/route.ts`

`middleware.ts` does not run in this project. A route handler has nothing in front of it, so this
one authenticates on its first line:

- Vercel sends `Authorization: Bearer <CRON_SECRET>` when the `CRON_SECRET` environment variable
  exists. The route compares with `crypto.timingSafeEqual` over equal-length buffers and answers
  **401** to anything else.
- If `CRON_SECRET` is **unset**, the route answers **500** with a message naming the variable and
  runs nothing. An unset secret must never mean "open".
- `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `maxDuration = 60`.
- No session, no user. The run is recorded with `trigger = 'SCHEDULED'` (below).

It runs GOLIVE, then MANUFACTURING, sequentially, **each inside its own try/catch** so one tenant's
failure never skips the other. It returns a JSON summary of both, with HTTP **200** only if both
completed; **500** if either failed, so Vercel's cron log shows the failure.

### Incremental only

If `lastSyncWatermark` is null for a tenant, the route does not call the feed. It records a
`SyncRun` row for that tenant with `errors = 1` and the message *"No watermark for this tenant. A
FULL sync must be started by an admin from /admin/sync; it is not run on a schedule."* — so the
refusal is visible on the admin page rather than in a log nobody reads. `runSync` is not called;
a new `runScheduledSync(db, tenant, client, now)` in `lib/sync/scheduled.ts` performs the check and
delegates to `runSync` only when a watermark exists.

### Concurrency guard — in `runSync`, so SYNC NOW gets it too

Before creating its row, `runSync` looks for a run of the same tenant with `finishedAt IS NULL`
and `startedAt` within the last **10 minutes**. If one exists it throws `SyncInProgressError`
(a `DomainError`, so the admin action shows the message rather than a stack trace) and writes
nothing. Ten minutes is generous against a 60-second function limit; a null-`finishedAt` row older
than that is a killed run — the 4 September row — and is ignored rather than blocking for ever.

The cron route catches `SyncInProgressError` per tenant and reports it in its summary; it is not a
failure of the cron.

### Two `SyncRun` defects fixed

1. **`finishedAt` is written as the START instant.** `finish` writes `finishedAt: now`, where `now`
   is the value the run was started with. Measured: `finishedAt = startedAt` on every completed
   run, so no run has ever had a duration. It becomes `new Date()`. `startedAt` keeps `now`, so a
   test that controls the clock still controls the start.
2. **Nothing records whether a run was clicked or scheduled.** `SyncRun` gains
   `trigger String @default("MANUAL")` — a string, like `mode` and `tenant` beside it. The default
   is true of all thirteen existing rows. `SyncArgs` gains `trigger: 'MANUAL' | 'SCHEDULED'`;
   `syncNowAction` passes `MANUAL`, the cron passes `SCHEDULED`. `/admin/sync` shows the column.

   Migration `20260911000000_sync_run_trigger`, additive. Production migrations are run by hand
   with `prisma migrate deploy` before `vercel --prod`, as `docs/deployment.md` already requires.

### Staleness on the dashboard

`lib/sync/staleness.ts` — pure. `describeStaleness(lastReads, now, staleAfterHours)` takes the
latest successful read per tenant and returns, per tenant, the instant and whether it is stale, and
overall whether the board should warn. "Successful read" is the latest `SyncRun` for that tenant
with `finishedAt IS NOT NULL` and `errors = 0`; a run that failed to reach the feed read nothing.

`STALE_AFTER_HOURS = 30` — a daily cadence plus slack. At 17:59 the data is 24 hours old and that
is normal; at 30 hours the cron has missed.

`app/page.tsx` renders one line under the header, from a small `SyncStatusLine` component:

> ACUMATICA LAST READ · GOLIVE 10 Sep 2026 6:02 PM · MANUFACTURING 10 Sep 2026 6:02 PM

and, past the threshold on either tenant, the line becomes an amber warning:

> ACUMATICA NOT READ FOR 31 HOURS — cheques generated since then are not on this board.

with a link to `/admin/sync` for admins. Times are shown in Manila time, the way every other
timestamp on the dashboard is. This line is what turns *a sync nobody ran* from an invisible gap
into a visible one; on a once-a-day plan it matters as much as the cron itself.

### Configuration

`vercel.json` gains:

```json
"crons": [{ "path": "/api/cron/sync", "schedule": "0 10 * * *" }]
```

`CRON_SECRET` joins `.env.example` (documented as `openssl rand -base64 32`, name only) and the
environment table in `docs/deployment.md`, which also gains a verify step: the day after deploy,
`/admin/sync` shows a run with trigger SCHEDULED for each tenant.

## Testing

Targeted, never the full suite:

- `tests/sync/cron-route.test.ts` — 401 without a bearer, 401 with the wrong one, 500 with
  `CRON_SECRET` unset; the database is never touched on any refused path (the counting-Proxy
  pattern from `tests/export/route.test.ts`); with the right bearer both tenants run; when the
  first tenant's client throws, the second still runs and the response is 500.
- `tests/sync/scheduled.test.ts` — a tenant with no watermark produces a refusal row and the
  client's `fetchAll` is never called.
- `tests/sync/run.test.ts` (existing, extended) — the concurrency guard: an unfinished run started
  five minutes ago blocks; one started fifteen minutes ago does not; `finishedAt` is later than
  `startedAt`; `trigger` is recorded.
- `tests/sync/staleness.test.ts` — literals in, verdicts out, at 29 and 31 hours.
- `tests/admin/actions.test.ts` (existing) — still passes with `trigger: 'MANUAL'`.

`npx tsc --noEmit` after every task. Files to run: `tests/sync/`, `tests/admin/actions.test.ts`,
and whatever imports `app/page.tsx`'s new component.

## Rollout, in order

1. Set `CRON_SECRET` in Vercel (Production).
2. `npx prisma migrate deploy` against production.
3. `npx vercel --prod`.
4. Vercel dashboard → Project → Cron Jobs: the job is listed. Trigger it once by hand from there
   and confirm two SCHEDULED rows on `/admin/sync`.
5. The next evening: two more, unprompted.

## Not in this design

- **More than daily.** That is the Hobby ceiling. Moving to Pro changes one line in `vercel.json`;
  an external scheduler would call the same route with the same secret. Neither is built.
- **Notifications.** A failed cron is visible on `/admin/sync` and in Vercel's cron log, and the
  dashboard warns when data goes stale. Nobody is emailed. That is CLAUDE.md item 4, unchanged.
- **A FULL sync on a schedule.** Refused by design; see above.
