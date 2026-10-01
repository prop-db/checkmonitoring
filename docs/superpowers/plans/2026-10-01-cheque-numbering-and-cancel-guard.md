# Cheque Numbering Report and CANCELLED Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop queuing CANCELLED portal events the portal can never match (no APV), close the two already parked, and give Finance a per-cash-account cheque numbering report with MISSING runs and an Excel export.

**Architecture:** Part A puts one shared rule (`portalApvs`) under both the delivery client and the two domain actions that queue CANCELLED, plus a dry-run-first repair script for the parked rows. Part B is the `/recon` pattern again: a pure series function (`lib/numbering/series.ts`), one query (`lib/numbering/query.ts`), a pure view module (`lib/numbering-view.ts`), a workbook builder, an export route and a page, with a new NUMBERING module in the bar.

**Tech Stack:** Next.js 15 App Router, Prisma 6 / PostgreSQL (Neon), Vitest, ExcelJS, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-01-cheque-numbering-and-cancel-guard-design.md`

## Global Constraints

- **Amounts are decimal strings end to end** (CLAUDE.md rule 8). `Number(amount)` only when writing an Excel cell, as `recon-workbook.ts` does.
- **Cheque numbers are compared as `BigInt`**, never as JS numbers or strings; every number and count leaves `buildSeries` as a decimal string.
- **Never write to `crNumber`**, never change a cheque's `status` outside `lib/domain/actions.ts`, never delete an audit row.
- **`writeAudit` is the only audit writer.**
- **The local `.env` `DATABASE_URL` is PRODUCTION.** Do not run any script in this plan with `--apply`, and do not run it at all, unless the user asks. Tests use `DATABASE_URL_TEST` via `tests/helpers/db.ts`.
- **One agent at a time against the test database.** Before running any database-backed test, confirm no other session is running Vitest (an untracked `tests/actions/revert-signature.test.ts` showed another session at work on 2026-10-01). Ask the user if unsure.
- **Run tests from Git Bash as** `node node_modules/vitest/vitest.mjs run <file>` and types as `node node_modules/typescript/bin/tsc --noEmit` (`npx.cmd` mis-tokenises under Git Bash). Run only the files a task touches; the full suite is ~25 minutes.
- **`tsc --noEmit` must be clean before any task is called done** — Vitest erases types.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `docs/deployment.md` or `For fun/` (the user's own uncommitted work).

## File Map

| File | Responsibility |
| --- | --- |
| `lib/integrations/portal/apvs.ts` (create) | `portalApvs` — the one definition of "the APVs the portal would receive". |
| `lib/integrations/portal/client.ts` (modify) | Body builder uses `portalApvs`. |
| `lib/domain/actions.ts` (modify) | `voidCheck` / `cancelCheck` queue CANCELLED only when routed **and** matchable; audit records it. |
| `lib/admin/unmatchable-cancelled.ts` (create) | Find and close PARKED CANCELLED events whose cheque has no APV. |
| `scripts/close-unmatchable-cancelled.ts` (create) | CLI: dry run, `--apply` with snapshot. |
| `lib/admin/portal-overview.ts`, `app/admin/portal/page.tsx` (modify) | Count `unmatchable:` closures separately. |
| `lib/numbering/series.ts` (create) | Pure: one account's cheques → ordered entries with MISSING runs, summary. |
| `lib/numbering/query.ts` (create) | Population and grouping by cash account; count of cheques with no account. |
| `lib/numbering-view.ts` (create) | Pure: paths, hrefs, `missing` toggle, filter line, filename, scope note. |
| `lib/export/numbering-workbook.ts` (create) | SUMMARY + one sheet per account. |
| `app/api/export/numbering/route.ts` (create) | Session-guarded export. |
| `components/NumberingTables.tsx` (create) | Summary table and entries table. |
| `app/numbering/page.tsx` (create) | The screen. |
| `lib/module-nav.ts` (modify) | NUMBERING module between RECON and ADMINISTRATION. |

---

## Part A — the guard

### Task 1: `portalApvs`, shared by the client

**Files:**
- Create: `lib/integrations/portal/apvs.ts`
- Modify: `lib/integrations/portal/client.ts:88-90`
- Test: `tests/integrations/portal-apvs.test.ts` (create)

**Interfaces:**
- Produces: `portalApvs(check: { apvNumbers: readonly string[]; bills: readonly { apvNumber: string }[] }): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integrations/portal-apvs.test.ts
import { describe, it, expect } from 'vitest'
import { portalApvs } from '@/lib/integrations/portal/apvs'

describe('portalApvs', () => {
  it('prefers the cheque\'s own apvNumbers', () => {
    expect(portalApvs({ apvNumbers: ['AP-1', 'AP-2'], bills: [{ apvNumber: 'AP-9' }] })).toEqual(['AP-1', 'AP-2'])
  })
  it('falls back to the bills when apvNumbers is empty', () => {
    expect(portalApvs({ apvNumbers: [], bills: [{ apvNumber: 'AP-9' }, { apvNumber: 'AP-8' }] })).toEqual(['AP-9', 'AP-8'])
  })
  it('is empty when the cheque has neither', () => {
    expect(portalApvs({ apvNumbers: [], bills: [] })).toEqual([])
  })
  it('returns a copy, never the caller\'s array', () => {
    const apvNumbers = ['AP-1']
    const out = portalApvs({ apvNumbers, bills: [] })
    out.push('AP-X')
    expect(apvNumbers).toEqual(['AP-1'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/integrations/portal-apvs.test.ts`
Expected: FAIL — cannot resolve `@/lib/integrations/portal/apvs`.

- [ ] **Step 3: Implement**

```ts
// lib/integrations/portal/apvs.ts
/**
 * The APVs the portal would receive for a cheque — the one definition, shared
 * by the delivery client (which refuses an event with none) and by the domain
 * actions (which do not queue a CANCELLED event the portal cannot match; spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §A1). `apvNumbers` is the
 * source's list; a cheque imported before 2026-09-07 may carry only bills.
 */
export function portalApvs(
  check: { apvNumbers: readonly string[]; bills: readonly { apvNumber: string }[] },
): string[] {
  return check.apvNumbers.length ? [...check.apvNumbers] : check.bills.map((b) => b.apvNumber)
}
```

In `lib/integrations/portal/client.ts`, add the import beside the existing ones:

```ts
import { portalApvs } from './apvs'
```

and replace line 90:

```ts
  const apvs = check.apvNumbers.length ? check.apvNumbers : check.bills.map((b) => b.apvNumber)
```

with:

```ts
  const apvs = portalApvs(check)
```

(Keep the two comment lines above it.)

- [ ] **Step 4: Run the new test and the client's tests**

Run: `node node_modules/vitest/vitest.mjs run tests/integrations/portal-apvs.test.ts tests/integrations/portal-client.test.ts`
Expected: PASS, both files. (`portal-client` is pure — no database. If the filename differs, find it with `ls tests/integrations`.)

- [ ] **Step 5: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.

```bash
git add lib/integrations/portal/apvs.ts lib/integrations/portal/client.ts tests/integrations/portal-apvs.test.ts
git commit -m "refactor(portal): portalApvs - one definition of the APVs an event carries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: no CANCELLED event for a cheque with no APV

**Files:**
- Modify: `lib/domain/actions.ts` (`queueCancelled` neighbourhood ~line 61-74, `voidCheck` ~749-792, `cancelCheck` ~950-1010)
- Modify tests: `tests/actions/portal-cancel.test.ts`, `tests/actions/actions.test.ts` (~line 455-468), `tests/import/upsert.test.ts` (add one case after ~line 535)

**Interfaces:**
- Consumes: `portalApvs` from Task 1.
- Produces: exported constant `NO_APV_SKIP_REASON = 'no APV numbers'` in `lib/domain/actions.ts`; audit `details.portalNotified: boolean` and `details.portalSkipReason` on `voided` / `voided_after_release` / `cancelled` rows of routed cheques.

- [ ] **Step 1: Update the existing tests that relied on a no-APV cheque queuing**

`makeCheck` defaults to `apvNumbers: []`, so three existing cases now describe the skip. Give them an APV.

In `tests/actions/portal-cancel.test.ts`, first test: change

```ts
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER' })
```
to
```ts
    const check = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST000001'] })
```

second test: change

```ts
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'BROKER' })
```
to
```ts
    const check = await makeCheck({ status: 'RELEASED', eligibility: 'BROKER', apvNumbers: ['AP-ST000002'] })
```

In `tests/actions/actions.test.ts`, the case `'queues a CANCELLED portal event for a portal-routed cheque'`: change

```ts
    const check = await makeCheck({ status: 'SIGNATURE_PENDING', eligibility: 'SUPPLIER' })
```
to
```ts
    const check = await makeCheck({ status: 'SIGNATURE_PENDING', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST000003'] })
```

(`tests/import/upsert.test.ts`'s void cases need no change: its `row()` carries `apvNumbers: ['APV-ST-009911']`.)

- [ ] **Step 2: Write the failing tests for the guard**

Append inside the `describe('CANCELLED portal event', …)` block of `tests/actions/portal-cancel.test.ts`:

```ts
  it('cancelCheck queues nothing for a routed cheque with no APV, and says so', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', apvNumbers: [] })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'spoiled', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(after.portalDomain).toBe('LOCAL')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    expect(audit.details).toEqual({ portalNotified: false, portalSkipReason: NO_APV_SKIP_REASON })
  })

  it('voidCheck queues nothing for a routed cheque with no APV, and says so', async () => {
    const check = await makeCheck({ status: 'SIGNATURE_PENDING', eligibility: 'SUPPLIER', apvNumbers: [] })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(after.portalDomain).toBe('LOCAL')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'voided' } })
    expect(audit.details).toMatchObject({ portalNotified: false, portalSkipReason: NO_APV_SKIP_REASON })
  })

  it('a cheque with no apvNumbers but a bill still queues — the bill is an APV', async () => {
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', apvNumbers: [] })
    await testDb.checkBill.create({ data: { checkId: check.id, apvNumber: 'AP-ST000004' } })
    await voidCheck(testDb, { checkId: check.id, reason: 'Voided in Acumatica', now: NOW })
    const ev = await testDb.portalEvent.findFirstOrThrow({ where: { checkId: check.id } })
    expect(ev.kind).toBe('CANCELLED')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'voided' } })
    expect(audit.details).toMatchObject({ portalNotified: true })
  })

  it('a routed cheque that queues records portalNotified: true', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER', apvNumbers: ['AP-ST000005'] })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'duplicate', now: NOW })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    expect(audit.details).toEqual({ portalNotified: true })
  })

  it('an INTERNAL cheque records no portal keys at all', async () => {
    const user = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await cancelCheck(testDb, { checkId: check.id, userId: user.id, reason: 'x', now: NOW })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'cancelled' } })
    expect(audit.details).toBeNull()
  })
```

and change the file's import line to:

```ts
import { cancelCheck, voidCheck, NO_APV_SKIP_REASON } from '@/lib/domain/actions'
```

If `CheckBill` has other required columns, `tsc` will say so in Step 4; supply them in the `create` (read `model CheckBill` in `prisma/schema.prisma`).

Append to `tests/import/upsert.test.ts`, inside the same `describe` as `'voids a cheque Acumatica reports voided, through the domain action'`:

```ts
  it('a cheque created already voided, with no APV, queues no portal event (spec 2026-10-01 §A1)', async () => {
    await seedCompany()
    await upsert(row({
      source: 'ACUMATICA', voided: true, sourceSheet: null, sourceRow: null, apvNumbers: [],
      acumaticaDocType: 'Voided Payment', acumaticaStatus: 'Closed',
    }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.status).toBe('VOIDED')
    expect(check.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })
```

- [ ] **Step 3: Run them to verify they fail**

Confirm no other session is running Vitest, then:

Run: `node node_modules/vitest/vitest.mjs run tests/actions/portal-cancel.test.ts`
Expected: FAIL — `NO_APV_SKIP_REASON` is not exported, and the no-APV cases find an event.

- [ ] **Step 4: Implement**

In `lib/domain/actions.ts`, add the import beside the others:

```ts
import { portalApvs } from '@/lib/integrations/portal/apvs'
```

Directly after the `queueCancelled` function, add:

```ts
/** Recorded on the audit row when a routed cheque's CANCELLED event is skipped. */
export const NO_APV_SKIP_REASON = 'no APV numbers'

/**
 * Whether a CANCELLED event for this cheque could ever be delivered. The portal
 * matches on APV and the client refuses an event with none, so an event queued
 * for a cheque with no APV parks on its first attempt and RETRY parks it again
 * (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §A1). The plainest
 * case is a cheque the sync creates already voided: the portal was never told
 * it existed. Bills are read only when `apvNumbers` is empty — the same
 * fallback as the client, through the same function.
 */
async function portalCanMatch(tx: Prisma.TransactionClient, check: { id: string; apvNumbers: string[] }): Promise<boolean> {
  if (check.apvNumbers.length) return true
  const bills = await tx.checkBill.findMany({ where: { checkId: check.id }, select: { apvNumber: true } })
  return portalApvs({ apvNumbers: check.apvNumbers, bills }).length > 0
}

/** The audit keys for the portal decision; none for an unrouted (INTERNAL) cheque. */
function portalAuditDetails(routed: boolean, pushes: boolean): Record<string, unknown> {
  if (!routed) return {}
  return pushes ? { portalNotified: true } : { portalNotified: false, portalSkipReason: NO_APV_SKIP_REASON }
}
```

In `voidCheck`, replace

```ts
    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null
```

with

```ts
    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null && await portalCanMatch(tx, check)
```

and its `writeAudit` `details` line

```ts
      details: { fromStatus: from, releasedAt: check.releasedAt?.toISOString() ?? null },
```

with

```ts
      details: {
        fromStatus: from, releasedAt: check.releasedAt?.toISOString() ?? null,
        ...portalAuditDetails(route !== null, pushes),
      },
```

Update the doc comment paragraph that begins `Queues a \`CANCELLED\` \`PortalEvent\` for a portal-routed cheque` by appending one sentence: `Only when the cheque carries an APV the portal can match it on (spec 2026-10-01 §A1); otherwise nothing is queued and the audit row says so.`

In `cancelCheck`, make the same two-line change to `pushes`, and replace its audit call

```ts
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'cancelled', remarks: args.reason,
    })
```

with

```ts
    const portal = portalAuditDetails(route !== null, pushes)
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'cancelled', remarks: args.reason,
      ...(Object.keys(portal).length ? { details: portal as Prisma.InputJsonValue } : {}),
    })
```

(An INTERNAL cancel keeps writing no `details`, so its row is unchanged — that is what the INTERNAL test pins.) In `voidCheck` the spread is inside an object that already has keys, so no cast is needed there; if `tsc` objects to `Record<string, unknown>` in that object literal, give `portalAuditDetails` the return type `{ portalNotified?: boolean; portalSkipReason?: string }` instead and drop the cast in `cancelCheck`.

`portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE'` and `portalDomain: route` stay as they are in both functions: a routed cheque with no APV gets `NOT_APPLICABLE` with its domain kept, which the database's INTERNAL check constraint allows.

- [ ] **Step 5: Run the affected files**

Run: `node node_modules/vitest/vitest.mjs run tests/actions/portal-cancel.test.ts tests/actions/actions.test.ts tests/import/upsert.test.ts tests/sync/run.test.ts`
Expected: PASS, all four. (`sync/run` voids rows from Acumatica, whose `apvNumbers` is always `[]`; its only CANCELLED assertion counts non-CANCELLED events, so it stays green. If it does fail on a CANCELLED count, that case was relying on the old behaviour: give its row an APV and say so in the commit.)

- [ ] **Step 6: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.

```bash
git add lib/domain/actions.ts tests/actions/portal-cancel.test.ts tests/actions/actions.test.ts tests/import/upsert.test.ts
git commit -m "fix(portal): no CANCELLED event for a cheque with no APV - the portal cannot match it

A void or cancel of an unlinked cheque queued an event the client refuses
before sending, so it parked, and RETRY parked it again. The audit row now
records portalNotified and, when skipped, why.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: close the parked ones, and count them on `/admin/portal`

**Files:**
- Create: `lib/admin/unmatchable-cancelled.ts`, `scripts/close-unmatchable-cancelled.ts`
- Modify: `lib/admin/portal-overview.ts`, `app/admin/portal/page.tsx:20`
- Test: `tests/admin/unmatchable-cancelled.test.ts` (create), `tests/admin/portal-overview.test.ts` (modify)

**Interfaces:**
- Consumes: `portalApvs` (Task 1).
- Produces:
  - `UNMATCHABLE_ERROR = 'unmatchable: no APV numbers'`
  - `type UnmatchableRow = { eventId: string; checkId: string; checkNumber: string; payeeName: string | null; attempts: number; lastError: string | null }`
  - `findUnmatchableCancelled(db: Db): Promise<UnmatchableRow[]>`
  - `closeUnmatchableCancelled(db: PrismaClient, rows: readonly UnmatchableRow[], now: Date): Promise<number>`
  - `PortalClosedCounts` gains `unmatchable: number`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/admin/unmatchable-cancelled.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { findUnmatchableCancelled, closeUnmatchableCancelled, UNMATCHABLE_ERROR } from '@/lib/admin/unmatchable-cancelled'

const NOW = new Date('2026-10-01T10:00:00+08:00')

beforeEach(resetDb)

async function parked(checkId: string, kind: 'CANCELLED' | 'MARK_AVAILABLE' = 'CANCELLED', status: 'PARKED' | 'FAILED' = 'PARKED') {
  return testDb.portalEvent.create({
    data: {
      checkId, direction: 'OUT', kind, status, attempts: 1, idempotencyKey: `${checkId}:${kind}:${Math.random()}`,
      payload: {}, lastError: 'cheque x has no APV numbers; the portal requires at least one',
    },
  })
}

describe('findUnmatchableCancelled', () => {
  it('selects only PARKED CANCELLED events whose cheque has no APV', async () => {
    const bare = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    const withApv = await makeCheck({ status: 'VOIDED', apvNumbers: ['AP-1'] })
    const withBill = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    await testDb.checkBill.create({ data: { checkId: withBill.id, apvNumber: 'AP-2' } })
    const failing = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    const otherKind = await makeCheck({ status: 'SIGNED', apvNumbers: [] })
    const target = await parked(bare.id)
    await parked(withApv.id); await parked(withBill.id)
    await parked(failing.id, 'CANCELLED', 'FAILED'); await parked(otherKind.id, 'MARK_AVAILABLE')

    const rows = await findUnmatchableCancelled(testDb)
    expect(rows.map((r) => r.eventId)).toEqual([target.id])
    expect(rows[0]).toMatchObject({ checkId: bare.id, checkNumber: bare.checkNumber, attempts: 1 })
  })
})

describe('closeUnmatchableCancelled', () => {
  it('closes unsent, sets the cheque NOT_APPLICABLE, and writes one audit row each', async () => {
    const check = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    await testDb.check.update({ where: { id: check.id }, data: { portalSyncStatus: 'PENDING', portalDomain: 'LOCAL' } })
    const ev = await parked(check.id)
    const closed = await closeUnmatchableCancelled(testDb, await findUnmatchableCancelled(testDb), NOW)
    expect(closed).toBe(1)
    const after = await testDb.portalEvent.findUniqueOrThrow({ where: { id: ev.id } })
    expect(after.status).toBe('SYNCED')
    expect(after.lastError).toBe(UNMATCHABLE_ERROR)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).portalSyncStatus).toBe('NOT_APPLICABLE')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id, action: 'portal_event_closed_unmatchable' } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.details).toMatchObject({ eventId: ev.id, kind: 'CANCELLED', attempts: 1 })
  })

  it('is idempotent: a second run finds and closes nothing', async () => {
    const check = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    await parked(check.id)
    await closeUnmatchableCancelled(testDb, await findUnmatchableCancelled(testDb), NOW)
    expect(await findUnmatchableCancelled(testDb)).toEqual([])
    expect(await testDb.auditLog.count({ where: { action: 'portal_event_closed_unmatchable' } })).toBe(1)
  })

  it('leaves a row that is no longer PARKED, or whose cheque gained an APV, untouched', async () => {
    const a = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    const b = await makeCheck({ status: 'VOIDED', apvNumbers: [] })
    const evA = await parked(a.id); const evB = await parked(b.id)
    const rows = await findUnmatchableCancelled(testDb)
    await testDb.portalEvent.update({ where: { id: evA.id }, data: { status: 'PENDING' } })
    await testDb.check.update({ where: { id: b.id }, data: { apvNumbers: ['AP-LATE'] } })
    expect(await closeUnmatchableCancelled(testDb, rows, NOW)).toBe(0)
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: evA.id } })).status).toBe('PENDING')
    expect((await testDb.portalEvent.findUniqueOrThrow({ where: { id: evB.id } })).status).toBe('PARKED')
  })
})
```

In `tests/admin/portal-overview.test.ts`, change the first test's

```ts
    expect(o.closed).toEqual({ delivered: 1, superseded: 0, stale: 0 })
```
to
```ts
    expect(o.closed).toEqual({ delivered: 1, superseded: 0, stale: 0, unmatchable: 0 })
```

and replace the second test's last three lines (from `await mk('a', null)`) with:

```ts
    await mk('a', null); await mk('b', 'unmatched: AP-9'); await mk('c', 'superseded by x'); await mk('d', 'stale: cheque is now CANCELLED')
    await mk('e', 'unmatchable: no APV numbers')
    const o = await getPortalOverview(testDb)
    expect(o.counts.SYNCED).toBe(5)
    expect(o.closed).toEqual({ delivered: 2, superseded: 1, stale: 1, unmatchable: 1 })
```

(`unmatched:` — a delivered event the portal answered with unmatched refs — stays counted as delivered; `unmatchable:` was never sent.)

- [ ] **Step 2: Run them to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run tests/admin/unmatchable-cancelled.test.ts tests/admin/portal-overview.test.ts`
Expected: FAIL — module not found; `unmatchable` missing from `closed`.

- [ ] **Step 3: Implement the library**

```ts
// lib/admin/unmatchable-cancelled.ts
import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { portalApvs } from '@/lib/integrations/portal/apvs'

type Db = PrismaClient | Prisma.TransactionClient

/** `lastError` on a row closed by this repair; `/admin/portal` counts the prefix. */
export const UNMATCHABLE_ERROR = 'unmatchable: no APV numbers'

export type UnmatchableRow = {
  eventId: string; checkId: string; checkNumber: string; payeeName: string | null
  attempts: number; lastError: string | null
}

/**
 * PARKED CANCELLED events the portal can never match, because their cheque has
 * no APV (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §A2). These
 * were queued before `voidCheck` / `cancelCheck` stopped queuing them. A parked
 * CANCELLED whose cheque does carry an APV parked for some other reason and is
 * not selected. Prints no amounts.
 */
export async function findUnmatchableCancelled(db: Db): Promise<UnmatchableRow[]> {
  const parked = await db.portalEvent.findMany({
    where: { kind: 'CANCELLED', status: 'PARKED' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { check: { select: { checkNumber: true, payeeName: true, apvNumbers: true, bills: { select: { apvNumber: true } } } } },
  })
  return parked
    .filter((ev) => portalApvs(ev.check).length === 0)
    .map((ev) => ({
      eventId: ev.id, checkId: ev.checkId, checkNumber: ev.check.checkNumber, payeeName: ev.check.payeeName,
      attempts: ev.attempts, lastError: ev.lastError,
    }))
}

/**
 * Close each row unsent — SYNCED with `UNMATCHABLE_ERROR`, the convention the
 * worker uses for `superseded by …` and `stale: …` — set the cheque's
 * `portalSyncStatus` to NOT_APPLICABLE, and write one audit row, in one
 * transaction per row. Conditional: a row no longer PARKED, or whose cheque has
 * gained an APV since it was listed, is left alone. Returns how many closed.
 */
export async function closeUnmatchableCancelled(db: PrismaClient, rows: readonly UnmatchableRow[], now: Date): Promise<number> {
  let closed = 0
  for (const r of rows) {
    const done = await db.$transaction(async (tx) => {
      const check = await tx.check.findUniqueOrThrow({
        where: { id: r.checkId }, select: { apvNumbers: true, bills: { select: { apvNumber: true } } },
      })
      if (portalApvs(check).length > 0) return false
      const updated = await tx.portalEvent.updateMany({
        where: { id: r.eventId, status: 'PARKED' },
        data: { status: 'SYNCED', lastError: UNMATCHABLE_ERROR },
      })
      if (!updated.count) return false
      await tx.check.update({ where: { id: r.checkId }, data: { portalSyncStatus: 'NOT_APPLICABLE' } })
      await writeAudit(tx, {
        checkId: r.checkId, actorType: 'SYSTEM', action: 'portal_event_closed_unmatchable',
        details: { eventId: r.eventId, kind: 'CANCELLED', attempts: r.attempts, lastError: r.lastError, closedAt: now.toISOString() },
        remarks: 'Closed unsent: the cheque carries no APV, so the portal cannot match a CANCELLED event for it.',
      })
      return true
    })
    if (done) closed += 1
  }
  return closed
}
```

- [ ] **Step 4: Count them on `/admin/portal`**

In `lib/admin/portal-overview.ts`, change the type:

```ts
export type PortalClosedCounts = { delivered: number; superseded: number; stale: number; unmatchable: number }
```

and replace the two `count` lines and `closed`:

```ts
  const superseded = await db.portalEvent.count({ where: { status: 'SYNCED', lastError: { startsWith: 'superseded by' } } })
  const stale = await db.portalEvent.count({ where: { status: 'SYNCED', lastError: { startsWith: 'stale:' } } })
  const unmatchable = await db.portalEvent.count({ where: { status: 'SYNCED', lastError: { startsWith: 'unmatchable:' } } })
  const closed = { delivered: counts.SYNCED - superseded - stale - unmatchable, superseded, stale, unmatchable }
```

Extend the doc comment above `PortalClosedCounts` with: `…or the cheque has no APV for the portal to match (\`unmatchable: …\`, closed by scripts/close-unmatchable-cancelled.ts).`

In `app/admin/portal/page.tsx` line 20, append after `{o.closed.stale} closed as stale`:

```tsx
 · {o.closed.unmatchable} closed as unmatchable
```

- [ ] **Step 5: Write the script**

```ts
// scripts/close-unmatchable-cancelled.ts
/**
 * Close PARKED CANCELLED portal events whose cheque has no APV — events the
 * portal can never match, queued before voidCheck/cancelCheck stopped queuing
 * them (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §A2).
 *
 *   npx.cmd tsx scripts/close-unmatchable-cancelled.ts           # dry run: lists them
 *   npx.cmd tsx scripts/close-unmatchable-cancelled.ts --apply   # snapshot, then close each
 *
 * Nothing is sent to the portal. Prints no amounts. DATABASE_URL is PRODUCTION.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { findUnmatchableCancelled, closeUnmatchableCancelled } from '../lib/admin/unmatchable-cancelled'

const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const db = new PrismaClient()
  try {
    const rows = await findUnmatchableCancelled(db)
    console.log(`\nPARKED CANCELLED events whose cheque has no APV: ${rows.length}`)
    console.table(rows.map((r) => ({ cheque: r.checkNumber, payee: r.payeeName ?? '', event: r.eventId, tries: r.attempts, lastError: r.lastError ?? '' })))
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (rows.length === 0) { console.log('\nNothing to close.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `close-unmatchable-cancelled-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    const cheques = await db.check.findMany({
      where: { id: { in: rows.map((r) => r.checkId) } },
      select: { id: true, checkNumber: true, portalSyncStatus: true, portalDomain: true },
    })
    await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), events: rows, cheques }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const closed = await closeUnmatchableCancelled(db, rows, now)
    console.log(`\nDONE  closed ${closed} of ${rows.length}`)
    console.log(`  still parked and unmatchable: ${(await findUnmatchableCancelled(db)).length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
```

**Do not run this script.** It reads production. The user runs it.

- [ ] **Step 6: Run the tests**

Run: `node node_modules/vitest/vitest.mjs run tests/admin/unmatchable-cancelled.test.ts tests/admin/portal-overview.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.

```bash
git add lib/admin/unmatchable-cancelled.ts scripts/close-unmatchable-cancelled.ts lib/admin/portal-overview.ts app/admin/portal/page.tsx tests/admin/unmatchable-cancelled.test.ts tests/admin/portal-overview.test.ts
git commit -m "feat(portal): close parked CANCELLED events the portal cannot match; count them on /admin/portal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part B — the numbering report

### Task 4: `buildSeries` (pure)

**Files:**
- Create: `lib/numbering/series.ts`
- Test: `tests/numbering/series.test.ts` (create)

**Interfaces:**
- Produces:

```ts
export type SeriesCheque = {
  id: string; checkNumber: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string; status: CheckStatus
}
export type SeriesEntry =
  | { kind: 'CHEQUE'; cheque: SeriesCheque; duplicate: boolean }
  | { kind: 'MISSING'; from: string; to: string; count: string }
export type SeriesSummary = {
  first: string | null; last: string | null; held: number; voided: number; cancelled: number
  missingNumbers: string; missingRuns: number; notNumeric: number; duplicates: number
}
export type AccountSeries = { entries: SeriesEntry[]; notNumeric: SeriesCheque[]; summary: SeriesSummary }
export function buildSeries(cheques: readonly SeriesCheque[]): AccountSeries
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/numbering/series.test.ts
import { describe, it, expect } from 'vitest'
import { buildSeries, type SeriesCheque, type SeriesEntry } from '@/lib/numbering/series'

let seq = 0
function c(checkNumber: string, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque {
  seq += 1
  return { id: `id${String(seq).padStart(4, '0')}`, checkNumber, checkDate: null, payeeName: null, amount: '1.00', currency: 'PHP', status }
}
const shape = (entries: SeriesEntry[]) =>
  entries.map((e) => (e.kind === 'CHEQUE' ? e.cheque.checkNumber : `MISSING ${e.from}-${e.to} (${e.count})`))

describe('buildSeries', () => {
  it('a consecutive run has no MISSING line', () => {
    const s = buildSeries([c('103'), c('101'), c('102')])
    expect(shape(s.entries)).toEqual(['101', '102', '103'])
    expect(s.summary).toMatchObject({ first: '101', last: '103', held: 3, missingNumbers: '0', missingRuns: 0 })
  })

  it('one missing number is one line', () => {
    expect(shape(buildSeries([c('101'), c('103')]).entries)).toEqual(['101', 'MISSING 102-102 (1)', '103'])
  })

  it('a large gap is one line with the exact count, never one row per number', () => {
    const s = buildSeries([c('1791259553'), c('6000354350')])
    expect(shape(s.entries)).toEqual(['1791259553', 'MISSING 1791259554-6000354349 (4209094796)', '6000354350'])
    expect(s.summary.missingNumbers).toBe('4209094796')
    expect(s.summary.missingRuns).toBe(1)
  })

  it('gaps either side of a single cheque are two lines', () => {
    expect(shape(buildSeries([c('1'), c('5'), c('9')]).entries))
      .toEqual(['1', 'MISSING 2-4 (3)', '5', 'MISSING 6-8 (3)', '9'])
  })

  it('orders numerically, not as text', () => {
    expect(shape(buildSeries([c('1000'), c('999')]).entries)).toEqual(['999', '1000'])
  })

  it('shows both cheques on a duplicate number, flagged, counted once as held', () => {
    const s = buildSeries([c('7'), c('7'), c('8')])
    expect(s.entries.filter((e) => e.kind === 'CHEQUE' && e.duplicate)).toHaveLength(2)
    expect(s.summary).toMatchObject({ held: 2, duplicates: 2, missingNumbers: '0' })
  })

  it('keeps non-numeric numbers out of the sequence and lists them', () => {
    const s = buildSeries([c('AP-DG001931'), c('5'), c('6')])
    expect(shape(s.entries)).toEqual(['5', '6'])
    expect(s.notNumeric.map((x) => x.checkNumber)).toEqual(['AP-DG001931'])
    expect(s.summary.notNumeric).toBe(1)
  })

  it('counts VOIDED and CANCELLED across every cheque in the account', () => {
    const s = buildSeries([c('1', 'VOIDED'), c('2', 'CANCELLED'), c('3'), c('X', 'VOIDED')])
    expect(s.summary).toMatchObject({ voided: 2, cancelled: 1 })
  })

  it('keeps a leading-zero width on the MISSING bounds', () => {
    expect(shape(buildSeries([c('0098'), c('0101')]).entries)).toEqual(['0098', 'MISSING 0099-0100 (2)', '0101'])
  })

  it('a single cheque, and an empty account', () => {
    expect(buildSeries([c('42')]).summary).toMatchObject({ first: '42', last: '42', held: 1, missingRuns: 0 })
    expect(buildSeries([])).toEqual({
      entries: [], notNumeric: [],
      summary: { first: null, last: null, held: 0, voided: 0, cancelled: 0, missingNumbers: '0', missingRuns: 0, notNumeric: 0, duplicates: 0 },
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/numbering/series.test.ts`
Expected: FAIL — cannot resolve `@/lib/numbering/series`.

- [ ] **Step 3: Implement**

```ts
// lib/numbering/series.ts
import type { CheckStatus } from '@prisma/client'

/**
 * One cash account's cheques in number order, with every unused number between
 * the lowest and the highest reported as MISSING — the user's rule, "every
 * number counts" (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §B2).
 *
 * Pure. Numbers are compared as BigInt (they run to ten digits; text order puts
 * 999 after 1000). A gap is one line, never one row per number: the jump between
 * two booklets on one account can be billions. Every number and count leaves
 * this function as a decimal string.
 */
export type SeriesCheque = {
  id: string; checkNumber: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string; status: CheckStatus
}
export type SeriesEntry =
  | { kind: 'CHEQUE'; cheque: SeriesCheque; duplicate: boolean }
  | { kind: 'MISSING'; from: string; to: string; count: string }
export type SeriesSummary = {
  first: string | null; last: string | null
  /** Distinct numbers held — a duplicate counts once. */
  held: number
  voided: number; cancelled: number
  missingNumbers: string; missingRuns: number
  notNumeric: number
  /** Cheques sharing a number with another cheque in the account. */
  duplicates: number
}
export type AccountSeries = { entries: SeriesEntry[]; notNumeric: SeriesCheque[]; summary: SeriesSummary }

const NUMERIC = /^\d+$/

export function buildSeries(cheques: readonly SeriesCheque[]): AccountSeries {
  const numeric: { n: bigint; text: string; cheque: SeriesCheque }[] = []
  const notNumeric: SeriesCheque[] = []
  for (const cheque of cheques) {
    const text = cheque.checkNumber.trim()
    if (NUMERIC.test(text)) numeric.push({ n: BigInt(text), text, cheque })
    else notNumeric.push(cheque)
  }
  numeric.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.cheque.id < b.cheque.id ? -1 : a.cheque.id > b.cheque.id ? 1 : 0))
  notNumeric.sort((a, b) => a.checkNumber.localeCompare(b.checkNumber))

  const perNumber = new Map<bigint, number>()
  for (const x of numeric) perNumber.set(x.n, (perNumber.get(x.n) ?? 0) + 1)
  const isDuplicate = (n: bigint) => (perNumber.get(n) ?? 0) > 1

  const entries: SeriesEntry[] = []
  let missing = 0n
  let runs = 0
  let prev: { n: bigint; text: string } | null = null
  for (const x of numeric) {
    if (prev && x.n > prev.n + 1n) {
      const from = prev.n + 1n
      const to = x.n - 1n
      const count = to - from + 1n
      // A leading-zero number keeps its width on the MISSING bounds.
      entries.push({
        kind: 'MISSING',
        from: from.toString().padStart(prev.text.length, '0'),
        to: to.toString().padStart(prev.text.length, '0'),
        count: count.toString(),
      })
      missing += count
      runs += 1
    }
    entries.push({ kind: 'CHEQUE', cheque: x.cheque, duplicate: isDuplicate(x.n) })
    prev = { n: x.n, text: x.text }
  }

  const every = [...numeric.map((x) => x.cheque), ...notNumeric]
  return {
    entries,
    notNumeric,
    summary: {
      first: numeric.length ? numeric[0].text : null,
      last: numeric.length ? numeric[numeric.length - 1].text : null,
      held: perNumber.size,
      voided: every.filter((x) => x.status === 'VOIDED').length,
      cancelled: every.filter((x) => x.status === 'CANCELLED').length,
      missingNumbers: missing.toString(),
      missingRuns: runs,
      notNumeric: notNumeric.length,
      duplicates: numeric.filter((x) => isDuplicate(x.n)).length,
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/numbering/series.test.ts`
Expected: PASS (10 tests). No database.

- [ ] **Step 5: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output. (If `tsconfig` targets below ES2020, BigInt literals `1n` fail; check `"target"` in `tsconfig.json` and, if needed, use `BigInt(1)` in their place.)

```bash
git add lib/numbering/series.ts tests/numbering/series.test.ts
git commit -m "feat(numbering): buildSeries - an account's cheques in number order with MISSING runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: the population query

**Files:**
- Create: `lib/numbering/query.ts`
- Test: `tests/numbering/query.test.ts` (create)

**Interfaces:**
- Consumes: `buildSeries`, `AccountSeries`, `SeriesCheque` (Task 4).
- Produces:

```ts
export type NumberingFilters = { companyId?: string; cashAccountId?: string }
export type NumberingAccount = { accountId: string; account: string; bank: string; company: string; series: AccountSeries }
export async function listNumberingAccounts(db: Db, f: NumberingFilters): Promise<NumberingAccount[]>
export async function countChequesWithoutAccount(db: Db, f: { companyId?: string }): Promise<number>
```

- [ ] **Step 1: Write the failing test**

`makeCheck` creates a new company, bank and cash account for every cheque, so cheques that share an account are moved onto the first one's.

```ts
// tests/numbering/query.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listNumberingAccounts, countChequesWithoutAccount } from '@/lib/numbering/query'

beforeEach(resetDb)

async function onAccountOf(first: { cashAccountId: string | null }, overrides: Parameters<typeof makeCheck>[0]) {
  const c = await makeCheck(overrides)
  return testDb.check.update({ where: { id: c.id }, data: { cashAccountId: first.cashAccountId } })
}

describe('listNumberingAccounts', () => {
  it('includes every status and cheques with no amount; excludes non-cheques', async () => {
    const first = await makeCheck({ checkNumber: '100', status: 'RELEASED' })
    await onAccountOf(first, { checkNumber: '101', status: 'VOIDED', amount: null })
    await onAccountOf(first, { checkNumber: '102', status: 'CANCELLED' })
    await onAccountOf(first, { checkNumber: '104', status: 'SIGNED', isCheque: false })
    const [acc, ...rest] = await listNumberingAccounts(testDb, {})
    expect(rest).toHaveLength(0)
    expect(acc.accountId).toBe(first.cashAccountId)
    expect(acc.series.summary).toMatchObject({ first: '100', last: '102', held: 3, voided: 1, cancelled: 1, missingRuns: 0 })
    const voided = acc.series.entries.find((e) => e.kind === 'CHEQUE' && e.cheque.checkNumber === '101')
    expect(voided?.kind === 'CHEQUE' && voided.cheque.amount).toBeNull()
  })

  it('one entry per cash account, sorted by account code, amounts as strings', async () => {
    const a = await makeCheck({ checkNumber: '1', amount: '197715.42' })
    const b = await makeCheck({ checkNumber: '2' })
    await testDb.cashAccount.update({ where: { id: a.cashAccountId! }, data: { code: 'ZZZ' } })
    await testDb.cashAccount.update({ where: { id: b.cashAccountId! }, data: { code: 'AAA' } })
    const out = await listNumberingAccounts(testDb, {})
    expect(out.map((x) => x.account)).toEqual(['AAA', 'ZZZ'])
    const e = out[1].series.entries[0]
    expect(e.kind === 'CHEQUE' && e.cheque.amount).toBe('197715.42')
  })

  it('narrows by the account\'s company, and by one account', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    const b = await makeCheck({ checkNumber: '2' })
    const accA = await testDb.cashAccount.findUniqueOrThrow({ where: { id: a.cashAccountId! } })
    expect((await listNumberingAccounts(testDb, { companyId: accA.companyId })).map((x) => x.accountId)).toEqual([a.cashAccountId])
    expect((await listNumberingAccounts(testDb, { cashAccountId: b.cashAccountId! })).map((x) => x.accountId)).toEqual([b.cashAccountId])
  })
})

describe('countChequesWithoutAccount', () => {
  it('counts cheques with no cash account, narrowed by the cheque\'s company', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    await testDb.check.update({ where: { id: a.id }, data: { cashAccountId: null } })
    await makeCheck({ checkNumber: '2' })
    expect(await countChequesWithoutAccount(testDb, {})).toBe(1)
    expect(await countChequesWithoutAccount(testDb, { companyId: a.companyId })).toBe(1)
    const other = await makeCheck({ checkNumber: '3' })
    expect(await countChequesWithoutAccount(testDb, { companyId: other.companyId })).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/numbering/query.test.ts`
Expected: FAIL — cannot resolve `@/lib/numbering/query`.

- [ ] **Step 3: Implement**

```ts
// lib/numbering/query.ts
import type { Prisma, PrismaClient } from '@prisma/client'
import { buildSeries, type AccountSeries, type SeriesCheque } from './series'

type Db = PrismaClient | Prisma.TransactionClient

export type NumberingFilters = { companyId?: string; cashAccountId?: string }
export type NumberingAccount = { accountId: string; account: string; bank: string; company: string; series: AccountSeries }

/**
 * Every cheque that holds a number in a cash account's series: `isCheque`, a
 * cash account, and EVERY status — VOIDED, CANCELLED and no-amount cheques
 * included, because the number was used whatever happened to it (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §B1). The cash account is
 * the series key: the sync publishes no cheque book. One query, grouped here;
 * ~12,000 rows.
 */
export async function listNumberingAccounts(db: Db, f: NumberingFilters): Promise<NumberingAccount[]> {
  const rows = await db.check.findMany({
    where: {
      isCheque: true,
      cashAccountId: f.cashAccountId ?? { not: null },
      ...(f.companyId ? { cashAccount: { companyId: f.companyId } } : {}),
    },
    select: {
      id: true, checkNumber: true, checkDate: true, payeeName: true, amount: true, currency: true, status: true,
      cashAccount: { select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } } },
    },
  })

  const byAccount = new Map<string, { account: string; bank: string; company: string; cheques: SeriesCheque[] }>()
  for (const r of rows) {
    if (!r.cashAccount) continue
    let group = byAccount.get(r.cashAccount.id)
    if (!group) {
      group = { account: r.cashAccount.code, bank: r.cashAccount.bank.code, company: r.cashAccount.company.code, cheques: [] }
      byAccount.set(r.cashAccount.id, group)
    }
    group.cheques.push({
      id: r.id, checkNumber: r.checkNumber, checkDate: r.checkDate, payeeName: r.payeeName,
      amount: r.amount?.toString() ?? null, currency: r.currency, status: r.status,
    })
  }

  return [...byAccount.entries()]
    .map(([accountId, g]) => ({ accountId, account: g.account, bank: g.bank, company: g.company, series: buildSeries(g.cheques) }))
    .sort((a, b) => a.account.localeCompare(b.account))
}

/** Cheques in no series because they carry no cash account — stated on the page, not listed. */
export async function countChequesWithoutAccount(db: Db, f: { companyId?: string }): Promise<number> {
  return db.check.count({ where: { isCheque: true, cashAccountId: null, ...(f.companyId ? { companyId: f.companyId } : {}) } })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/numbering/query.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.

```bash
git add lib/numbering/query.ts tests/numbering/query.test.ts
git commit -m "feat(numbering): the population - every status, grouped by cash account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: the view module (pure)

**Files:**
- Create: `lib/numbering-view.ts`
- Test: `tests/numbering-view.test.ts` (create)

**Interfaces:**
- Consumes: `SeriesEntry` (Task 4).
- Produces:

```ts
export const NUMBERING_PATH = '/numbering'
export const NUMBERING_EXPORT_PATH = '/api/export/numbering'
export type NumberingParams = { company?: string; account?: string; missing?: boolean }
export function numberingHref(p: NumberingParams, path?: string): string
export function isMissingOnly(value: string | null | undefined): boolean
export function visibleEntries(entries: readonly SeriesEntry[], missingOnly: boolean): SeriesEntry[]
export function describeNumberingFilters(f: { company?: string | null; account?: string | null; missingOnly?: boolean }): string
export function missingLabel(e: { from: string; to: string; count: string }): string
export function numberingFilename(day: string): string
export const NUMBERING_SCOPE_NOTE: string
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/numbering-view.test.ts
import { describe, it, expect } from 'vitest'
import {
  numberingHref, isMissingOnly, visibleEntries, describeNumberingFilters, missingLabel, numberingFilename,
  NUMBERING_EXPORT_PATH,
} from '@/lib/numbering-view'
import type { SeriesEntry } from '@/lib/numbering/series'

describe('numberingHref', () => {
  it('writes only what is set, in a fixed order', () => {
    expect(numberingHref({})).toBe('/numbering')
    expect(numberingHref({ company: 'c1', account: 'a1', missing: true })).toBe('/numbering?company=c1&account=a1&missing=1')
    expect(numberingHref({ account: ' ', missing: false })).toBe('/numbering')
    expect(numberingHref({ account: 'a1' }, NUMBERING_EXPORT_PATH)).toBe('/api/export/numbering?account=a1')
  })
})

describe('isMissingOnly', () => {
  it('is true only for exactly 1', () => {
    expect(isMissingOnly('1')).toBe(true)
    expect(isMissingOnly(' 1 ')).toBe(true)
    expect(isMissingOnly('true')).toBe(false)
    expect(isMissingOnly(undefined)).toBe(false)
    expect(isMissingOnly(null)).toBe(false)
  })
})

describe('visibleEntries', () => {
  const cheque: SeriesEntry = { kind: 'CHEQUE', duplicate: false, cheque: { id: 'x', checkNumber: '1', checkDate: null, payeeName: null, amount: null, currency: 'PHP', status: 'VOIDED' } }
  const gap: SeriesEntry = { kind: 'MISSING', from: '2', to: '3', count: '2' }
  it('keeps everything, or only the MISSING lines', () => {
    expect(visibleEntries([cheque, gap], false)).toEqual([cheque, gap])
    expect(visibleEntries([cheque, gap], true)).toEqual([gap])
  })
})

describe('labels', () => {
  it('describes the filters', () => {
    expect(describeNumberingFilters({})).toBe('No filters applied')
    expect(describeNumberingFilters({ company: 'STK', account: 'BPI STK', missingOnly: true })).toBe('COMPANY: STK  ·  ACCOUNT: BPI STK  ·  MISSING ONLY')
  })
  it('a missing run reads as a range, a single number as itself', () => {
    expect(missingLabel({ from: '6000354301', to: '6000354349', count: '49' })).toBe('6000354301 – 6000354349 · MISSING · 49')
    expect(missingLabel({ from: '102', to: '102', count: '1' })).toBe('102 · MISSING · 1')
  })
  it('names the file by the Manila day', () => {
    expect(numberingFilename('2026-10-01')).toBe('cheque-numbering-2026-10-01.xlsx')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/numbering-view.test.ts`
Expected: FAIL — cannot resolve `@/lib/numbering-view`.

- [ ] **Step 3: Implement**

```ts
// lib/numbering-view.ts
import { slugify } from './export/report'
import type { SeriesEntry } from './numbering/series'

/** The numbering screen's arithmetic — parameters, hrefs, labels, the filename. Pure. */
export const NUMBERING_PATH = '/numbering'
export const NUMBERING_EXPORT_PATH = '/api/export/numbering'

export type NumberingParams = { company?: string; account?: string; missing?: boolean }

export function numberingHref(p: NumberingParams, path: string = NUMBERING_PATH): string {
  const qs = new URLSearchParams()
  const company = p.company?.trim()
  const account = p.account?.trim()
  if (company) qs.set('company', company)
  if (account) qs.set('account', account)
  if (p.missing) qs.set('missing', '1')
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export function isMissingOnly(value: string | null | undefined): boolean {
  return (value ?? '').trim() === '1'
}

export function visibleEntries(entries: readonly SeriesEntry[], missingOnly: boolean): SeriesEntry[] {
  return missingOnly ? entries.filter((e) => e.kind === 'MISSING') : [...entries]
}

export function describeNumberingFilters(
  f: { company?: string | null; account?: string | null; missingOnly?: boolean },
): string {
  const parts: string[] = []
  if (f.company) parts.push(`COMPANY: ${f.company}`)
  if (f.account) parts.push(`ACCOUNT: ${f.account}`)
  if (f.missingOnly) parts.push('MISSING ONLY')
  return parts.length ? parts.join('  ·  ') : 'No filters applied'
}

export function missingLabel(e: { from: string; to: string; count: string }): string {
  const range = e.from === e.to ? e.from : `${e.from} – ${e.to}`
  return `${range} · MISSING · ${e.count}`
}

export function numberingFilename(day: string): string {
  return `${slugify('cheque numbering')}-${day}.xlsx`
}

/** Printed on the page and in the file (spec §B2): what MISSING cannot tell you. */
export const NUMBERING_SCOPE_NOTE =
  'MISSING means no cheque in this system holds the number. The Acumatica sync reads payments dated 2026 ' +
  'onward, so an account\'s first number may sit partway through a booklet and earlier numbers are not known ' +
  'here. A cheque Acumatica holds with a memo in place of its number is on the staged queue, not here — its ' +
  'number may be one of the MISSING.'
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/numbering-view.test.ts`
Expected: PASS. No database.

- [ ] **Step 5: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.

```bash
git add lib/numbering-view.ts tests/numbering-view.test.ts
git commit -m "feat(numbering): view module - hrefs, missing-only toggle, labels, filename

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: the workbook

**Files:**
- Create: `lib/export/numbering-workbook.ts`
- Test: `tests/export/numbering-workbook.test.ts` (create)

**Interfaces:**
- Consumes: `NumberingAccount` (Task 5), `visibleEntries`, `missingLabel`, `NUMBERING_SCOPE_NOTE` (Task 6).
- Produces:

```ts
export const NUMBERING_SUMMARY_SHEET = 'SUMMARY'
export const NUMBERING_ACCOUNT_HEADERS: readonly string[]
export type NumberingMeta = { generatedAt: Date; generatedBy: string; filterDescription: string; missingOnly: boolean; noAccountCount: number; rowLimit: number }
export function sheetNameFor(code: string, used: Set<string>): string
export async function buildNumberingWorkbook(args: { accounts: readonly NumberingAccount[]; meta: NumberingMeta }): Promise<ArrayBuffer>
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/export/numbering-workbook.test.ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildNumberingWorkbook, sheetNameFor, NUMBERING_SUMMARY_SHEET, NUMBERING_ACCOUNT_HEADERS } from '@/lib/export/numbering-workbook'
import { buildSeries, type SeriesCheque } from '@/lib/numbering/series'
import type { NumberingAccount } from '@/lib/numbering/query'

const ch = (n: string, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque =>
  ({ id: `id-${n}`, checkNumber: n, checkDate: new Date('2026-09-01T00:00:00Z'), payeeName: 'HENKEL', amount: '197715.42', currency: 'PHP', status })
const account = (code: string, cheques: SeriesCheque[]): NumberingAccount =>
  ({ accountId: `acc-${code}`, account: code, bank: 'BPI', company: 'STK', series: buildSeries(cheques) })
const META = { generatedAt: new Date('2026-10-01T02:00:00Z'), generatedBy: 'Paolo Parcon', filterDescription: 'No filters applied', missingOnly: false, noAccountCount: 3, rowLimit: 50_000 }

async function load(buf: ArrayBuffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  return wb
}

describe('sheetNameFor', () => {
  it('strips the characters Excel refuses, caps at 31, and de-duplicates case-insensitively', () => {
    const used = new Set(['SUMMARY'])
    expect(sheetNameFor('BPI/STK [1]', used)).toBe('BPI STK  1')
    expect(sheetNameFor('summary', used)).toBe('summary (2)')
    const long = 'X'.repeat(40)
    expect(sheetNameFor(long, used)).toHaveLength(31)
    expect(sheetNameFor(long, used)).toBe(`${'X'.repeat(27)} (2)`)
  })
})

describe('buildNumberingWorkbook', () => {
  it('writes SUMMARY and one sheet per account, MISSING lines in their own columns, numbers as text', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101'), ch('104', 'VOIDED')]), account('MBTC A1', [ch('7')])],
      meta: META,
    }))
    expect(wb.worksheets.map((w) => w.name)).toEqual([NUMBERING_SUMMARY_SHEET, 'BPI STK', 'MBTC A1'])

    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(1).values).toEqual([undefined, ...NUMBERING_ACCOUNT_HEADERS])
    expect(ws.getRow(2).getCell(1).value).toBe('101')
    expect(ws.getRow(3).getCell(4).value).toBe('MISSING')
    expect(ws.getRow(3).getCell(7).value).toBe('102')
    expect(ws.getRow(3).getCell(8).value).toBe('103')
    expect(ws.getRow(3).getCell(9).value).toBe(2)
    expect(ws.getRow(4).getCell(4).value).toBe('VOIDED')

    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const text = summary.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).toContain('BPI STK')
    expect(text).toContain('3 cheques with no cash account')
  })

  it('missing-only keeps just the MISSING lines', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101'), ch('104')])],
      meta: { ...META, missingOnly: true },
    }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.rowCount).toBe(2)
    expect(ws.getRow(2).getCell(4).value).toBe('MISSING')
  })

  it('lists non-numeric cheques after the sequence', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('5'), ch('MEMO')])], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(3).getCell(1).value).toBe('MEMO')
    expect(ws.getRow(3).getCell(10).value).toBe('NOT NUMERIC')
  })

  it('stops at the row limit and says so on SUMMARY', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('A', [ch('1'), ch('2'), ch('3')]), account('B', [ch('9')])],
      meta: { ...META, rowLimit: 2 },
    }))
    expect(wb.getWorksheet('A')!.rowCount).toBe(3)
    expect(wb.getWorksheet('B')).toBeUndefined()
    const text = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).toContain('first 2 of 4 lines')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/export/numbering-workbook.test.ts`
Expected: FAIL — cannot resolve `@/lib/export/numbering-workbook`.

- [ ] **Step 3: Implement**

```ts
// lib/export/numbering-workbook.ts
import ExcelJS from 'exceljs'
import { currencyNumberFormat } from './report'
import { BAND_FILL, COUNT_FORMAT, DATE_FORMAT, styleHeaderCell } from './sheet-style'
import type { NumberingAccount } from '@/lib/numbering/query'
import type { SeriesCheque } from '@/lib/numbering/series'
import { visibleEntries, NUMBERING_SCOPE_NOTE } from '@/lib/numbering-view'

/**
 * The numbering report as a workbook: SUMMARY, then one sheet per account with
 * every cheque in number order and each MISSING run as one row whose FROM, TO
 * and COUNT have their own columns — so a filter on STATUS = MISSING works
 * (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §B4). Cheque
 * numbers are text cells. Amounts are Excel numbers in the cells, the one
 * sanctioned use of a JS number for money, as in `recon-workbook.ts`.
 */
export const NUMBERING_SUMMARY_SHEET = 'SUMMARY'
export const NUMBERING_ACCOUNT_HEADERS = [
  'CHECK NUMBER', 'CHEQUE DATE', 'PAYEE', 'STATUS', 'CURRENCY', 'AMOUNT', 'FROM', 'TO', 'COUNT', 'NOTE',
] as const
const SUMMARY_HEADERS = ['ACCOUNT', 'BANK', 'COMPANY', 'FIRST', 'LAST', 'HELD', 'VOIDED', 'CANCELLED', 'MISSING NUMBERS', 'MISSING RUNS', 'NOT NUMERIC'] as const

export type NumberingMeta = {
  generatedAt: Date; generatedBy: string; filterDescription: string
  missingOnly: boolean; noAccountCount: number
  /** `caps.exportRows`: cheque and MISSING lines across all account sheets. */
  rowLimit: number
}

const TITLE_INK = 'FF0F172A'
const MUTED_INK = 'FF475569'
const fmt = (n: number) => n.toLocaleString('en-PH')
/** A count as a cell: a number while exact, else its decimal string. */
const countCell = (s: string): number | string => (s.length <= 15 ? Number(s) : s)

/** Excel: ≤31 chars, none of []:*?/\, unique case-insensitively within the book. */
export function sheetNameFor(code: string, used: Set<string>): string {
  const base = (code.replace(/[[\]:*?/\\]/g, ' ').trim() || 'ACCOUNT').slice(0, 31)
  let name = base
  let i = 2
  while (used.has(name.toUpperCase())) {
    const suffix = ` (${i++})`
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`
  }
  used.add(name.toUpperCase())
  return name
}

function generatedLine(meta: NumberingMeta): string {
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })
  return `Generated ${stamp} by ${meta.generatedBy}`
}

export async function buildNumberingWorkbook(
  { accounts, meta }: { accounts: readonly NumberingAccount[]; meta: NumberingMeta },
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt

  const lines = accounts.map((a) => ({ a, entries: visibleEntries(a.series.entries, meta.missingOnly) }))
  const totalLines = lines.reduce((n, l) => n + l.entries.length + (meta.missingOnly ? 0 : l.a.series.notNumeric.length), 0)

  const ws = wb.addWorksheet(NUMBERING_SUMMARY_SHEET)
  ws.getCell('A1').value = 'CHEQUE NUMBERING — CHECK RELEASE MONITORING'
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE_INK } }
  ws.getCell('A2').value = meta.filterDescription
  ws.getCell('A2').font = { bold: true, size: 12, color: { argb: TITLE_INK } }
  ws.getCell('A3').value = totalLines > meta.rowLimit
    ? `${generatedLine(meta)}  ·  account sheets hold the first ${fmt(meta.rowLimit)} of ${fmt(totalLines)} lines`
    : `${generatedLine(meta)}  ·  ${fmt(accounts.length)} account${accounts.length === 1 ? '' : 's'}`
  ws.getCell('A3').font = { size: 10, color: { argb: MUTED_INK } }
  ws.getCell('A4').value = `${NUMBERING_SCOPE_NOTE} Not in any series: ${fmt(meta.noAccountCount)} cheque${meta.noAccountCount === 1 ? '' : 's'} with no cash account.`
  ws.getCell('A4').font = { size: 10, color: { argb: MUTED_INK } }

  const header = ws.getRow(6)
  SUMMARY_HEADERS.forEach((label, i) => styleHeaderCell(header.getCell(i + 1), label, i >= 5 ? 'right' : 'left'))
  accounts.forEach((a, i) => {
    const s = a.series.summary
    const row = ws.getRow(7 + i)
    const values: (string | number | null)[] = [
      a.account, a.bank, a.company, s.first, s.last, s.held, s.voided, s.cancelled,
      countCell(s.missingNumbers), s.missingRuns, s.notNumeric,
    ]
    values.forEach((v, col) => {
      row.getCell(col + 1).value = v
      if (col >= 5) row.getCell(col + 1).numFmt = COUNT_FORMAT
    })
    if (i % 2 === 1) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
  })
  ;[22, 10, 10, 14, 14, 10, 10, 12, 18, 14, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w })

  const used = new Set([NUMBERING_SUMMARY_SHEET.toUpperCase()])
  let budget = meta.rowLimit
  for (const { a, entries } of lines) {
    if (budget <= 0) break
    const sheet = wb.addWorksheet(sheetNameFor(a.account, used), { views: [{ state: 'frozen', ySplit: 1 }] })
    const h = sheet.getRow(1)
    NUMBERING_ACCOUNT_HEADERS.forEach((label, i) => styleHeaderCell(h.getCell(i + 1), label, label === 'AMOUNT' || label === 'COUNT' ? 'right' : 'left'))
    let r = 2
    const chequeRow = (c: SeriesCheque, note: string | null) => {
      const row = sheet.getRow(r++)
      row.getCell(1).value = c.checkNumber
      row.getCell(2).value = c.checkDate
      if (c.checkDate) row.getCell(2).numFmt = DATE_FORMAT
      row.getCell(3).value = c.payeeName
      row.getCell(4).value = c.status
      row.getCell(5).value = c.currency
      row.getCell(6).value = c.amount === null ? null : Number(c.amount)
      row.getCell(6).numFmt = currencyNumberFormat(c.currency)
      row.getCell(10).value = note
    }
    const rows = [...entries.map((e) => ({ e })), ...(meta.missingOnly ? [] : a.series.notNumeric.map((c) => ({ c })))]
    for (const item of rows.slice(0, budget)) {
      if ('c' in item) { chequeRow(item.c, 'NOT NUMERIC'); continue }
      const e = item.e
      if (e.kind === 'CHEQUE') { chequeRow(e.cheque, e.duplicate ? 'DUPLICATE NUMBER' : null); continue }
      const row = sheet.getRow(r++)
      row.getCell(1).value = e.from === e.to ? e.from : `${e.from} – ${e.to}`
      row.getCell(4).value = 'MISSING'
      row.getCell(7).value = e.from
      row.getCell(8).value = e.to
      row.getCell(9).value = countCell(e.count)
      row.getCell(9).numFmt = COUNT_FORMAT
      row.font = { bold: true }
      row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } } })
    }
    budget -= Math.min(rows.length, budget)
    ;[22, 14, 36, 18, 10, 18, 14, 14, 12, 18].forEach((w, i) => { sheet.getColumn(i + 1).width = w })
  }

  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>
}
```

Notes for the implementer:
- `ExcelJS` reads a `null` cell back as `undefined`/absent; the tests only read cells that hold values.
- `row.eachCell({ includeEmpty: true })` on the MISSING row fills only cells up to the last one written (column 9). That is intended.
- Check how `recon-workbook.ts` ends (`wb.xlsx.writeBuffer()` and its cast) and match it exactly if it differs from the line above.

- [ ] **Step 4: Run it to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/export/numbering-workbook.test.ts`
Expected: PASS (5 tests). No database. If the `getRow(1).values` assertion fails only because ExcelJS returns a sparse array, compare `NUMBERING_ACCOUNT_HEADERS.map((_, i) => ws.getRow(1).getCell(i + 1).value)` against `[...NUMBERING_ACCOUNT_HEADERS]` instead.

- [ ] **Step 5: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.

```bash
git add lib/export/numbering-workbook.ts tests/export/numbering-workbook.test.ts
git commit -m "feat(numbering): workbook - SUMMARY and one sheet per account, MISSING rows filterable

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: the export route

**Files:**
- Create: `app/api/export/numbering/route.ts`
- Test: `tests/export/numbering-route.test.ts` (create)

**Interfaces:**
- Consumes: `listNumberingAccounts`, `countChequesWithoutAccount` (Task 5); `isMissingOnly`, `describeNumberingFilters`, `numberingFilename` (Task 6); `buildNumberingWorkbook` (Task 7); `getFilterOptions` (`lib/queries.ts`), `loadSettings` (`lib/settings/read.ts`, key `caps.exportRows`), `manilaDay` (`lib/forecast/buckets.ts`), `getSessionUser` (`lib/auth`).
- Produces: `GET /api/export/numbering?company=&account=&missing=1`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/export/numbering-route.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { NUMBERING_SUMMARY_SHEET } from '@/lib/export/numbering-workbook'

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => state.user }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: new Proxy(testDb, { get(t, p, r) { state.dbTouches += 1; return Reflect.get(t, p, r) } }) }
})

const SIGNED_IN = { id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER' }
async function get(url: string) {
  const { GET } = await import('@/app/api/export/numbering/route')
  return GET(new Request(url))
}

beforeEach(async () => {
  await resetDb()
  state.user = SIGNED_IN
  state.dbTouches = 0
})

describe('GET /api/export/numbering', () => {
  it('refuses an unauthenticated request with 401 and touches nothing', async () => {
    state.user = null
    const res = await get('http://localhost/api/export/numbering')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('serves an uncached file named cheque-numbering-<day>.xlsx', async () => {
    await makeCheck({ checkNumber: '1' })
    const res = await get('http://localhost/api/export/numbering')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/cheque-numbering-\d{4}-\d{2}-\d{2}\.xlsx/)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('honours account: the file holds that account only', async () => {
    const a = await makeCheck({ checkNumber: '1' })
    await makeCheck({ checkNumber: '2' })
    const res = await get(`http://localhost/api/export/numbering?account=${a.cashAccountId}`)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    expect(wb.worksheets.map((w) => w.name)).toHaveLength(2)
    expect(wb.worksheets[0].name).toBe(NUMBERING_SUMMARY_SHEET)
  })

  it('refuses an unknown account with 404 rather than widening to every account', async () => {
    await makeCheck({ checkNumber: '1' })
    const res = await get('http://localhost/api/export/numbering?account=nope')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/export/numbering-route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/export/numbering/route`.

- [ ] **Step 3: Implement**

```ts
// app/api/export/numbering/route.ts
import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { manilaDay } from '@/lib/forecast/buckets'
import { listNumberingAccounts, countChequesWithoutAccount } from '@/lib/numbering/query'
import { isMissingOnly, describeNumberingFilters, numberingFilename } from '@/lib/numbering-view'
import { buildNumberingWorkbook } from '@/lib/export/numbering-workbook'
import { loadSettings } from '@/lib/settings/read'

/**
 * EXPORT THE CHEQUE NUMBERING. The file is the view: company, account and
 * MISSING ONLY are in the title block. Authenticates on its first line — 401,
 * not a redirect — as every export route does; never on the public list. An
 * account id that names no account is a 404, never a widened file.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) return new Response('UNAUTHORISED', { status: 401, headers: TEXT })

  const params = new URL(request.url).searchParams
  const now = new Date()
  const [options, settings] = await Promise.all([getFilterOptions(prisma), loadSettings(prisma)])
  const company = options.companies.find((c) => c.id === (params.get('company')?.trim() || undefined))
  const accountParam = params.get('account')?.trim() || undefined
  const account = options.cashAccounts.find((a) => a.id === accountParam)
  if (accountParam && !account) return new Response('UNKNOWN ACCOUNT', { status: 404, headers: TEXT })
  const missingOnly = isMissingOnly(params.get('missing'))

  const [accounts, noAccountCount] = await Promise.all([
    listNumberingAccounts(prisma, { companyId: account ? undefined : company?.id, cashAccountId: account?.id }),
    countChequesWithoutAccount(prisma, { companyId: company?.id }),
  ])

  const workbook = await buildNumberingWorkbook({
    accounts,
    meta: {
      generatedAt: now, generatedBy: user.name, missingOnly, noAccountCount,
      filterDescription: describeNumberingFilters({ company: company?.code, account: account?.code, missingOnly }),
      rowLimit: settings.values['caps.exportRows'],
    },
  })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${numberingFilename(manilaDay(now))}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/export/numbering-route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Confirm the route is NOT public**

Run: `node node_modules/vitest/vitest.mjs run tests/public-paths.test.ts`
Expected: PASS, and `lib/public-paths.ts` unchanged — `/api/export/numbering` must stay behind the middleware and its own session check.

- [ ] **Step 6: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.

```bash
git add app/api/export/numbering/route.ts tests/export/numbering-route.test.ts
git commit -m "feat(numbering): /api/export/numbering - session-guarded, 404 on an unknown account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: the page, its tables, and the NUMBERING module

**Files:**
- Create: `components/NumberingTables.tsx`, `app/numbering/page.tsx`
- Modify: `lib/module-nav.ts`
- Test: `tests/module-nav.test.ts` (modify)

**Interfaces:**
- Consumes: Tasks 5 and 6; `requireUser` (`lib/auth`), `getFilterOptions`, `AppHeader`, `EmptyState`, `StatusPill`, `formatMoney` (`lib/money`).
- Produces: `/numbering`; `ModuleId` gains `'NUMBERING'`.

- [ ] **Step 1: Write the failing module-nav test**

In `tests/module-nav.test.ts` replace the `MODULES` test body with:

```ts
  it('lists the seven in bar order, ADMINISTRATION last and admin-only', () => {
    expect(MODULES.map((m) => m.id)).toEqual(['CHECK_RELEASE', 'VOUCHERS', 'FORECAST', 'CLEARING', 'RECON', 'NUMBERING', 'ADMINISTRATION'])
    expect(MODULES.map((m) => m.adminOnly)).toEqual([false, false, false, false, false, false, true])
    expect(MODULES.find((m) => m.id === 'ADMINISTRATION')!.href).toBe('/admin/sync')
    expect(MODULES.find((m) => m.id === 'CHECK_RELEASE')!.label).toBe('CHECK RELEASE')
    expect(MODULES.find((m) => m.id === 'NUMBERING')!.href).toBe('/numbering')
  })
```

add to `'lights each module on its own path and on a sub-path'`:

```ts
    expect(activeModule('/numbering')).toBe('NUMBERING')
```

add to `'matches whole segments only'`:

```ts
    expect(activeModule('/numberings')).toBe('CHECK_RELEASE')
```

and change `expect(modulesFor('FINANCE_USER')).toHaveLength(5)` to `toHaveLength(6)`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/module-nav.test.ts`
Expected: FAIL — NUMBERING not in `MODULES`.

- [ ] **Step 3: Add the module**

In `lib/module-nav.ts`:

```ts
export type ModuleId = 'CHECK_RELEASE' | 'VOUCHERS' | 'FORECAST' | 'CLEARING' | 'RECON' | 'NUMBERING' | 'ADMINISTRATION'
```

and insert after the RECON entry:

```ts
  { id: 'NUMBERING', label: 'NUMBERING', href: '/numbering', prefixes: ['/numbering'], adminOnly: false },
```

Update the doc comment's "Six peers" to "Seven peers" and add: `NUMBERING (2026-10-01) checks cheque consecutives per cash account.`

Run: `grep -rn "ModuleId" app components lib --include=*.ts --include=*.tsx` — if any file switches on `ModuleId` exhaustively, add the NUMBERING case there.

Run: `node node_modules/vitest/vitest.mjs run tests/module-nav.test.ts` — expected: PASS.

- [ ] **Step 4: Write the tables component**

```tsx
// components/NumberingTables.tsx
import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { StatusPill } from '@/components/StatusPill'
import { missingLabel, numberingHref } from '@/lib/numbering-view'
import type { NumberingAccount } from '@/lib/numbering/query'
import type { SeriesCheque, SeriesEntry } from '@/lib/numbering/series'

const fmtDay = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const fmtCount = (s: string) => (s.length <= 15 ? Number(s).toLocaleString('en-PH') : s)
const th = 'px-4 py-3'

/** One row per cash account. The account links to its own series. */
export function NumberingSummaryTable({ accounts, company }: { accounts: readonly NumberingAccount[]; company?: string }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className={th}>ACCOUNT</th><th className={th}>BANK</th><th className={th}>COMPANY</th>
            <th className={th}>FIRST</th><th className={th}>LAST</th>
            <th className={`${th} text-right`}>HELD</th><th className={`${th} text-right`}>VOIDED</th>
            <th className={`${th} text-right`}>CANCELLED</th><th className={`${th} text-right`}>MISSING</th>
            <th className={`${th} text-right`}>NOT NUMERIC</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => {
            const s = a.series.summary
            return (
              <tr key={a.accountId} className="border-b border-slate-100 odd:bg-white even:bg-ground">
                <td className={th}><Link prefetch={false} href={numberingHref({ company, account: a.accountId })} className="underline underline-offset-2">{a.account}</Link></td>
                <td className={th}>{a.bank}</td>
                <td className={th}>{a.company}</td>
                <td className={`${th} tabular-nums`}>{s.first ?? '—'}</td>
                <td className={`${th} tabular-nums`}>{s.last ?? '—'}</td>
                <td className={`${th} text-right tabular-nums`}>{s.held.toLocaleString('en-PH')}</td>
                <td className={`${th} text-right tabular-nums`}>{s.voided.toLocaleString('en-PH')}</td>
                <td className={`${th} text-right tabular-nums`}>{s.cancelled.toLocaleString('en-PH')}</td>
                <td className={`${th} text-right tabular-nums ${s.missingRuns ? 'font-semibold text-amber-700' : ''}`}>
                  {fmtCount(s.missingNumbers)}{s.missingRuns ? ` (${s.missingRuns.toLocaleString('en-PH')})` : ''}
                </td>
                <td className={`${th} text-right tabular-nums`}>{s.notNumeric.toLocaleString('en-PH')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

function ChequeRow({ c, note }: { c: SeriesCheque; note?: string }) {
  return (
    <tr className="border-b border-slate-100 odd:bg-white even:bg-ground">
      <td className={`${th} tabular-nums`}><Link prefetch={false} href={`/checks/${c.id}`} className="underline underline-offset-2">{c.checkNumber}</Link></td>
      <td className={th}>{fmtDay(c.checkDate)}</td>
      <td className={th}>{c.payeeName ?? '—'}</td>
      <td className={`${th} text-right tabular-nums`}>{c.amount === null ? '—' : formatMoney(c.amount, c.currency)}</td>
      <td className={th}><StatusPill status={c.status} />{note && <span className="ml-2 text-xs font-semibold text-amber-700">{note}</span>}</td>
    </tr>
  )
}

/** One account's series in number order, each MISSING run as one highlighted line. */
export function NumberingEntriesTable({ entries }: { entries: readonly SeriesEntry[] }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr><th className={th}>CHECK NUMBER</th><th className={th}>CHEQUE DATE</th><th className={th}>PAYEE</th><th className={`${th} text-right`}>AMOUNT</th><th className={th}>STATUS</th></tr>
        </thead>
        <tbody>
          {entries.map((e) => e.kind === 'MISSING'
            ? (
              <tr key={`m-${e.from}`} className="border-b border-amber-200 bg-amber-50">
                <td colSpan={5} className={`${th} font-semibold tabular-nums text-amber-800`}>{missingLabel(e)}</td>
              </tr>
            )
            : <ChequeRow key={e.cheque.id} c={e.cheque} note={e.duplicate ? 'DUPLICATE NUMBER' : undefined} />)}
        </tbody>
      </table>
    </section>
  )
}

/** Cheques whose number cannot be placed in the sequence. */
export function NotNumericTable({ cheques }: { cheques: readonly SeriesCheque[] }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <tbody>{cheques.map((c) => <ChequeRow key={c.id} c={c} />)}</tbody>
      </table>
    </section>
  )
}
```

If `formatMoney` already renders `null` as `—`, drop the `c.amount === null` branch and pass it straight through (read `lib/money.ts:28`). If the `bg-ground`, `ring-hairline` or `text-amber-*` classes are not in the Tailwind config, use what `OutstandingList.tsx` and `ReconTable.tsx` use.

- [ ] **Step 5: Write the page**

```tsx
// app/numbering/page.tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { listNumberingAccounts, countChequesWithoutAccount } from '@/lib/numbering/query'
import {
  NUMBERING_PATH, NUMBERING_EXPORT_PATH, NUMBERING_SCOPE_NOTE,
  numberingHref, isMissingOnly, visibleEntries, describeNumberingFilters,
} from '@/lib/numbering-view'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { NumberingSummaryTable, NumberingEntriesTable, NotNumericTable } from '@/components/NumberingTables'

/**
 * CHEQUE NUMBERING — consecutives per cash account (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §B3). Every cheque of
 * every status, in number order, with each unused number between the first and
 * last as one MISSING line. Everything shown is decided in `lib/numbering/`;
 * the export reads the same parameters, so the file and the screen agree.
 */
export default async function NumberingPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; account?: string; missing?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const options = await getFilterOptions(prisma)
  const company = options.companies.find((c) => c.id === params.company?.trim())
  const accountParam = params.account?.trim() || undefined
  const account = options.cashAccounts.find((a) => a.id === accountParam)
  const missingOnly = isMissingOnly(params.missing)
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  if (accountParam && !account) {
    return (
      <main className="mx-auto max-w-[1600px] space-y-6 p-8">
        <AppHeader user={user} title="CHEQUE NUMBERING" back={{ href: NUMBERING_PATH, label: '← ALL ACCOUNTS' }} />
        <EmptyState title="NO SUCH CASH ACCOUNT">That account is not on record. Choose one from the list.</EmptyState>
      </main>
    )
  }

  const [accounts, noAccountCount] = await Promise.all([
    listNumberingAccounts(prisma, { companyId: account ? undefined : company?.id, cashAccountId: account?.id }),
    countChequesWithoutAccount(prisma, { companyId: company?.id }),
  ])
  const current = { company: company?.id, account: account?.id, missing: missingOnly }
  const one = account ? accounts[0] : undefined

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <AppHeader user={user} title="CHEQUE NUMBERING" back={{ href: '/', label: '← DASHBOARD' }} />

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        {NUMBERING_SCOPE_NOTE}
      </p>

      {!account && (
        <form className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline" method="get">
          <label className="sr-only" htmlFor="numbering-company">COMPANY</label>
          <select id="numbering-company" name="company" defaultValue={company?.id ?? ''} className={field}>
            <option value="">ANY COMPANY</option>
            {options.companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </select>
          <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">APPLY</button>
          {company && <Link href={NUMBERING_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>}
        </form>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            {account ? account.code : `${accounts.length.toLocaleString('en-PH')} CASH ACCOUNT${accounts.length === 1 ? '' : 'S'}`}
            {' · '}{describeNumberingFilters({ company: company?.code, account: account?.code, missingOnly })}
          </p>
          {!account && noAccountCount > 0 && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              NOT IN ANY SERIES: {noAccountCount.toLocaleString('en-PH')} CHEQUE{noAccountCount === 1 ? '' : 'S'} WITH NO CASH ACCOUNT.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {account && (
            <>
              <Link href={numberingHref({ company: company?.id })} className="text-sm text-slate-600 underline underline-offset-2">← ALL ACCOUNTS</Link>
              <Link href={numberingHref({ ...current, missing: !missingOnly })} className="rounded-lg px-3 py-2 text-sm font-medium tracking-wide text-navy ring-1 ring-hairline">
                {missingOnly ? 'SHOW ALL' : 'MISSING ONLY'}
              </Link>
            </>
          )}
          <a href={numberingHref(current, NUMBERING_EXPORT_PATH)} className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">EXPORT EXCEL</a>
        </div>
      </div>

      {!account && (accounts.length === 0
        ? <EmptyState title="NO CHEQUES IN ANY CASH ACCOUNT">{company ? 'No cash account of this company holds a cheque.' : 'No cheque carries a cash account yet.'}</EmptyState>
        : <NumberingSummaryTable accounts={accounts} company={company?.id} />)}

      {account && !one && <EmptyState title="NO CHEQUES ON THIS ACCOUNT">No cheque on record carries this cash account.</EmptyState>}

      {one && (() => {
        const entries = visibleEntries(one.series.entries, missingOnly)
        return (
          <>
            {entries.length === 0
              ? <EmptyState title="NOTHING MISSING" tone="good">Every number from {one.series.summary.first ?? '—'} to {one.series.summary.last ?? '—'} is held here.</EmptyState>
              : <NumberingEntriesTable entries={entries} />}
            {!missingOnly && one.series.notNumeric.length > 0 && (
              <>
                <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">NOT NUMERIC — NOT IN THE SEQUENCE</h2>
                <NotNumericTable cheques={one.series.notNumeric} />
              </>
            )}
          </>
        )
      })()}
    </main>
  )
}
```

Check `AppHeader`'s props (`components/AppHeader.tsx`) and `EmptyState`'s `tone` values (`components/EmptyState.tsx`) and adjust if they differ from how `app/recon/page.tsx` uses them — that page is the reference.

- [ ] **Step 6: Type-check, build, and look at it**

Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.
Run: `node node_modules/next/dist/bin/next build` — expected: compiles; `/numbering` and `/api/export/numbering` listed as dynamic routes.

**Do not start the dev server against the local `.env`: it is production.** Ask the user whether to preview it (they may point `DATABASE_URL` at the test database for the session) — and if they agree, use `preview_start`, open `/numbering`, open one account, toggle MISSING ONLY, and screenshot each.

- [ ] **Step 7: Commit**

```bash
git add lib/module-nav.ts tests/module-nav.test.ts components/NumberingTables.tsx app/numbering/page.tsx
git commit -m "feat(numbering): /numbering - per-account consecutives with MISSING runs; NUMBERING module

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: record it

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run every test file this plan touched, together**

Confirm no other session is using the test database, then:

```bash
node node_modules/vitest/vitest.mjs run tests/integrations/portal-apvs.test.ts tests/integrations/portal-client.test.ts tests/actions/portal-cancel.test.ts tests/actions/actions.test.ts tests/import/upsert.test.ts tests/sync/run.test.ts tests/admin/unmatchable-cancelled.test.ts tests/admin/portal-overview.test.ts tests/numbering tests/numbering-view.test.ts tests/export/numbering-workbook.test.ts tests/export/numbering-route.test.ts tests/module-nav.test.ts tests/public-paths.test.ts
```

Expected: all pass. Record the pass count from the output.

- [ ] **Step 2: Update CLAUDE.md**

Add to the commands block, after the `void-acumatica-voided.ts` line:

```
npx tsx scripts/close-unmatchable-cancelled.ts [--apply]         # parked CANCELLED events whose cheque has no APV: close unsent
```

Add to **Things that will catch you out**, as its own paragraph:

```
**A void or cancel of a cheque with no APV queues nothing for the portal** (2026-10-01, spec
`2026-10-01-cheque-numbering-and-cancel-guard-design.md`). The portal matches on APV and the client
refuses an event with none, so such an event parked on its first attempt and RETRY parked it again —
which is how `6000354350` and `1791259553` reached `/admin/portal`. `voidCheck` / `cancelCheck` now
ask `portalApvs` (`lib/integrations/portal/apvs.ts`, the same rule the client uses) first; a routed
cheque with none gets `portalSyncStatus = NOT_APPLICABLE` and `portalNotified: false` on its audit
row. Only CANCELLED is guarded. `scripts/close-unmatchable-cancelled.ts` closes the ones already
parked (`unmatchable: no APV numbers`, counted on `/admin/portal`).

**NUMBERING (`/numbering`) checks cheque consecutives per cash account.** Every cheque of every
status — VOIDED, CANCELLED and no-amount included — in BigInt order; each unused number between an
account's first and last is one MISSING line, however large (user ruling 2026-10-01: "every number
counts", not a booklet heuristic). The cash account is the series key because the sync publishes
no cheque book. MISSING is bounded by the sync's scope (2026 onward, CHK only) and by memo-numbered
cheques sitting on `/admin/staged`; the page says so.
```

Update the module count in the Layout table if it lists modules, and the test count line in **State** with the figure from Step 1 marked as a partial run (the full suite is run before the merge, not here).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: the CANCELLED guard, close-unmatchable-cancelled, and NUMBERING

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand over to the user — do not run against production**

Tell the user, with the commands in their own fenced blocks:
1. Deploy as usual (no migration in this plan).
2. Dry run, read the list, then apply:

```bash
npx.cmd tsx scripts/close-unmatchable-cancelled.ts
```

```bash
npx.cmd tsx scripts/close-unmatchable-cancelled.ts --apply
```

3. The full suite (~25 min) before merging, in the background.
