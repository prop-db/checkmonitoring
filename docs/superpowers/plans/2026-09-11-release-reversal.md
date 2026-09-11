# Release Reversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A FINANCE_ADMIN can undo a release ticked by mistake — back to READY_FOR_RELEASE, collection cleared, supplier portal told "available again", reason on the audit trail — and is refused outright when a receipt is on record or the bank has cleared the cheque.

**Architecture:** One new edge on the ladder (`RELEASED → READY_FOR_RELEASE`), one new `PortalEventKind` (`RELEASE_REVERSED`, an additive enum migration), a pure guard (`lib/domain/reversal.ts`) that both the domain action and the page read, `reverseRelease` in `lib/domain/actions.ts` mirroring `revertAvailability`, a server action mirroring `revertAction`, and a form in the detail page's RELEASED branch.

**Tech Stack:** Prisma 6 (one enum migration) · Next 15 server actions · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-release-reversal-design.md`. Read it before Task 1.

## Global Constraints

- **`npx tsc --noEmit` must pass before any task is called done.** Vitest transpiles with esbuild, which erases types.
- **On Windows use `npx.cmd` / `npm.cmd`.**
- **Run ONLY the test files named in the task. Never the full suite.** All database tests share one Neon database that `resetDb()` truncates — never two test processes at once.
- **The migration reaches the TEST database before any test in this plan runs:** `node scripts/migrate.mjs test`, then `npx.cmd prisma generate`. Production gets it by hand before deploy (`node scripts/migrate.mjs prod --confirm`) — and Postgres cannot use a new enum value in the transaction that added it, so the migration file holds the `ALTER TYPE` and nothing else.
- **FINANCE_ADMIN only**, enforced in the server action; the button hidden for everyone else, the server check being what enforces it.
- **Reason mandatory.** A blank one is a `DomainError('REASON_REQUIRED', …)` before anything is written.
- **Refused when a receipt is on record** (`orNumber` or `receiptType` set) and **when any clearing is recorded** (`clearingStatus ≠ NONE`, or `crNumber` / `clearedDate` set). Both before the transaction writes.
- **Rule 2: an INTERNAL cheque never produces a portal call.** The event is created only when `portalRoute(eligibility)` is non-null, as the other three sites do.
- **Rule 5 is untouched**: nothing here lets the portal mark anything.
- **Rule 7: audit rows are append-only.** One `release_reversed` row per reversal, with the reason and what was undone.
- **Rule 8: amounts are never touched here.** Nothing in this plan reads or writes an amount.
- **`RELEASED` stays in `CLOSED_STATUSES`.** The new edge is a correction, not a stage; the dashboard's scopes do not change.
- **No bulk reversal.** One cheque, one reason.
- **British spelling in prose. Never commit or print `.env`, credentials or any `.xlsx`. No raw control characters.**
- **Commit messages end with:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | **Modify.** `PortalEventKind` gains `RELEASE_REVERSED`. |
| `prisma/migrations/20260911000100_portal_event_release_reversed/migration.sql` | **Create.** `ALTER TYPE … ADD VALUE`. |
| `lib/domain/check-status.ts` | **Modify.** `RELEASED: ['READY_FOR_RELEASE', 'VOIDED']`. |
| `lib/domain/reversal.ts` | **Create.** Pure: `checkReleaseReversible` — the two refusals, as a `GuardResult`, for the domain action and the page. |
| `lib/domain/actions.ts` | **Modify.** `reverseRelease`. |
| `app/checks/actions.ts` | **Modify.** `reverseReleaseAction`. |
| `app/checks/[id]/page.tsx` | **Modify.** The RELEASED branch: form, or the refusal sentence, for an admin. |
| `CLAUDE.md` | **Modify.** Item 8 becomes built. |
| `tests/domain/check-status.test.ts` | **Modify.** The new edge. |
| `tests/domain/reversal.test.ts` | **Create.** The pure guard. |
| `tests/actions/reverse-release.test.ts` | **Create.** The domain action. |
| `tests/actions/server-actions.test.ts` | **Modify.** The role refusal and the admin path. |

---

### Task 1: The edge and the kind

**Files:**
- Modify: `prisma/schema.prisma` (enum `PortalEventKind`), `lib/domain/check-status.ts` (`TRANSITIONS`)
- Create: `prisma/migrations/20260911000100_portal_event_release_reversed/migration.sql`
- Test: `tests/domain/check-status.test.ts`

**Interfaces:**
- Produces: `canTransition('RELEASED', 'READY_FOR_RELEASE') === true`; Prisma's `PortalEventKind` union includes `'RELEASE_REVERSED'`.

- [ ] **Step 1: Write the failing test**

In `tests/domain/check-status.test.ts`, inside the first `describe` (the one holding `it('allows the forward path', …)`), add after the test named `'treats RELEASED and CANCELLED as terminal'`:

```ts
  /**
   * The one edge out of RELEASED that is a correction rather than a fact from
   * the bank. A FINANCE_ADMIN who ticked the wrong row goes back exactly one
   * rung, to where the cheque was available — not to SIGNED, which would
   * withdraw it from the supplier. RELEASED is still CLOSED for every scope.
   */
  it('allows a release to be reversed back to READY_FOR_RELEASE, and nowhere else', () => {
    expect(canTransition('RELEASED', 'READY_FOR_RELEASE')).toBe(true)
    expect(canTransition('RELEASED', 'SIGNED')).toBe(false)
    expect(canTransition('RELEASED', 'SCHEDULED')).toBe(false)
    expect(canTransition('RELEASED', 'VOIDED')).toBe(true)
  })
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/domain/check-status.test.ts
```

Expected: FAIL on `expect(canTransition('RELEASED', 'READY_FOR_RELEASE')).toBe(true)`.

- [ ] **Step 3: The edge**

In `lib/domain/check-status.ts`, change the `RELEASED` line of `TRANSITIONS` to:

```ts
  // READY_FOR_RELEASE is the reversal: a FINANCE_ADMIN undoing a release that
  // was ticked by mistake goes back exactly one rung, to where the cheque was
  // available — never to SIGNED, which would withdraw it from the supplier.
  // `reverseRelease` in actions.ts refuses it when a receipt is on record or
  // the bank has cleared the cheque. RELEASED stays CLOSED for every scope;
  // this edge is a correction, not a stage.
  RELEASED:          ['READY_FOR_RELEASE', 'VOIDED'],
```

- [ ] **Step 4: The kind**

In `prisma/schema.prisma`, inside `enum PortalEventKind`, after the `RELEASED` value and its comment, add:

```prisma
  // A release undone by a FINANCE_ADMIN: the cheque is back at READY_FOR_RELEASE
  // and the supplier may still collect it. Deliberately NOT `REVERT`, which the
  // portal reads as "withdrawn for re-upload" (its status REVERTED_FOR_REUPLOADING)
  // — the opposite of what happened. Delivered, when Plan 3 delivers anything,
  // through the same `POST /api/checks/:id` that carries RELEASED, with
  // `status: AVAILABLE_FOR_RELEASE`. Client ruling 2026-09-11.
  RELEASE_REVERSED
```

Create `prisma/migrations/20260911000100_portal_event_release_reversed/migration.sql`:

```sql
-- A fourth thing the outbox can tell the portal: a release was undone and the
-- cheque is available again. Not REVERT — the portal reads that as withdrawn.
--
-- Alone in its migration on purpose: Postgres refuses to USE a new enum value
-- inside the transaction that added it, so nothing else may share this file.
ALTER TYPE "PortalEventKind" ADD VALUE 'RELEASE_REVERSED';
```

Apply it to the test database and regenerate the client:

```bash
node scripts/migrate.mjs test
npx.cmd prisma generate
```

Expected: `Migrating TEST: <host>/check_monitoring_test`, one migration applied; `generate` completes.

- [ ] **Step 5: Run the test file and the type-checker**

```bash
npx.cmd vitest run tests/domain/check-status.test.ts
```

Expected: PASS, every test including the new one.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260911000100_portal_event_release_reversed/migration.sql lib/domain/check-status.ts tests/domain/check-status.test.ts
git commit -m "feat: a release can be reversed one rung, and the portal can be told so

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The guard and the action

**Files:**
- Create: `lib/domain/reversal.ts`
- Modify: `lib/domain/actions.ts`
- Test: `tests/domain/reversal.test.ts`, `tests/actions/reverse-release.test.ts`

**Interfaces:**
- Consumes: `canTransition` edge and `RELEASE_REVERSED` (Task 1); `GuardResult` from `lib/domain/check-status.ts`; `inTx`, `load`, `portalEventKey`, `portalRoute`, `writeAudit`, `assertTransition`, `DomainError` already in `actions.ts`.
- Produces, from `lib/domain/reversal.ts`:
  ```ts
  export type ReversalInput = { orNumber: string | null; receiptType: string | null; clearingStatus: string; crNumber: string | null; clearedDate: Date | null }
  export const RECEIPT_ON_RECORD_MESSAGE: string
  export const CLEARED_MESSAGE: string
  export function checkReleaseReversible(input: ReversalInput): GuardResult
  ```
- Produces, from `lib/domain/actions.ts`:
  ```ts
  export async function reverseRelease(db: Db, args: { checkId: string; userId: string; reason: string; now: Date }): Promise<Check>
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/reversal.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { checkReleaseReversible, RECEIPT_ON_RECORD_MESSAGE, CLEARED_MESSAGE } from '@/lib/domain/reversal'

/**
 * Pure. The two refusals, pinned with literals. Both the domain action and the
 * detail page read this one function, so the page cannot offer a button the
 * action would refuse.
 */
const clean = { orNumber: null, receiptType: null, clearingStatus: 'NONE', crNumber: null, clearedDate: null }

describe('checkReleaseReversible', () => {
  it('allows a cheque with no receipt and no clearing', () => {
    expect(checkReleaseReversible(clean)).toEqual({ ok: true })
  })

  it('refuses when a receipt is on record — by number or by type', () => {
    expect(checkReleaseReversible({ ...clean, orNumber: 'OR-000123' }))
      .toEqual({ ok: false, code: 'RECEIPT_ON_RECORD', message: RECEIPT_ON_RECORD_MESSAGE })
    expect(checkReleaseReversible({ ...clean, receiptType: 'CR' }).ok).toBe(false)
  })

  it('refuses when the bank has cleared it — by status, reference or date', () => {
    expect(checkReleaseReversible({ ...clean, clearingStatus: 'CLEARED' }))
      .toEqual({ ok: false, code: 'CLEARED', message: CLEARED_MESSAGE })
    expect(checkReleaseReversible({ ...clean, clearingStatus: 'DEPOSITED' }).ok).toBe(false)
    expect(checkReleaseReversible({ ...clean, crNumber: 'BNK-9' }).ok).toBe(false)
    expect(checkReleaseReversible({ ...clean, clearedDate: new Date('2026-09-01') }).ok).toBe(false)
  })

  it('reports the receipt before the clearing when both apply', () => {
    const r = checkReleaseReversible({ ...clean, orNumber: 'OR-1', clearingStatus: 'CLEARED' })
    expect(r.ok === false && r.code).toBe('RECEIPT_ON_RECORD')
  })
})
```

Create `tests/actions/reverse-release.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import {
  markReadyForRelease, markReleased, applyPickupConfirmation, reverseRelease,
} from '@/lib/domain/actions'

const NOW = new Date('2026-09-01T13:32:00+08:00')
const LATER = new Date('2026-09-02T09:00:00+08:00')
const PICKUP = new Date('2026-09-03')

beforeEach(resetDb)

/** A cheque released through the app, the way every future release will be. */
async function released(opts: { eligibility?: 'SUPPLIER' | 'INTERNAL'; withReceipt?: boolean } = {}) {
  const user = await makeUser()
  const check = await makeCheck({ status: 'SIGNED', eligibility: opts.eligibility ?? 'SUPPLIER' })
  await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
  await markReleased(testDb, {
    checkId: check.id, userId: user.id, now: NOW, remarks: 'Handed to the courier',
    ...(opts.withReceipt ? { orNumber: 'OR-000123', receiptType: 'OR' as const } : {}),
  })
  return { user, check }
}

describe('reverseRelease — the happy path', () => {
  it('returns the cheque to READY_FOR_RELEASE, clears the release and the collection, keeps the availability', async () => {
    const { user, check } = await released()
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'Ticked the wrong row', now: LATER })

    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.releasedAt).toBeNull()
    expect(out.releasedById).toBeNull()
    expect(out.scheduledPickupDate).toBeNull()
    expect(out.scheduledPickupTime).toBeNull()
    expect(out.pickupRep).toBeNull()
    expect(out.portalConfirmedAt).toBeNull()
    // Still available: the cheque simply was not handed over after all.
    expect(out.availablePickupDate).toEqual(PICKUP)
    expect(out.readyById).toBe(user.id)
    expect(out.readyAt).toEqual(NOW)
    // Finance's own note is not overwritten; the reason goes on the audit row.
    expect(out.remarks).toBe('Handed to the courier')
  })

  it('clears a collection the supplier had booked', async () => {
    // The honest path: available → booked in the portal (SCHEDULED) → released
    // from SCHEDULED, which the ladder allows → reversed.
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await applyPickupConfirmation(testDb, {
      checkId: check.id, pickupDate: PICKUP, pickupTime: '10:00', pickupRep: 'Juan', confirmedAt: NOW,
    })
    await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER })
    expect(out.status).toBe('READY_FOR_RELEASE')
    expect(out.scheduledPickupDate).toBeNull()
    expect(out.scheduledPickupTime).toBeNull()
    expect(out.pickupRep).toBeNull()
    expect(out.portalConfirmedAt).toBeNull()
  })

  it('writes one audit row carrying the reason and what was undone', async () => {
    const { user, check } = await released()
    const admin = await makeUser('FINANCE_ADMIN')
    await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'Ticked the wrong row', now: LATER })
    const rows = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'release_reversed' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe(admin.id)
    expect(rows[0].remarks).toBe('Ticked the wrong row')
    expect(rows[0].details).toEqual({ releasedAt: NOW.toISOString(), releasedById: user.id })
  })
})

describe('reverseRelease — the portal', () => {
  it('queues exactly one RELEASE_REVERSED event for a SUPPLIER cheque, keyed on this action', async () => {
    const { check } = await released({ eligibility: 'SUPPLIER' })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER })

    const events = await testDb.portalEvent.findMany({ where: { checkId: check.id, kind: 'RELEASE_REVERSED' } })
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('PENDING')
    expect(events[0].direction).toBe('OUT')
    expect(events[0].idempotencyKey).toBe(`${check.id}:RELEASE_REVERSED:${LATER.toISOString()}`)
    expect(events[0].payload).toEqual({ action: 'RELEASE_REVERSED', checkNumber: check.checkNumber })
    expect(out.portalSyncStatus).toBe('PENDING')
  })

  /**
   * Rule 2. An INTERNAL cheque — payroll, tax, an inter-company transfer — must
   * never produce a portal call, and the database's own CHECK constraint
   * refuses routing state on one. Pinned here the way the other three sites
   * pin it.
   */
  it('never queues anything for an INTERNAL cheque', async () => {
    const { check } = await released({ eligibility: 'INTERNAL' })
    const admin = await makeUser('FINANCE_ADMIN')
    const out = await reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER })
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    expect(out.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(out.portalDomain).toBeNull()
  })
})

describe('reverseRelease — the refusals, and that they write nothing', () => {
  async function expectUntouched(checkId: string) {
    const after = await testDb.check.findUniqueOrThrow({ where: { id: checkId } })
    expect(after.status).toBe('RELEASED')
    expect(after.releasedAt).toEqual(NOW)
    expect(await testDb.auditLog.count({ where: { checkId, action: 'release_reversed' } })).toBe(0)
    expect(await testDb.portalEvent.count({ where: { checkId, kind: 'RELEASE_REVERSED' } })).toBe(0)
  }

  it('refuses a blank reason', async () => {
    const { check } = await released()
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: '   ', now: LATER }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    await expectUntouched(check.id)
  })

  /**
   * The client's own condition (2026-09-10): a recorded OR/CR is the supplier's
   * paper saying they took the cheque. It is settled with the supplier first.
   */
  it('refuses when a receipt is on record', async () => {
    const { check } = await released({ withReceipt: true })
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER }))
      .rejects.toMatchObject({ code: 'RECEIPT_ON_RECORD' })
    await expectUntouched(check.id)
  })

  it('refuses when the bank has cleared it', async () => {
    const { check } = await released()
    await testDb.check.update({ where: { id: check.id }, data: { clearingStatus: 'CLEARED', clearedDate: LATER } })
    const admin = await makeUser('FINANCE_ADMIN')
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER }))
      .rejects.toMatchObject({ code: 'CLEARED' })
    await expectUntouched(check.id)
  })

  it('refuses a cheque that is not RELEASED', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(reverseRelease(testDb, { checkId: check.id, userId: admin.id, reason: 'x', now: LATER }))
      .rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
    expect(await testDb.auditLog.count({ where: { checkId: check.id } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx.cmd vitest run tests/domain/reversal.test.ts tests/actions/reverse-release.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/domain/reversal"`, and `reverseRelease` is not exported.

- [ ] **Step 3: The pure guard**

Create `lib/domain/reversal.ts`:

```ts
import type { GuardResult } from './check-status'

/**
 * Whether a release may be reversed. Pure, and read by BOTH the domain action
 * and the detail page, so the page cannot offer a button the action would
 * refuse — it shows the refusal sentence instead.
 *
 * Two refusals, in this order.
 *
 * A RECEIPT ON RECORD is the client's own condition (2026-09-10): an OR or CR
 * number in `orNumber` is the supplier's paper saying they took the cheque.
 * Reversing the release over it would make this system claim a cheque is
 * available for collection while holding the supplier's own evidence that it
 * was collected. It is settled with the supplier, and the receipt removed,
 * before the release is reversed.
 *
 * CLEARED is the addition approved on 2026-09-11: any clearing recorded —
 * status, the bank's reference, or a cleared date — means the bank has paid
 * the cheque. Money that has moved cannot be un-handed-over. `crNumber` here
 * is the BANK's reference (rule 11), which is exactly why it counts.
 */
export type ReversalInput = {
  orNumber: string | null
  receiptType: string | null
  clearingStatus: string
  crNumber: string | null
  clearedDate: Date | null
}

export const RECEIPT_ON_RECORD_MESSAGE =
  "A receipt is recorded: the supplier's own paper says they collected this cheque. " +
  'Settle that with the supplier before reversing the release.'

export const CLEARED_MESSAGE = 'The bank has cleared this cheque; it cannot be un-released.'

export function checkReleaseReversible(input: ReversalInput): GuardResult {
  if (input.orNumber !== null || input.receiptType !== null) {
    return { ok: false, code: 'RECEIPT_ON_RECORD', message: RECEIPT_ON_RECORD_MESSAGE }
  }
  if (input.clearingStatus !== 'NONE' || input.crNumber !== null || input.clearedDate !== null) {
    return { ok: false, code: 'CLEARED', message: CLEARED_MESSAGE }
  }
  return { ok: true }
}
```

- [ ] **Step 4: The action**

In `lib/domain/actions.ts`, add to the imports:

```ts
import { checkReleaseReversible } from './reversal'
```

and add, directly after `revertAvailability`:

```ts
/**
 * A release, undone. FINANCE_ADMIN only — enforced by the server action, as
 * `revertAvailability`'s is — with a mandatory reason.
 *
 * Client design 2026-09-10, one point settled 2026-09-11: the cheque goes back
 * ONE rung, to READY_FOR_RELEASE, and stays available to the supplier. The
 * portal is therefore told the cheque is available again — `RELEASE_REVERSED`,
 * delivered through the same status endpoint RELEASED uses — and NOT `REVERT`,
 * which the portal reads as withdrawn for re-upload. Two systems disagreeing
 * about whether a supplier may collect is the failure this distinction avoids.
 *
 * What is cleared: the release itself (`releasedAt`, `releasedById`) and the
 * collection that did not happen (the scheduled pickup and its confirmation).
 * What is kept: the availability (`availablePickupDate`, `readyById`,
 * `readyAt`) and Finance's `remarks`. The reason goes on the audit row, whose
 * `details` record what was undone, so the trail says more than "reversed".
 *
 * Refused — before anything is written — when a receipt is on record or the
 * bank has cleared the cheque. See `checkReleaseReversible`.
 */
export async function reverseRelease(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to reverse a release.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'READY_FOR_RELEASE')
    const guard = checkReleaseReversible(check)
    if (!guard.ok) throw new DomainError(guard.code, guard.message)

    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'READY_FOR_RELEASE',
        releasedAt: null,
        releasedById: null,
        scheduledPickupDate: null,
        scheduledPickupTime: null,
        pickupRep: null,
        portalConfirmedAt: null,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })

    if (pushes) {
      await tx.portalEvent.create({
        data: {
          checkId: check.id, direction: 'OUT', kind: 'RELEASE_REVERSED', status: 'PENDING',
          idempotencyKey: portalEventKey(check.id, 'RELEASE_REVERSED', args.now),
          payload: { action: 'RELEASE_REVERSED', checkNumber: check.checkNumber },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'release_reversed', remarks: args.reason,
      // What was undone, as it stood: the trail must say more than "reversed".
      details: { releasedAt: check.releasedAt?.toISOString() ?? null, releasedById: check.releasedById },
    })

    return updated
  })
}
```

- [ ] **Step 5: Run the two test files and the type-checker**

```bash
npx.cmd vitest run tests/domain/reversal.test.ts tests/actions/reverse-release.test.ts
```

Expected: PASS — 4 and 9.

```bash
npx.cmd tsc --noEmit
```

Expected: no output. (`checkReleaseReversible(check)` type-checks because the loaded `check` carries every `ReversalInput` field; `clearingStatus` is an enum whose values are strings.)

- [ ] **Step 6: Commit**

```bash
git add lib/domain/reversal.ts lib/domain/actions.ts tests/domain/reversal.test.ts tests/actions/reverse-release.test.ts
git commit -m "feat: reverse a release - back to READY FOR RELEASE, refused over a receipt or a cleared cheque

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The server action, the page, and CLAUDE.md

**Files:**
- Modify: `app/checks/actions.ts`, `app/checks/[id]/page.tsx`, `CLAUDE.md`
- Test: `tests/actions/server-actions.test.ts`

**Interfaces:**
- Consumes: `reverseRelease` (Task 2); `checkReleaseReversible` (Task 2); the page's existing `ActionForm`, `revertAction` pattern.
- Produces: `reverseReleaseAction(formData: FormData): Promise<ActionResult>`.

- [ ] **Step 1: Write the failing tests**

In `tests/actions/server-actions.test.ts`, add at the end of the file:

```ts
describe('reverseReleaseAction', () => {
  async function releasedCheck() {
    const { readyForReleaseAction, releaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    await releaseAction(fd({ checkId: check.id }))
    return check
  }

  it('refuses a FINANCE_USER and leaves the release standing', async () => {
    const { reverseReleaseAction } = await import('@/app/checks/actions')
    const check = await releasedCheck()
    const result = await reverseReleaseAction(fd({ checkId: check.id, reason: 'Wrong row' }))
    expect(result.ok).toBe(false)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('RELEASED')
  })

  it('lets a FINANCE_ADMIN reverse with a reason', async () => {
    const { reverseReleaseAction } = await import('@/app/checks/actions')
    const check = await releasedCheck()
    // The mock's user object is mutable; the role is what the action checks.
    ;(currentUser as { role: string }).role = 'FINANCE_ADMIN'
    try {
      const result = await reverseReleaseAction(fd({ checkId: check.id, reason: 'Wrong row' }))
      expect(result.ok).toBe(true)
      const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
      expect(after.status).toBe('READY_FOR_RELEASE')
    } finally {
      ;(currentUser as { role: string }).role = 'FINANCE_USER'
    }
  })

  it('refuses a blank reason even for an admin', async () => {
    const { reverseReleaseAction } = await import('@/app/checks/actions')
    const check = await releasedCheck()
    ;(currentUser as { role: string }).role = 'FINANCE_ADMIN'
    try {
      const result = await reverseReleaseAction(fd({ checkId: check.id, reason: '' }))
      expect(result.ok).toBe(false)
    } finally {
      ;(currentUser as { role: string }).role = 'FINANCE_USER'
    }
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/actions/server-actions.test.ts
```

Expected: the three new tests FAIL — `reverseReleaseAction` is not exported. Every existing test still passes.

- [ ] **Step 3: The server action**

In `app/checks/actions.ts`, extend the import from `@/lib/domain/actions` with `reverseRelease`, and add directly after `revertAction`:

```ts
/**
 * A release, undone. FINANCE_ADMIN only — the same guard as `revertAction`,
 * one rung up. The reason is required by the domain; the page requires it too,
 * but the domain is what enforces it. Refusals for a recorded receipt or a
 * cleared cheque arrive as `DomainError`s and are shown as their own words.
 */
export async function reverseReleaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') {
    return { ok: false, message: 'Only a Finance Admin can reverse a release.' }
  }
  const checkId = str(formData, 'checkId')
  return run(checkId, () => reverseRelease(prisma, {
    checkId, userId: user.id,
    reason: str(formData, 'reason'), now: new Date(),
  }))
}
```

- [ ] **Step 4: The page**

In `app/checks/[id]/page.tsx`:

1. Extend the import from `'../actions'` with `reverseReleaseAction`, and add:

```ts
import { checkReleaseReversible } from '@/lib/domain/reversal'
```

2. Replace the `RELEASED` branch — the block beginning `{check.status === 'RELEASED' && (` and ending with its `)}` — with:

```tsx
        {check.status === 'RELEASED' && (
          <div className="space-y-4">
            <p className="rounded-xl bg-success-bg px-4 py-3 text-sm text-success-ink">
              This cheque has been released
              {check.releasedBy?.name ? ` by ${check.releasedBy.name}` : ''}
              {check.releasedAt ? ` on ${fmtDateTime(check.releasedAt)}` : ''}.
            </p>

            {/* The undo for the one action that hands money over. Client design
                2026-09-10, built 2026-09-11. FINANCE_ADMIN only, matching
                `reverseReleaseAction`'s own guard: hidden for everyone else,
                enforced on the server. The same guard the action applies is run
                here first, so an admin is TOLD why a reversal is refused —
                a receipt on record, or a cleared cheque — rather than shown a
                button that would refuse them. */}
            {user.role === 'FINANCE_ADMIN' && (() => {
              const reversible = checkReleaseReversible(check)
              return reversible.ok ? (
                <ActionForm
                  action={reverseReleaseAction}
                  checkId={check.id}
                  label="REVERSE RELEASE"
                  className="block rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy transition hover:bg-ground disabled:opacity-50"
                >
                  <label className="block text-[11px] font-semibold tracking-widest text-slate-400">
                    REASON <span className="text-danger-ink">— REQUIRED</span>
                  </label>
                  <input name="reason" required placeholder="Ticked the wrong row"
                    className="h-10 w-full max-w-md rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" />
                  <p className="text-[11px] text-slate-500">
                    Returns this cheque to READY FOR RELEASE, clears any pickup that was booked, and
                    tells the supplier portal it is available again. The release stays on the audit
                    trail with your reason.
                  </p>
                </ActionForm>
              ) : (
                <p className="text-sm text-slate-600">
                  <span className="font-semibold text-navy">This release cannot be reversed.</span>{' '}
                  {reversible.message}
                </p>
              )
            })()}

            {user.role !== 'FINANCE_ADMIN' && (
              <p className="text-sm text-slate-500">There is nothing further to do here.</p>
            )}
          </div>
        )}
```

- [ ] **Step 5: CLAUDE.md**

In `CLAUDE.md`'s "What is missing", replace item 8 — the paragraph beginning `8. **A release cannot be reversed.**` through `since Plan 1.)` — with:

```markdown
8. **A release can be reversed** (built 2026-09-11, client design of 2026-09-10). `reverseRelease`
   in `lib/domain/actions.ts`: FINANCE_ADMIN only, mandatory reason, back to READY_FOR_RELEASE with
   the availability kept and the collection cleared, one `release_reversed` audit row recording
   what was undone. **Refused outright when a receipt is on record** — the supplier's own paper —
   and, an addition approved the same day, **when any clearing is recorded**: money the bank has
   paid cannot be un-handed-over. Both refusals live in `lib/domain/reversal.ts`, which the page
   reads too, so an admin is told why rather than shown a button that would refuse. The portal is
   told `RELEASE_REVERSED` — a fourth `PortalEventKind`, delivered via `POST /api/checks/:id` with
   `status: AVAILABLE_FOR_RELEASE` when Plan 3 delivers — and deliberately NOT `REVERT`, which the
   portal reads as withdrawn for re-upload. Measured before building: none of the 9,594 released
   cheques carries a receipt, `releasedAt`, or clearing, because `markReleased` has never run in
   production; both refusals are forward-looking. Migration
   `20260911000100_portal_event_release_reversed` must reach production before the deploy.
   (Reverting availability, READY_FOR_RELEASE -> SIGNED, has been on the detail page since
   2026-09-10.)
```

- [ ] **Step 6: Run the test file, the type-checker and the build**

```bash
npx.cmd vitest run tests/actions/server-actions.test.ts
```

Expected: PASS, every test including the three new ones.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

```bash
npx.cmd next build
```

Expected: build succeeds; `/checks/[id]` is listed as a dynamic route.

- [ ] **Step 7: Commit**

```bash
git add app/checks/actions.ts "app/checks/[id]/page.tsx" CLAUDE.md tests/actions/server-actions.test.ts
git commit -m "feat: REVERSE RELEASE on the cheque page, for an admin, with the refusal spelled out

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Not in this plan

- **Bulk reversal.** One cheque, one reason.
- **Reversing a VOIDED cheque.** Acumatica owns that.
- **Delivering `RELEASE_REVERSED`.** Plan 3; it queues with the other three kinds.
- **Removing a receipt.** The existing receipt form; then the release can be reversed.
- **Deploying.** `node scripts/migrate.mjs prod --confirm`, then `npx vercel --prod` — the user's actions, in that order.
