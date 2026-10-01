# Signing Schedule (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monday's Acumatica cheques auto-sign on Tuesday at 12:00 Manila; every other pending cheque is signed with a one-click, confirmed SIGN ALL; any Finance user can revert a SIGNED cheque to SIGNATURE PENDING.

**Architecture:** The pure rule in `lib/domain/auto-sign.ts` is rewritten from "N days after `createdAt`" to "created on the Manila Monday before a Manila Tuesday run, never reverted". A second Vercel cron at 04:00 UTC calls the existing `/api/cron/sync` route (sync, then auto-sign). SIGN ALL copies RELEASE ALL's server-confirmed pattern (`?confirm=sign`, `expectedCount`, server-computed set). Revert is a new ladder edge `SIGNED → SIGNATURE_PENDING` and a new domain action `revertSignature`.

**Tech Stack:** Next.js 15 App Router, Prisma 6 on Neon, Vitest, TypeScript strict.

Spec: `docs/superpowers/specs/2026-10-01-signing-schedule-apv-and-table-design.md`, part A.

## Global Constraints

- Manila is UTC+8 with no daylight saving; a fixed offset is exact.
- Rule 4: the sync never writes `status`. Auto-sign stays its own step in `lib/domain/actions.ts`.
- `lib/domain/` modules other than `actions.ts` are pure: no database, network, clock.
- Every status change writes exactly one audit row, in the same transaction.
- A present-but-unrecognised filter on a bulk "ALL" action REFUSES; it never widens.
- Settings are read with `loadSettings` at request time; never read a default constant at a call site.
- Amounts are decimal strings, never JS numbers (rule 8).
- Tests: `node node_modules/vitest/vitest.mjs run <file>` (Git Bash; `npx.cmd` breaks). Run only the files touched; one agent at a time against the test database.
- Types: `node node_modules/typescript/bin/tsc --noEmit` before claiming any task done.
- Never run scripts against production from this plan; the local `.env` is production.

## File map

| File | Change |
| --- | --- |
| `lib/domain/check-status.ts` | add edge `SIGNED → SIGNATURE_PENDING` |
| `lib/domain/auto-sign.ts` | rewrite rule: `isManilaTuesday`, `mondayWindow`, `isDueForAutoSign(facts, now, enabled)`, `SIGNATURE_REVERTED_ACTION` |
| `lib/settings/defaults.ts`, `lib/settings/registry.ts` | `autoSign.afterDays` → `autoSign.mondayEnabled` (int 0/1) |
| `lib/domain/actions.ts` | `autoSign` new args; new `revertSignature` |
| `lib/sync/auto-sign.ts` | candidates by Monday window, `enabled` replaces `days`, `IDLE` outcome |
| `app/admin/sync/page.tsx` | LAST AUTO-SIGN wording |
| `app/api/cron/sync/route.ts` | comment only |
| `vercel.json` | second cron `0 4 * * *` |
| `scripts/auto-sign-backlog.ts` | delete (one-off for the old rule) |
| `lib/queries.ts` | `getPendingSignature`, `listPendingSignatureIds` |
| `lib/dashboard-view.ts` | `signAllConfirmHref`, `signAllCancelHref` |
| `app/checks/bulk-actions.ts` | `signAllPendingAction`, `bulkRevertToPendingAction`; rename `readReleaseNarrowing` → `readNarrowing` |
| `app/checks/actions.ts` | `revertSignatureAction` |
| `components/SignAllConfirm.tsx` | new, modelled on `ReleaseAllConfirm` |
| `app/page.tsx` | SIGN ALL link + confirm panel on the SIGNATURE PENDING list |
| `lib/row-receipts.ts`, `components/BulkActionBar.tsx` | `signedIds`, REVERT TO PENDING button |
| `app/checks/[id]/page.tsx` | REVERT TO SIGNATURE PENDING form |
| `CLAUDE.md` | rule and command updates |

---

### Task 1: The ladder edge and `revertSignature`

**Files:**
- Modify: `lib/domain/check-status.ts:20-22`
- Modify: `lib/domain/auto-sign.ts` (add one export only in this task)
- Modify: `lib/domain/actions.ts` (add `revertSignature` after `autoSign`)
- Test: `tests/domain/check-status.test.ts`, `tests/actions/revert-signature.test.ts` (new)

**Interfaces:**
- Produces: `SIGNATURE_REVERTED_ACTION = 'signature_reverted'` exported from `lib/domain/auto-sign.ts`.
- Produces: `revertSignature(db: Db, args: { checkId: string; userId: string; reason?: string; now: Date }): Promise<Check>`.

- [ ] **Step 1: Write the failing ladder test**

Append inside the top-level `describe` of `tests/domain/check-status.test.ts`:

```ts
  it('allows a signature to be reverted, and only from SIGNED', () => {
    expect(canTransition('SIGNED', 'SIGNATURE_PENDING')).toBe(true)
    for (const s of ['GENERATED', 'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED'] as const) {
      expect(canTransition(s, 'SIGNATURE_PENDING'), s).toBe(s === 'GENERATED')
    }
  })
```

(`GENERATED → SIGNATURE_PENDING` already exists; the loop pins that nothing else gains the edge.)

- [ ] **Step 2: Write the failing action test**

Create `tests/actions/revert-signature.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { revertSignature } from '@/lib/domain/actions'
import { SIGNATURE_REVERTED_ACTION } from '@/lib/domain/auto-sign'

const now = new Date('2026-09-30T04:00:00Z')
beforeEach(resetDb)

describe('revertSignature', () => {
  it('returns a SIGNED cheque to SIGNATURE_PENDING, clears the signer, writes one row', async () => {
    const signer = await makeUser()
    const actor = await makeUser()
    const c = await makeCheck({ status: 'SIGNED' })
    await testDb.check.update({ where: { id: c.id }, data: { signedById: signer.id, signedAt: now } })

    const after = await revertSignature(testDb, { checkId: c.id, userId: actor.id, reason: 'Wrong batch', now })
    expect(after).toMatchObject({ status: 'SIGNATURE_PENDING', signedById: null, signedAt: null })

    const rows = await testDb.auditLog.findMany({ where: { checkId: c.id, action: SIGNATURE_REVERTED_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actorType: 'USER', userId: actor.id, remarks: 'Wrong batch' })
    expect(rows[0].details).toMatchObject({ from: 'SIGNED', to: 'SIGNATURE_PENDING', previousSignerId: signer.id })
  })

  it('accepts no reason, and records an auto-signed cheque as such', async () => {
    const actor = await makeUser()
    const c = await makeCheck({ status: 'SIGNED' })
    await revertSignature(testDb, { checkId: c.id, userId: actor.id, now })
    const row = await testDb.auditLog.findFirstOrThrow({ where: { checkId: c.id, action: SIGNATURE_REVERTED_ACTION } })
    expect(row.remarks).toBeNull()
    expect(row.details).toMatchObject({ previousSignerId: null })
  })

  it('refuses every status but SIGNED and writes nothing', async () => {
    const actor = await makeUser()
    for (const status of ['SIGNATURE_PENDING', 'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED'] as const) {
      const c = await makeCheck({ status })
      await expect(revertSignature(testDb, { checkId: c.id, userId: actor.id, now }), status).rejects.toThrow()
      expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe(status)
    }
    expect(await testDb.auditLog.count({ where: { action: SIGNATURE_REVERTED_ACTION } })).toBe(0)
  })

  it('queues no portal event', async () => {
    const actor = await makeUser()
    const c = await makeCheck({ status: 'SIGNED' })
    await revertSignature(testDb, { checkId: c.id, userId: actor.id, now })
    expect(await testDb.portalEvent.count({ where: { checkId: c.id } })).toBe(0)
  })
})
```

- [ ] **Step 3: Run both, expect FAIL**

Run: `node node_modules/vitest/vitest.mjs run tests/domain/check-status.test.ts tests/actions/revert-signature.test.ts`
Expected: the ladder case fails (`SIGNED → SIGNATURE_PENDING` false); the action file fails to import `revertSignature` / `SIGNATURE_REVERTED_ACTION`.

- [ ] **Step 4: Implement**

`lib/domain/check-status.ts`, the SIGNED line and a comment above it:

```ts
  // SIGNATURE_PENDING is the signature undone (client, 2026-10-01): any
  // Finance user, `revertSignature` in actions.ts. A cheque on the release
  // list goes back to SIGNED first, through `revertAvailability`.
  SIGNED:            ['READY_FOR_RELEASE', 'SIGNATURE_PENDING', 'CANCELLED', 'VOIDED'],
```

`lib/domain/auto-sign.ts`, below `AUTO_SIGN_RUN_ACTION`:

```ts
/** A person undid a signature. A cheque carrying one is never auto-signed again. */
export const SIGNATURE_REVERTED_ACTION = 'signature_reverted'
```

`lib/domain/actions.ts`: extend the import from `./auto-sign` to `import { isDueForAutoSign, AUTO_SIGNED_ACTION, SIGNATURE_REVERTED_ACTION } from './auto-sign'`, and add after `autoSign`:

```ts
/**
 * A signature, undone (client, 2026-10-01). Any Finance user; the reason is
 * optional. SIGNED only — the ladder refuses anything else, and a cheque on
 * the release list must come back to SIGNED through `revertAvailability`
 * first. The previous signer goes on the audit row (null for an auto-signed
 * cheque), because clearing `signedById` would otherwise erase who it was.
 * No portal event: signing never produces one. A cheque carrying this row is
 * never auto-signed again (`isDueForAutoSign`).
 */
export async function revertSignature(
  db: Db, args: { checkId: string; userId: string; reason?: string; now: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'SIGNATURE_PENDING')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: { status: 'SIGNATURE_PENDING', signedById: null, signedAt: null },
    })
    const reason = args.reason?.trim() || null
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: SIGNATURE_REVERTED_ACTION,
      details: {
        from: 'SIGNED', to: 'SIGNATURE_PENDING',
        previousSignerId: check.signedById, previousSignedAt: check.signedAt?.toISOString() ?? null,
      },
      remarks: reason,
    })
    return updated
  })
}
```

If `writeAudit`'s `remarks` type does not accept `null`, pass `...(reason ? { remarks: reason } : {})` instead and keep the test's `toBeNull()` (an omitted column is null).

- [ ] **Step 5: Run, expect PASS; type-check**

Run: `node node_modules/vitest/vitest.mjs run tests/domain/check-status.test.ts tests/actions/revert-signature.test.ts`
Expected: PASS.
Run: `node node_modules/typescript/bin/tsc --noEmit` — Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/domain/check-status.ts lib/domain/auto-sign.ts lib/domain/actions.ts tests/domain/check-status.test.ts tests/actions/revert-signature.test.ts
git commit -m "feat(domain): SIGNED -> SIGNATURE_PENDING, revertSignature with one audit row"
```

---

### Task 2: The Monday rule (pure) and its setting

**Files:**
- Modify: `lib/domain/auto-sign.ts` (replace `dueBefore` and `isDueForAutoSign`; rewrite header comment)
- Modify: `lib/settings/defaults.ts:26`, `lib/settings/registry.ts:14,44,85-87`
- Test: `tests/domain/auto-sign.test.ts` (rewrite), `tests/settings/registry.test.ts:40-46`

**Interfaces:**
- Produces: `AutoSignFacts` gains `reverted: boolean`.
- Produces: `isManilaTuesday(now: Date): boolean`, `mondayWindow(now: Date): { from: Date; to: Date }` (Monday 00:00 Manila inclusive, Tuesday 00:00 Manila exclusive, relative to `now`'s Manila day), `isDueForAutoSign(c: AutoSignFacts, now: Date, enabled: boolean): boolean`.
- Produces: setting key `'autoSign.mondayEnabled'` (int, 0 or 1, default 1). `dueBefore` is removed.

The registry supports only `int` and `list` kinds; a 0/1 int is the ON/OFF switch the spec asks for without a new kind. Record that in the spec (Step 7).

- [ ] **Step 1: Rewrite the pure test**

Replace `tests/domain/auto-sign.test.ts` entirely:

```ts
import { describe, it, expect } from 'vitest'
import { isDueForAutoSign, isManilaTuesday, mondayWindow, type AutoSignFacts } from '@/lib/domain/auto-sign'

// 29 Sep 2026 is a Tuesday (25 Sep is a Friday).
const tuesdayNoon = new Date('2026-09-29T04:00:00Z') // 12:00 Manila, Tuesday 29 Sep
const mondayStart = new Date('2026-09-27T16:00:00Z') // 00:00 Manila, Monday 28 Sep
const tuesdayStart = new Date('2026-09-28T16:00:00Z') // 00:00 Manila, Tuesday 29 Sep

const pending = (o: Partial<AutoSignFacts> = {}): AutoSignFacts => ({
  status: 'SIGNATURE_PENDING', acumaticaPaymentId: 'BPI-000123', isCheque: true,
  acumaticaStatus: 'Balanced', createdAt: new Date('2026-09-28T10:00:00Z'), reverted: false, ...o,
})

describe('isManilaTuesday', () => {
  it('is the Manila calendar day, not UTC', () => {
    expect(isManilaTuesday(tuesdayNoon)).toBe(true)
    expect(isManilaTuesday(tuesdayStart)).toBe(true)                               // Tue 00:00 Manila = Mon 16:00 UTC
    expect(isManilaTuesday(new Date(tuesdayStart.getTime() - 1))).toBe(false)      // Mon 23:59:59.999 Manila
    expect(isManilaTuesday(new Date('2026-09-29T15:59:59.999Z'))).toBe(true)       // Tue 23:59:59.999 Manila
    expect(isManilaTuesday(new Date('2026-09-29T16:00:00Z'))).toBe(false)          // Wed 00:00 Manila
  })
})

describe('mondayWindow', () => {
  it('is the Manila day before now', () => {
    expect(mondayWindow(tuesdayNoon)).toEqual({ from: mondayStart, to: tuesdayStart })
  })
})

describe('isDueForAutoSign', () => {
  it('signs Monday 00:00 and Monday 23:59:59.999 Manila at Tuesday’s run', () => {
    expect(isDueForAutoSign(pending({ createdAt: mondayStart }), tuesdayNoon, true)).toBe(true)
    expect(isDueForAutoSign(pending({ createdAt: new Date(tuesdayStart.getTime() - 1) }), tuesdayNoon, true)).toBe(true)
  })

  it('does not sign Sunday 23:59:59.999 or Tuesday 00:00 Manila', () => {
    expect(isDueForAutoSign(pending({ createdAt: new Date(mondayStart.getTime() - 1) }), tuesdayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ createdAt: tuesdayStart }), tuesdayNoon, true)).toBe(false)
  })

  it('does not reach back to an earlier Monday', () => {
    expect(isDueForAutoSign(pending({ createdAt: new Date('2026-09-21T10:00:00Z') }), tuesdayNoon, true)).toBe(false)
  })

  it('signs nothing on any day but Tuesday', () => {
    const monday = pending({ createdAt: mondayStart })
    for (const iso of ['2026-09-28T04:00:00Z', '2026-09-30T04:00:00Z', '2026-10-01T04:00:00Z', '2026-10-02T04:00:00Z', '2026-10-03T04:00:00Z', '2026-10-04T04:00:00Z']) {
      expect(isDueForAutoSign(monday, new Date(iso), true), iso).toBe(false)
    }
  })

  it('signs nothing when switched off', () => {
    expect(isDueForAutoSign(pending(), tuesdayNoon, false)).toBe(false)
  })

  it('never re-signs a cheque someone reverted', () => {
    expect(isDueForAutoSign(pending({ reverted: true }), tuesdayNoon, true)).toBe(false)
  })

  it('accepts a null Acumatica status', () => {
    expect(isDueForAutoSign(pending({ acumaticaStatus: null }), tuesdayNoon, true)).toBe(true)
  })

  it('refuses other statuses, register-only, non-cheques and Voided', () => {
    for (const status of ['GENERATED', 'SIGNED', 'READY_FOR_RELEASE', 'RELEASED', 'CANCELLED', 'VOIDED']) {
      expect(isDueForAutoSign(pending({ status }), tuesdayNoon, true), status).toBe(false)
    }
    expect(isDueForAutoSign(pending({ acumaticaPaymentId: null }), tuesdayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ isCheque: false }), tuesdayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ acumaticaStatus: 'Voided' }), tuesdayNoon, true)).toBe(false)
  })
})
```

- [ ] **Step 2: Update the registry test**

In `tests/settings/registry.test.ts`, replace the `'declares auto-sign as a WORKFLOW setting…'` case:

```ts
  it('declares Monday auto-sign as a WORKFLOW ON/OFF switch, on by default', () => {
    const def = settingDef('autoSign.mondayEnabled')
    expect(def).toMatchObject({ kind: 'int', group: 'WORKFLOW', default: 1, min: 0, max: 1 })
    expect(DEFAULTS['autoSign.mondayEnabled']).toBe(1)
    expect(parseSettingText(def!, '0')).toEqual({ ok: true, value: 0 })
    expect(parseSettingText(def!, '2').ok).toBe(false)
    expect(settingDef('autoSign.afterDays' as never)).toBeUndefined()
  })
```

- [ ] **Step 3: Run, expect FAIL**

Run: `node node_modules/vitest/vitest.mjs run tests/domain/auto-sign.test.ts tests/settings/registry.test.ts`
Expected: FAIL — `isManilaTuesday` / `mondayWindow` not exported; `autoSign.mondayEnabled` undefined.

- [ ] **Step 4: Implement the rule**

Replace everything in `lib/domain/auto-sign.ts` from the header comment down to the end of the file (keep the three action constants) with:

```ts
/**
 * AUTO-SIGN, THE RULE. Client, 2026-10-01, replacing the 2026-09-24 "3 days
 * after creation": "All checks prepared on Monday — automatically will be
 * transferred to signed by Tuesday. All checks on Tuesday to Friday will have
 * a 1 click button."
 *
 * "Prepared on Monday" is read as "first read by the sync on a Manila
 * Monday" — `createdAt` — because Acumatica publishes no creation timestamp
 * and its one date, PaymentDate, is post-dated on some cheques. A cheque
 * prepared Monday after the 18:00 read first arrives at Tuesday's 12:00 read,
 * carries a Tuesday `createdAt`, and waits for SIGN ALL. Accepted.
 *
 * Only on a Manila TUESDAY, and only the Monday immediately before it: a run
 * that failed is retried by hand the same day, and never reaches back to an
 * earlier Monday — older cheques are SIGN ALL's.
 *
 * A cheque a person reverted (`signature_reverted`) is never signed by the
 * clock again: next Tuesday's run would otherwise quietly undo the revert.
 *
 * The Philippines is UTC+8 with no daylight saving, so a fixed offset is
 * exact. Pure. No database, no clock: the caller passes `now`.
 */

export const AUTO_SIGNED_ACTION = 'auto_signed'
export const AUTO_SIGN_RUN_ACTION = 'auto_sign_run'
/** A person undid a signature. A cheque carrying one is never auto-signed again. */
export const SIGNATURE_REVERTED_ACTION = 'signature_reverted'

const DAY_MS = 86_400_000
const MANILA_OFFSET_MS = 8 * 3_600_000
/** 1970-01-01 was a Thursday; with Sunday = 0 that is weekday 4. */
const EPOCH_WEEKDAY = 4
const TUESDAY = 2

export type AutoSignFacts = {
  status: string
  acumaticaPaymentId: string | null
  isCheque: boolean
  acumaticaStatus: string | null
  createdAt: Date
  /** Carries a `signature_reverted` audit row. */
  reverted: boolean
}

/** The Manila calendar day index (days since the epoch, in UTC+8) an instant falls on. */
function dayIndex(t: number): number {
  return Math.floor((t + MANILA_OFFSET_MS) / DAY_MS)
}

/** The UTC instant at which Manila day `index` begins. */
function dayStart(index: number): Date {
  return new Date(index * DAY_MS - MANILA_OFFSET_MS)
}

export function isManilaTuesday(now: Date): boolean {
  return (dayIndex(now.getTime()) + EPOCH_WEEKDAY) % 7 === TUESDAY
}

/** The Manila day before `now`'s: `from` inclusive, `to` exclusive. On a Tuesday, Monday. */
export function mondayWindow(now: Date): { from: Date; to: Date } {
  const today = dayIndex(now.getTime())
  return { from: dayStart(today - 1), to: dayStart(today) }
}

export function isDueForAutoSign(c: AutoSignFacts, now: Date, enabled: boolean): boolean {
  if (!enabled) return false
  if (!isManilaTuesday(now)) return false
  if (c.status !== 'SIGNATURE_PENDING') return false
  // Only what Acumatica generated. A register-only cheque waits for a person.
  if (c.acumaticaPaymentId === null) return false
  // DEBIT ADV and CASH are never signed by anyone.
  if (!c.isCheque) return false
  // A voided payment is the sync's or a person's to settle, not the clock's.
  if (c.acumaticaStatus === 'Voided') return false
  if (c.reverted) return false
  const { from, to } = mondayWindow(now)
  const t = c.createdAt.getTime()
  return t >= from.getTime() && t < to.getTime()
}
```

(This also removes the duplicate `SIGNATURE_REVERTED_ACTION` line Task 1 added — there must be exactly one.)

- [ ] **Step 5: Implement the setting**

`lib/settings/defaults.ts:26`:

```ts
/** 1 = Monday's Acumatica cheques auto-sign at Tuesday's 12:00 run; 0 = off. */
export const DEFAULT_AUTO_SIGN_MONDAY_ENABLED = 1
```

`lib/settings/registry.ts`: import `DEFAULT_AUTO_SIGN_MONDAY_ENABLED as AUTO_SIGN_MONDAY_ENABLED` instead of the old constant; in `IntKey` replace `'autoSign.afterDays'` with `'autoSign.mondayEnabled'`; replace the setting entry with:

```ts
  { kind: 'int', key: 'autoSign.mondayEnabled', group: 'WORKFLOW', label: "AUTO-SIGN MONDAY'S ACUMATICA CHEQUES ON TUESDAY", unit: '1 = on, 0 = off',
    help: 'At 12:00 every Tuesday, an Acumatica cheque first read on the Monday and still at SIGNATURE PENDING is signed. Every other pending cheque waits for SIGN ALL.',
    default: AUTO_SIGN_MONDAY_ENABLED, min: 0, max: 1 },
```

A stored `autoSign.afterDays` row is left in the `Setting` table and ignored: confirm by reading `lib/settings/read.ts` that unknown keys are skipped (it iterates `SETTINGS`, not rows). If it instead reports unknown keys as errors, make it skip them and add a case to `tests/settings/read.test.ts`: `a stored key no longer in the registry is ignored`.

- [ ] **Step 6: Run, expect PASS for these two files**

Run: `node node_modules/vitest/vitest.mjs run tests/domain/auto-sign.test.ts tests/settings/registry.test.ts`
Expected: PASS. (`tsc` will fail until Task 3 — `actions.ts` and `sync/auto-sign.ts` still use `days`. Do not commit yet; Task 3 continues in the same commit.)

- [ ] **Step 7: Note the 0/1 setting in the spec**

In the spec's A1b, replace "(boolean, default ON)" with "(an int setting, 1 = ON, 0 = OFF, default 1 — the registry has only `int` and `list` kinds)".

---

### Task 3: The run — `autoSign`, candidates, run record, cron

**Files:**
- Modify: `lib/domain/actions.ts` (`autoSign`)
- Modify: `lib/sync/auto-sign.ts`
- Modify: `app/admin/sync/page.tsx:192`
- Modify: `app/api/cron/sync/route.ts` (comments)
- Modify: `vercel.json`
- Delete: `scripts/auto-sign-backlog.ts`
- Test: `tests/actions/auto-sign.test.ts`, `tests/sync/auto-sign.test.ts` (rewrite both), `tests/sync/cron-route.test.ts` (adjust)

**Interfaces:**
- Consumes: `isDueForAutoSign(facts, now, enabled)`, `mondayWindow`, `isManilaTuesday`, `SIGNATURE_REVERTED_ACTION` (Task 2).
- Produces: `autoSign(db, { checkId: string; now: Date }): Promise<Check | null>` (enabled is the caller's decision; `autoSign` is only reached when enabled).
- Produces: `AutoSignRun = { outcome: 'OK' | 'DISABLED' | 'IDLE' | 'FAILED'; signed: number; skipped: number; enabled: boolean | null; error?: string }` — `IDLE` = not a Manila Tuesday.
- Produces: `listAutoSignCandidates(db: PrismaClient, now: Date): Promise<AutoSignCandidate[]>`.

- [ ] **Step 1: Rewrite `tests/actions/auto-sign.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { autoSign, revertSignature, markSigned } from '@/lib/domain/actions'
import { AUTO_SIGNED_ACTION } from '@/lib/domain/auto-sign'

const tuesdayNoon = new Date('2026-09-29T04:00:00Z')
const mondayMorning = new Date('2026-09-28T01:00:00Z') // 09:00 Manila Monday

async function acumaticaPending(createdAt: Date, o: { isCheque?: boolean; acumaticaStatus?: string | null } = {}) {
  const c = await makeCheck({ status: 'SIGNATURE_PENDING', isCheque: o.isCheque ?? true })
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: `PAY-${c.id}`,
      acumaticaStatus: o.acumaticaStatus === undefined ? 'Balanced' : o.acumaticaStatus,
      createdAt,
    },
  })
}

beforeEach(resetDb)

describe('autoSign', () => {
  it('signs a Monday cheque at Tuesday’s run, no signing user, one SYSTEM row', async () => {
    const c = await acumaticaPending(mondayMorning)
    const signed = await autoSign(testDb, { checkId: c.id, now: tuesdayNoon })
    expect(signed).toMatchObject({ status: 'SIGNED', signedById: null })
    expect(signed!.signedAt!.toISOString()).toBe(tuesdayNoon.toISOString())
    const audit = await testDb.auditLog.findMany({ where: { checkId: c.id, action: AUTO_SIGNED_ACTION } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', userId: null })
    expect(audit[0].details).toMatchObject({
      from: 'SIGNATURE_PENDING', to: 'SIGNED', rule: 'MONDAY', inAppSince: c.createdAt.toISOString(),
    })
  })

  it('queues no portal event', async () => {
    const c = await acumaticaPending(mondayMorning)
    await autoSign(testDb, { checkId: c.id, now: tuesdayNoon })
    expect(await testDb.portalEvent.count({ where: { checkId: c.id } })).toBe(0)
  })

  it('skips (null) a cheque someone reverted', async () => {
    const u = await makeUser()
    const c = await acumaticaPending(mondayMorning)
    await markSigned(testDb, { checkId: c.id, userId: u.id, now: mondayMorning })
    await revertSignature(testDb, { checkId: c.id, userId: u.id, now: mondayMorning })
    expect(await autoSign(testDb, { checkId: c.id, now: tuesdayNoon })).toBeNull()
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('skips (null) a Tuesday cheque and any run on another day', async () => {
    const tue = await acumaticaPending(new Date('2026-09-29T01:00:00Z'))
    expect(await autoSign(testDb, { checkId: tue.id, now: tuesdayNoon })).toBeNull()
    const mon = await acumaticaPending(mondayMorning)
    expect(await autoSign(testDb, { checkId: mon.id, now: new Date('2026-09-30T04:00:00Z') })).toBeNull()
  })
})
```

- [ ] **Step 2: Rewrite `tests/sync/auto-sign.test.ts`**

Keep the file's imports and `getLastAutoSign` cases if any exist below line 80 (read the file first; adapt any `days` assertion to `enabled`). Replace the helpers and the `listAutoSignCandidates` / `runAutoSign` describes with:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { runAutoSign, listAutoSignCandidates, getLastAutoSign } from '@/lib/sync/auto-sign'
import { AUTO_SIGN_RUN_ACTION } from '@/lib/domain/auto-sign'
import { markSigned, revertSignature } from '@/lib/domain/actions'

const tuesdayNoon = new Date('2026-09-29T04:00:00Z')
const wednesdayNoon = new Date('2026-09-30T04:00:00Z')

async function pendingAt(createdAt: Date, o: { acumatica?: boolean; acumaticaStatus?: string | null } = {}) {
  const c = await makeCheck({ status: 'SIGNATURE_PENDING' })
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: o.acumatica === false ? null : `PAY-${c.id}`,
      acumaticaStatus: o.acumaticaStatus === undefined ? 'Balanced' : o.acumaticaStatus,
      createdAt,
    },
  })
}

beforeEach(resetDb)

describe('listAutoSignCandidates', () => {
  it('lists Monday’s Acumatica cheques only, on a Tuesday', async () => {
    const monEarly = await pendingAt(new Date('2026-09-27T16:00:00Z'))       // Mon 00:00 Manila
    const monNull = await pendingAt(new Date('2026-09-28T09:00:00Z'), { acumaticaStatus: null })
    await pendingAt(new Date('2026-09-27T15:59:59Z'))                         // Sun 23:59:59 Manila
    await pendingAt(new Date('2026-09-28T16:00:00Z'))                         // Tue 00:00 Manila
    await pendingAt(new Date('2026-09-21T09:00:00Z'))                         // the Monday before
    await pendingAt(new Date('2026-09-28T09:00:00Z'), { acumaticaStatus: 'Voided' })
    await pendingAt(new Date('2026-09-28T09:00:00Z'), { acumatica: false })
    const ids = (await listAutoSignCandidates(testDb, tuesdayNoon)).map((c) => c.id).sort()
    expect(ids).toEqual([monEarly.id, monNull.id].sort())
  })

  it('leaves out a reverted cheque', async () => {
    const u = await makeUser()
    const c = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    await markSigned(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-09-28T10:00:00Z') })
    await revertSignature(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-09-28T11:00:00Z') })
    expect(await listAutoSignCandidates(testDb, tuesdayNoon)).toEqual([])
  })

  it('lists nothing on any other day', async () => {
    await pendingAt(new Date('2026-09-28T09:00:00Z'))
    expect(await listAutoSignCandidates(testDb, wednesdayNoon)).toEqual([])
  })
})

describe('runAutoSign', () => {
  it('signs Monday’s cheques on Tuesday and records one run row with no checkId', async () => {
    const a = await pendingAt(new Date('2026-09-28T01:00:00Z'))
    const b = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    const tue = await pendingAt(new Date('2026-09-29T01:00:00Z'))

    const run = await runAutoSign(testDb, { now: tuesdayNoon })
    expect(run).toEqual({ outcome: 'OK', signed: 2, skipped: 0, enabled: true })
    const after = await testDb.check.findMany({ where: { id: { in: [a.id, b.id, tue.id] } }, select: { id: true, status: true } })
    expect(Object.fromEntries(after.map((r) => [r.id, r.status]))).toEqual({
      [a.id]: 'SIGNED', [b.id]: 'SIGNED', [tue.id]: 'SIGNATURE_PENDING',
    })
    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ checkId: null, actorType: 'SYSTEM' })
    expect(rows[0].details).toMatchObject({ outcome: 'OK', signed: 2, enabled: true })
  })

  it('is IDLE on a non-Tuesday and signs nothing', async () => {
    const c = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    expect(await runAutoSign(testDb, { now: wednesdayNoon })).toEqual({ outcome: 'IDLE', signed: 0, skipped: 0, enabled: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('is DISABLED when the setting is 0', async () => {
    await testDb.setting.create({ data: { key: 'autoSign.mondayEnabled', value: '0' } })
    const c = await pendingAt(new Date('2026-09-28T09:00:00Z'))
    expect(await runAutoSign(testDb, { now: tuesdayNoon })).toEqual({ outcome: 'DISABLED', signed: 0, skipped: 0, enabled: false })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('stops at the deadline as FAILED, naming what is left', async () => {
    await pendingAt(new Date('2026-09-28T09:00:00Z'))
    const run = await runAutoSign(testDb, { now: tuesdayNoon, deadline: new Date(0) })
    expect(run.outcome).toBe('FAILED')
    expect(run.error).toMatch(/1 cheque\(s\) still due/)
  })
})

describe('getLastAutoSign', () => {
  it('reads back the newest run, with enabled', async () => {
    await runAutoSign(testDb, { now: wednesdayNoon })
    expect(await getLastAutoSign(testDb)).toMatchObject({ outcome: 'IDLE', enabled: true })
  })
})
```

- [ ] **Step 3: Run, expect FAIL**

Run: `node node_modules/vitest/vitest.mjs run tests/actions/auto-sign.test.ts tests/sync/auto-sign.test.ts`
Expected: FAIL (old signatures).

- [ ] **Step 4: Implement `autoSign`**

Replace `autoSign` in `lib/domain/actions.ts`:

```ts
/**
 * The Monday rule's write (lib/domain/auto-sign.ts). No user: `signedById`
 * stays null, because a name on a signature nobody gave is worse than none.
 * Reached only when the setting is on — the run decides that. Re-judged on
 * the row as loaded, so a cheque someone signed, reverted or cancelled after
 * the candidates were listed is skipped (null), never overwritten. No portal
 * event — `markSigned` queues none either.
 */
export async function autoSign(
  db: Db, args: { checkId: string; now: Date },
): Promise<Check | null> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    const reverted = (await tx.auditLog.count({ where: { checkId: check.id, action: SIGNATURE_REVERTED_ACTION } })) > 0
    if (!isDueForAutoSign({ ...check, reverted }, args.now, true)) return null
    assertTransition(check.status as CheckStatus, 'SIGNED')
    const { count } = await tx.check.updateMany({
      where: { id: check.id, status: 'SIGNATURE_PENDING' },
      data: { status: 'SIGNED', signedAt: args.now },
    })
    if (count === 0) return null
    await writeAudit(tx, {
      checkId: check.id,
      actorType: 'SYSTEM',
      action: AUTO_SIGNED_ACTION,
      details: { from: 'SIGNATURE_PENDING', to: 'SIGNED', rule: 'MONDAY', inAppSince: check.createdAt.toISOString() },
      remarks:
        `Signed automatically at Tuesday's run: this Acumatica cheque first reached the app on ` +
        `Monday (${check.createdAt.toISOString()}). No one signed it here, so no signing user is recorded.`,
    })
    return tx.check.findUniqueOrThrow({ where: { id: check.id } })
  })
}
```

- [ ] **Step 5: Implement the run**

In `lib/sync/auto-sign.ts`:
- import `{ AUTO_SIGN_RUN_ACTION, SIGNATURE_REVERTED_ACTION, isManilaTuesday, mondayWindow }` from `@/lib/domain/auto-sign` (drop `dueBefore`).
- Replace the header comment's first paragraph with: `THE AUTO-SIGN RUN. Called by /api/cron/sync after both tenants' syncs, at 12:00 and 18:00 Manila. It signs only on a Manila Tuesday — Monday's Acumatica cheques (lib/domain/auto-sign.ts); on every other day it records IDLE.`
- Replace the type and the two functions:

```ts
export type AutoSignRun = {
  outcome: 'OK' | 'DISABLED' | 'IDLE' | 'FAILED'
  signed: number
  /** Listed as due, then found changed inside its own transaction, or deleted before it could be signed. */
  skipped: number
  /** The setting in force; null only when it could not be read. */
  enabled: boolean | null
  error?: string
}

/** The database form of `isDueForAutoSign`; `autoSign` re-judges each row with the pure rule. */
export async function listAutoSignCandidates(db: PrismaClient, now: Date): Promise<AutoSignCandidate[]> {
  if (!isManilaTuesday(now)) return []
  const { from, to } = mondayWindow(now)
  const rows = await db.check.findMany({
    where: {
      status: 'SIGNATURE_PENDING',
      acumaticaPaymentId: { not: null },
      isCheque: true,
      // `{ not: 'Voided' }` alone would drop the nulls: SQL's <> never matches NULL.
      OR: [{ acumaticaStatus: null }, { acumaticaStatus: { not: 'Voided' } }],
      createdAt: { gte: from, lt: to },
      auditLogs: { none: { action: SIGNATURE_REVERTED_ACTION } },
    },
    select: { id: true, checkNumber: true, createdAt: true, company: { select: { code: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((r) => ({ id: r.id, checkNumber: r.checkNumber, createdAt: r.createdAt, companyCode: r.company.code }))
}
```

In `runAutoSign`: initial `run = { outcome: 'OK', signed: 0, skipped: 0, enabled: null }`; replace the settings read and branch with

```ts
    const enabled = (await loadSettings(db)).values['autoSign.mondayEnabled'] === 1
    run.enabled = enabled
    if (!enabled) {
      run.outcome = 'DISABLED'
    } else if (!isManilaTuesday(args.now)) {
      run.outcome = 'IDLE'
    } else {
      const candidates = await listAutoSignCandidates(db, args.now)
```

and the per-cheque call becomes `autoSign(tx, { checkId: c.id, now: args.now })`. In `getLastAutoSign`, replace `days: d.days ?? null` with `enabled: d.enabled ?? null`.

- [ ] **Step 6: Admin line, cron, route comment, delete the backlog script**

`app/admin/sync/page.tsx:192` — replace the OK line and add the IDLE/DISABLED wording next to it (read lines 180-200 first and keep their markup):

```tsx
            {lastAutoSign.outcome === 'OK' && <>: {n(lastAutoSign.signed)} Monday cheque(s) signed</>}
            {lastAutoSign.outcome === 'IDLE' && <>: not a Tuesday — nothing due</>}
            {lastAutoSign.outcome === 'DISABLED' && <>: switched off in settings</>}
```

(If a DISABLED line already exists, keep one.)

`vercel.json` `crons`:

```json
  "crons": [
    { "path": "/api/cron/sync", "schedule": "0 4 * * *" },
    { "path": "/api/cron/sync", "schedule": "0 10 * * *" }
  ],
```

`app/api/cron/sync/route.ts`: in the header, replace "Vercel calls this once a day — `crons` in vercel.json, `0 10 * * *` UTC, which is 18:00 Manila" with "Vercel calls this twice a day — `crons` in vercel.json, `0 4 * * *` and `0 10 * * *` UTC, 12:00 and 18:00 Manila"; replace the AUTO-SIGN paragraph with "Then AUTO-SIGN (lib/sync/auto-sign.ts): on a Manila Tuesday, the Acumatica cheques first read on the Monday become SIGNED; on any other day the run records IDLE. It runs even when a tenant failed, and its own failure also turns the response 500." Change no code.

```bash
git rm scripts/auto-sign-backlog.ts
```

Then `grep -rn "auto-sign-backlog" tests scripts lib app` — if a test imports it, delete that test file with `git rm` as well.

- [ ] **Step 7: Cron-route test**

Read `tests/sync/cron-route.test.ts` around line 150-170. Any case that seeds a pending cheque "N days old" and expects it signed: change it to seed `createdAt = 2026-09-28T09:00:00Z` and fake the clock to `2026-09-29T04:00:00Z` with `vi.useFakeTimers({ now: new Date('2026-09-29T04:00:00Z'), toFake: ['Date'] })` / `vi.useRealTimers()` in `afterEach`. A case that only asserts `autoSign.outcome === 'OK'` on an arbitrary day must accept `'IDLE'`: `expect(['OK', 'IDLE']).toContain(...)` is not acceptable — fix the clock instead so the expectation is exact.

- [ ] **Step 8: Run, type-check**

Run: `node node_modules/vitest/vitest.mjs run tests/actions/auto-sign.test.ts tests/sync/auto-sign.test.ts tests/sync/cron-route.test.ts tests/domain/auto-sign.test.ts tests/settings/registry.test.ts tests/settings/read.test.ts`
Expected: PASS.
Run: `grep -rn "afterDays\|dueBefore" app lib components scripts tests` — Expected: no output.
Run: `node node_modules/typescript/bin/tsc --noEmit` — Expected: no output.

- [ ] **Step 9: Commit (Tasks 2 and 3 together)**

```bash
git add -A lib/domain/auto-sign.ts lib/domain/actions.ts lib/settings lib/sync/auto-sign.ts app/admin/sync/page.tsx app/api/cron/sync/route.ts vercel.json tests docs/superpowers/specs/2026-10-01-signing-schedule-apv-and-table-design.md
git commit -m "feat(auto-sign): Monday's Acumatica cheques sign at Tuesday 12:00; second cron; ON/OFF setting"
```

---

### Task 4: SIGN ALL — query, action, confirmation

**Files:**
- Modify: `lib/queries.ts` (after `listTodaysReleaseIds`)
- Modify: `lib/dashboard-view.ts` (`LinkState`, `query`, two hrefs)
- Modify: `app/checks/bulk-actions.ts`
- Create: `components/SignAllConfirm.tsx`
- Modify: `app/page.tsx` (LIST screen)
- Test: `tests/queries.test.ts`, `tests/dashboard-view.test.ts`, `tests/actions/bulk-actions.test.ts`

**Interfaces:**
- Consumes: `markSigned` (existing), `SummaryNarrowing`, `buildWhere`, `CurrencyTotal`.
- Produces: `getPendingSignature(db: Db, narrow?: SummaryNarrowing): Promise<{ count: number; totalsByCurrency: CurrencyTotal[] }>`; `listPendingSignatureIds(db: Db, narrow?: SummaryNarrowing): Promise<string[]>`.
- Produces: `signAllConfirmHref(sel: DashboardSelection): string`, `signAllCancelHref(sel: DashboardSelection): string`.
- Produces: `signAllPendingAction(_prev: BulkActionResult | null, formData: FormData): Promise<BulkActionResult>`.

The set: `status = SIGNATURE_PENDING`, `isIncomplete = false`, `isCheque = true`, narrowed by company/bank/eligibility. Non-cheques are left out of the set (so the confirmed count is the count that can be signed) and stated on screen by the page as "N NON-CHEQUE PAYMENTS (DEBIT ADV, CASH) ARE NOT SIGNED". SIGN ALL is offered only when the LIST is on SIGNATURE PENDING with no search and the incomplete toggle off — otherwise the set would differ from the rows shown.

- [ ] **Step 1: Failing query test**

Append to `tests/queries.test.ts` (it already imports `testDb`, `resetDb`, `makeCheck`; add the two new names to its `@/lib/queries` import):

```ts
describe('SIGN ALL set', () => {
  it('is pending, real cheques with an amount, narrowed', async () => {
    const a = await makeCheck({ status: 'SIGNATURE_PENDING', amount: '100.00' })
    const b = await makeCheck({ status: 'SIGNATURE_PENDING', amount: '250.50' })
    await makeCheck({ status: 'SIGNATURE_PENDING', isCheque: false, amount: '9.00' })
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: null })
    await makeCheck({ status: 'SIGNED', amount: '1.00' })

    expect((await listPendingSignatureIds(testDb)).sort()).toEqual([a.id, b.id].sort())
    const s = await getPendingSignature(testDb)
    expect(s.count).toBe(2)
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '350.5', count: 2 }])

    expect(await listPendingSignatureIds(testDb, { companyId: a.companyId })).toContain(a.id)
    expect(await getPendingSignature(testDb, { companyId: 'no-such-company' })).toEqual({ count: 0, totalsByCurrency: [] })
  })
})
```

If `makeCheck` gives every cheque the same company, the `companyId` line still pins narrowing via the no-such-company case. Check the Decimal string form other tests in the file expect (`'350.5'` vs `'350.50'`) and match it.

- [ ] **Step 2: Failing view test**

Append to `tests/dashboard-view.test.ts` (import the two hrefs; reuse the file's existing selection builder — read its top to find it, e.g. `sel({...})`):

```ts
describe('SIGN ALL links', () => {
  it('confirm keeps the view and the narrowing and adds confirm=sign', () => {
    const s = { status: 'SIGNATURE_PENDING' as const, showAll: false, incomplete: false, live: false, base: { company: 'c1' } }
    expect(signAllConfirmHref(s)).toBe('/?company=c1&status=SIGNATURE_PENDING&confirm=sign')
    expect(signAllCancelHref(s)).toBe('/?company=c1&status=SIGNATURE_PENDING')
  })
})
```

- [ ] **Step 3: Failing action tests**

Append to `tests/actions/bulk-actions.test.ts`:

```ts
describe('signAllPendingAction', () => {
  const confirmFd = (count: number, extra: Record<string, string> = {}) =>
    fd([], { confirm: 'sign', expectedCount: String(count), ...extra })

  it('signs the whole pending set the server computes, one audit row each', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const b = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const other = await makeCheck({ status: 'SIGNED' })
    const r = await signAllPendingAction(null, confirmFd(2))
    expect(r).toMatchObject({ ok: true, succeeded: 2, failed: 0 })
    for (const id of [a.id, b.id]) {
      expect((await testDb.check.findUniqueOrThrow({ where: { id } })).status).toBe('SIGNED')
      expect(await testDb.auditLog.count({ where: { checkId: id, action: 'marked_signed' } })).toBe(1)
    }
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('SIGNED')
  })

  it('ignores ids sent by the browser', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const p = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const f = confirmFd(1); f.append('checkId', ready.id)
    expect(await signAllPendingAction(null, f)).toMatchObject({ ok: true, succeeded: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('SIGNED')
  })

  it('refuses without the confirmation field', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    expect(await signAllPendingAction(null, fd([], { expectedCount: '1' }))).toMatchObject({ ok: false })
  })

  it('refuses when more are pending than were confirmed', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    const r = await signAllPendingAction(null, confirmFd(1))
    expect(r).toMatchObject({ ok: false })
    expect(await testDb.check.count({ where: { status: 'SIGNED' } })).toBe(0)
  })

  it('refuses an unrecognised filter rather than widening', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    expect(await signAllPendingAction(null, confirmFd(1, { company: 'not-a-company' }))).toMatchObject({ ok: false })
    expect(await signAllPendingAction(null, confirmFd(1, { company: ' ' }))).toMatchObject({ ok: false })
    expect(await testDb.check.count({ where: { status: 'SIGNED' } })).toBe(0)
  })

  it('is open to a FINANCE_USER', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_USER'
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    expect(await signAllPendingAction(null, confirmFd(1))).toMatchObject({ ok: true, succeeded: 1 })
  })
})
```

- [ ] **Step 4: Run, expect FAIL**

Run: `node node_modules/vitest/vitest.mjs run tests/queries.test.ts tests/dashboard-view.test.ts tests/actions/bulk-actions.test.ts -t "SIGN ALL|signAllPendingAction"`
Expected: FAIL on missing exports.

- [ ] **Step 5: Implement the query**

`lib/queries.ts`, after `listTodaysReleaseIds`:

```ts
/**
 * The set SIGN ALL acts on (client, 2026-10-01): every SIGNATURE_PENDING
 * cheque with an amount, narrowed by exactly the three dropdowns, named one by
 * one for the reason `todaysReleaseFilter` gives. Non-cheques are left out —
 * `markSigned` refuses them, and a confirmed count that includes payments that
 * cannot be signed is a count that will not match what moved.
 */
function pendingSignatureWhere(narrow: SummaryNarrowing): Prisma.CheckWhereInput {
  return {
    ...buildWhere({
      status: 'SIGNATURE_PENDING', incomplete: false,
      companyId: narrow.companyId, cashAccountId: narrow.cashAccountId, eligibility: narrow.eligibility,
    }),
    isCheque: true,
  }
}

export async function getPendingSignature(db: Db, narrow: SummaryNarrowing = {}): Promise<TodaysRelease> {
  const grouped = await db.check.groupBy({
    by: ['currency'], _sum: { amount: true }, _count: { _all: true }, where: pendingSignatureWhere(narrow),
  })
  return {
    count: grouped.reduce((n, g) => n + g._count._all, 0),
    totalsByCurrency: grouped.map((g) => ({ currency: g.currency, total: g._sum.amount?.toString() ?? null, count: g._count._all })),
  }
}

/** Read here, never from the form — the same reason as `listTodaysReleaseIds`. Oldest cheque first. */
export async function listPendingSignatureIds(db: Db, narrow: SummaryNarrowing = {}): Promise<string[]> {
  const rows = await db.check.findMany({
    where: pendingSignatureWhere(narrow),
    orderBy: [{ checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: { id: true },
  })
  return rows.map((r) => r.id)
}
```

`buildWhere` is declared later in the file as a `function` declaration, so it is hoisted; no reordering needed.

- [ ] **Step 6: Implement the hrefs**

`lib/dashboard-view.ts`: `type LinkState = ViewState & { incomplete: boolean; live?: boolean; confirmRelease?: boolean; confirmSign?: boolean }`; in `query`, after the `confirmRelease` line: `if (view.confirmSign) qs.set('confirm', 'sign')`. After `releaseCancelHref`:

```ts
/** SIGN ALL's confirmation: the same list, with `confirm=sign`. */
export function signAllConfirmHref(sel: DashboardSelection): string {
  return href(sel.base, { status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete, confirmSign: true })
}

/** CANCEL: the same list, confirmation dropped. */
export function signAllCancelHref(sel: DashboardSelection): string {
  return href(sel.base, { status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete })
}
```

- [ ] **Step 7: Implement the action**

`app/checks/bulk-actions.ts`: rename `readReleaseNarrowing` to `readNarrowing` (both call sites) and change its doc's first line to "The narrowing the screen was showing when an ALL action was pressed". Import `listPendingSignatureIds`. Add after `releaseAllReadyAction`:

```ts
/**
 * SIGN ALL (client, 2026-10-01: "All checks on Tuesday to Friday will have a 1
 * click button"). The RELEASE ALL pattern, for a lower-risk act that can be
 * undone (`revertSignature`): open to every Finance user, but the confirmation
 * is still a field on the request, the count read is submitted back, and the
 * set is the server's, never ids from the form. `useActionState`'s signature,
 * for the same no-JavaScript reason as `releaseAllReadyAction`.
 */
export async function signAllPendingAction(
  _previousState: BulkActionResult | null,
  formData: FormData,
): Promise<BulkActionResult> {
  const user = await requireUser()

  if (str(formData, 'confirm') !== 'sign') {
    return { ok: false, message: 'This was not confirmed. Press SIGN ALL and confirm the figures first.' }
  }
  const rawExpected = str(formData, 'expectedCount')
  const expectedCount = /^\d+$/.test(rawExpected) ? Number(rawExpected) : Number.NaN
  if (!Number.isInteger(expectedCount)) {
    return { ok: false, message: 'This could not be confirmed. Press SIGN ALL again and re-read the figures.' }
  }

  const settings = await loadSettings(prisma)
  const cap = settings.values['caps.bulkSelection']
  const narrow = await readNarrowing(formData)
  if (narrow === null) {
    return { ok: false, message: 'The filter on screen was not recognised. Press SIGN ALL again and re-read the figures.' }
  }
  const checkIds = await listPendingSignatureIds(prisma, narrow)
  if (checkIds.length === 0) return { ok: false, message: 'No cheques are waiting for a signature.' }
  if (checkIds.length > expectedCount) {
    return {
      ok: false,
      message: `${checkIds.length} cheques are pending now, but ${expectedCount} were on screen when you confirmed. Re-read and confirm the current figures.`,
    }
  }

  const now = new Date()
  const outcomes: BulkOutcome[] = []
  for (const batch of chunkSelection(checkIds, cap)) {
    const selection = parseSelection(batch, cap)
    if (!selection.ok) return { ok: false, message: selection.message }
    const batchResult = await runEach(prisma, selection.checkIds, (checkId) =>
      markSigned(prisma, { checkId, userId: user.id, now }))
    if (!batchResult.ok) return batchResult
    outcomes.push(...batchResult.outcomes)
  }
  const succeeded = outcomes.filter((o) => o.ok).length
  return { ok: true, succeeded, failed: outcomes.length - succeeded, outcomes }
}
```

- [ ] **Step 8: The confirm component**

Create `components/SignAllConfirm.tsx` — a copy of `components/ReleaseAllConfirm.tsx` with these differences only: imports `signAllPendingAction`; prop type `SignNarrowing = { company: string; cashAccount: string; eligibility: string }`; hidden `confirm` value `sign`; button classes `bg-navy … hover:bg-navy/90`; button text `{pending ? 'SIGNING…' : \`YES — SIGN ALL ${count}\`}`; success text `{done.succeeded} OF {done.outcomes.length} CHEQUE(S) SIGNED.`; failure heading `… WERE NOT SIGNED:`; back link text `BACK TO THE LIST`. Its header comment: one paragraph — "SIGN ALL's confirm form. The confirmation is the server-rendered `?confirm=sign` step on the SIGNATURE PENDING list; this component only submits it and reports per cheque. See `signAllPendingAction`."

- [ ] **Step 9: Wire the page**

`app/page.tsx` LIST branch:
- import `getPendingSignature` from `@/lib/queries`, `signAllConfirmHref, signAllCancelHref` from `@/lib/dashboard-view`, `SignAllConfirm` from `@/components/SignAllConfirm`.
- `const signAllOffered = status === 'SIGNATURE_PENDING' && !showAll && !q && !incomplete`
- add a fifth entry to the LIST `Promise.all`: `signAllOffered ? getPendingSignature(prisma, narrow) : Promise.resolve(null)`, destructured as `pendingSign`. The non-cheque count is `matching - pendingSign.count`: with no search and the toggle off, the list is exactly the pending cheques with an amount under the same narrowing, so the difference is exactly the non-cheques.
- render, directly below the header bar:

```tsx
      {pendingSign && pendingSign.count > 0 && (
        <div className="rounded-2xl bg-white px-4 py-3 ring-1 ring-hairline">
          {params.confirm === 'sign' ? (
            <>
              <p className="text-sm font-semibold tracking-wide text-slate-900">
                SIGN {pendingSign.count.toLocaleString('en-PH')} CHEQUE{pendingSign.count === 1 ? '' : 'S'}
                {pendingSign.totalsByCurrency.map((t) => ` · ${t.currency} ${t.total === null ? '—' : formatMoney(t.total)}`).join('')}?
              </p>
              <SignAllConfirm
                count={pendingSign.count}
                cancelHref={signAllCancelHref(selection)}
                narrow={{ company: companyId ?? '', cashAccount: cashAccountId ?? '', eligibility: eligibility ?? '' }}
              />
            </>
          ) : (
            <Link href={signAllConfirmHref(selection)}
              className="inline-block rounded-lg bg-navy px-4 py-2 text-sm font-semibold tracking-wide text-white hover:bg-navy/90">
              SIGN ALL {pendingSign.count.toLocaleString('en-PH')}
            </Link>
          )}
          {matching > pendingSign.count && (
            <p className="mt-2 text-xs text-slate-500">
              {(matching - pendingSign.count).toLocaleString('en-PH')} NON-CHEQUE PAYMENT(S) (DEBIT ADV, CASH) IN THIS VIEW ARE NOT SIGNED.
            </p>
          )}
        </div>
      )}
```

Use the money formatter the page already uses for totals (`grep -n "formatMoney\|fmtMoney\|lib/money" app/page.tsx components/TodaysReleasePanel.tsx`) — replace `formatMoney` with that name. Confirm `resolveDashboardQuery` does not reject or reinterpret `confirm=sign` (it passes through `params.confirm`, used only by the TOTALS panel's `=== 'release'`), and that `dashboardScreen` still returns LIST for `status=SIGNATURE_PENDING&confirm=sign` — add that as one case in `tests/dashboard-view.test.ts` if `confirm` is a key `dashboardScreen` reads.

- [ ] **Step 10: Run, type-check**

Run: `node node_modules/vitest/vitest.mjs run tests/queries.test.ts tests/dashboard-view.test.ts tests/actions/bulk-actions.test.ts`
Expected: PASS.
Run: `node node_modules/typescript/bin/tsc --noEmit` — Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add lib/queries.ts lib/dashboard-view.ts app/checks/bulk-actions.ts components/SignAllConfirm.tsx app/page.tsx tests/queries.test.ts tests/dashboard-view.test.ts tests/actions/bulk-actions.test.ts
git commit -m "feat(dashboard): SIGN ALL on the SIGNATURE PENDING list, server-confirmed"
```

---

### Task 5: REVERT TO SIGNATURE PENDING on screen

**Files:**
- Modify: `app/checks/actions.ts` (add `revertSignatureAction`)
- Modify: `app/checks/bulk-actions.ts` (add `bulkRevertToPendingAction`)
- Modify: `lib/row-receipts.ts` (add `signedIds`)
- Modify: `components/BulkActionBar.tsx`
- Modify: `app/checks/[id]/page.tsx`
- Test: `tests/actions/bulk-actions.test.ts`, `tests/actions/server-actions.test.ts`, `tests/row-receipts.test.ts`

**Interfaces:**
- Consumes: `revertSignature` (Task 1).
- Produces: `revertSignatureAction(formData: FormData): Promise<ActionResult>`; `bulkRevertToPendingAction(formData: FormData): Promise<BulkActionResult>`; `signedIds(rows: readonly RowFacts[]): string[]`.

- [ ] **Step 1: Failing tests**

`tests/row-receipts.test.ts` (reuse the file's row builder; read its top for the name):

```ts
describe('signedIds', () => {
  it('is the ticked SIGNED rows only', () => {
    const rows = [row({ id: 'a', status: 'SIGNED' }), row({ id: 'b', status: 'SIGNATURE_PENDING' }), row({ id: 'c', status: 'READY_FOR_RELEASE' })]
    expect(signedIds(rows)).toEqual(['a'])
  })
})
```

`tests/actions/bulk-actions.test.ts`:

```ts
describe('bulkRevertToPendingAction', () => {
  it('reverts the ticked SIGNED cheques, refuses the rest per cheque, reason optional', async () => {
    const { bulkRevertToPendingAction } = await import('@/app/checks/bulk-actions')
    const s = await makeCheck({ status: 'SIGNED' })
    const r = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await bulkRevertToPendingAction(fd([s.id, r.id]))
    expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('SIGNATURE_PENDING')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('READY_FOR_RELEASE')
    expect(outcomeFor(result, r.id).ok).toBe(false)
  })

  it('passes the shared reason to each audit row', async () => {
    const { bulkRevertToPendingAction } = await import('@/app/checks/bulk-actions')
    const s = await makeCheck({ status: 'SIGNED' })
    await bulkRevertToPendingAction(fd([s.id], { reason: 'Signed too early' }))
    const row = await testDb.auditLog.findFirstOrThrow({ where: { checkId: s.id, action: 'signature_reverted' } })
    expect(row.remarks).toBe('Signed too early')
  })
})
```

`tests/actions/server-actions.test.ts` (it already mocks auth/db; mirror its `signAction` case):

```ts
describe('revertSignatureAction', () => {
  it('lets a FINANCE_USER revert a SIGNED cheque', async () => {
    const { revertSignatureAction } = await import('@/app/checks/actions')
    const c = await makeCheck({ status: 'SIGNED' })
    const f = new FormData(); f.set('checkId', c.id)
    expect(await revertSignatureAction(f)).toEqual({ ok: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node node_modules/vitest/vitest.mjs run tests/row-receipts.test.ts tests/actions/bulk-actions.test.ts tests/actions/server-actions.test.ts -t "signedIds|bulkRevertToPendingAction|revertSignatureAction"`
Expected: FAIL on missing exports.

- [ ] **Step 3: Implement**

`lib/row-receipts.ts`, after `revertableIds`:

```ts
/** The ticked rows REVERT TO PENDING acts on: signed, not yet on the release list. */
export function signedIds(rows: readonly RowFacts[]): string[] {
  return rows.filter((r) => r.status === 'SIGNED').map((r) => r.id)
}
```

`app/checks/actions.ts` — add `revertSignature` to the `@/lib/domain/actions` import and, after `revertAction`:

```ts
export async function revertSignatureAction(formData: FormData): Promise<ActionResult> {
  // Every Finance user (client, 2026-10-01). The reason is optional.
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  return run(checkId, () => revertSignature(prisma, {
    checkId, userId: user.id, reason: str(formData, 'reason'), now: new Date(),
  }))
}
```

`app/checks/bulk-actions.ts` — add `revertSignature` to the domain import and, after `bulkRevertToSignedAction`:

```ts
/**
 * SIGNED back to SIGNATURE_PENDING, from the list (client, 2026-10-01). Every
 * Finance user. The reason is optional and shared by the batch.
 */
export async function bulkRevertToPendingAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }
  const reason = str(formData, 'reason')
  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) =>
    revertSignature(prisma, { checkId, userId: user.id, reason, now }))
}
```

`components/BulkActionBar.tsx`: import `bulkRevertToPendingAction` and `signedIds`; `const signed = signedIds(selectedRows)`; after the REVERT TO SIGNED block:

```tsx
        {/* SIGNED back to SIGNATURE PENDING (client, 2026-10-01). Every
            Finance user; the reason is optional. A cheque reverted here is
            never auto-signed again. */}
        {signed.length > 0 && (
          <button
            type="button" disabled={disabled}
            onClick={() => {
              if (!confirm(`Revert ${signed.length} cheque(s) to SIGNATURE PENDING?`)) return
              submit(bulkRevertToPendingAction, signed, revertReason.trim() ? [['reason', revertReason.trim()]] : [])
            }}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            REVERT TO PENDING ({signed.length})
          </button>
        )}
```

(The REASON box is rendered only when `revertable.length > 0`; leaving it unshown for SIGNED-only selections is fine because the reason is optional.)

`app/checks/[id]/page.tsx`: import `revertSignatureAction`; after the `check.status === 'SIGNED'` `ReadyForReleaseForm` block:

```tsx
        {/* SIGNED back to SIGNATURE PENDING (client, 2026-10-01). Every
            Finance user; the reason is optional. Never auto-signed again. */}
        {check.status === 'SIGNED' && (
          <ActionForm
            action={revertSignatureAction}
            checkId={check.id}
            label="REVERT TO SIGNATURE PENDING"
            className="block rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy transition hover:bg-ground disabled:opacity-50"
          >
            <label className="block text-[11px] font-semibold tracking-widest text-slate-400">REASON (OPTIONAL)</label>
            <input name="reason" placeholder="Signed in error"
              className="h-10 w-full max-w-md rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" />
          </ActionForm>
        )}
```

- [ ] **Step 4: Run, type-check**

Run: `node node_modules/vitest/vitest.mjs run tests/row-receipts.test.ts tests/actions/bulk-actions.test.ts tests/actions/server-actions.test.ts`
Expected: PASS.
Run: `node node_modules/typescript/bin/tsc --noEmit` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/row-receipts.ts app/checks/actions.ts app/checks/bulk-actions.ts components/BulkActionBar.tsx "app/checks/[id]/page.tsx" tests/row-receipts.test.ts tests/actions/bulk-actions.test.ts tests/actions/server-actions.test.ts
git commit -m "feat(checks): REVERT TO SIGNATURE PENDING on the cheque page and the list"
```

---

### Task 6: Verify in the browser, document, full suite

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Browser check (dev server against the TEST database only)**

The repo `.env` is production. Do not start the dev server with it. If `.claude/launch.json` has no configuration that sets `DATABASE_URL` to the test URL, skip this step and say so in the hand-off; do not improvise one. If it exists: open `/?status=SIGNATURE_PENDING`, confirm the SIGN ALL N link, open it, confirm the count/total line and CANCEL; open a SIGNED cheque and confirm the REVERT TO SIGNATURE PENDING form. Screenshot both.

- [ ] **Step 2: CLAUDE.md**

- In "What is missing" item 1, replace the "Auto-sign rides on the same run" paragraph with: "**Auto-sign** (rewritten 2026-10-01, spec `2026-10-01-signing-schedule-apv-and-table-design.md`): the cron runs at 12:00 and 18:00 Manila (`0 4 * * *`, `0 10 * * *`); on a Manila Tuesday only, an Acumatica cheque first read on the Monday before and still at SIGNATURE_PENDING becomes SIGNED (`signedById` null, one `auto_signed` row, no portal event). Every other pending cheque is signed by SIGN ALL on the SIGNATURE PENDING list (server-confirmed like RELEASE ALL, every Finance user). `SIGNED → SIGNATURE_PENDING` is `revertSignature`, every Finance user, reason optional, one `signature_reverted` row; a reverted cheque is never auto-signed again. Setting `autoSign.mondayEnabled` (1/0) replaces `autoSign.afterDays`. Every run writes one `auto_sign_run` row — `IDLE` on a non-Tuesday."
- In "A threshold is a setting…", replace `autoSign.afterDays` with `autoSign.mondayEnabled`.
- Remove the two `scripts/auto-sign-backlog.ts` lines from Commands.

- [ ] **Step 3: Full suite (background, ~30 min)**

Run (Bash, `run_in_background: true`): `node node_modules/vitest/vitest.mjs run > "$TEMP/suite-part-a.log" 2>&1; tail -20 "$TEMP/suite-part-a.log"`
Expected: 0 failures. Record the count in CLAUDE.md's State paragraph in the existing style ("N tests across M files (measured, full run 2026-10-0X…)"), with the per-file deltas from Tasks 1-5.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: Monday auto-sign, SIGN ALL, revert signature; suite count"
```

- [ ] **Step 5: Deployment note for the user (do not do it)**

Deploying Part A needs: no migration; the new `vercel.json` cron registers on deploy. After deploying, the first Tuesday 12:00 run should show `auto_sign_run` OK on `/admin/sync`; any other day, IDLE.
