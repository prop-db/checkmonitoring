# Portal Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Finance ticks READY FOR RELEASE, the Supplier Portal updates automatically, and when a supplier confirms pickup the schedule appears here — without anyone re-encoding a cheque.

**Architecture:** An outbox. `lib/domain/actions.ts` already writes a `PortalEvent` in the same transaction as the status change, so the status commits even if the portal is unreachable. A worker claims events and delivers them; a poller reads `GET /api/checks` and applies pickup confirmations through the existing `applyPickupConfirmation`, which can only move `READY_FOR_RELEASE → SCHEDULED`. Nothing in this plan lets the portal release a cheque.

**Tech Stack:** Next.js 15 (App Router, server actions), Prisma 6, PostgreSQL (Neon), Vitest, TypeScript strict. The portal is an Express app authenticated by **session cookie**, not a bearer token.

## Scope

This plan covers the automation only. **Reports, exports, notifications, and the remaining admin
screens (`/admin/users`, `/admin/settings`, `/admin/audit`) are Plan 4** — they are an independent
subsystem, they do not gate the automation, and bundling them would make this plan untestable as a
unit.

## Global Constraints

Carried forward from Plans 1 and 2. Every task's requirements implicitly include these.

- **INTERNAL USE ONLY. Do not create any supplier login, supplier dashboard, supplier access, or supplier-facing page. Suppliers must never log in to this system.**
- **An `INTERNAL` cheque must never produce a portal call.** Spec §7 requires this be asserted in `lib/domain/eligibility.ts` **and again inside the portal client before any request is built**. Two independent checks: a payroll register reaching a supplier-facing portal is not a recoverable error.
- **Acumatica stays read-only.** The client exposes no mutating method; do not add one.
- **The portal may never mark a cheque `RELEASED`.** Physical release is a Finance-only confirmation.
- Amounts are decimal strings end to end, never JS numbers. `Decimal(18,2)`.
- Audit rows are append-only and are written in the same transaction as the change they describe.
- Never print, log, or commit `.env` contents, credentials, connection strings, or the contents of the two gitignored `.xlsx` files.
- Tests never make live network calls. Inject `fetchImpl`.
- `app.allow_audit_purge` appears only in `tests/helpers/db.ts` and the trigger migration.
- Run `npx tsc --noEmit` before claiming done. **A green Vitest run is not sufficient** — esbuild erases types, and this project has repeatedly had a green suite over unsound types.
- Baseline at plan start: `tsc` clean, **484 tests across 32 files**, `next build` clean, 9 routes.

## State of this plan

**Tasks 0–6 are written to full detail and ready to dispatch.** Tasks 7–10 are specified —
files, interfaces, and the behaviours their tests must pin — but their steps are outlined rather
than carrying complete code.

**Expand a task to full code immediately before dispatching it, not now.** This is deliberate, and
it is how Plan 2 was executed: its Tasks 7–10 were expanded after Tasks 1–6 had run, and that
ordering is what let the expansions absorb what earlier tasks had actually discovered — the
bank-prefixed cheque numbers, the `PaymentMethod` field, the staging reasons. Writing them in full
today would bake in assumptions that Task 0 is specifically designed to overturn.

## Evidence

`docs/superpowers/specs/2026-09-04-supplier-portal-api-evidence.md` — read from the portal's own
source. Read it before Task 2. The load-bearing facts:

- `POST /api/checks/import` matches **server-side** on `ref` = **APV number** and `vendorRef` = **PO number**, so this system never needs the portal's internal ids. `ref` is *not* the cheque number.
- `POST /api/checks/mark-available` takes `tradeIds`; `POST /api/broker-checks/mark-available` takes `transactionIds`. Both exist; both require `encoder` tier.
- `POST /api/checks/:id/confirm-pickup` **refuses an admin session with 403**. Pickup can only be polled, never written.
- `GET /api/checks` returns `apvNumber`, `pickupDate`, `pickupTime`, `pickupRep`, `confirmedAt`, and `tradeId`.
- `unmatched` in the import response is capped at 50; `unmatchedTotal` is the true count.
- `MAX_ROWS = 5000`; `pickupDate` must be `^\d{4}-\d{2}-\d{2}$`.

---

## Task 0: Answer the two blocking questions before building anything

**Files:** none — this task writes no code.

**Nothing in Tasks 5 onward may be built until this is done.** Tasks 8 and 9 of Plan 2 were built
against assumed Acumatica behaviour, passed 355 tests, and still carried four money-affecting
defects that only appeared on first contact with the live feed. The portal is the same risk, and
one of its unknowns can reach real suppliers.

Use the **UAT sandbox**, never production: `RCL PROJECTS/Supplier Portal/docs/uat-sandbox-runbook.md`.
Its data is tagged (`ZZ-TEST%` suppliers, `zztest-%` usernames) and is erasable.

- [ ] **Step 1: Confirm the service account exists at `encoder` tier**

Design decision D6 assumes a dedicated portal service account so that portal-side audit rows
attribute actions to this system. Nothing has verified it. Confirm the account exists, its tier is
`encoder`, and its credentials are available to this system. **If it does not exist, stop and report
— someone with portal admin rights must create it.** Do not proceed by borrowing a human's account:
that would attribute every automated action to a person in the portal's audit log.

- [ ] **Step 2: Determine whether re-importing an already-available cheque re-notifies the supplier**

Against the sandbox, `POST /api/checks/import` with a row for a cheque that is already available.
Read `src/checks/import.js` and whatever notification path it triggers, then confirm by observation.

Record the answer in the evidence spec.

**This decides whether Task 5 may retry at all.** A retrying outbox against a re-notifying endpoint
sends a supplier one message per attempt. If the answer is "it re-notifies", the outbox must
succeed-or-park rather than retry, and that changes Task 5's design — not just a constant.

- [ ] **Step 3: Record the session lifetime and what an expired session returns**

401, or a redirect to a login page with 200? Task 2's re-authentication depends on telling them
apart, and a redirect-to-login parsed as success is how a client silently stops working.

- [ ] **Step 4: Write the findings into the evidence spec and commit**

```bash
git add docs/superpowers/specs/2026-09-04-supplier-portal-api-evidence.md
git commit -m "docs: answer the portal's three unknowns against the UAT sandbox"
```

---

## Task 1: Make PortalEvent a queue

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_portal_event_queue/migration.sql`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: `PortalEventStatus` enum, `PortalEvent.nextAttemptAt`, `.claimedAt`, `.claimedBy`, `.kind`, `.idempotencyKey`

`PortalEvent` today has `status String @default("PENDING")`, `attempts`, and `lastError`. It cannot
be claimed safely by a worker, cannot be scheduled, and its status is an unconstrained string.

- [ ] **Step 1: Write the failing test**

```ts
// tests/schema.test.ts — append
describe('PortalEvent as a queue', () => {
  it('rejects a status outside the enum', async () => {
    const check = await makeCheck({ eligibility: 'SUPPLIER' })
    await expect(testDb.portalEvent.create({
      data: {
        checkId: check.id, direction: 'OUT', kind: 'MARK_AVAILABLE',
        // @ts-expect-error - proving the column is an enum, not a free string
        status: 'DEFINITELY_NOT_A_STATUS', payload: {},
      },
    })).rejects.toThrow()
  })

  it('refuses two events with the same idempotency key', async () => {
    const check = await makeCheck({ eligibility: 'SUPPLIER' })
    const data = {
      checkId: check.id, direction: 'OUT' as const, kind: 'MARK_AVAILABLE' as const,
      payload: {}, idempotencyKey: `${check.id}:MARK_AVAILABLE:1`,
    }
    await testDb.portalEvent.create({ data })
    // The outbox must not be able to queue the same instruction twice — a
    // double MARK_AVAILABLE is a second notification to a supplier.
    await expect(testDb.portalEvent.create({ data })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/schema.test.ts`
Expected: FAIL — `Unknown argument 'kind'`.

- [ ] **Step 3: Change the schema**

```prisma
enum PortalEventStatus {
  PENDING
  IN_FLIGHT
  SYNCED
  FAILED
  // Terminal and deliberate: delivery was abandoned and a human must look.
  // Distinct from FAILED, which is retryable.
  PARKED
}

enum PortalEventKind {
  MARK_AVAILABLE
  REVERT
}

model PortalEvent {
  id             String            @id @default(cuid())
  checkId        String
  direction      PortalDirection
  kind           PortalEventKind
  payload        Json
  status         PortalEventStatus @default(PENDING)
  attempts       Int               @default(0)
  lastError      String?

  // When this event next becomes eligible for delivery. Backoff is expressed
  // as a time rather than a sleep so the worker stays stateless and a restart
  // does not reset every backoff to zero.
  nextAttemptAt  DateTime          @default(now())

  // Claim columns. A worker sets both in one conditional update, so two
  // workers cannot deliver the same event — which for MARK_AVAILABLE would be
  // two notifications to one supplier.
  claimedAt      DateTime?
  claimedBy      String?

  // One instruction per (check, kind, attempt-generation). The outbox must not
  // be able to queue the same instruction twice.
  idempotencyKey String            @unique

  createdAt      DateTime          @default(now())
  check          Check             @relation(fields: [checkId], references: [id])

  @@index([status, nextAttemptAt])
  @@index([checkId])
}
```

- [ ] **Step 4: Migrate the test database, then the application database**

There is no `package.json` script for the test database, and the connection string contains `&`, so
spawn the CLI with the URL as an argv entry and `shell: false`.

```bash
DIRECT_DATABASE_URL="$DIRECT_DATABASE_URL_TEST" DATABASE_URL="$DATABASE_URL_TEST" npx prisma migrate deploy
npx prisma migrate deploy
```

- [ ] **Step 5: Update `lib/domain/actions.ts` to set `kind` and `idempotencyKey`**

Both `portalEvent.create` call sites gain `kind` and a key. Use
`` `${check.id}:MARK_AVAILABLE:${check.readyAt?.toISOString() ?? now.toISOString()}` `` — a fresh
ready-for-release generates a new key, so a revert-then-re-ready is a legitimately new instruction,
while a duplicate submit of the same action is not.

- [ ] **Step 6: Run the full suite, `tsc`, and commit**

```bash
npx vitest run && npx tsc --noEmit
git add prisma tests lib
git commit -m "feat: make PortalEvent a claimable, scheduled queue"
```

---

## Task 2: The portal client — session auth and reads

**Files:**
- Create: `lib/integrations/portal/client.ts`
- Test: `tests/integrations/portal-client.test.ts`

**Interfaces:**
- Produces:
  - `createPortalClient({ baseUrl, username, password, fetchImpl? }): PortalClient`
  - `PortalClient.listChecks(opts?: { q?: string; status?: string }): Promise<PortalCheckRow[]>`
  - `PortalClient.listBrokerChecks(opts?): Promise<PortalCheckRow[]>`
- Consumes: nothing from this plan.

**The portal authenticates with a session cookie, not a bearer token.** Do not write this by analogy
to `lib/integrations/acumatica/client.ts`, which sets a Basic header on every request.

- [ ] **Step 1: Write the failing tests**

Cover, with an injected `fetchImpl` and no network:

```ts
it('logs in once and reuses the session cookie', async () => {
  const calls: string[] = []
  const client = createPortalClient({
    baseUrl: 'https://portal.test', username: 'svc', password: 'pw',
    fetchImpl: async (url, init) => {
      calls.push(String(url))
      if (String(url).includes('/api/login')) {
        return new Response('{}', { status: 200, headers: { 'set-cookie': 'sid=abc; Path=/' } })
      }
      expect((init?.headers as Record<string, string>)?.cookie).toContain('sid=abc')
      return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    },
  })
  await client.listChecks()
  await client.listChecks()
  expect(calls.filter((c) => c.includes('/api/login'))).toHaveLength(1)  // not twice
})

it('re-authenticates once when the session has expired, then gives up', async () => { /* 401 -> login -> retry; a second 401 throws rather than looping */ })

it('treats a redirect to the login page as expiry, not success', async () => {
  // Recorded in Task 0 Step 3. A login redirect parsed as a successful
  // response is how a client silently stops working while reporting health.
})

it('never puts the password in an error message, stack, or serialised form', async () => {
  // Same assertion shape as the Acumatica client's credential test.
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/integrations/portal-client.test.ts`
Expected: FAIL — `Cannot find module '@/lib/integrations/portal/client'`.

- [ ] **Step 3: Implement the client's read half**

Single-flight the login so two concurrent calls cannot log in twice. Re-authenticate at most once
per request. Never include credentials in a thrown error — assert this, do not assume it.

- [ ] **Step 4: Run, `tsc`, commit**

```bash
npx vitest run tests/integrations/portal-client.test.ts && npx tsc --noEmit
git add lib/integrations/portal tests/integrations
git commit -m "feat: read the Supplier Portal through a session-authenticated client"
```

---

## Task 3: The portal client — writes, behind a second eligibility gate

**Files:**
- Modify: `lib/integrations/portal/client.ts`
- Test: `tests/integrations/portal-client.test.ts`

**Interfaces:**
- Produces:
  - `PortalClient.importRows(rows: PortalImportRow[], pickupDate: string): Promise<PortalImportResult>`
  - `PortalClient.markAvailable(tradeIds: number[], pickupDate: string)`
  - `PortalClient.markBrokerAvailable(transactionIds: number[], pickupDate: string)`
  - `PortalClient.revert({ tradeReleaseIds, brokerReleaseIds })`
  - The two shared types, defined here and consumed by Tasks 4, 5 and 7:

```ts
// `ref` is the APV number and `vendorRef` the PO number — NOT the cheque
// number. The portal matches on trade.apv_number / acu_po_number.
// `eligibility` is carried so the client can refuse an INTERNAL cheque
// without having to ask the database; it is never sent to the portal.
export type PortalImportRow = {
  ref: string
  vendorRef: string
  checkNo?: string
  bank?: string
  eligibility: 'SUPPLIER' | 'BROKER' | 'INTERNAL'
}

export type PortalImportResult = {
  marked: number
  alreadyAvailable: number
  // Capped at 50 by the portal. Use `unmatchedTotal` for the real count.
  unmatched: { ref: string; vendorRef: string }[]
  unmatchedTotal: number
}
```

- [ ] **Step 1: Write the failing tests — the eligibility gate first**

```ts
it('refuses to build a request for an INTERNAL cheque', async () => {
  // Spec §7: asserted in eligibility.ts AND AGAIN here. This is the second of
  // two independent checks. A payroll register reaching a supplier-facing
  // portal is not a recoverable error, so the client must refuse even when a
  // caller has already got it wrong.
  let fetched = false
  const client = createPortalClient({ /* fetchImpl sets fetched = true */ })
  await expect(client.importRows(
    [{ ref: 'AP-ST036371', vendorRef: 'PO-ST-027539', eligibility: 'INTERNAL' }], '2026-09-05',
  )).rejects.toMatchObject({ code: 'INTERNAL_NEVER_PUBLISHED' })
  expect(fetched).toBe(false)   // no request was even built
})

it('rejects a pickup date the portal would reject', async () => {
  // The portal 400s anything not ^\d{4}-\d{2}-\d{2}$. Failing here costs one
  // caught error; failing there costs an outbox retry cycle against a request
  // that can never succeed.
})

it('refuses more than the portal MAX_ROWS of 5000', async () => { /* ... */ })

it('reports unmatchedTotal, not unmatched.length', async () => {
  // The portal caps `unmatched` at 50 entries. Reading the array length would
  // under-report a large mismatch as exactly 50 every time.
  const res = await client.importRows(/* response with 50 entries, total 137 */)
  expect(res.unmatchedTotal).toBe(137)
})
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement the write half**

`importRows` is the primary path — it matches server-side on APV and PO, so no portal id is needed.
`markAvailable` / `markBrokerAvailable` exist for when a `portalTradeId` is already known.

- [ ] **Step 4: Run, `tsc`, commit**

```bash
git commit -m "feat: write to the portal, with the eligibility gate asserted a second time"
```

---

## Task 4: Map a cheque to a portal payload

**Files:**
- Create: `lib/integrations/portal/payload.ts`
- Test: `tests/integrations/portal-payload.test.ts`

**Interfaces:**
- Produces: `toImportRows(check: CheckForPortal): PortalImportRow[]`

- [ ] **Step 1: Write the failing tests**

```ts
it('sends the APV as ref and the PO as vendorRef, not the cheque number', () => {
  // The single most likely error in this file. `ref` reads like a payment
  // reference, and sending the cheque number there matches nothing at all —
  // the portal keys on trade.apv_number.
  const rows = toImportRows({ apvNumbers: ['AP-ST036371'], poNumbers: ['PO-ST-027539'], checkNumber: '6000308611', cashAccountCode: 'BPI STK', eligibility: 'SUPPLIER' })
  expect(rows[0].ref).toBe('AP-ST036371')
  expect(rows[0].vendorRef).toBe('PO-ST-027539')
  expect(rows[0].checkNo).toBe('6000308611')
})

it('emits one row per APV for a cheque that settles several bills', () => {
  // A cheque routinely pays several bills; the portal dedupes by ref and
  // matches each independently, so all of them must be offered or the
  // unmatched ones are silently never marked available.
  const rows = toImportRows({ apvNumbers: ['AP-ST036371', 'AP-ST036372'], poNumbers: ['PO-ST-027539'], /* ... */ })
  expect(rows.map((r) => r.ref)).toEqual(['AP-ST036371', 'AP-ST036372'])
})

it('sends a cheque with no APV as an empty payload rather than a blank ref', () => {
  // A blank ref matches nothing and would be reported as unmatched forever.
  expect(toImportRows({ apvNumbers: [], /* ... */ })).toEqual([])
})
```

- [ ] **Step 2–4: Run, implement, run, commit**

```bash
git commit -m "feat: map a cheque onto the portal's APV/PO match keys"
```

---

## Task 5: The outbox worker

**Files:**
- Create: `lib/portal/outbox.ts`
- Test: `tests/portal/outbox.test.ts`

**Interfaces:**
- Produces: `runOutbox(db, { client, now, workerId, max? }): Promise<OutboxResult>`

**Do not start this task until Task 0 Step 2 is answered.** If re-importing re-notifies the
supplier, this worker must succeed-or-park rather than retry, and that is a design difference, not a
constant.

- [ ] **Step 1: Write the failing tests**

Cover:
- an event is claimed by exactly one worker — run two `runOutbox` calls concurrently against one PENDING event and assert the portal was called **once**
- a delivered event becomes `SYNCED` and its check's `portalSyncStatus` becomes `SYNCED`
- a failed delivery increments `attempts`, records `lastError`, and sets `nextAttemptAt` into the future — assert the backoff **grows**, and that an event is not re-delivered before its `nextAttemptAt`
- after the attempt cap the event is `PARKED`, not retried forever, and the check shows `FAILED`
- **an `INTERNAL` cheque has no event to deliver** — assert `portalEvent.count()` is 0 for one, so the gate is proven at this layer too
- a portal error message is recorded without leaking credentials

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

Claim with a single conditional update — `updateMany` on `{ status: PENDING, nextAttemptAt: { lte: now } }` setting `IN_FLIGHT`, `claimedAt`, `claimedBy` — then read back what this worker claimed. Never `findMany` then `update`: two workers would both see the same PENDING row.

- [ ] **Step 4: Run, `tsc`, commit**

```bash
git commit -m "feat: deliver portal events from a claimable outbox"
```

---

## Task 6: Pull pickup confirmations back

**Files:**
- Create: `lib/portal/poll-pickups.ts`
- Test: `tests/portal/poll-pickups.test.ts`

**Interfaces:**
- Produces: `pollPickups(db, { client, now }): Promise<PollResult>`

`POST /api/checks/:id/confirm-pickup` refuses an admin session with 403, so this system can only
observe a confirmation. Polling is the portal's rule, not a preference.

- [ ] **Step 1: Write the failing tests**

- a confirmed row moves `READY_FOR_RELEASE → SCHEDULED` and records `scheduledPickupDate`, `scheduledPickupTime`, `pickupRep`, `portalConfirmedAt`
- **a portal row claiming a cheque is released does NOT release it** — assert the status is unchanged and an audit row records that the claim was ignored. Physical release is Finance-only, and this is the assertion that keeps it so
- matching is on `apvNumber`, which the portal returns
- a confirmation for a cheque this system does not have is counted, not thrown
- re-polling the same confirmation is idempotent — no second audit row, no second transition
- every applied confirmation writes a `SYSTEM` audit row

- [ ] **Step 2–4: Run, implement, run, commit**

Route every change through the existing `applyPickupConfirmation` in `lib/domain/actions.ts`, which
already refuses any transition but `READY_FOR_RELEASE → SCHEDULED`. Do not write a second path.

```bash
git commit -m "feat: poll the portal for pickup confirmations, which it will not push"
```

---

## Task 7: The unmatched queue

**Files:**
- Modify: `prisma/schema.prisma` (add `PortalUnmatched`)
- Create: `lib/portal/unmatched.ts`, `app/admin/unmatched/page.tsx`
- Test: `tests/portal/unmatched.test.ts`

A cheque this system published that the portal could not match is neither an error nor a success:
the portal has no trade with that APV. It must be visible, because a supplier is waiting for a
cheque nobody has told them about.

- [ ] **Step 1: Write the failing test** — an import result with `unmatchedTotal: 137` records 137, not the 50 the portal returned; re-recording the same unmatched ref updates rather than duplicating; a later successful match clears it.

- [ ] **Step 2–4: Run, implement, run, commit**

---

## Task 8: Batch release

**Files:**
- Create: `app/checks/batch-actions.ts`, `components/BatchReleaseBar.tsx`
- Test: `tests/actions/batch-release.test.ts`

**`FINANCE_ADMIN` only** — design decision D11 names this the highest-risk action in the system.

- [ ] **Step 1: Write the failing tests**

- a `FINANCE_USER` is refused with an `ActionResult`, not a redirect (`run()`'s catch would swallow a redirect — follow `revertAction`)
- **one ineligible cheque does not release the rest, and does not silently drop itself either** — the result names exactly which succeeded and which were refused, with the reason per cheque
- each released cheque gets its own audit row
- a batch is capped, and the cap is asserted
- an INTERNAL cheque in the selection releases without producing a portal event

- [ ] **Step 2–4: Run, implement, run, commit**

---

## Task 9: Portal admin screen and scheduling

**Files:**
- Create: `app/admin/portal/page.tsx`, `app/admin/portal/actions.ts`
- Modify: `app/admin/layout.tsx`
- Test: `tests/admin/portal-actions.test.ts`

- [ ] **Step 1:** Failing tests — retry and park actions are `FINANCE_ADMIN` only; a retry resets `nextAttemptAt` and `status` but **not** `attempts`, so the history of a struggling event is not erased.

- [ ] **Step 2:** The screen — pending / in-flight / synced / failed / parked counts, the oldest pending event's age, per-event last error, manual retry, and the unmatched count.

- [ ] **Step 3:** Decide and document how `runOutbox` and `pollPickups` are triggered in production — an authenticated cron route, or an external scheduler. Whatever is chosen, **the trigger must be authenticated**: an open endpoint that delivers portal events is an open endpoint that notifies suppliers.

- [ ] **Step 4:** Run, `tsc`, build, commit.

---

## Task 10: The end-to-end path that must never break

**Files:**
- Create: `tests/e2e/release-path.spec.ts`, `playwright.config.ts`

Spec §14 names this path explicitly: sign → ready → portal push → schedule pulled back → release →
audit trail complete.

- [ ] **Step 1:** Install and configure Playwright against a seeded test database and a stubbed portal. **The stub must be a real HTTP server**, not a mocked module — the point is to exercise the client's session handling, which a module mock would skip.

- [ ] **Step 2:** Write the spec covering the full path, plus the two negatives that matter most: an INTERNAL cheque completes the same journey and **produces no portal request at all**, and a portal row claiming release does not release the cheque.

- [ ] **Step 3:** Run, `tsc`, commit.

---

## Deployment items carried from Plans 1 and 2

Not tasks in this plan, but they gate go-live and must not be lost:

- **Rotate the seeded credentials** `admin@rcl.test` / `finance@rcl.test` before production.
- **Create the `check_monitoring_app` database role** so the dormant `REVOKE` on `audit_log` becomes active. Append-only is currently enforced by application code and a trigger, not by permissions.
- **Login rate limiting** was accepted as absent on the explicit basis that deployment is internal-only. **If this ever becomes internet-facing, revisit it.**
- The import runs at ~3 rows/s because `upsertCheck` does three reference lookups per row. Caching them per batch would roughly halve the 50-minute historical load. Deliberately not done: it touches the shared write path, and a long-lived process holding stale reference data is a correctness risk that wants deciding on purpose.
