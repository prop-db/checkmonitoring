# Scheduled Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily Vercel cron reads both Acumatica tenants at 18:00 Manila, refuses ever to run a FULL sync, cannot overlap a SYNC NOW, records itself as SCHEDULED, and the dashboard states when Acumatica was last read — so a sync nobody ran is a visible gap, not an invisible one.

**Architecture:** `runSync` in `lib/sync/run.ts` stays the one place a sync happens; it gains a `trigger`, a concurrency guard and a true `finishedAt`. A thin `lib/sync/scheduled.ts` wraps it with the incremental-only rule. A route under `app/api/cron/sync` authenticates with a bearer secret on its first line (middleware does not run) and calls the wrapper once per tenant. A pure `lib/sync/staleness.ts` decides when the dashboard warns; a small server component renders it. One additive migration adds `SyncRun.trigger`.

**Tech Stack:** Next 15 App Router route handler · Prisma 6 (one migration) · Vercel Cron · Node `crypto.timingSafeEqual` · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-scheduled-sync-design.md`. Read it before Task 1.

## Global Constraints

- **`npx tsc --noEmit` must pass before any task is called done.** Vitest transpiles with esbuild, which erases types.
- **On Windows use `npx.cmd` / `npm.cmd`.** PowerShell's execution policy blocks `npx.ps1`.
- **Run ONLY the test files named in the task. Never the full suite.** Every test crosses the network to Neon; the whole suite is ~20 minutes and the user has ruled it out for routine work. All test files share one database and `resetDb()` truncates it — never two test processes at once.
- **The migration must reach the TEST database before any test in this plan runs**, and it reaches production by hand before deploy. `npx prisma migrate dev` refuses this non-interactive shell, and the Neon URL contains `&`, which a shell mangles — Task 1 adds `scripts/migrate.mjs`, which spawns the Prisma CLI with the URL in `argv` and no shell. Use it; never paste the URL on a command line.
- **`middleware.ts` does not run.** The cron route authenticates itself on its first line. An unset `CRON_SECRET` means REFUSE, never open.
- **Acumatica stays read-only.** This plan reads the feed through the existing client and adds no method to it.
- **An import never changes a cheque's status** — `runSync` goes through `upsertCheck` and nothing here touches that.
- **A FULL sync is never run on a schedule.** No watermark → record a refusal, call nothing.
- **Never write a raw control character into a source file.**
- **Never commit or print** `.env`, any credential, or any `.xlsx`. `CRON_SECRET`'s value appears nowhere in the repository — `.env.example` documents the name only.
- **British spelling in prose** ("cheque").
- **Commit messages end with:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | **Modify.** `SyncRun.trigger String @default("MANUAL")`. |
| `prisma/migrations/20260911000000_sync_run_trigger/migration.sql` | **Create.** The additive column. |
| `scripts/migrate.mjs` | **Create.** `node scripts/migrate.mjs test` / `prod --confirm`: applies migrations with the URL passed in `argv`, no shell. The procedure earlier plans rediscovered by hand, committed. |
| `lib/sync/run.ts` | **Modify.** `SyncTrigger`, `SyncArgs.trigger`, `SyncInProgressError`, the guard, and `finishedAt: new Date()`. |
| `app/admin/actions.ts` | **Modify.** Passes `trigger: 'MANUAL'`. |
| `scripts/sync.ts` | **Modify.** Passes `trigger: 'MANUAL'`. |
| `lib/sync/scheduled.ts` | **Create.** `runScheduledSync`: incremental-only, records a refusal, classifies outcomes. |
| `app/api/cron/sync/route.ts` | **Create.** Bearer guard, both tenants, JSON summary, 500 on any failure. |
| `lib/sync/staleness.ts` | **Create.** Pure: `describeStaleness`, `STALE_AFTER_HOURS = 30`. |
| `components/SyncStatusLine.tsx` | **Create.** The line under the dashboard header, and its warning form. |
| `app/page.tsx` | **Modify.** Fetches the sync overview alongside the summary; renders the line. |
| `app/admin/sync/page.tsx` | **Modify.** TRIGGER column in the log. |
| `vercel.json` | **Modify.** The `crons` entry. |
| `.env.example` | **Modify.** `CRON_SECRET`, name only. |
| `docs/deployment.md` | **Modify.** The variable, the migration script, the verify step. |
| `CLAUDE.md` | **Modify.** Item 1 of "What is missing" becomes built-pending-deploy; the migration procedure. |
| `tests/sync/run.test.ts` | **Modify.** Trigger recorded; `finishedAt` after `startedAt`; the guard. |
| `tests/sync/scheduled.test.ts` | **Create.** |
| `tests/sync/cron-route.test.ts` | **Create.** |
| `tests/sync/staleness.test.ts` | **Create.** |

---

### Task 1: `SyncRun.trigger`, a true `finishedAt`, and a way to migrate the test database

**Files:**
- Modify: `prisma/schema.prisma` (the `SyncRun` model)
- Create: `prisma/migrations/20260911000000_sync_run_trigger/migration.sql`
- Create: `scripts/migrate.mjs`
- Modify: `lib/sync/run.ts`, `app/admin/actions.ts`, `scripts/sync.ts`
- Test: `tests/sync/run.test.ts`

**Interfaces:**
- Produces: `export type SyncTrigger = 'MANUAL' | 'SCHEDULED'`; `SyncArgs.trigger: SyncTrigger` (required — stated, never defaulted, like `tenant`); `SyncRun.trigger` column.

- [ ] **Step 1: The migration script**

Create `scripts/migrate.mjs`:

```js
/**
 * Apply the migrations in prisma/migrations to ONE named database.
 *
 *   node scripts/migrate.mjs test
 *   node scripts/migrate.mjs prod --confirm
 *
 * WHY THIS EXISTS. `npx prisma migrate dev` refuses to run in the
 * non-interactive shells this project is worked from, and the Neon connection
 * string carries `&` and `?`, which a shell interprets — pasting it on a command
 * line fails with "'channel_binding' is not recognized as an internal or
 * external command". Plans 1, 2 and 4 each rediscovered this by hand. The
 * answer, every time, was to spawn the Prisma CLI with the URL as an argv entry
 * and NO shell, from a script that loads .env itself. This is that script,
 * committed.
 *
 * `test` swaps the *_TEST variables in for the plain ones so `migrate deploy`
 * sees the test database as the database. `prod` uses the plain names — which
 * in .env ARE production — and refuses without --confirm, because a migration
 * against real money should never be one typo away from the test one.
 *
 * Prints the host and database it is about to touch, never the credentials.
 */
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const TARGETS = {
  test: { DATABASE_URL: 'DATABASE_URL_TEST', DIRECT_DATABASE_URL: 'DIRECT_DATABASE_URL_TEST' },
  prod: { DATABASE_URL: 'DATABASE_URL', DIRECT_DATABASE_URL: 'DIRECT_DATABASE_URL' },
}

const [target, ...flags] = process.argv.slice(2)
if (!TARGETS[target]) {
  console.error('usage: node scripts/migrate.mjs test | prod --confirm')
  process.exit(2)
}
if (target === 'prod' && !flags.includes('--confirm')) {
  console.error('Refusing to migrate PRODUCTION without --confirm.')
  process.exit(2)
}

const env = { ...process.env }
for (const [name, from] of Object.entries(TARGETS[target])) {
  const value = process.env[from]
  if (!value) {
    console.error(`${from} is not set in .env.`)
    process.exit(2)
  }
  env[name] = value
}

// Host and database only. The password is in the same string and stays there.
const where = new URL(env.DIRECT_DATABASE_URL)
console.log(`Migrating ${target.toUpperCase()}: ${where.hostname}${where.pathname}`)

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  process.execPath,
  [path.join(repo, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
  { cwd: repo, env, stdio: 'inherit' },
)
process.exit(result.status ?? 1)
```

- [ ] **Step 2: The column**

In `prisma/schema.prisma`, inside `model SyncRun`, directly after the `watermark  DateTime?` line and its comment, add:

```prisma
  // Who started the run: a person pressing SYNC NOW, or the schedule. A string
  // like `mode` and `tenant` beside it. Defaults to MANUAL because that is the
  // truth about every row written before the column existed — all thirteen of
  // them were clicked. `runSync` always sets it; the default is for history, not
  // for callers, and `SyncArgs.trigger` is required for exactly that reason.
  trigger    String    @default("MANUAL")
```

Create `prisma/migrations/20260911000000_sync_run_trigger/migration.sql`:

```sql
-- Who started a sync: a person pressing SYNC NOW, or the schedule.
--
-- Until 2026-09-11 every run was a click, so the default is not a guess about
-- history — it is history. From here the daily cron writes SCHEDULED and the
-- admin log can say which runs happened because somebody remembered and which
-- because nobody had to.
ALTER TABLE "SyncRun" ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'MANUAL';
```

Apply it to the test database and regenerate the client:

```bash
node scripts/migrate.mjs test
npx.cmd prisma generate
```

Expected: the script prints `Migrating TEST: <host>/check_monitoring_test`, Prisma reports `1 migration found` and applies `20260911000000_sync_run_trigger`; `generate` completes.

- [ ] **Step 3: Write the failing tests**

In `tests/sync/run.test.ts`, change the `sync` helper so `runSync` receives a trigger — the call becomes:

```ts
    result: runSync(testDb, {
      client,
      tenant: opts.tenant ?? 'GOLIVE',
      since: opts.since ?? null,
      now: opts.now ?? NOW,
      trigger: opts.trigger ?? 'MANUAL',
    }),
```

and the helper's `opts` type gains `trigger?: 'MANUAL' | 'SCHEDULED'`.

Then add, inside `describe('runSync — the run record', ...)`:

```ts
  it('records who started it', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow()], { trigger: 'SCHEDULED' }).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.trigger).toBe('SCHEDULED')
  })

  /**
   * Measured 2026-09-10: `finishedAt = startedAt` on every completed run in
   * production, because `finish` wrote the instant the run was STARTED with.
   * No run had ever had a duration. `startedAt` is still the caller's clock —
   * that is what lets these tests pin it — so the only honest `finishedAt` is
   * the real one.
   */
  it('finishes after it starts', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow()]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.startedAt).toEqual(NOW)
    expect(run.finishedAt!.getTime()).toBeGreaterThan(run.startedAt.getTime())
  })
```

- [ ] **Step 4: Run and watch them fail**

```bash
npx.cmd vitest run tests/sync/run.test.ts
```

Expected: the first new test fails with `expected 'MANUAL' to be 'SCHEDULED'` (the column defaults), the second with the two instants equal. Every pre-existing test still passes.

- [ ] **Step 5: Thread the trigger and fix `finishedAt`**

In `lib/sync/run.ts`, after `export type SyncMode = ...`, add:

```ts
/** Who started a run. Stated by every caller, never defaulted — like `tenant`. */
export type SyncTrigger = 'MANUAL' | 'SCHEDULED'
```

In `SyncArgs`, after `now: Date`, add:

```ts
  /**
   * A person pressing SYNC NOW, a terminal run, or the schedule. Recorded on
   * the `SyncRun` row so the admin log can say which runs happened because
   * somebody remembered and which because nobody had to.
   */
  trigger: SyncTrigger
```

In `runSync`, change the destructuring to `const { client, tenant, since, now, trigger } = args` and the row creation to:

```ts
  const run = await db.syncRun.create({ data: { mode, tenant, startedAt: now, trigger } })
```

In `finish`, change `finishedAt: now,` to:

```ts
        // The real instant, not `now`. `now` is the caller's clock and is what
        // `startedAt` holds; writing it here too gave every run in production a
        // duration of zero (measured 2026-09-10) and made a hung run look
        // finished the moment it began.
        finishedAt: new Date(),
```

In `app/admin/actions.ts`, inside `syncNowAction`'s `runSync` call, add `trigger: 'MANUAL',` after `now: new Date(),`.

In `scripts/sync.ts`, inside its `runSync` call, add `trigger: 'MANUAL',` after `now: new Date(),`.

- [ ] **Step 6: Run the test file and the type-checker**

```bash
npx.cmd vitest run tests/sync/run.test.ts tests/admin/actions.test.ts
```

Expected: PASS in both files — `actions.test.ts` is run because `app/admin/actions.ts` changed, and its SYNC NOW tests exercise the new argument end to end.

```bash
npx.cmd tsc --noEmit
```

Expected: no output. If any other caller of `runSync` fails to type-check for want of `trigger`, add `trigger: 'MANUAL'` there — the type is deliberately required, and the three known callers are the admin action, `scripts/sync.ts`, and the tests.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260911000000_sync_run_trigger/migration.sql scripts/migrate.mjs lib/sync/run.ts app/admin/actions.ts scripts/sync.ts tests/sync/run.test.ts
git commit -m "feat: record who started a sync, and when it actually finished

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The concurrency guard

**Files:**
- Modify: `lib/sync/run.ts`
- Test: `tests/sync/run.test.ts`

**Interfaces:**
- Produces: `export const SYNC_IN_PROGRESS_MINUTES = 10`; `export class SyncInProgressError extends DomainError`; `runSync` throws it, before writing anything, when an unfinished run of the same tenant started inside the window.

- [ ] **Step 1: Write the failing tests**

Add to `tests/sync/run.test.ts` — extend the import from `@/lib/sync/run` with `SyncInProgressError, SYNC_IN_PROGRESS_MINUTES`, then add a new `describe` at the end of the file:

```ts
describe('runSync — one run per tenant at a time', () => {
  const minutesBefore = (m: number) => new Date(NOW.getTime() - m * 60_000)

  const unfinished = (tenant: 'GOLIVE' | 'MANUFACTURING', startedAt: Date) =>
    testDb.syncRun.create({
      data: { mode: 'INCREMENTAL', tenant, startedAt, finishedAt: null, trigger: 'MANUAL' },
    })

  it('refuses to start while a run of the same tenant is still going', async () => {
    await seedBothTenantsST()
    await unfinished('GOLIVE', minutesBefore(5))
    await expect(sync([feedRow()]).result).rejects.toBeInstanceOf(SyncInProgressError)
    // Refused BEFORE writing: the refusal leaves no row of its own.
    expect(await testDb.syncRun.count()).toBe(1)
  })

  /**
   * A killed run keeps `finishedAt` null for ever — the 4 September 14:07 row
   * in production is one. Past the window it is a corpse, not a competitor,
   * and must not block every future run.
   */
  it('ignores an unfinished run older than the window', async () => {
    await seedBothTenantsST()
    await unfinished('GOLIVE', minutesBefore(SYNC_IN_PROGRESS_MINUTES + 5))
    const result = await sync([feedRow()]).result
    expect(result.imported).toBe(1)
  })

  it('does not let one tenant block the other', async () => {
    await seedBothTenantsST()
    await unfinished('MANUFACTURING', minutesBefore(5))
    const result = await sync([feedRow()], { tenant: 'GOLIVE' }).result
    expect(result.imported).toBe(1)
  })
})
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx.cmd vitest run tests/sync/run.test.ts
```

Expected: the first new test fails (the run proceeds and writes a second row); the import of `SyncInProgressError` is `undefined`.

- [ ] **Step 3: Add the guard**

In `lib/sync/run.ts`, add to the imports:

```ts
import { DomainError } from '@/lib/domain/errors'
```

After `export const SYNC_OVERLAP_MINUTES = 120` and its comment, add:

```ts
/**
 * How long an unfinished run is believed to be still running.
 *
 * `runSync` writes its row before reading the feed and finishes it in every
 * exit path it controls — but a platform kill runs no `catch`, so a killed run
 * keeps `finishedAt` null for ever. The 4 September 14:07 row in production is
 * one. Two facts follow: a null `finishedAt` inside this window is a run to
 * wait for, and one outside it is a corpse to ignore.
 *
 * Ten minutes is generous against the 60-second function limit the scheduled
 * route runs under, and short enough that a killed SYNC NOW does not lock the
 * tenant until somebody notices. `ABANDONED_AFTER_MINUTES` in
 * lib/admin/sync-overview.ts is the SCREEN's threshold for the same rows and is
 * deliberately longer: a terminal run of a first full sync legitimately takes
 * an hour, and the screen must not libel it. This one governs whether a NEW
 * run may start, and nothing that runs on a schedule takes an hour.
 */
export const SYNC_IN_PROGRESS_MINUTES = 10

/**
 * Thrown before anything is written. A `DomainError`, so the admin action shows
 * its message rather than a stack trace, and the scheduled route can tell it
 * from a failure — a sync that declined to double up is not a sync that broke.
 */
export class SyncInProgressError extends DomainError {
  constructor(tenant: AcumaticaTenant, startedAt: Date) {
    super(
      'SYNC_IN_PROGRESS',
      `A ${tenant} sync started at ${startedAt.toISOString()} has not finished. ` +
        `Wait for it, or ${SYNC_IN_PROGRESS_MINUTES} minutes, before starting another.`,
    )
  }
}

async function assertNoRunInProgress(db: Db, tenant: AcumaticaTenant, now: Date): Promise<void> {
  const open = await db.syncRun.findFirst({
    where: {
      tenant,
      finishedAt: null,
      startedAt: { gt: new Date(now.getTime() - SYNC_IN_PROGRESS_MINUTES * 60_000) },
    },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })
  if (open) throw new SyncInProgressError(tenant, open.startedAt)
}
```

In `runSync`, insert as the first statement after `const mode: SyncMode = ...` and before the row is created:

```ts
  // Before the row, so a refused start leaves no trace of its own. The check
  // and the create are two round trips, not one transaction — a genuine race
  // between two clicks a millisecond apart would let both through, and the
  // upserts are idempotent so the cost of that is wasted work, not a wrong
  // cheque. What this stops is the common case: a cron landing on a SYNC NOW.
  await assertNoRunInProgress(db, tenant, now)
```

- [ ] **Step 4: Run the test file and the type-checker**

```bash
npx.cmd vitest run tests/sync/run.test.ts
```

Expected: PASS, all tests. (The `afterEach` PortalEvent assertion still holds on every one.)

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/run.ts tests/sync/run.test.ts
git commit -m "feat: one sync per tenant at a time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The scheduled wrapper — incremental only

**Files:**
- Create: `lib/sync/scheduled.ts`
- Test: `tests/sync/scheduled.test.ts`

**Interfaces:**
- Consumes: `runSync`, `lastSyncWatermark`, `SyncInProgressError` from `lib/sync/run.ts`; `AcumaticaClient` type; `AcumaticaTenant` type.
- Produces:
  ```ts
  export const NO_WATERMARK_MESSAGE: string
  export type ScheduledSyncOutcome =
    | { tenant: AcumaticaTenant; outcome: 'RAN'; syncRunId: string; mode: SyncMode; fetched: number; imported: number; updated: number; staged: number; errors: number }
    | { tenant: AcumaticaTenant; outcome: 'REFUSED_NO_WATERMARK'; syncRunId: string }
    | { tenant: AcumaticaTenant; outcome: 'IN_PROGRESS'; message: string }
    | { tenant: AcumaticaTenant; outcome: 'FAILED'; message: string }
  export function runScheduledSync(db: Db, args: { tenant: AcumaticaTenant; now: Date; client: () => AcumaticaClient }): Promise<ScheduledSyncOutcome>
  ```
  `client` is a **factory**, called only when a run will actually happen, so a missing environment variable for one tenant becomes that tenant's `FAILED` and not the whole route's.

- [ ] **Step 1: Write the failing test**

Create `tests/sync/scheduled.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { runScheduledSync, NO_WATERMARK_MESSAGE } from '@/lib/sync/scheduled'
import {
  PAYMENTS_FEED, type AcumaticaClient, type AcumaticaRow,
} from '@/lib/integrations/acumatica/client'

const NOW = new Date('2026-09-11T10:00:00Z')

beforeEach(resetDb)

// The schedule is the path most likely to grow a portal call by accident: it
// runs unattended. Asserted after every test, as tests/sync/run.test.ts does.
afterEach(async () => {
  expect(await testDb.portalEvent.count()).toBe(0)
})

/** A client that records whether it was asked for anything. */
function fakeClient(rows: readonly AcumaticaRow[] = [], failWith?: Error) {
  const calls: string[] = []
  const client: AcumaticaClient = {
    async fetchAll(feed) {
      calls.push(feed)
      if (failWith) throw failWith
      return [...rows]
    },
    async fetchPage() {
      throw new Error('not used')
    },
  }
  return { client, calls }
}

const watermarked = (tenant: 'GOLIVE' | 'MANUFACTURING') =>
  testDb.syncRun.create({
    data: {
      mode: 'INCREMENTAL', tenant, trigger: 'MANUAL',
      startedAt: new Date('2026-09-10T10:00:00Z'), finishedAt: new Date('2026-09-10T10:00:05Z'),
      watermark: new Date('2026-09-10T08:00:00Z'),
    },
  })

describe('runScheduledSync', () => {
  /**
   * The first FULL sync of GOLIVE was killed by Vercel's timeout after ~29
   * minutes. A schedule must never take that path: no watermark means record
   * the refusal where an admin will see it and call nothing.
   */
  it('refuses to run FULL: no watermark means a recorded refusal and no fetch', async () => {
    const feed = fakeClient()
    const outcome = await runScheduledSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })

    expect(outcome.outcome).toBe('REFUSED_NO_WATERMARK')
    expect(feed.calls).toEqual([])

    const rows = await testDb.syncRun.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0].tenant).toBe('GOLIVE')
    expect(rows[0].trigger).toBe('SCHEDULED')
    expect(rows[0].errors).toBe(1)
    expect(rows[0].finishedAt).not.toBeNull()
    expect(rows[0].message).toBe(NO_WATERMARK_MESSAGE)
  })

  it('runs an incremental read, recorded as SCHEDULED, when a watermark exists', async () => {
    await watermarked('GOLIVE')
    const feed = fakeClient()
    const outcome = await runScheduledSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })

    expect(outcome.outcome).toBe('RAN')
    expect(feed.calls).toEqual([PAYMENTS_FEED])

    const run = await testDb.syncRun.findFirstOrThrow({ where: { startedAt: NOW } })
    expect(run.mode).toBe('INCREMENTAL')
    expect(run.trigger).toBe('SCHEDULED')
  })

  it('reports a feed failure as FAILED and leaves the recorded row behind', async () => {
    await watermarked('MANUFACTURING')
    const feed = fakeClient([], new Error('HTTP 503 from the feed'))
    const outcome = await runScheduledSync(testDb, { tenant: 'MANUFACTURING', now: NOW, client: () => feed.client })

    expect(outcome.outcome).toBe('FAILED')
    if (outcome.outcome === 'FAILED') expect(outcome.message).toContain('503')
    const run = await testDb.syncRun.findFirstOrThrow({ where: { startedAt: NOW } })
    expect(run.errors).toBe(1)
    expect(run.finishedAt).not.toBeNull()
  })

  it('reports a run already in progress as IN_PROGRESS, not as a failure', async () => {
    await watermarked('GOLIVE')
    await testDb.syncRun.create({
      data: {
        mode: 'INCREMENTAL', tenant: 'GOLIVE', trigger: 'MANUAL',
        startedAt: new Date(NOW.getTime() - 2 * 60_000), finishedAt: null,
      },
    })
    const feed = fakeClient()
    const outcome = await runScheduledSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })
    expect(outcome.outcome).toBe('IN_PROGRESS')
    expect(feed.calls).toEqual([])
  })

  it('turns a client that cannot be built into that tenant FAILED', async () => {
    await watermarked('GOLIVE')
    const outcome = await runScheduledSync(testDb, {
      tenant: 'GOLIVE', now: NOW,
      client: () => { throw new Error('ACUMATICA_ODATA_URL is not set') },
    })
    expect(outcome.outcome).toBe('FAILED')
    if (outcome.outcome === 'FAILED') expect(outcome.message).toContain('ACUMATICA_ODATA_URL')
  })
})
```

`PAYMENTS_FEED` is the feed name `runSync` asks for; comparing to the constant rather than a literal means a renamed feed cannot silently pass this test.

- [ ] **Step 2: Run and watch it fail**

```bash
npx.cmd vitest run tests/sync/scheduled.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/sync/scheduled"`.

- [ ] **Step 3: Write the wrapper**

Create `lib/sync/scheduled.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import { lastSyncWatermark, runSync, SyncInProgressError, type SyncMode } from './run'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * What a scheduled run says when it will not run.
 *
 * Recorded on a `SyncRun` row rather than logged: the admin page reads rows,
 * and a refusal nobody can see is a cheque nobody can see. The first FULL sync
 * of GOLIVE was killed by Vercel's timeout after ~29 minutes; it is a job for
 * scripts/sync.ts from a terminal, and this route never attempts it.
 */
export const NO_WATERMARK_MESSAGE =
  'No watermark for this tenant. A FULL sync must be started by an admin — from ' +
  'scripts/sync.ts in a terminal for a first read — and is never run on a schedule.'

export type ScheduledSyncOutcome =
  | {
      tenant: AcumaticaTenant
      outcome: 'RAN'
      syncRunId: string
      mode: SyncMode
      fetched: number
      imported: number
      updated: number
      staged: number
      errors: number
    }
  | { tenant: AcumaticaTenant; outcome: 'REFUSED_NO_WATERMARK'; syncRunId: string }
  | { tenant: AcumaticaTenant; outcome: 'IN_PROGRESS'; message: string }
  | { tenant: AcumaticaTenant; outcome: 'FAILED'; message: string }

/**
 * One tenant's scheduled read, never throwing.
 *
 * Every outcome is a value, because the route calls this once per tenant in
 * sequence and one tenant's trouble must never skip the other. `client` is a
 * factory rather than a client so that a missing environment variable for one
 * tenant is that tenant's FAILED and not an exception before either has run.
 *
 * `IN_PROGRESS` is kept apart from `FAILED` deliberately: a sync that declined
 * to double up on a SYNC NOW somebody just pressed is not a sync that broke,
 * and the route does not answer 500 for it.
 */
export async function runScheduledSync(
  db: Db,
  args: { tenant: AcumaticaTenant; now: Date; client: () => AcumaticaClient },
): Promise<ScheduledSyncOutcome> {
  const { tenant, now } = args
  try {
    const since = await lastSyncWatermark(db, tenant)
    if (since === null) {
      const run = await db.syncRun.create({
        data: {
          mode: 'FULL', tenant, trigger: 'SCHEDULED',
          startedAt: now, finishedAt: new Date(),
          errors: 1, message: NO_WATERMARK_MESSAGE,
        },
      })
      return { tenant, outcome: 'REFUSED_NO_WATERMARK', syncRunId: run.id }
    }

    const result = await runSync(db, { client: args.client(), tenant, since, now, trigger: 'SCHEDULED' })
    return {
      tenant, outcome: 'RAN', syncRunId: result.syncRunId, mode: result.mode,
      fetched: result.fetched, imported: result.imported, updated: result.updated,
      staged: result.staged, errors: result.errors,
    }
  } catch (error) {
    if (error instanceof SyncInProgressError) return { tenant, outcome: 'IN_PROGRESS', message: error.message }
    return { tenant, outcome: 'FAILED', message: error instanceof Error ? error.message : String(error) }
  }
}
```

- [ ] **Step 4: Run the test file and the type-checker**

```bash
npx.cmd vitest run tests/sync/scheduled.test.ts
```

Expected: PASS, 5 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/scheduled.ts tests/sync/scheduled.test.ts
git commit -m "feat: a scheduled read is incremental or it is a recorded refusal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The cron route, and the configuration around it

**Files:**
- Create: `app/api/cron/sync/route.ts`
- Modify: `vercel.json`, `.env.example`, `docs/deployment.md`
- Test: `tests/sync/cron-route.test.ts`

**Interfaces:**
- Consumes: `runScheduledSync` (Task 3); `SYNC_TENANTS` from `lib/admin/sync-overview.ts`; `createClientForTenant` from `lib/integrations/acumatica/from-env.ts`; `prisma` from `@/lib/db`.
- Produces: `GET /api/cron/sync` → `{ ranAt, outcomes }`, 200 or 500.

- [ ] **Step 1: Write the failing test**

Create `tests/sync/cron-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetDb, testDb } from '../helpers/db'

/**
 * The scheduled route's guard. `middleware.ts` DOES NOT RUN in this project, so
 * a route handler has no perimeter in front of it; this one authenticates
 * itself with a bearer secret on its first line, and an UNSET secret refuses
 * rather than opens. The database is reached through a Proxy that counts every
 * property touch, so "did nothing" is asserted as "never asked the database",
 * the same way tests/export/route.test.ts does it.
 */
const state = vi.hoisted(() => ({
  dbTouches: 0,
  requested: [] as string[],
  failFor: null as string | null,
}))

vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return {
    prisma: new Proxy(testDb, {
      get(target, prop, receiver) {
        state.dbTouches += 1
        return Reflect.get(target, prop, receiver)
      },
    }),
  }
})

vi.mock('@/lib/integrations/acumatica/from-env', () => ({
  createClientForTenant: (tenant: string) => {
    state.requested.push(tenant)
    if (state.failFor === tenant) throw new Error(`${tenant} cannot be built`)
    return { fetchAll: async () => [], fetchPage: async () => [] }
  },
}))

const SECRET = 'test-cron-secret'

async function get(authorization?: string) {
  const { GET } = await import('@/app/api/cron/sync/route')
  return GET(new Request('http://localhost/api/cron/sync', {
    headers: authorization ? { authorization } : {},
  }))
}

const watermarked = (tenant: 'GOLIVE' | 'MANUFACTURING') =>
  testDb.syncRun.create({
    data: {
      mode: 'INCREMENTAL', tenant, trigger: 'MANUAL',
      startedAt: new Date('2026-09-10T10:00:00Z'), finishedAt: new Date('2026-09-10T10:00:05Z'),
      watermark: new Date('2026-09-10T08:00:00Z'),
    },
  })

beforeEach(async () => {
  await resetDb()
  process.env.CRON_SECRET = SECRET
  state.dbTouches = 0
  state.requested = []
  state.failFor = null
})

describe('GET /api/cron/sync — the guard', () => {
  it('refuses with 500 and touches nothing when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)
    expect(state.dbTouches).toBe(0)
    expect(state.requested).toEqual([])
  })

  it('refuses a request with no bearer', async () => {
    const res = await get()
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('refuses the wrong bearer', async () => {
    const res = await get('Bearer not-the-secret')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
    expect(state.requested).toEqual([])
  })
})

describe('GET /api/cron/sync — the run', () => {
  it('reads both tenants, in order, as SCHEDULED', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.outcomes.map((o: { tenant: string; outcome: string }) => [o.tenant, o.outcome]))
      .toEqual([['GOLIVE', 'RAN'], ['MANUFACTURING', 'RAN']])
    expect(state.requested).toEqual(['GOLIVE', 'MANUFACTURING'])

    const scheduled = await testDb.syncRun.findMany({ where: { trigger: 'SCHEDULED' } })
    expect(scheduled.map((r) => r.tenant).sort()).toEqual(['GOLIVE', 'MANUFACTURING'])
  })

  it('still reads the second tenant when the first fails, and answers 500', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failFor = 'GOLIVE'
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['FAILED', 'RAN'])
    expect(state.requested).toEqual(['GOLIVE', 'MANUFACTURING'])
  })

  it('answers 200 when a tenant merely had no watermark — the refusal is recorded, not a fault of the cron', async () => {
    await watermarked('GOLIVE')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['RAN', 'REFUSED_NO_WATERMARK'])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx.cmd vitest run tests/sync/cron-route.test.ts
```

Expected: FAIL — `Failed to resolve import "@/app/api/cron/sync/route"`.

- [ ] **Step 3: Write the route**

Create `app/api/cron/sync/route.ts`:

```ts
import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/db'
import { createClientForTenant } from '@/lib/integrations/acumatica/from-env'
import { SYNC_TENANTS } from '@/lib/admin/sync-overview'
import { runScheduledSync, type ScheduledSyncOutcome } from '@/lib/sync/scheduled'

/**
 * THE SCHEDULED SYNC. Vercel calls this once a day — `crons` in vercel.json,
 * `0 10 * * *` UTC, which is 18:00 Manila and never drifts because the
 * Philippines has no daylight saving.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` DOES NOT RUN in this project. A route handler has nothing in
 * front of it, so this one authenticates on its first line: Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` when that environment variable exists,
 * and nothing else is allowed to trigger a read of the ERP.
 *
 * An UNSET secret refuses (500) rather than opening. The alternative — "no
 * secret configured, so anyone may run it" — is exactly the default that gets
 * shipped by accident.
 *
 * No session, no user. The run records itself as SCHEDULED.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Both tenants, in order, each inside `runScheduledSync`'s own try/catch, so
 * one tenant's trouble never skips the other. 500 if any tenant FAILED, so
 * Vercel's cron log shows the failure; a refusal for want of a watermark or a
 * run already in progress is recorded and is not a failure of the cron.
 */

// ExcelJS is not involved, but the Prisma client is Node-only all the same.
export const runtime = 'nodejs'
// Never cached, never prerendered.
export const dynamic = 'force-dynamic'
/**
 * Hobby honours 60 with or without Fluid Compute. An incremental run is
 * seconds; the FULL path that would need more is refused by design.
 */
export const maxDuration = 60

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Constant-time on equal lengths; a length mismatch is refused outright. */
function bearerMatches(request: Request, secret: string): boolean {
  const presented = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

export async function GET(request: Request): Promise<Response> {
  // Read at request time, not module load, so a test can vary it and a
  // deployment that sets it later does not need a rebuild.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return json({ error: 'CRON_SECRET is not set. The scheduled sync refuses to run open.' }, 500)
  }
  if (!bearerMatches(request, secret)) {
    return new Response('UNAUTHORISED', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const now = new Date()
  const outcomes: ScheduledSyncOutcome[] = []
  for (const tenant of SYNC_TENANTS) {
    outcomes.push(
      await runScheduledSync(prisma, { tenant, now, client: () => createClientForTenant(tenant) }),
    )
  }

  const failed = outcomes.some((o) => o.outcome === 'FAILED')
  return json({ ranAt: now.toISOString(), outcomes }, failed ? 500 : 200)
}
```

- [ ] **Step 4: The configuration**

In `vercel.json`, add a top-level key after `"regions"`:

```json
  "crons": [
    { "path": "/api/cron/sync", "schedule": "0 10 * * *" }
  ],
```

In `.env.example`, append:

```
# The bearer Vercel presents when it calls /api/cron/sync on the daily schedule.
# Generate with `openssl rand -base64 32`. Set in Vercel for Production; the route
# refuses to run at all while it is unset.
CRON_SECRET="generate-with-openssl-rand-base64-32"
```

In `docs/deployment.md`:

1. In the environment-variable table, add a row after `ACUMATICA_GI_NAME`:

```markdown
| `CRON_SECRET` | `openssl rand -base64 32`. Vercel presents it as a bearer when it calls `/api/cron/sync` daily at 18:00 Manila; the route refuses to run while it is unset. |
```

2. Replace the "Migrations" section's command block with:

```markdown
Vercel does not run migrations. Run them yourself, from a machine that has the direct URL:

```bash
node scripts/migrate.mjs prod --confirm
```

The connection string contains `&`, which breaks shell invocations of the Prisma CLI; the script
passes the URL in `argv` with no shell, and prints the host and database it is about to touch.
`node scripts/migrate.mjs test` does the same to the test database, which every migration must
reach before the suite is run.
```

3. In "After the first deploy — verify, do not assume", add:

```markdown
6. Vercel dashboard → Project → Settings → Cron Jobs lists `/api/cron/sync` at `0 10 * * *`.
   Trigger it once from there. `/admin/sync` then shows a run per tenant with trigger SCHEDULED.
   The next evening at 18:00 Manila, two more appear unprompted — and the dashboard's
   ACUMATICA LAST READ line moves.
```

- [ ] **Step 5: Run the test file and the type-checker**

```bash
npx.cmd vitest run tests/sync/cron-route.test.ts
```

Expected: PASS, 6 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/sync/route.ts tests/sync/cron-route.test.ts vercel.json .env.example docs/deployment.md
git commit -m "feat: read Acumatica every evening, behind a bearer nobody else holds

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Staleness on the dashboard, and the TRIGGER column

**Files:**
- Create: `lib/sync/staleness.ts`
- Create: `components/SyncStatusLine.tsx`
- Modify: `app/page.tsx`, `app/admin/sync/page.tsx`
- Test: `tests/sync/staleness.test.ts`

**Interfaces:**
- Consumes: `getSyncOverview` and `TenantSync` from `lib/admin/sync-overview.ts` (`lastSuccess` is the latest run with `finishedAt` not null and `errors = 0` — exactly the spec's "successful read").
- Produces:
  ```ts
  export const STALE_AFTER_HOURS = 30
  export type TenantRead = { tenant: string; lastReadAt: Date | null }
  export type TenantStaleness = TenantRead & { hoursAgo: number | null; stale: boolean }
  export type Staleness = { tenants: TenantStaleness[]; warn: boolean; oldestHours: number | null }
  export function describeStaleness(reads: readonly TenantRead[], now: Date, staleAfterHours?: number): Staleness
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/sync/staleness.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { describeStaleness, STALE_AFTER_HOURS } from '@/lib/sync/staleness'

const NOW = new Date('2026-09-12T10:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

/**
 * Pure. On a once-a-day plan this is what turns "a sync nobody ran" from an
 * invisible gap into a visible one, so the threshold and the verdicts are
 * pinned with literals rather than read off a rendered page.
 */
describe('describeStaleness', () => {
  it('is quiet at 24 hours — that is what a daily cadence looks like', () => {
    const s = describeStaleness([{ tenant: 'GOLIVE', lastReadAt: hoursAgo(24) }], NOW)
    expect(s.warn).toBe(false)
    expect(s.tenants[0].hoursAgo).toBe(24)
    expect(s.tenants[0].stale).toBe(false)
  })

  it('warns once the daily run has been missed', () => {
    const s = describeStaleness([{ tenant: 'GOLIVE', lastReadAt: hoursAgo(31) }], NOW)
    expect(s.warn).toBe(true)
    expect(s.oldestHours).toBe(31)
  })

  it('pins the threshold at 30 hours', () => {
    expect(STALE_AFTER_HOURS).toBe(30)
    expect(describeStaleness([{ tenant: 'GOLIVE', lastReadAt: hoursAgo(29) }], NOW).warn).toBe(false)
    expect(describeStaleness([{ tenant: 'GOLIVE', lastReadAt: hoursAgo(30) }], NOW).warn).toBe(true)
  })

  it('warns when either tenant is stale, and names the older', () => {
    const s = describeStaleness([
      { tenant: 'GOLIVE', lastReadAt: hoursAgo(2) },
      { tenant: 'MANUFACTURING', lastReadAt: hoursAgo(40) },
    ], NOW)
    expect(s.warn).toBe(true)
    expect(s.oldestHours).toBe(40)
    expect(s.tenants.map((t) => t.stale)).toEqual([false, true])
  })

  it('treats a tenant never read as stale, with no age to state', () => {
    const s = describeStaleness([{ tenant: 'MANUFACTURING', lastReadAt: null }], NOW)
    expect(s.warn).toBe(true)
    expect(s.tenants[0].hoursAgo).toBeNull()
    expect(s.oldestHours).toBeNull()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx.cmd vitest run tests/sync/staleness.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/sync/staleness"`.

- [ ] **Step 3: The pure module**

Create `lib/sync/staleness.ts`:

```ts
/**
 * When the dashboard should say Acumatica has not been read.
 *
 * Pure: reads in, verdicts out. On a once-a-day plan this line matters as much
 * as the cron itself — since the register was retired, a cheque the sync has
 * not read does not exist anywhere Finance can see, and a board that looked
 * current while being a day and a half old would be the quiet version of that.
 */

/**
 * A daily cadence plus slack. At 17:59 the evening run is 24 hours old and that
 * is normal; at 30 hours the run has been missed. Not shorter, or the line would
 * cry wolf every afternoon; not much longer, or a missed run would go a whole
 * second day unremarked.
 */
export const STALE_AFTER_HOURS = 30

export type TenantRead = { tenant: string; lastReadAt: Date | null }
export type TenantStaleness = TenantRead & { hoursAgo: number | null; stale: boolean }
export type Staleness = {
  tenants: TenantStaleness[]
  /** True if any tenant is stale — the board warns as a whole. */
  warn: boolean
  /** The largest known age, for the warning's headline. Null if no tenant has ever been read. */
  oldestHours: number | null
}

export function describeStaleness(
  reads: readonly TenantRead[],
  now: Date,
  staleAfterHours: number = STALE_AFTER_HOURS,
): Staleness {
  const tenants: TenantStaleness[] = reads.map((r) => {
    // Never read is the stalest a tenant can be, and has no age to state.
    if (r.lastReadAt === null) return { ...r, hoursAgo: null, stale: true }
    const hoursAgo = Math.floor((now.getTime() - r.lastReadAt.getTime()) / 3_600_000)
    return { ...r, hoursAgo, stale: hoursAgo >= staleAfterHours }
  })
  const known = tenants.flatMap((t) => (t.hoursAgo === null ? [] : [t.hoursAgo]))
  return {
    tenants,
    warn: tenants.some((t) => t.stale),
    oldestHours: known.length ? Math.max(...known) : null,
  }
}
```

- [ ] **Step 4: The component**

Create `components/SyncStatusLine.tsx`:

```tsx
import Link from 'next/link'
import type { Staleness } from '@/lib/sync/staleness'

const TENANT_LABEL: Readonly<Record<string, string>> = {
  GOLIVE: 'GO-LIVE',
  MANUFACTURING: 'MANUFACTURING',
}

/**
 * Manila, stated. Every other timestamp on the dashboard calls
 * `toLocaleString('en-PH', …)` with no zone and renders in the SERVER's zone —
 * which on Vercel is UTC, eight hours behind the office. For a line whose one
 * job is "how old is this", eight hours is the difference between fine and
 * stale, so the zone is named.
 */
const fmt = (d: Date) =>
  d.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })

/**
 * When Acumatica was last read, and — past the threshold — that it has not been.
 *
 * Since the register was retired, the sync is the only way a cheque arrives.
 * This line is what makes a sync nobody ran visible: on the once-a-day plan
 * the cron is the mechanism and this is the check on it. Shown to everyone;
 * the fix is offered only to an admin, because only an admin can press it.
 */
export function SyncStatusLine({ staleness, isAdmin }: { staleness: Staleness; isAdmin: boolean }) {
  const parts = staleness.tenants.map(
    (t) => `${TENANT_LABEL[t.tenant] ?? t.tenant} ${t.lastReadAt ? fmt(t.lastReadAt) : 'never'}`,
  )

  if (!staleness.warn) {
    return (
      <p className="text-xs font-medium tracking-wide text-slate-500">
        ACUMATICA LAST READ · {parts.join(' · ')}
      </p>
    )
  }

  const neverRead = staleness.tenants.filter((t) => t.lastReadAt === null)
  const headline = neverRead.length
    ? `ACUMATICA HAS NEVER BEEN READ FOR ${neverRead.map((t) => TENANT_LABEL[t.tenant] ?? t.tenant).join(' AND ')}`
    : `ACUMATICA NOT READ FOR ${staleness.oldestHours} HOURS`

  return (
    <div className="rounded-xl bg-warning-bg px-4 py-3 text-sm text-warning-ink ring-1 ring-warning-ink/20">
      <p className="font-semibold tracking-wide">{headline}</p>
      <p className="mt-1">
        Cheques generated in Acumatica since then are not on this board. {parts.join(' · ')}.{' '}
        {isAdmin ? (
          <>
            Press SYNC NOW on the{' '}
            <Link href="/admin/sync" className="underline underline-offset-2">administration page</Link>.
          </>
        ) : (
          'Ask an administrator to run SYNC NOW.'
        )}
      </p>
    </div>
  )
}
```

- [ ] **Step 5: Wire the dashboard**

In `app/page.tsx`:

1. Add imports:

```ts
import { getSyncOverview } from '@/lib/admin/sync-overview'
import { describeStaleness } from '@/lib/sync/staleness'
import { SyncStatusLine } from '@/components/SyncStatusLine'
```

2. Change the `Promise.all` that fetches `summary, options, todaysRelease` to also fetch the overview:

```ts
  const [summary, options, todaysRelease, syncOverview] = await Promise.all([
    getSummary(prisma),
    getFilterOptions(prisma),
    getTodaysRelease(prisma),
    // A fourth query, added for the staleness line. Two cheap findFirsts per
    // tenant on an indexed column; the comment above about "no fourth query"
    // was about the redesign of the KPI row, and this is not that.
    getSyncOverview(prisma),
  ])

  const staleness = describeStaleness(
    // The latest run that finished with no failed row — `lastSuccess` — is the
    // read; a run that never reached the feed read nothing.
    syncOverview.tenants.map((t) => ({ tenant: t.tenant, lastReadAt: t.lastSuccess?.startedAt ?? null })),
    new Date(),
  )
```

3. Directly under `<AppHeader user={user} title="CHECK RELEASE MONITORING" />`, render:

```tsx
      {/* When Acumatica was last read. Above the cards, because every number
          on them is only as current as this line says. */}
      <SyncStatusLine staleness={staleness} isAdmin={user.role === 'FINANCE_ADMIN'} />
```

Update the existing comment that says "These THREE queries feed everything above the table … no fourth query was added for the redesign" to read "These queries feed everything above the table" — it is now four, and the new comment beside the fourth says why.

- [ ] **Step 6: The TRIGGER column**

In `app/admin/sync/page.tsx`, in the SYNC LOG table, add a header cell after `MODE`:

```tsx
                <th className="px-4 py-3">TRIGGER</th>
```

and a body cell after the `{r.mode}` cell:

```tsx
                  <td className="px-4 py-3 text-slate-600">{r.trigger}</td>
```

- [ ] **Step 7: Run the test file, the type-checker and the build**

```bash
npx.cmd vitest run tests/sync/staleness.test.ts
```

Expected: PASS, 5 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

```bash
npx.cmd next build
```

Expected: build succeeds; `/api/cron/sync` and `/` are listed as dynamic routes.

- [ ] **Step 8: Commit**

```bash
git add lib/sync/staleness.ts components/SyncStatusLine.tsx app/page.tsx app/admin/sync/page.tsx tests/sync/staleness.test.ts
git commit -m "feat: the dashboard says when Acumatica was last read, and warns when it was not

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Tell the codebase, and the admin who has to deploy it

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Item 1 of "What is missing"**

In `CLAUDE.md`, replace item 1 of "What is missing, measured 2026-09-10 — in priority order" (the paragraph beginning `**Nothing is scheduled, and since 2026-09-10 this is a PREREQUISITE`) with:

```markdown
1. **The scheduled sync is BUILT and not yet deployed** (2026-09-11). `vercel.json` carries
   `crons: [{ path: /api/cron/sync, schedule: "0 10 * * *" }]` — 18:00 Manila, daily, which is the
   Hobby plan's ceiling. The route authenticates with `CRON_SECRET` on its first line and refuses
   to run while it is unset; it never runs FULL — no watermark means a recorded refusal on
   `/admin/sync`, and a first read stays a terminal job (`scripts/sync.ts`). `runSync` now refuses
   to overlap another run of the same tenant inside `SYNC_IN_PROGRESS_MINUTES` (10), records
   `trigger` (MANUAL | SCHEDULED), and writes a true `finishedAt` — every run before 2026-09-11
   has `finishedAt = startedAt`, because `finish` wrote the start instant. The dashboard states
   ACUMATICA LAST READ per tenant and warns past `STALE_AFTER_HOURS` (30).
   **To go live:** set `CRON_SECRET` in Vercel, `node scripts/migrate.mjs prod --confirm`,
   `npx vercel --prod`, then trigger the job once from the Vercel dashboard and confirm two
   SCHEDULED rows on `/admin/sync`. Until that is done, item 1 is still open in production.
```

- [ ] **Step 2: The migration procedure, where the next person will look**

In `CLAUDE.md`'s "Things that will catch you out", replace the paragraph beginning `**The Neon connection string contains \`&\`.**` with:

```markdown
**The Neon connection string contains `&`, and `prisma migrate dev` refuses a non-interactive
shell.** `node scripts/migrate.mjs test` and `node scripts/migrate.mjs prod --confirm` apply the
migrations with the URL passed in `argv` and no shell, printing the host and database first. Every
migration must reach the TEST database before the suite is run, or every database test fails on a
missing column. Any other script that spawns the Prisma CLI must do the same: URL as an argv entry,
`shell: false`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: the scheduled sync is built; what it takes to switch it on

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Not in this plan

- **More than daily.** The Hobby ceiling. Pro changes one line in `vercel.json`; an external scheduler would call the same route with the same secret.
- **Notifications.** A failed cron is visible on `/admin/sync`, in Vercel's cron log, and — when it goes stale — on the dashboard. Nobody is emailed. CLAUDE.md item 4.
- **Deploying it.** `CRON_SECRET`, the production migration and `vercel --prod` are the user's actions, in that order; Task 6 writes them down.
- **A FULL sync on a schedule.** Refused by design.
