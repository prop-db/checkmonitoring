# Portal Outbox Delivery (Check Monitoring side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain the `PortalEvent` outbox to the Supplier Portal's `POST /api/integrations/check-monitoring/events` so that Finance ticking READY FOR RELEASE, releasing, reversing, reverting or cancelling a cheque reaches suppliers without re-encoding.

**Architecture:** The outbox rows already written in `lib/domain/actions.ts` stay as they are; this plan adds the `CANCELLED` kind, a bearer-token client that builds the portal payload from the cheque *at delivery time*, a worker with latest-wins-per-cheque, exclusive claims and backoff, three triggers (after each action via `after()`, the daily cron, an admin page), and a backlog review script. Spec: `docs/superpowers/specs/2026-09-26-check-monitoring-integration-design.md` (Part 2). This plan supersedes Tasks 1–5 and 7–9 of `2026-09-04-portal-automation.md`; Task 6 (pickup confirmations back) stays a follow-up.

**Tech Stack:** Next.js 15.5 App Router (server actions, `after` from `next/server`), Prisma 6 / Postgres (Neon), NextAuth v5, Vitest against a real test database (`DATABASE_URL_TEST`), TypeScript strict. Windows: `npm.cmd` / `npx.cmd`.

## Global Constraints

- **An `INTERNAL` cheque must never produce a portal call.** `portalRoute()` gates the outbox write AND the client asserts it again before building any request (rule 2).
- **Acumatica stays read-only.** Nothing here touches `lib/integrations/acumatica`.
- **The portal may never mark a cheque RELEASED here** (rule 5) — this plan sends only; nothing reads a status back.
- Amounts stay decimal strings; the payload sends no amount at all.
- Audit rows are append-only and written with `writeAudit` in the same transaction as the change.
- Never print, log or commit `.env`, tokens, or the two `.xlsx` files. Errors name the setting (`PORTAL_TOKEN`), never its value.
- Tests never make live network calls: inject `fetchImpl`.
- A new enum value lives **alone** in its migration (Postgres refuses to use it in the same transaction).
- Any new machine-called route goes in `lib/public-paths.ts` — this plan adds none (the worker is outbound; the admin page is session-gated).
- Run `npx.cmd tsc --noEmit` before claiming any task done; a green Vitest run is not sufficient.
- Tests: `npx.cmd vitest run <file>` per task; the whole suite (~20 min, crosses to Neon) once at the end.
- Commit after each task; the tree was clean on `master` at plan time.

---

### Task 1: `CANCELLED` joins `PortalEventKind`

**Files:**
- Modify: `prisma/schema.prisma:100-112` (enum)
- Create: `prisma/migrations/20260926000100_portal_event_cancelled/migration.sql`
- Test: `tests/schema.test.ts` (append)

**Interfaces:**
- Produces: `PortalEventKind.CANCELLED`.

- [ ] **Step 1: Write the failing test** — append to `tests/schema.test.ts`:

```ts
describe('PortalEventKind CANCELLED', () => {
  it('accepts a CANCELLED event', async () => {
    const check = await makeCheck({ status: 'CANCELLED' })
    const ev = await testDb.portalEvent.create({
      data: {
        checkId: check.id, direction: 'OUT', kind: 'CANCELLED', status: 'PENDING',
        idempotencyKey: `${check.id}:CANCELLED:test`, payload: { action: 'CANCELLED', checkNumber: check.checkNumber },
      },
    })
    expect(ev.kind).toBe('CANCELLED')
  })
})
```

(`makeCheck` and `testDb` are already imported in that file; add the imports if not.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx.cmd vitest run tests/schema.test.ts -t CANCELLED`
Expected: FAIL — TypeScript/Prisma rejects `'CANCELLED'` for `kind`.

- [ ] **Step 3: Schema + migration**

In `prisma/schema.prisma`, after `RELEASE_REVERSED` inside `enum PortalEventKind`:

```prisma
  // A cheque cancelled by Finance or voided by Acumatica after the portal may
  // have been told it was available or released. The portal applies it
  // directly - no approval queue - because this system is the record for
  // cancellations (spec 2026-09-26-check-monitoring-integration-design).
  CANCELLED
```

`prisma/migrations/20260926000100_portal_event_cancelled/migration.sql`:

```sql
-- A fifth thing the outbox can tell the portal: the cheque is cancelled or
-- voided. Alone in its migration on purpose: Postgres refuses to USE a new
-- enum value inside the transaction that added it.
ALTER TYPE "PortalEventKind" ADD VALUE 'CANCELLED';
```

Apply to the test database: `npx.cmd prisma migrate deploy` with `DATABASE_URL` pointed at the test DB the way the repo's `docs/deployment.md` describes, then `npx.cmd prisma generate`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx.cmd vitest run tests/schema.test.ts -t CANCELLED`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260926000100_portal_event_cancelled/migration.sql tests/schema.test.ts
git commit -m "feat(portal): CANCELLED joins PortalEventKind

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `cancelCheck` and `voidCheck` queue a `CANCELLED` event

**Files:**
- Modify: `lib/domain/actions.ts:734-770` (`voidCheck`), `:925-960` (`cancelCheck`)
- Test: `tests/actions/portal-cancel.test.ts`

**Interfaces:**
- Consumes: `portalEventKey` (private, same file), `portalRoute`.
- Produces: one `PortalEvent { kind: 'CANCELLED', payload: { action: 'CANCELLED', checkNumber } }` per cancel/void of a SUPPLIER/BROKER cheque; `Check.portalSyncStatus = 'PENDING'`, `portalDomain` set.

- [ ] **Step 1: Write the failing test**

```ts
// tests/actions/portal-cancel.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { cancelCheck, voidCheck } from '@/lib/domain/actions'

const NOW = new Date('2026-09-26T10:00:00+08:00')

beforeEach(resetDb)

describe('CANCELLED portal event', () => {
  it('cancelCheck queues CANCELLED for a SUPPLIER cheque', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER' })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'duplicate', now: NOW })
    const ev = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: check.id } })
    expect(ev.kind).toBe('CANCELLED')
    expect(ev.status).toBe('PENDING')
    expect(ev.idempotencyKey).toBe(`${check.id}:CANCELLED:${NOW.toISOString()}`)
    expect(ev.payload).toEqual({ action: 'CANCELLED', checkNumber: check.checkNumber })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('PENDING')
    expect(after.portalDomain).toBe('LOCAL')
  })

  it('voidCheck queues CANCELLED for a BROKER cheque, even after release', async () => {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'BROKER' })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    const ev = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: check.id } })
    expect(ev.kind).toBe('CANCELLED')
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalDomain).toBe('BROKER')
  })

  it('an INTERNAL cheque queues nothing', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx.cmd vitest run tests/actions/portal-cancel.test.ts`
Expected: FAIL — `findFirstOrThrow` finds no event.

- [ ] **Step 3: Implement**

In `cancelCheck`, compute the route before the update and queue after it:

```ts
    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'CANCELLED',
        cancelledById: args.userId,
        cancelledAt: args.now,
        cancelReason: args.reason,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })
    if (pushes) await queueCancelled(tx, check.id, check.checkNumber, args.now)
```

In `voidCheck`, the same around its `tx.check.update` (add `portalSyncStatus` / `portalDomain` to `data`, then `if (pushes) await queueCancelled(tx, check.id, check.checkNumber, args.now)` after the update). Add the shared private helper next to `portalEventKey`:

```ts
/**
 * The fifth kind. The reason stays here: the portal never shows a payee an
 * internal reason, and a field it does not accept is a field that can fail a
 * delivery nobody is watching (the same rule as `receiptType` on RELEASED).
 */
async function queueCancelled(tx: Prisma.TransactionClient, checkId: string, checkNumber: string, now: Date): Promise<void> {
  await tx.portalEvent.create({
    data: {
      checkId, direction: 'OUT', kind: 'CANCELLED', status: 'PENDING',
      idempotencyKey: portalEventKey(checkId, 'CANCELLED', now),
      payload: { action: 'CANCELLED', checkNumber },
    },
  })
}
```

- [ ] **Step 4: Run the tests**

Run: `npx.cmd vitest run tests/actions/portal-cancel.test.ts tests/actions/actions.test.ts tests/import` and `npx.cmd tsc --noEmit`
Expected: all pass, tsc clean. (`tests/import` pins the Acumatica void path and `void_not_applied`.)

- [ ] **Step 5: Commit**

```bash
git add lib/domain/actions.ts tests/actions/portal-cancel.test.ts
git commit -m "feat(portal): cancel and void queue a CANCELLED outbox event for portal-routed cheques

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The portal client

**Files:**
- Create: `lib/integrations/portal/client.ts`, `lib/integrations/portal/from-env.ts`
- Test: `tests/integrations/portal-client.test.ts`

**Interfaces:**
- Produces:
  - `type PortalEventBody = { eventId: string; kind: PortalEventKind; apvs: string[]; poNumbers: string[]; checkNo: string; bank: string; availablePickupDate?: string; releaseDate?: string; orNumber?: string; orDate?: string }`
  - `type CheckForPortal = Pick<Check, 'id'|'checkNumber'|'apvNumbers'|'eligibility'|'availablePickupDate'|'releasedAt'|'orNumber'|'orDate'> & { cashAccount: { bank: { code: string } } | null; checkBook: { bank: { code: string } } | null; bills: { apvNumber: string; poNumber: string | null }[] }`
  - `buildPortalEventBody(event: { id: string; kind: PortalEventKind }, check: CheckForPortal): PortalEventBody` — throws `Error('INTERNAL cheque must never reach the portal')` when `portalRoute(check.eligibility) === null`.
  - `manilaDay(d: Date): string` (`YYYY-MM-DD` in Asia/Manila).
  - `type PortalDeliveryResult = { status: number; body: { eventId: string; replay: boolean; results: { ref: string; domain: string; releaseId: number | null; outcome: 'applied'|'already'|'noop'|'refused'; reason?: string }[]; unmatched: string[] } | null }`
  - `type PortalClient = { deliver(body: PortalEventBody): Promise<PortalDeliveryResult> }`
  - `createPortalClient({ baseUrl, token, fetchImpl }): PortalClient`; `createPortalClientFromEnv(): PortalClient` (reads `PORTAL_BASE_URL`, `PORTAL_TOKEN`; throws naming the setting when unset).

- [ ] **Step 1: Write the failing test**

```ts
// tests/integrations/portal-client.test.ts
import { describe, it, expect } from 'vitest'
import { buildPortalEventBody, createPortalClient, manilaDay, type CheckForPortal } from '@/lib/integrations/portal/client'

const bank = { bank: { code: 'BPI' } }
const check = (over: Partial<CheckForPortal> = {}): CheckForPortal => ({
  id: 'chk1', checkNumber: '6000353106', apvNumbers: ['AP-1001', 'AP-1002'], eligibility: 'SUPPLIER',
  availablePickupDate: new Date('2026-09-30T00:00:00Z'), releasedAt: null, orNumber: null, orDate: null,
  cashAccount: bank, checkBook: null,
  bills: [{ apvNumber: 'AP-1001', poNumber: 'PO-77' }, { apvNumber: 'AP-1002', poNumber: null }],
  ...over,
})

describe('manilaDay', () => {
  it('renders the Manila calendar day', () => {
    expect(manilaDay(new Date('2026-09-30T20:00:00Z'))).toBe('2026-10-01')
    expect(manilaDay(new Date('2026-09-30T00:00:00Z'))).toBe('2026-09-30')
  })
})

describe('buildPortalEventBody', () => {
  it('MARK_AVAILABLE carries apvs, positional PO numbers, cheque number, bank and the pickup date', () => {
    expect(buildPortalEventBody({ id: 'ev1', kind: 'MARK_AVAILABLE' }, check())).toEqual({
      eventId: 'ev1', kind: 'MARK_AVAILABLE', apvs: ['AP-1001', 'AP-1002'], poNumbers: ['PO-77', ''],
      checkNo: '6000353106', bank: 'BPI', availablePickupDate: '2026-09-30',
    })
  })

  it('RELEASED carries the release day and receipt from the cheque as it stands', () => {
    const body = buildPortalEventBody({ id: 'ev2', kind: 'RELEASED' }, check({
      releasedAt: new Date('2026-10-02T02:00:00Z'), orNumber: 'OR-9', orDate: new Date('2026-10-02T00:00:00Z'),
    }))
    expect(body).toMatchObject({ kind: 'RELEASED', releaseDate: '2026-10-02', orNumber: 'OR-9', orDate: '2026-10-02' })
    expect(body).not.toHaveProperty('availablePickupDate')
  })

  it('RELEASE_REVERSED carries the pickup date; REVERT and CANCELLED carry no dates', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'RELEASE_REVERSED' }, check())).toMatchObject({ availablePickupDate: '2026-09-30' })
    for (const kind of ['REVERT', 'CANCELLED'] as const) {
      const b = buildPortalEventBody({ id: 'e', kind }, check())
      expect(b).not.toHaveProperty('availablePickupDate'); expect(b).not.toHaveProperty('releaseDate')
    }
  })

  it('takes the bank from the cheque book when there is no cash account, and blank when neither', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ cashAccount: null, checkBook: { bank: { code: 'MBTC' } } })).bank).toBe('MBTC')
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ cashAccount: null })).bank).toBe('')
  })

  it('falls back to the bills for APVs when apvNumbers is empty', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ apvNumbers: [] })).apvs).toEqual(['AP-1001', 'AP-1002'])
  })

  it('refuses an INTERNAL cheque before building anything', () => {
    expect(() => buildPortalEventBody({ id: 'e', kind: 'MARK_AVAILABLE' }, check({ eligibility: 'INTERNAL' })))
      .toThrow(/INTERNAL/)
  })
})

describe('createPortalClient', () => {
  it('POSTs JSON with the bearer to the events route and parses the reply', async () => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = []
    const client = createPortalClient({
      baseUrl: 'https://portal.test/', token: 'tok',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return { ok: true, status: 200, text: async () => JSON.stringify({ eventId: 'ev1', replay: false, results: [], unmatched: ['AP-1001'] }) }
      },
    })
    const out = await client.deliver(buildPortalEventBody({ id: 'ev1', kind: 'REVERT' }, check()))
    expect(calls[0].url).toBe('https://portal.test/api/integrations/check-monitoring/events')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.authorization).toBe('Bearer tok')
    expect(JSON.parse(calls[0].init.body).eventId).toBe('ev1')
    expect(out).toEqual({ status: 200, body: { eventId: 'ev1', replay: false, results: [], unmatched: ['AP-1001'] } })
  })

  it('returns the status with a null body when the reply is not JSON', async () => {
    const client = createPortalClient({ baseUrl: 'https://portal.test', token: 'tok',
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' }) })
    expect(await client.deliver(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check()))).toEqual({ status: 502, body: null })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx.cmd vitest run tests/integrations/portal-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/integrations/portal/client.ts`**

```ts
// The Supplier Portal client (spec 2026-09-26-check-monitoring-integration-
// design §2.2). One route, one bearer, one event per call. The body is built
// from the cheque AS IT STANDS at delivery time, not from the payload the
// outbox stored: the worker delivers the cheque's current truth (latest wins),
// so a stale MARK_AVAILABLE never announces a pickup date that has since moved.
//
// RULE 2, asserted here independently of portalRoute() at the outbox write
// site: an INTERNAL cheque (payroll, tax, fund transfers) must never reach a
// supplier-facing system. Two checks on purpose.
import type { Check, PortalEventKind } from '@prisma/client'
import { portalRoute, type Eligibility } from '@/lib/domain/eligibility'

export type PortalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export type CheckForPortal = Pick<
  Check, 'id' | 'checkNumber' | 'apvNumbers' | 'eligibility' | 'availablePickupDate' | 'releasedAt' | 'orNumber' | 'orDate'
> & {
  cashAccount: { bank: { code: string } } | null
  checkBook: { bank: { code: string } } | null
  bills: { apvNumber: string; poNumber: string | null }[]
}

export type PortalEventBody = {
  eventId: string
  kind: PortalEventKind
  apvs: string[]
  poNumbers: string[]
  checkNo: string
  bank: string
  availablePickupDate?: string
  releaseDate?: string
  orNumber?: string
  orDate?: string
}

export type PortalOutcome = 'applied' | 'already' | 'noop' | 'refused'
export type PortalDeliveryResult = {
  status: number
  body: {
    eventId: string
    replay: boolean
    results: { ref: string; domain: string; releaseId: number | null; outcome: PortalOutcome; reason?: string }[]
    unmatched: string[]
  } | null
}

export type PortalClient = { deliver(body: PortalEventBody): Promise<PortalDeliveryResult> }

/** The Manila calendar day, as the portal's date fields expect (YYYY-MM-DD). */
export function manilaDay(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function buildPortalEventBody(event: { id: string; kind: PortalEventKind }, check: CheckForPortal): PortalEventBody {
  if (portalRoute(check.eligibility as Eligibility) === null) {
    throw new Error(`INTERNAL cheque ${check.id} must never reach the portal.`)
  }
  // apvNumbers is the source's list; the bills are the same vouchers with
  // their PO numbers. A cheque imported before 2026-09-07 may carry only bills.
  const apvs = check.apvNumbers.length ? check.apvNumbers : check.bills.map((b) => b.apvNumber)
  const poByApv = new Map(check.bills.map((b) => [b.apvNumber, b.poNumber ?? '']))
  const body: PortalEventBody = {
    eventId: event.id,
    kind: event.kind,
    apvs,
    poNumbers: apvs.map((a) => poByApv.get(a) ?? ''),
    checkNo: check.checkNumber,
    bank: check.cashAccount?.bank.code ?? check.checkBook?.bank.code ?? '',
  }
  if (event.kind === 'MARK_AVAILABLE' || event.kind === 'RELEASE_REVERSED') {
    if (check.availablePickupDate) body.availablePickupDate = manilaDay(check.availablePickupDate)
  }
  if (event.kind === 'RELEASED') {
    if (check.releasedAt) body.releaseDate = manilaDay(check.releasedAt)
    if (check.orNumber) body.orNumber = check.orNumber
    if (check.orDate) body.orDate = manilaDay(check.orDate)
  }
  return body
}

export function createPortalClient(opts: { baseUrl: string; token: string; fetchImpl?: PortalFetch }): PortalClient {
  const fetchImpl: PortalFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/integrations/check-monitoring/events`
  return {
    async deliver(body) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let parsed: PortalDeliveryResult['body'] = null
      try { parsed = JSON.parse(text) } catch { parsed = null }
      return { status: res.status, body: parsed }
    },
  }
}
```

`lib/integrations/portal/from-env.ts`:

```ts
import { createPortalClient, type PortalClient } from './client'

/**
 * The one place a live portal client is built from configuration, so the
 * worker, the cron and the admin action can be tested with an injected client.
 * Names the setting, never the value.
 */
export function createPortalClientFromEnv(): PortalClient {
  const baseUrl = process.env.PORTAL_BASE_URL ?? ''
  const token = process.env.PORTAL_TOKEN ?? ''
  if (!baseUrl) throw new Error('PORTAL_BASE_URL is not set, so the Supplier Portal cannot be reached.')
  if (!token) throw new Error('PORTAL_TOKEN is not set, so the Supplier Portal cannot be reached.')
  return createPortalClient({ baseUrl, token })
}
```

- [ ] **Step 4: Run the tests**

Run: `npx.cmd vitest run tests/integrations/portal-client.test.ts` and `npx.cmd tsc --noEmit`
Expected: 8 passed, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/integrations/portal tests/integrations/portal-client.test.ts
git commit -m "feat(portal): bearer client that builds the events payload from the cheque at delivery time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The outbox worker

**Files:**
- Create: `lib/sync/portal-outbox.ts`
- Test: `tests/sync/portal-outbox.test.ts`

**Interfaces:**
- Consumes: `PortalClient`, `buildPortalEventBody` (Task 3), `writeAudit`.
- Produces: `deliverPortalEvents(db, { now, deadline, client, claimedBy? }): Promise<PortalOutboxOutcome>` where `PortalOutboxOutcome = { delivered: number; synced: number; failed: number; parked: number; superseded: number; stoppedAtDeadline: boolean; error?: string }`; constants `RETRY_DELAYS_MS`, `MAX_ATTEMPTS = 12`, `UNMATCHED_MAX_ATTEMPTS = 7`, `STALE_CLAIM_MS`.

Rules (spec §2.3): latest-wins per cheque over every non-terminal event; exclusive claim; on 200 — any `refused` → PARKED; nothing matched → FAILED daily up to 7 attempts then PARKED; else SYNCED (+ `Check.portalSyncStatus = SYNCED`, `portalTradeId` from the first `releaseId`). Non-200: 401/400 → PARKED; anything else / thrown fetch → FAILED with backoff 1 m, 5 m, 30 m, 2 h, then daily; PARKED after 12 attempts. Stop at `deadline`. Audit `portal_event_<status>` (SYSTEM).

- [ ] **Step 1: Write the failing test**

```ts
// tests/sync/portal-outbox.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { deliverPortalEvents, RETRY_DELAYS_MS, MAX_ATTEMPTS, UNMATCHED_MAX_ATTEMPTS } from '@/lib/sync/portal-outbox'
import type { PortalClient, PortalDeliveryResult, PortalEventBody } from '@/lib/integrations/portal/client'

const NOW = new Date('2026-09-26T10:00:00+08:00')
const LATER = new Date(NOW.getTime() + 60_000)

function fakeClient(reply: (body: PortalEventBody) => PortalDeliveryResult | Error): PortalClient & { sent: PortalEventBody[] } {
  const sent: PortalEventBody[] = []
  return {
    sent,
    async deliver(body) {
      sent.push(body)
      const r = reply(body)
      if (r instanceof Error) throw r
      return r
    },
  }
}

const ok = (over: Partial<NonNullable<PortalDeliveryResult['body']>> = {}): PortalDeliveryResult => ({
  status: 200,
  body: { eventId: 'x', replay: false, results: [{ ref: 'AP-1', domain: 'local', releaseId: 41, outcome: 'applied' }], unmatched: [], ...over },
})

async function queue(checkId: string, kind: 'MARK_AVAILABLE' | 'RELEASED' | 'REVERT' | 'RELEASE_REVERSED' | 'CANCELLED', createdAt: Date, extra: Record<string, unknown> = {}) {
  return testDb.portalEvent.create({
    data: {
      checkId, direction: 'OUT', kind, status: 'PENDING', createdAt, nextAttemptAt: createdAt,
      idempotencyKey: `${checkId}:${kind}:${createdAt.toISOString()}`, payload: { action: kind },
      ...extra,
    },
  })
}

beforeEach(resetDb)

describe('deliverPortalEvents', () => {
  it('delivers a pending event and marks it SYNCED, learning the portal id', async () => {
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', apvNumbers: ['AP-1'], availablePickupDate: new Date('2026-09-30') })
    const ev = await queue(check.id, 'MARK_AVAILABLE', NOW)
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ delivered: 1, synced: 1, failed: 0, parked: 0, superseded: 0, stoppedAtDeadline: false })
    expect(client.sent[0]).toMatchObject({ eventId: ev.id, kind: 'MARK_AVAILABLE', apvs: ['AP-1'], availablePickupDate: '2026-09-30' })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('SYNCED'); expect(after.attempts).toBe(1); expect(after.claimedBy).toBeTruthy()
    const chk = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(chk.portalSyncStatus).toBe('SYNCED'); expect(chk.portalTradeId).toBe(41)
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'portal_event_synced' } })).toBe(1)
  })

  it('latest wins per cheque: older non-terminal events are superseded, not sent', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    const old = await queue(check.id, 'MARK_AVAILABLE', new Date('2026-08-01T00:00:00Z'))
    const mid = await queue(check.id, 'REVERT', new Date('2026-08-02T00:00:00Z'), { status: 'FAILED', nextAttemptAt: new Date('2099-01-01') })
    const newest = await queue(check.id, 'RELEASED', new Date('2026-08-03T00:00:00Z'))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ delivered: 1, superseded: 2 })
    expect(client.sent.map((b) => b.eventId)).toEqual([newest.id])
    for (const id of [old.id, mid.id]) {
      const e = await testDb.portalEvent.findUniqueOrThrow({ where: { id } })
      expect(e.status).toBe('SYNCED'); expect(e.lastError).toBe(`superseded by ${newest.id}`)
    }
  })

  it('a newest event not yet due is neither sent nor superseded; the cheque waits', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    await queue(check.id, 'RELEASED', new Date('2026-08-03T00:00:00Z'), { status: 'FAILED', nextAttemptAt: new Date('2099-01-01') })
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ delivered: 0, superseded: 0 })
    expect(client.sent).toHaveLength(0)
  })

  it('a refused result parks the event and flags the cheque', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok({ results: [{ ref: 'AP-1', domain: 'local', releaseId: 41, outcome: 'refused', reason: 'cancelled in the portal' }] }))
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ parked: 1 })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED'); expect(after.lastError).toMatch(/cancelled in the portal/)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).portalSyncStatus).toBe('FAILED')
  })

  it('nothing matched retries daily and parks after UNMATCHED_MAX_ATTEMPTS', async () => {
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', apvNumbers: ['AP-9'], availablePickupDate: new Date('2026-09-30') })
    const ev = await queue(check.id, 'MARK_AVAILABLE', NOW, { attempts: UNMATCHED_MAX_ATTEMPTS - 2 })
    const client = fakeClient(() => ok({ results: [], unmatched: ['AP-9'] }))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    let after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('FAILED'); expect(after.lastError).toMatch(/unmatched: AP-9/)
    expect(after.nextAttemptAt.getTime()).toBe(LATER.getTime() + 24 * 3_600_000)

    await testDb.portalEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: LATER } })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED'); expect(after.attempts).toBe(UNMATCHED_MAX_ATTEMPTS)
  })

  it('a network error backs off along RETRY_DELAYS_MS and parks at MAX_ATTEMPTS', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => new Error('ECONNRESET'))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    let after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('FAILED'); expect(after.attempts).toBe(1); expect(after.lastError).toMatch(/ECONNRESET/)
    expect(after.nextAttemptAt.getTime()).toBe(LATER.getTime() + RETRY_DELAYS_MS[0])

    await testDb.portalEvent.update({ where: { id: ev.id }, data: { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: LATER } })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PARKED')
  })

  it('401 and 400 park immediately; 503 retries', async () => {
    for (const [status, expected] of [[401, 'PARKED'], [400, 'PARKED'], [503, 'FAILED']] as const) {
      await resetDb()
      const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
      const ev = await queue(check.id, 'RELEASED', NOW)
      const client = fakeClient(() => ({ status, body: null }))
      await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
      expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe(expected)
    }
  })

  it('never sends an INTERNAL cheque: the event parks without a request', async () => {
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'INTERNAL', apvNumbers: ['AP-1'] })
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent).toHaveLength(0)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('PARKED')
  })

  it('stops at the deadline and leaves the rest PENDING', async () => {
    const a = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    const b = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-2'] })
    await queue(a.id, 'RELEASED', NOW); await queue(b.id, 'RELEASED', NOW)
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() - 1), client })
    expect(out.stoppedAtDeadline).toBe(true); expect(out.delivered).toBe(0)
    expect(await testDb.portalEvent.count({ where: { status: 'PENDING' } })).toBe(2)
  })

  it('a stale IN_FLIGHT claim is retried, a fresh one is left alone', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    const stale = await queue(check.id, 'RELEASED', NOW, { status: 'IN_FLIGHT', claimedAt: new Date(LATER.getTime() - 3_600_000), claimedBy: 'dead-run' })
    const client = fakeClient(() => ok())
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('SYNCED')

    const other = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-2'] })
    const fresh = await queue(other.id, 'RELEASED', NOW, { status: 'IN_FLIGHT', claimedAt: LATER, claimedBy: 'live-run' })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('IN_FLIGHT')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx.cmd vitest run tests/sync/portal-outbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/sync/portal-outbox.ts`**

```ts
import type { Prisma, PrismaClient, PortalEvent } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { buildPortalEventBody, type PortalClient, type PortalDeliveryResult } from '@/lib/integrations/portal/client'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * THE OUTBOX WORKER (spec 2026-09-26-check-monitoring-integration-design §2.3).
 *
 * Latest wins per cheque. The portal is told the cheque's current truth, not
 * its history: among a cheque's non-terminal events only the newest is
 * delivered and the older ones are closed as superseded. This is what makes
 * the backlog queued since 2026-09-04 safe to drain - a stale MARK_AVAILABLE
 * for a cheque since released must not email a supplier "ready for pickup"
 * seconds before "picked up".
 *
 * Claims are exclusive (a conditional updateMany), backoff is a timestamp so
 * the worker stays stateless, and PARKED is the human's queue.
 */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000] as const
const DAILY_MS = 24 * 3_600_000
export const MAX_ATTEMPTS = 12
export const UNMATCHED_MAX_ATTEMPTS = 7
/** A claim older than this belongs to a run the platform killed. */
export const STALE_CLAIM_MS = 10 * 60_000

export type PortalOutboxOutcome = {
  delivered: number
  synced: number
  failed: number
  parked: number
  superseded: number
  stoppedAtDeadline: boolean
  error?: string
}

function backoff(attempts: number): number {
  return RETRY_DELAYS_MS[attempts - 1] ?? DAILY_MS
}

const cap = (s: string) => s.slice(0, 300)

type Verdict =
  | { status: 'SYNCED'; releaseId: number | null; note?: string }
  | { status: 'FAILED'; error: string; delayMs: number; maxAttempts: number }
  | { status: 'PARKED'; error: string }

function judge(res: PortalDeliveryResult, attempts: number): Verdict {
  if (res.status === 200 && res.body) {
    const refused = res.body.results.find((r) => r.outcome === 'refused')
    if (refused) return { status: 'PARKED', error: `refused ${refused.ref}: ${refused.reason ?? 'no reason given'}` }
    if (res.body.results.length === 0) {
      return { status: 'FAILED', error: `unmatched: ${res.body.unmatched.join(', ')}`, delayMs: DAILY_MS, maxAttempts: UNMATCHED_MAX_ATTEMPTS }
    }
    const first = res.body.results.find((r) => r.releaseId !== null)
    const note = res.body.unmatched.length ? `unmatched: ${res.body.unmatched.join(', ')}` : undefined
    return { status: 'SYNCED', releaseId: first?.releaseId ?? null, note }
  }
  if (res.status === 401) return { status: 'PARKED', error: 'portal refused the token (401): check PORTAL_TOKEN' }
  if (res.status === 400) return { status: 'PARKED', error: 'portal rejected the payload (400)' }
  return { status: 'FAILED', error: `portal answered ${res.status}`, delayMs: backoff(attempts), maxAttempts: MAX_ATTEMPTS }
}

async function settle(db: Db, ev: PortalEvent, verdict: Verdict, now: Date): Promise<Verdict['status']> {
  const attempts = ev.attempts + 1
  let status: Verdict['status'] = verdict.status
  let lastError: string | null = null
  let nextAttemptAt = ev.nextAttemptAt
  if (verdict.status === 'FAILED') {
    lastError = cap(verdict.error)
    if (attempts >= verdict.maxAttempts) status = 'PARKED'
    else nextAttemptAt = new Date(now.getTime() + verdict.delayMs)
  } else if (verdict.status === 'PARKED') {
    lastError = cap(verdict.error)
  } else if (verdict.note) {
    lastError = cap(verdict.note)
  }
  await db.portalEvent.update({ where: { id: ev.id }, data: { status, attempts, lastError, nextAttemptAt } })
  if (status === 'SYNCED') {
    await db.check.update({
      where: { id: ev.checkId },
      data: { portalSyncStatus: 'SYNCED', ...(verdict.status === 'SYNCED' && verdict.releaseId !== null ? { portalTradeId: verdict.releaseId } : {}) },
    })
  } else if (status === 'PARKED') {
    await db.check.update({ where: { id: ev.checkId }, data: { portalSyncStatus: 'FAILED' } })
  }
  await writeAudit(db, {
    checkId: ev.checkId, actorType: 'SYSTEM', action: `portal_event_${status.toLowerCase()}`,
    details: { eventId: ev.id, kind: ev.kind, attempts, lastError },
  })
  return status
}

export async function deliverPortalEvents(
  db: Db,
  args: { now: Date; deadline: Date; client: PortalClient; claimedBy?: string },
): Promise<PortalOutboxOutcome> {
  const out: PortalOutboxOutcome = { delivered: 0, synced: 0, failed: 0, parked: 0, superseded: 0, stoppedAtDeadline: false }
  const claimedBy = args.claimedBy ?? `run-${args.now.toISOString()}`
  const staleBefore = new Date(args.now.getTime() - STALE_CLAIM_MS)

  // Every non-terminal event, oldest first, so the newest per cheque is the
  // last one seen. A stale IN_FLIGHT claim counts as non-terminal.
  const open = await db.portalEvent.findMany({
    where: {
      OR: [
        { status: { in: ['PENDING', 'FAILED'] } },
        { status: 'IN_FLIGHT', claimedAt: { lt: staleBefore } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const newest = new Map<string, PortalEvent>()
  for (const ev of open) newest.set(ev.checkId, ev)

  for (const ev of open) {
    const winner = newest.get(ev.checkId)!
    if (winner.id === ev.id) continue
    const r = await db.portalEvent.updateMany({
      where: { id: ev.id, status: ev.status },
      data: { status: 'SYNCED', lastError: `superseded by ${winner.id}` },
    })
    if (r.count) out.superseded += 1
  }

  for (const ev of newest.values()) {
    if (Date.now() >= args.deadline.getTime() || args.now.getTime() > args.deadline.getTime()) { out.stoppedAtDeadline = true; break }
    if (ev.status !== 'IN_FLIGHT' && ev.nextAttemptAt.getTime() > args.now.getTime()) continue

    const claim = await db.portalEvent.updateMany({
      where: { id: ev.id, status: ev.status },
      data: { status: 'IN_FLIGHT', claimedAt: args.now, claimedBy },
    })
    if (!claim.count) continue

    const check = await db.check.findUnique({
      where: { id: ev.checkId },
      include: { cashAccount: { include: { bank: true } }, checkBook: { include: { bank: true } }, bills: true },
    })
    if (!check) { await settle(db, ev, { status: 'PARKED', error: 'cheque no longer exists' }, args.now); out.parked += 1; continue }

    let verdict: Verdict
    try {
      // RULE 2 is asserted inside buildPortalEventBody; an INTERNAL cheque
      // throws before any request exists and parks below.
      const body = buildPortalEventBody({ id: ev.id, kind: ev.kind }, check)
      out.delivered += 1
      verdict = judge(await args.client.deliver(body), ev.attempts + 1)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      verdict = /INTERNAL/.test(message)
        ? { status: 'PARKED', error: message }
        : { status: 'FAILED', error: message, delayMs: backoff(ev.attempts + 1), maxAttempts: MAX_ATTEMPTS }
    }
    const status = await settle(db, ev, verdict, args.now)
    if (status === 'SYNCED') out.synced += 1
    else if (status === 'FAILED') out.failed += 1
    else out.parked += 1
  }
  return out
}
```

Note `bills` is the relation name for `CheckBill` on `Check` — confirm in `prisma/schema.prisma` (`grep -n "CheckBill\[\]" prisma/schema.prisma`) and use the actual field name in both the `include` and `CheckForPortal`.

- [ ] **Step 4: Run the tests**

Run: `npx.cmd vitest run tests/sync/portal-outbox.test.ts` and `npx.cmd tsc --noEmit`
Expected: 10 passed, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/portal-outbox.ts tests/sync/portal-outbox.test.ts
git commit -m "feat(portal): outbox worker - latest wins per cheque, exclusive claims, backoff, parked queue

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Triggers — after each action, and the daily cron

**Files:**
- Create: `lib/sync/portal-kick.ts`
- Modify: `app/checks/actions.ts:30-43` (`run`), `app/checks/bulk-actions.ts` (`runEach` — find with `grep -n "async function runEach" app/checks/bulk-actions.ts`), `app/api/cron/sync/route.ts:96-120`
- Test: `tests/sync/cron-route.test.ts` (append), `tests/sync/portal-kick.test.ts`

**Interfaces:**
- Produces: `kickPortalDelivery(db, { budgetMs, client? }): Promise<PortalOutboxOutcome | { skipped: string }>` — best-effort, never throws; `{ skipped }` when `PORTAL_BASE_URL` / `PORTAL_TOKEN` are unset. Cron response gains `portal: PortalOutboxOutcome | { skipped }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sync/portal-kick.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { kickPortalDelivery } from '@/lib/sync/portal-kick'

beforeEach(async () => { await resetDb(); delete process.env.PORTAL_BASE_URL; delete process.env.PORTAL_TOKEN })

describe('kickPortalDelivery', () => {
  it('skips, naming the setting, when the portal is not configured', async () => {
    expect(await kickPortalDelivery(testDb, { budgetMs: 1000 })).toEqual({ skipped: 'PORTAL_BASE_URL is not set' })
  })

  it('delivers with an injected client and never throws', async () => {
    const check = await makeCheck({ status: 'RELEASED', apvNumbers: ['AP-1'] })
    await testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'RELEASED', status: 'PENDING', idempotencyKey: 'k', payload: {} } })
    const out = await kickPortalDelivery(testDb, {
      budgetMs: 1000,
      client: { deliver: async () => { throw new Error('boom') } },
    })
    expect(out).toMatchObject({ delivered: 1, failed: 1 })
  })
})
```

Append to `tests/sync/cron-route.test.ts` (inside its existing `describe`, using its `get`, `SECRET`, `watermarked` helpers; add `PORTAL_BASE_URL`/`PORTAL_TOKEN` deletes to its `beforeEach`):

```ts
  it('reports the portal outbox after auto-sign, skipped when unconfigured', async () => {
    await watermarked('GOLIVE'); await watermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    const body = await res.json()
    expect(body.portal).toEqual({ skipped: 'PORTAL_BASE_URL is not set' })
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx.cmd vitest run tests/sync/portal-kick.test.ts tests/sync/cron-route.test.ts`
Expected: FAIL — module not found / `body.portal` undefined.

- [ ] **Step 3: Write `lib/sync/portal-kick.ts`**

```ts
import type { Prisma, PrismaClient } from '@prisma/client'
import { createPortalClientFromEnv } from '@/lib/integrations/portal/from-env'
import type { PortalClient } from '@/lib/integrations/portal/client'
import { deliverPortalEvents, type PortalOutboxOutcome } from './portal-outbox'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Best-effort delivery within a time budget: from a server action (after the
 * response, via next/server `after`), from the cron, from the admin button.
 * Never throws - a portal outage must never fail a Finance action, and an
 * unconfigured portal is a skip that says which setting is missing (the
 * message names the setting, never a value).
 */
export async function kickPortalDelivery(
  db: Db, args: { budgetMs: number; client?: PortalClient; now?: Date },
): Promise<PortalOutboxOutcome | { skipped: string }> {
  const now = args.now ?? new Date()
  let client = args.client
  if (!client) {
    try { client = createPortalClientFromEnv() }
    catch (e) { return { skipped: (e instanceof Error ? e.message : String(e)).split(',')[0] } }
  }
  try {
    return await deliverPortalEvents(db, { now, deadline: new Date(now.getTime() + args.budgetMs), client })
  } catch (e) {
    console.error('portal delivery failed:', e instanceof Error ? e.message : e)
    return { delivered: 0, synced: 0, failed: 0, parked: 0, superseded: 0, stoppedAtDeadline: false, error: e instanceof Error ? e.message : String(e) }
  }
}
```

- [ ] **Step 4: Hook the triggers**

`app/checks/actions.ts` — add `import { after } from 'next/server'` and `import { kickPortalDelivery } from '@/lib/sync/portal-kick'`; in `run`, after `await fn()` and before the `revalidatePath` calls:

```ts
    // Deliver the outbox row this action just wrote, after the response is
    // sent so the Finance user never waits on the portal (spec 2026-09-26-
    // check-monitoring-integration-design §2.4). Best-effort: a portal outage
    // is the worker's problem, never this action's.
    after(() => kickPortalDelivery(prisma, { budgetMs: 8_000 }))
```

`app/checks/bulk-actions.ts` — same two imports; in `runEach`, after the loop completes (before it returns its result), add the same `after(() => kickPortalDelivery(prisma, { budgetMs: 8_000 }))` line.

`app/api/cron/sync/route.ts` — import `kickPortalDelivery`; after `autoSign`:

```ts
  // The outbox: retries and the backlog. Whatever budget is left inside the
  // route's 60s ceiling, minus room for the response.
  const remaining = 55_000 - (Date.now() - now.getTime())
  const portal = await kickPortalDelivery(prisma, { budgetMs: Math.max(remaining, 5_000) })
```

and add `portal` to the JSON body: `json({ ranAt: now.toISOString(), outcomes, autoSign, portal }, failed ? 500 : 200)`. Delivery failures do not turn the cron 500 (they are recorded per event).

- [ ] **Step 5: Run the tests**

Run: `npx.cmd vitest run tests/sync/portal-kick.test.ts tests/sync/cron-route.test.ts tests/actions` and `npx.cmd tsc --noEmit`
Expected: all pass, tsc clean. If `after` is not exported by the installed Next (`grep -n "export.*after" node_modules/next/server.d.ts`), import `unstable_after as after` instead.

- [ ] **Step 6: Commit**

```bash
git add lib/sync/portal-kick.ts app/checks/actions.ts app/checks/bulk-actions.ts app/api/cron/sync/route.ts tests/sync/portal-kick.test.ts tests/sync/cron-route.test.ts
git commit -m "feat(portal): deliver the outbox after each action and from the daily cron

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Admin page `/admin/portal`

**Files:**
- Create: `lib/admin/portal-overview.ts`, `app/admin/portal/page.tsx`, `app/admin/portal/actions.ts`, `components/PortalRetryButton.tsx`
- Modify: `app/admin/layout.tsx:16-23` (add `['/admin/portal', 'PORTAL']`)
- Test: `tests/admin/portal-overview.test.ts`, `tests/admin/portal-actions.test.ts`

**Interfaces:**
- Produces: `getPortalOverview(db): Promise<{ counts: Record<PortalEventStatus, number>; attention: { id, checkId, checkNumber, payeeName, kind, status, attempts, lastError, nextAttemptAt, createdAt }[] }>` (attention = `PARKED` + `FAILED`, newest first, max 200); server actions `retryPortalEventAction(formData{eventId})` and `deliverPortalNowAction()` returning `AdminActionResult`, FINANCE_ADMIN only by returned refusal.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/admin/portal-overview.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { getPortalOverview } from '@/lib/admin/portal-overview'

beforeEach(resetDb)

describe('getPortalOverview', () => {
  it('counts by status and lists parked and failed rows newest first', async () => {
    const check = await makeCheck({ status: 'RELEASED', payeeName: 'HENKEL' })
    const mk = (status: 'PENDING' | 'SYNCED' | 'FAILED' | 'PARKED', key: string, createdAt: Date) =>
      testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'RELEASED', status, idempotencyKey: key, payload: {}, createdAt, lastError: status === 'SYNCED' ? null : `e-${key}` } })
    await mk('PENDING', 'a', new Date('2026-09-01')); await mk('SYNCED', 'b', new Date('2026-09-02'))
    await mk('FAILED', 'c', new Date('2026-09-03')); await mk('PARKED', 'd', new Date('2026-09-04'))
    const o = await getPortalOverview(testDb)
    expect(o.counts).toMatchObject({ PENDING: 1, SYNCED: 1, FAILED: 1, PARKED: 1, IN_FLIGHT: 0 })
    expect(o.attention.map((r) => [r.status, r.lastError, r.checkNumber, r.payeeName])).toEqual([
      ['PARKED', 'e-d', check.checkNumber, 'HENKEL'], ['FAILED', 'e-c', check.checkNumber, 'HENKEL'],
    ])
  })
})
```

```ts
// tests/admin/portal-actions.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'

const state = vi.hoisted(() => ({ role: 'FINANCE_ADMIN' as 'FINANCE_ADMIN' | 'FINANCE_USER', kicked: 0 }))
vi.mock('@/lib/db', async () => ({ prisma: (await import('../helpers/db')).testDb }))
vi.mock('@/lib/auth', () => ({ requireUser: async () => ({ id: 'u1', email: 'a@b', name: 'A', role: state.role }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/sync/portal-kick', () => ({ kickPortalDelivery: async () => { state.kicked += 1; return { skipped: 'PORTAL_BASE_URL is not set' } } }))

beforeEach(async () => { await resetDb(); state.role = 'FINANCE_ADMIN'; state.kicked = 0 })

describe('portal admin actions', () => {
  it('retry puts a PARKED event back to PENDING, due now, and audits it', async () => {
    const { retryPortalEventAction } = await import('@/app/admin/portal/actions')
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'RELEASED' })
    const ev = await testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind: 'RELEASED', status: 'PARKED', idempotencyKey: 'k', payload: {}, attempts: 12, nextAttemptAt: new Date('2099-01-01') } })
    const f = new FormData(); f.set('eventId', ev.id)
    void user
    expect(await retryPortalEventAction(f)).toEqual({ ok: true })
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('PENDING'); expect(after.attempts).toBe(0); expect(after.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 1000)
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'portal_event_retried' } })).toBe(1)
    expect(state.kicked).toBe(1)
  })

  it('a FINANCE_USER is refused by a returned result', async () => {
    const { retryPortalEventAction, deliverPortalNowAction } = await import('@/app/admin/portal/actions')
    state.role = 'FINANCE_USER'
    const f = new FormData(); f.set('eventId', 'x')
    expect(await retryPortalEventAction(f)).toMatchObject({ ok: false })
    expect(await deliverPortalNowAction()).toMatchObject({ ok: false })
    expect(state.kicked).toBe(0)
  })

  it('deliver now kicks the worker', async () => {
    const { deliverPortalNowAction } = await import('@/app/admin/portal/actions')
    expect(await deliverPortalNowAction()).toMatchObject({ ok: false, message: expect.stringContaining('PORTAL_BASE_URL') })
    expect(state.kicked).toBe(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx.cmd vitest run tests/admin/portal-overview.test.ts tests/admin/portal-actions.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `lib/admin/portal-overview.ts`**

```ts
import type { Prisma, PrismaClient, PortalEventStatus, PortalEventKind } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type PortalAttentionRow = {
  id: string; checkId: string; checkNumber: string; payeeName: string | null
  kind: PortalEventKind; status: PortalEventStatus; attempts: number
  lastError: string | null; nextAttemptAt: Date; createdAt: Date
}

export type PortalOverview = { counts: Record<PortalEventStatus, number>; attention: PortalAttentionRow[] }

const STATUSES: PortalEventStatus[] = ['PENDING', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'PARKED']

/** PARKED is the human's queue; FAILED is shown so a stuck retry is visible before it parks. */
export async function getPortalOverview(db: Db): Promise<PortalOverview> {
  const grouped = await db.portalEvent.groupBy({ by: ['status'], _count: { _all: true } })
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<PortalEventStatus, number>
  for (const g of grouped) counts[g.status] = g._count._all
  const rows = await db.portalEvent.findMany({
    where: { status: { in: ['PARKED', 'FAILED'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
    include: { check: { select: { checkNumber: true, payeeName: true } } },
  })
  return {
    counts,
    attention: rows.map((r) => ({
      id: r.id, checkId: r.checkId, checkNumber: r.check.checkNumber, payeeName: r.check.payeeName,
      kind: r.kind, status: r.status, attempts: r.attempts, lastError: r.lastError,
      nextAttemptAt: r.nextAttemptAt, createdAt: r.createdAt,
    })),
  }
}
```

- [ ] **Step 4: Write `app/admin/portal/actions.ts`**

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { kickPortalDelivery } from '@/lib/sync/portal-kick'
import type { AdminActionResult } from '@/app/admin/actions'

// Refuse a FINANCE_USER by RETURNING, never by redirecting - the same rule as
// app/admin/actions.ts and for the same reason (a redirect is a throw).
const ADMIN_ONLY = 'Only a Finance Admin can manage portal delivery.'

export async function retryPortalEventAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }
  const eventId = String(formData.get('eventId') ?? '').trim()
  const ev = await prisma.portalEvent.findUnique({ where: { id: eventId } })
  if (!ev || (ev.status !== 'PARKED' && ev.status !== 'FAILED')) return { ok: false, message: 'That event is not waiting on a retry.' }
  await prisma.$transaction(async (tx) => {
    await tx.portalEvent.update({ where: { id: ev.id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } })
    await writeAudit(tx, { checkId: ev.checkId, actorType: 'USER', userId: user.id, action: 'portal_event_retried', details: { eventId: ev.id, kind: ev.kind, from: ev.status } })
  })
  await kickPortalDelivery(prisma, { budgetMs: 8_000 })
  revalidatePath('/admin/portal')
  return { ok: true }
}

export async function deliverPortalNowAction(): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }
  const out = await kickPortalDelivery(prisma, { budgetMs: 25_000 })
  revalidatePath('/admin/portal')
  if ('skipped' in out) return { ok: false, message: out.skipped }
  if (out.error) return { ok: false, message: out.error }
  return { ok: true }
}
```

- [ ] **Step 5: Write the page and button**

`components/PortalRetryButton.tsx` (client component, mirrors `components/SyncNowButton.tsx` — read it first and follow its `useTransition` + result-message pattern):

```tsx
'use client'

import { useState, useTransition } from 'react'
import type { AdminActionResult } from '@/app/admin/actions'

export function PortalActionButton({ label, action, pending }: {
  label: string
  action: () => Promise<AdminActionResult>
  pending: string
}) {
  const [isPending, start] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() => start(async () => { const r = await action(); setMessage(r.ok ? 'Done.' : r.message) })}
        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold tracking-wide text-white disabled:opacity-50"
      >
        {isPending ? pending : label}
      </button>
      {message ? <span className="text-xs text-slate-600">{message}</span> : null}
    </span>
  )
}
```

`app/admin/portal/page.tsx`:

```tsx
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getPortalOverview } from '@/lib/admin/portal-overview'
import { PortalActionButton } from '@/components/PortalRetryButton'
import { deliverPortalNowAction, retryPortalEventAction } from './actions'

const fmt = (d: Date) => d.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default async function AdminPortalPage() {
  await requireAdmin()
  const o = await getPortalOverview(prisma)
  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">SUPPLIER PORTAL · OUTBOX</h2>
          <PortalActionButton label="DELIVER NOW" pending="DELIVERING…" action={deliverPortalNowAction} />
        </div>
        <p className="mt-2 text-sm text-slate-700">
          {o.counts.PENDING} pending · {o.counts.IN_FLIGHT} in flight · {o.counts.FAILED} retrying · {o.counts.PARKED} parked · {o.counts.SYNCED} delivered
        </p>
      </section>
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">NEEDS ATTENTION</h2>
        {o.attention.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nothing is parked or retrying.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs text-slate-400">
              <tr><th>CHEQUE</th><th>PAYEE</th><th>EVENT</th><th>STATUS</th><th>TRIES</th><th>LAST ERROR</th><th>NEXT</th><th></th></tr>
            </thead>
            <tbody>
              {o.attention.map((r) => (
                <tr key={r.id} className="border-t border-hairline">
                  <td className="py-2"><a className="underline" href={`/checks/${r.checkId}`}>{r.checkNumber}</a></td>
                  <td>{r.payeeName ?? '—'}</td>
                  <td>{r.kind}</td>
                  <td>{r.status}</td>
                  <td>{r.attempts}</td>
                  <td className="max-w-md truncate" title={r.lastError ?? ''}>{r.lastError ?? '—'}</td>
                  <td>{r.status === 'FAILED' ? fmt(r.nextAttemptAt) : '—'}</td>
                  <td>
                    <PortalActionButton label="RETRY" pending="…" action={async () => {
                      'use server'
                      const f = new FormData(); f.set('eventId', r.id)
                      return retryPortalEventAction(f)
                    }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
```

Add `['/admin/portal', 'PORTAL'],` to the `tabs` array in `app/admin/layout.tsx` after `['/admin/sync', 'SYNC']`.

- [ ] **Step 6: Run the tests and the type check**

Run: `npx.cmd vitest run tests/admin/portal-overview.test.ts tests/admin/portal-actions.test.ts tests/module-nav.test.ts` and `npx.cmd tsc --noEmit` and `npm.cmd run build`
Expected: pass, tsc clean, build clean (the inline `'use server'` closure in the page requires Next's server-actions-in-server-components; if the build objects, replace it with a small client `RetryForm` that calls `retryPortalEventAction` via a `<form action>` with a hidden `eventId`).

- [ ] **Step 7: Commit**

```bash
git add lib/admin/portal-overview.ts app/admin/portal components/PortalRetryButton.tsx app/admin/layout.tsx tests/admin/portal-overview.test.ts tests/admin/portal-actions.test.ts
git commit -m "feat(admin): /admin/portal - outbox counts, parked/failed rows, retry and deliver now

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Backlog review script, docs, full suite, deploy checklist

**Files:**
- Create: `scripts/portal-backlog.ts`
- Modify: `CLAUDE.md` ("State" section and the Plan 3 note), `.env.example` (`PORTAL_BASE_URL=`, `PORTAL_TOKEN=`)
- Test: `tests/scripts/portal-backlog.test.ts`

**Interfaces:**
- Produces: `summariseBacklog(db): Promise<{ total: number; winners: { eventId, kind, checkNumber, payeeName, checkStatus, eligibility, createdAt }[]; superseded: number; byKind: Record<string, number> }>` exported from `lib/admin/portal-backlog.ts`; the script prints it (no amounts).

- [ ] **Step 1: Write the failing test**

```ts
// tests/scripts/portal-backlog.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { summariseBacklog } from '@/lib/admin/portal-backlog'

beforeEach(resetDb)

describe('summariseBacklog', () => {
  it('applies latest-wins as a dry run and never carries an amount', async () => {
    const check = await makeCheck({ status: 'RELEASED', payeeName: 'HENKEL' })
    const mk = (kind: 'MARK_AVAILABLE' | 'RELEASED', at: Date) =>
      testDb.portalEvent.create({ data: { checkId: check.id, direction: 'OUT', kind, status: 'PENDING', idempotencyKey: `${kind}${at.toISOString()}`, payload: {}, createdAt: at } })
    await mk('MARK_AVAILABLE', new Date('2026-09-05')); await mk('RELEASED', new Date('2026-09-06'))
    const s = await summariseBacklog(testDb)
    expect(s.total).toBe(2); expect(s.superseded).toBe(1)
    expect(s.winners).toEqual([expect.objectContaining({ kind: 'RELEASED', checkNumber: check.checkNumber, payeeName: 'HENKEL', checkStatus: 'RELEASED', eligibility: 'SUPPLIER' })])
    expect(s.byKind).toEqual({ MARK_AVAILABLE: 1, RELEASED: 1 })
    expect(JSON.stringify(s)).not.toMatch(/197715/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx.cmd vitest run tests/scripts/portal-backlog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/admin/portal-backlog.ts` and `scripts/portal-backlog.ts`**

```ts
// lib/admin/portal-backlog.ts
import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * What the worker WOULD deliver, without delivering (spec §2.5): the newest
 * non-terminal event per cheque, and how many older ones it would close as
 * superseded. Reviewed with the client before the first production run.
 * No amounts: this is printed to a console.
 */
export async function summariseBacklog(db: Db) {
  const open = await db.portalEvent.findMany({
    where: { status: { in: ['PENDING', 'FAILED', 'IN_FLIGHT'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { check: { select: { checkNumber: true, payeeName: true, status: true, eligibility: true } } },
  })
  const newest = new Map<string, (typeof open)[number]>()
  const byKind: Record<string, number> = {}
  for (const ev of open) { newest.set(ev.checkId, ev); byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1 }
  const winners = [...newest.values()].map((ev) => ({
    eventId: ev.id, kind: ev.kind, checkNumber: ev.check.checkNumber, payeeName: ev.check.payeeName,
    checkStatus: ev.check.status, eligibility: ev.check.eligibility, createdAt: ev.createdAt,
  }))
  return { total: open.length, winners, superseded: open.length - winners.length, byKind }
}
```

```ts
// scripts/portal-backlog.ts
// Dry run of the outbox backlog: what latest-wins would send. Read-only.
//   npx.cmd tsx scripts/portal-backlog.ts
import { prisma } from '@/lib/db'
import { summariseBacklog } from '@/lib/admin/portal-backlog'

async function main() {
  const s = await summariseBacklog(prisma)
  console.log(`open events: ${s.total}  would send: ${s.winners.length}  would supersede: ${s.superseded}`)
  console.log('by kind:', s.byKind)
  console.table(s.winners.map((w) => ({
    kind: w.kind, cheque: w.checkNumber, payee: w.payeeName ?? '', status: w.checkStatus, eligibility: w.eligibility, queued: w.createdAt.toISOString().slice(0, 10),
  })))
}

main().finally(() => prisma.$disconnect())
```

(Follow how `scripts/sync.ts` loads env and imports — copy its header lines if it uses `dotenv` or a path alias shim.)

- [ ] **Step 4: Docs**

`CLAUDE.md`: in "State", replace *"Plan 3 (portal automation) still paused: the portal needs an `encoder` service account that does not exist, and until it does every `PortalEvent` simply queues."* with:

```markdown
Plan 3 is superseded by `docs/superpowers/plans/2026-09-26-portal-outbox-delivery.md` (spec
`2026-09-26-check-monitoring-integration-design.md`): the outbox is delivered by
`lib/sync/portal-outbox.ts` to the portal's `POST /api/integrations/check-monitoring/events`
with `PORTAL_BASE_URL` / `PORTAL_TOKEN` (a bearer, no session), latest event per cheque wins,
`/admin/portal` shows what parked. Pickup confirmations back (old Task 6) remain a follow-up.
```

Add to the rules list, after rule 5: *"**The portal client sends only.** Nothing reads a status from the portal into a cheque; `lib/integrations/portal/client.ts` has one method."*

`.env.example`: append `PORTAL_BASE_URL=` and `PORTAL_TOKEN=`.

- [ ] **Step 5: Full suite and type check**

Run: `npx.cmd tsc --noEmit`, `npm.cmd run build`, then `npx.cmd vitest run` (≈20 min).
Expected: clean, clean, all green. Update the test count line in `CLAUDE.md` "State" with the measured numbers.

- [ ] **Step 6: Commit**

```bash
git add lib/admin/portal-backlog.ts scripts/portal-backlog.ts tests/scripts/portal-backlog.test.ts CLAUDE.md .env.example
git commit -m "feat(portal): backlog dry-run script; docs for the outbox delivery

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7: Deploy checklist (user runs, in this order)**

Rewritten after the final review (2026-09-26): the token stays **unset** on this side until the
backlog has been reviewed, so nothing can go out while the review is pending. Same order as the
spec's "Sequencing" and §2.5.

1. **Supplier Portal side live** — its plan deployed, migration 069 applied, `CHECK_MONITORING_TOKEN` set there.
2. `npx.cmd prisma migrate deploy` against production (adds the `CANCELLED` enum value).
3. **Deploy Check Monitoring with `PORTAL_BASE_URL` / `PORTAL_TOKEN` UNSET** on the `check-monitoring` Vercel project (confirm neither exists in Production). Every kick — after an action, the cron, DELIVER NOW — returns `{ skipped: 'PORTAL_BASE_URL is not set' }`; nothing can be sent, and cancellations made from here on already queue their `CANCELLED` event.
4. **Backlog review against production:** `npx.cmd tsx scripts/portal-backlog.ts` — review the winners with the user, including the `stale` column (winners the worker will close unsent because the cheque's status no longer matches). Then `npx.cmd tsx scripts/portal-backlog.ts --queue-cancelled` (dry run: counts portal-routed CANCELLED/VOIDED cheques with an open MARK_AVAILABLE and no CANCELLED event) and, if the user agrees, the same with `--apply` (queues one CANCELLED event per such cheque, with a SYSTEM `portal_event_backfilled` audit row).
5. **Set the two env vars and redeploy:** `PORTAL_BASE_URL=https://supplier-portal.rclcompanies.com` and `PORTAL_TOKEN=<the same token>` (Production); `scripts/set-vercel-env.mjs` is the repo's way. Env changes take effect only on a new deployment.
6. Open `/admin/portal`, press **DELIVER NOW**, watch the counts move; the cron finishes the rest at 18:00 Manila.

---

## Self-review

- **Spec coverage.** §2.1 enum + cancel/void queue → Tasks 1–2 (incl. Acumatica void path via `voidCheck`). §2.2 client, INTERNAL assertion, bank code, Manila dates, env names, injected fetch → Task 3. §2.3 worker: latest-wins, exclusive claim, verdict precedence, backoff/park thresholds, deadline, audit → Task 4. §2.4 triggers: `after()` in actions + bulk, cron, admin page with Retry / Deliver now → Tasks 5–6. §2.5 backlog dry run → Task 7. Sequencing → Task 7 checklist.
- **Placeholders.** None. One conditional instruction each on the `bills` relation name (Task 4), `after` import name (Task 5) and inline server action (Task 6) — verifiable facts with the fallback stated.
- **Type consistency.** `PortalClient.deliver(body) → PortalDeliveryResult` (Tasks 3, 4, 5); `deliverPortalEvents(db, { now, deadline, client, claimedBy? })` (Tasks 4, 5); `kickPortalDelivery(db, { budgetMs, client?, now? })` (Tasks 5, 6); `PortalOutboxOutcome` fields identical in Tasks 4, 5; `AdminActionResult` reused from `app/admin/actions.ts` (Task 6).
