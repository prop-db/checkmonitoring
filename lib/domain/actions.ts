import type {
  Check, Prisma, PrismaClient, PortalEventKind,
  ClearingStatus as PrismaClearing,
} from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from './errors'
import { portalRoute, type Eligibility } from './eligibility'
import { checkDeletable } from './incomplete'
import { checkReceipt, normaliseReceipt, hasReceipt, type Receipt, type ReceiptType } from './receipt'
import { checkReleaseReversible } from './reversal'
import {
  assertTransition, assertClearing, assertReleasable, checkReadyForRelease,
  type CheckStatus, type ClearingStatus,
} from './check-status'

type Db = PrismaClient | Prisma.TransactionClient

// Every action runs in one transaction that updates the check AND appends its
// audit row. A caller can pass an existing transaction client; otherwise we
// open our own.
async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return (db as PrismaClient).$transaction(fn)
  }
  return fn(db as Prisma.TransactionClient)
}

/**
 * The outbox's idempotency key: one instruction per (check, kind, acting
 * timestamp).
 *
 * The third segment is the action's own `now`, and that choice is the whole
 * design. A revert genuinely retracts what the portal was told, so marking the
 * cheque ready again afterwards is a NEW instruction the supplier has to hear
 * about — a fresh `now` gives it a fresh key, and the outbox queues it instead
 * of discarding it as already-sent. A repeat submit of the *same* action never
 * reaches here at all: `TRANSITIONS` in check-status.ts has no
 * READY_FOR_RELEASE -> READY_FOR_RELEASE edge, so it throws first. The unique
 * key is our own guarantee that the queue holds no duplicate work; it is not the
 * last line of defence against double-notifying a supplier, because the portal
 * holds a notify-exactly-once latch of its own (confirmed from its source,
 * 2026-09-04). Both exist; neither licenses relaxing the other.
 *
 * Do NOT take the timestamp from `check.readyAt`. `load()` snapshots the row
 * BEFORE the update, and `revertAvailability` sets `readyAt` back to null, so at
 * every call site it is null and a `check.readyAt ?? now` would be a branch that
 * can never be taken — exactly the kind a future reader "tidies" into something
 * that quietly changes the key.
 *
 * Deliberately not exported. The tests spell the format out as a literal, so
 * changing it fails a test rather than being mirrored by a shared helper that
 * would pin nothing.
 */
function portalEventKey(checkId: string, kind: PortalEventKind, now: Date): string {
  return `${checkId}:${kind}:${now.toISOString()}`
}

async function load(tx: Prisma.TransactionClient, checkId: string) {
  const check = await tx.check.findUnique({
    where: { id: checkId },
    include: { cashAccount: true },
  })
  if (!check) throw new DomainError('NOT_FOUND', 'Check not found.')
  return check
}

export async function markSigned(
  db: Db, args: { checkId: string; userId: string; now: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertReleasable({ isCheque: check.isCheque })
    assertTransition(check.status as CheckStatus, 'SIGNED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: { status: 'SIGNED', signedById: args.userId, signedAt: args.now },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'marked_signed',
    })
    return updated
  })
}

export async function markReadyForRelease(
  db: Db,
  args: { checkId: string; userId: string; availablePickupDate: Date | null; now: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)

    // Blocking guards. A failure aborts before anything is written.
    const guard = checkReadyForRelease({
      status: check.status as CheckStatus,
      checkNumber: check.checkNumber,
      payeeName: check.payeeName,
      amount: check.amount?.toString() ?? null,
      checkDate: check.checkDate,
      cashAccountCode: check.cashAccount?.code ?? null,
      availablePickupDate: args.availablePickupDate,
      isCheque: check.isCheque,
    })
    if (!guard.ok) throw new DomainError(guard.code, guard.message)

    assertTransition(check.status as CheckStatus, 'READY_FOR_RELEASE')

    // Routing condition, NOT a guard: an INTERNAL check still changes status,
    // it simply never produces a portal event.
    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'READY_FOR_RELEASE',
        readyById: args.userId,
        readyAt: args.now,
        availablePickupDate: args.availablePickupDate,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })

    if (pushes) {
      // Both fields are in REQUIRED_FIELDS, so the guard 30 lines above has
      // already proved them non-blank and this cannot fire. It is asserted
      // rather than defaulted because the alternative — `?? null`, as used at
      // the guard call site where a null is a legitimate input — would make a
      // portal event announcing a cheque with no amount, payable to nobody,
      // *representable*. If that guard were ever weakened, such a payload
      // would be published to a supplier instead of stopping here.
      //
      // Do not "simplify" this to `??`. This payload leaves the system, and a
      // financial figure on its way to an outside party is the wrong place to
      // be forgiving. Failing loudly here costs one blocked release; the
      // permissive version costs a supplier being told a cheque is ready and
      // being shown nothing where the amount should be.
      if (check.amount === null || check.payeeName === null) {
        throw new DomainError(
          'INCOMPLETE_PORTAL_PAYLOAD',
          'This check cannot be published to the supplier portal because its amount or payee is missing.',
        )
      }
      await tx.portalEvent.create({
        data: {
          checkId: check.id,
          direction: 'OUT',
          kind: 'MARK_AVAILABLE',
          status: 'PENDING',
          idempotencyKey: portalEventKey(check.id, 'MARK_AVAILABLE', args.now),
          payload: {
            action: 'MARK_AVAILABLE',
            checkNumber: check.checkNumber,
            payeeName: check.payeeName,
            amount: check.amount.toString(),
            availablePickupDate: args.availablePickupDate?.toISOString() ?? null,
          },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'ready_for_release',
      details: { availablePickupDate: args.availablePickupDate?.toISOString() ?? null, portalPush: pushes },
      remarks: `Pickup ${args.availablePickupDate?.toISOString().slice(0, 10) ?? 'unset'}`,
    })

    return updated
  })
}

export async function revertAvailability(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to revert availability.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'SIGNED')

    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null

    // Clearing the confirmation matters: a stale pickup date on a check that is
    // no longer available shows up as a phantom schedule on the dashboard.
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'SIGNED',
        availablePickupDate: null,
        scheduledPickupDate: null,
        scheduledPickupTime: null,
        pickupRep: null,
        portalConfirmedAt: null,
        readyById: null,
        readyAt: null,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })

    if (pushes) {
      await tx.portalEvent.create({
        data: {
          checkId: check.id, direction: 'OUT', kind: 'REVERT', status: 'PENDING',
          idempotencyKey: portalEventKey(check.id, 'REVERT', args.now),
          payload: { action: 'REVERT', checkNumber: check.checkNumber },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'reverted_availability', remarks: args.reason,
    })

    return updated
  })
}

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
    // `assertTransition` alone cannot tell this reversal apart from the
    // forward edge `markReadyForRelease` uses: READY_FOR_RELEASE is reachable
    // from SIGNED just as it is from RELEASED (`check-status.ts`'s ladder).
    // This action IS the RELEASED -> READY_FOR_RELEASE edge specifically, so
    // the starting status is checked directly before falling through to the
    // same ladder check every other action uses.
    if (check.status !== 'RELEASED') {
      throw new DomainError('ILLEGAL_TRANSITION', `Cannot move a check from ${check.status} to READY_FOR_RELEASE.`)
    }
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

export async function applyPickupConfirmation(
  db: Db,
  args: { checkId: string; pickupDate: Date; pickupTime?: string; pickupRep?: string; confirmedAt: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    // A portal message may only move READY_FOR_RELEASE -> SCHEDULED. It can
    // never release a check: physical release is Finance-only.
    assertTransition(check.status as CheckStatus, 'SCHEDULED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'SCHEDULED',
        scheduledPickupDate: args.pickupDate,
        scheduledPickupTime: args.pickupTime ?? null,
        pickupRep: args.pickupRep ?? null,
        portalConfirmedAt: args.confirmedAt,
      },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'SYSTEM', action: 'supplier_pickup_confirmed',
      details: { pickupDate: args.pickupDate.toISOString(), pickupTime: args.pickupTime ?? null },
      remarks: args.pickupDate.toISOString().slice(0, 10),
    })
    return updated
  })
}

/**
 * The audit row a receipt gets, wherever it was entered.
 *
 * Written for every receipt and only for a receipt, so "who recorded this OR,
 * and when" is one query rather than a reading of two different actions'
 * details. `withRelease` is the whole reason it is a shared helper: a receipt
 * handed over at the counter and a receipt typed in the next morning are
 * different events, and the difference has to be recorded at the time — it
 * cannot be reconstructed afterwards from timestamps, because a release and a
 * late entry on the same afternoon look identical.
 *
 * Amounts are never in here. A receipt is a reference, not a figure.
 */
const RECEIPT_REMARK_LABELS: Record<ReceiptType | 'UNSTATED', string> = {
  OR: 'Official Receipt',
  CR: 'Collection Receipt',
  UNSTATED: 'Receipt of unstated kind',
}

async function writeReceiptAudit(
  tx: Prisma.TransactionClient,
  args: { checkId: string; userId: string; receipt: Receipt; withRelease: boolean; now: Date },
): Promise<void> {
  await writeAudit(tx, {
    checkId: args.checkId,
    actorType: 'USER',
    userId: args.userId,
    action: 'receipt_recorded',
    details: {
      orNumber: args.receipt.orNumber,
      // The receipt's OWN date — the day the supplier wrote it — which is not
      // the day it was typed in. `recordedAt` below is that.
      orDate: args.receipt.orDate?.toISOString() ?? null,
      receiptType: args.receipt.receiptType,
      withRelease: args.withRelease,
      recordedAt: args.now.toISOString(),
    },
    // The null arm cannot be reached — `checkReceipt` refuses a reference with
    // no type — and is written out anyway rather than folded into the OR
    // branch. A ternary whose else-arm says "Official Receipt" would label an
    // unanswered question as an answer if the guard were ever weakened, which
    // is the one failure this whole feature is arranged to prevent.
    remarks:
      `${RECEIPT_REMARK_LABELS[args.receipt.receiptType ?? 'UNSTATED']} ` +
      `${args.receipt.orNumber}${args.withRelease ? ' (recorded at release)' : ' (added after release)'}`,
  })
}

export async function markReleased(
  db: Db,
  args: {
    checkId: string; userId: string
    /**
     * The supplier's receipt, all three optional together. The client's ruling:
     * a cheque may be released with the box empty and the receipt added later,
     * which is what RELEASE ALL at the counter depends on.
     */
    orNumber?: string; orDate?: Date; receiptType?: ReceiptType | null
    remarks?: string; now: Date
  },
): Promise<Check> {
  // Before the transaction opens, and before anything is written: a reference
  // with no type refuses the whole release rather than releasing the cheque and
  // dropping the reference on the floor.
  const guard = checkReceipt(args)
  if (!guard.ok) throw new DomainError(guard.code, guard.message)
  const receipt = normaliseReceipt(args)

  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertReleasable({ isCheque: check.isCheque })
    assertTransition(check.status as CheckStatus, 'RELEASED')

    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'RELEASED',
        releasedById: args.userId,
        releasedAt: args.now,
        orNumber: receipt.orNumber,
        orDate: receipt.orDate,
        receiptType: receipt.receiptType,
        remarks: args.remarks ?? check.remarks,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
      },
    })

    if (pushes) {
      await tx.portalEvent.create({
        data: {
          checkId: check.id,
          direction: 'OUT',
          // The third kind. This call site pre-dates Plan 3 and its plan was
          // drafted without it; the portal accepts it at POST /api/checks/:id,
          // which takes `status`, `orNumber` and `orDate` at encoder tier.
          kind: 'RELEASED',
          status: 'PENDING',
          idempotencyKey: portalEventKey(check.id, 'RELEASED', args.now),
          // `receiptType` is deliberately NOT in the payload. The portal's
          // POST /api/checks/:id takes `status`, `orNumber` and `orDate` at
          // encoder tier (evidence in docs/superpowers/specs/) and nothing
          // more; a field it does not accept is a field that can fail a
          // delivery nobody is watching. Which kind of receipt it is stays a
          // Finance fact until the portal asks for it.
          payload: {
            action: 'RELEASED',
            checkNumber: check.checkNumber,
            releasedAt: args.now.toISOString(),
            orNumber: receipt.orNumber,
          },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'released',
      remarks: args.remarks,
    })
    // In the same transaction as the release it accompanied, so a receipt can
    // never be recorded against a release that rolled back.
    if (hasReceipt(receipt)) {
      await writeReceiptAudit(tx, {
        checkId: check.id, userId: args.userId, receipt, withRelease: true, now: args.now,
      })
    }
    return updated
  })
}

/**
 * The add-it-later path, and the reason the box is allowed to be empty at all.
 *
 * The client made the receipt optional — "A cheque can be released with the box
 * empty and the receipt added later" — and an optional field with no way to
 * fill it in afterwards is not optional, it is skipped.
 *
 * **Only for a cheque that has actually been handed over.** A receipt is the
 * paper the supplier gives back when they collect, so there is nothing to
 * record before that happens. `releasedAt` is tested alongside the status, not
 * as a proxy for it: `voidCheck` leaves the release facts standing on a cheque
 * voided after release, deliberately, as the evidence it was handed over — and
 * the receipt for that hand-over is part of the same evidence.
 *
 * **It adds; it does not amend.** A cheque that already records a receipt is
 * refused, and the refusal names what is there. Overwriting would replace a
 * fact somebody entered against money that has already moved, and this path
 * exists to fill a gap rather than to correct one. If Finance ever needs a
 * correction, it should be its own action with its own reason, not this one
 * quietly widened.
 *
 * **It queues no portal event.** `markReleased` already queued RELEASED with
 * whatever the receipt was at the time — null, for every cheque that reaches
 * here — and the outbox is an append-only record of what the portal was told,
 * not a mutable draft. A late receipt therefore does not reach the supplier
 * portal; nothing does yet, since Plan 3 is paused for want of an `encoder`
 * service account, and adding a fourth `PortalEventKind` is that plan's
 * decision to make rather than this one's.
 */
export async function recordReceipt(
  db: Db,
  args: {
    checkId: string; userId: string
    orNumber: string; orDate?: Date; receiptType: ReceiptType | null
    now: Date
  },
): Promise<Check> {
  const guard = checkReceipt(args)
  if (!guard.ok) throw new DomainError(guard.code, guard.message)
  const receipt = normaliseReceipt(args)

  // Distinct from the guard above: this endpoint exists to ADD a receipt, so an
  // empty box is nothing to do rather than a silent clearing of one.
  if (!hasReceipt(receipt)) {
    throw new DomainError(
      'RECEIPT_REQUIRED',
      'Enter the receipt reference the supplier gave you. Leaving it blank records nothing.',
    )
  }

  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)

    if (check.status !== 'RELEASED' && check.releasedAt === null) {
      throw new DomainError(
        'NOT_RELEASED',
        'A supplier’s receipt can only be recorded against a cheque that has been RELEASED. ' +
        'Release the cheque first; the receipt can be entered at the same time.',
      )
    }

    if (check.orNumber !== null) {
      throw new DomainError(
        'RECEIPT_ALREADY_RECORDED',
        `This cheque already records receipt ${check.orNumber}. A recorded receipt is not ` +
        'overwritten from here — if it is wrong, raise it with a Finance Admin.',
      )
    }

    const updated = await tx.check.update({
      where: { id: check.id },
      // Only the three receipt columns. Not `status`, which is already
      // RELEASED and is not this action's to move; and emphatically not
      // `crNumber` or `clearingStatus`, which are the BANK's clearing facts.
      data: {
        orNumber: receipt.orNumber,
        orDate: receipt.orDate,
        receiptType: receipt.receiptType,
      },
    })

    await writeReceiptAudit(tx, {
      checkId: check.id, userId: args.userId, receipt, withRelease: false, now: args.now,
    })

    return updated
  })
}

export async function recordClearing(
  db: Db,
  args: {
    checkId: string; userId: string; clearingStatus: ClearingStatus
    crNumber?: string; clearedDate?: Date; now: Date
  },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertClearing(
      check.status as CheckStatus,
      check.clearingStatus as ClearingStatus,
      args.clearingStatus,
    )
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        clearingStatus: args.clearingStatus as PrismaClearing,
        crNumber: args.crNumber ?? check.crNumber,
        clearedDate: args.clearedDate ?? check.clearedDate,
      },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'clearing_recorded',
      details: { clearingStatus: args.clearingStatus, crNumber: args.crNumber ?? null },
    })
    return updated
  })
}

/**
 * The wording that makes a void after release impossible to miss in the audit
 * trail. Exported so the test asserts the shipped string rather than a copy of
 * it: this is the sentence a Finance user reads when deciding whether to ring
 * the bank, and a paraphrase that drifts is worse than no warning.
 */
export const VOID_AFTER_RELEASE_WARNING =
  'MONEY MAY ALREADY HAVE MOVED: this cheque had already been RELEASED to the payee when ' +
  'Acumatica voided it, so it may have been presented or cleared. Confirm with the bank before ' +
  'treating it as unpaid.'

/**
 * A void is an Acumatica FACT, not a Finance decision — which is the whole of
 * the difference between this and `cancelCheck`. The ERP has cancelled the
 * payment document; this system does not get a say, it only has to stop showing
 * a cheque the source of truth says no longer exists. Hence `actorType: 'SYSTEM'`
 * and no `userId`: there is no Finance user to attribute it to, and inventing
 * one would put a person's name against a decision they did not make.
 *
 * The plan said a void applies "from any non-RELEASED status". That is
 * superseded. `check-status.ts` permits RELEASED -> VOIDED deliberately: a
 * stop-payment on a cheque already handed over is a real event, and this system
 * disagreeing with the ERP is the worse failure. CANCELLED remains terminal, so
 * a void arriving for a cancelled cheque throws rather than overwriting a
 * Finance decision that carries a recorded reason.
 *
 * Writes no `PortalEvent`, like everything else in Plan 2. That has a
 * consequence worth stating plainly: a cheque already published to the supplier
 * portal as AVAILABLE and then voided in Acumatica goes on showing as available
 * to the supplier. It is recorded as a known gap for Plan 3 in
 * `.superpowers/sdd/progress.md` and must not be "fixed" here by writing an
 * event — publishing is a Finance action, never an import consequence.
 */
export async function voidCheck(
  db: Db, args: { checkId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to void a check.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    const from = check.status as CheckStatus
    assertTransition(from, 'VOIDED')

    const updated = await tx.check.update({
      where: { id: check.id },
      // The release facts are left standing. They are what makes this void
      // alarming, and clearing them would erase the evidence that the cheque
      // was ever handed over.
      data: { status: 'VOIDED', voidedAt: args.now },
    })

    // A distinct action, not just distinct remarks: every audit query, filter
    // and screen that groups by action then separates this case for free,
    // whereas a warning buried in free text is one a list view never shows.
    const afterRelease = from === 'RELEASED'
    await writeAudit(tx, {
      checkId: check.id,
      actorType: 'SYSTEM',
      action: afterRelease ? 'voided_after_release' : 'voided',
      details: { fromStatus: from, releasedAt: check.releasedAt?.toISOString() ?? null },
      remarks: afterRelease ? `${VOID_AFTER_RELEASE_WARNING} ${args.reason}` : args.reason,
    })

    return updated
  })
}

/**
 * The one path that removes a `Check` row, added at Finance's request so the
 * incomplete records can be cleared out. **Everything about it is narrow on
 * purpose.**
 *
 * Measured against production on 2026-09-04: 129 of the 9,247 register-derived
 * cheques carry no amount. 98 of them pass this guard. The other 31 — 25
 * RELEASED and 6 READY_FOR_RELEASE — do not, and that is the answer, not a gap
 * to be closed. See `UNDELETABLE_STATUSES`.
 *
 * **The audit trail survives.** `AuditLog.checkId` is ON DELETE SET NULL, so
 * every row this cheque accumulated goes on existing, detached but otherwise
 * byte-identical: action, details, remarks, actor and timestamp. Cascade would
 * destroy the record of who touched money, which is the thing the append-only
 * trigger exists to protect — and the trigger refuses it anyway. The detaching
 * UPDATE is the trigger's one exemption, granted only when the cheque is
 * genuinely gone; migration 20260905000100 is the record of that decision.
 *
 * **A final audit row is written first, in the same transaction.** Without it
 * the surviving rows point at nothing and nobody can say what was deleted, so
 * it carries the cheque's identity in `details` — number, company, payee,
 * status, source sheet and row. It is written with NO `checkId`: the column
 * would be set to null by the very delete two lines below it, and the identity
 * has to live somewhere that survives. `lib/admin/users.ts` writes its
 * user-administration rows the same way.
 *
 * There is deliberately no bulk version. 98 rows is a morning's work for one
 * person who is looking at each one, and a loop over a filter is how 98 becomes
 * 9,247 after somebody edits the filter.
 */
export async function deleteIncompleteCheck(
  db: Db,
  args: {
    checkId: string
    userId: string
    /**
     * The actor's role, passed in rather than read here: `lib/domain/` does not
     * reach for a session, and the server action has already resolved one. It
     * is still checked HERE as well as in the action, because a server action
     * is an HTTP endpoint and the domain rule must hold whoever calls it.
     */
    actorRole: 'FINANCE_USER' | 'FINANCE_ADMIN'
    reason: string
    now: Date
  },
): Promise<void> {
  // Required, like every other destructive act in this module. A deletion with
  // no stated reason would be the only unexplained one, and the reason is the
  // single thing a future reader of the surviving audit row cannot reconstruct
  // from the data.
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to delete a cheque record.')
  }

  return inTx(db, async (tx) => {
    const check = await tx.check.findUnique({
      where: { id: args.checkId },
      include: { company: true },
    })
    if (!check) throw new DomainError('NOT_FOUND', 'Check not found.')

    const guard = checkDeletable({
      actorRole: args.actorRole,
      // The amount itself, never `isIncomplete`. The flag is a stored
      // derivation the importer maintains and a stored derivation can drift.
      amount: check.amount?.toString() ?? null,
      status: check.status as CheckStatus,
      releasedAt: check.releasedAt,
    })
    if (!guard.ok) throw new DomainError(guard.code, guard.message)

    // `PortalEvent.checkId` is NOT NULL, so an event cannot be detached the way
    // an audit row can, and the FK is ON DELETE RESTRICT — the database would
    // refuse this anyway, with a foreign-key violation a Finance Admin cannot
    // act on. Refused here, first, with a sentence they can. Every event
    // counts, not only PENDING ones: a SYNCED event is the record that a
    // supplier was told something about this cheque.
    const events = await tx.portalEvent.count({ where: { checkId: check.id } })
    if (events > 0) {
      throw new DomainError(
        'PORTAL_EVENT_QUEUED',
        'The supplier portal outbox still holds an instruction about this cheque, so it cannot ' +
        'be deleted. A queued event cannot be detached the way an audit row can.',
      )
    }

    // `StagedCheck.promotedCheckId` is a plain column with no foreign key, so
    // nothing in the database would stop this: the pointer would simply dangle
    // and the staged queue would go on reporting the row as promoted into a
    // cheque that no longer exists. Measured: 0 of the 129 were promoted from a
    // staged row, so this refuses nothing today — it is here so it stays true.
    //
    // Deliberately NOT resolved by clearing `promotedCheckId`: that would make
    // the staged row eligible for promotion again and the next sync would
    // recreate the cheque, undoing the deletion with nobody told.
    const promoted = await tx.stagedCheck.count({ where: { promotedCheckId: check.id } })
    if (promoted > 0) {
      throw new DomainError(
        'PROMOTED_FROM_STAGED',
        'A staged register row was promoted into this cheque, and deleting it would leave the ' +
        'staging queue pointing at nothing. Settle the staged row first.',
      )
    }

    // Counted before the delete, for the record. `CheckBill` is ON DELETE
    // CASCADE and stays that way: a bill is a line OF the cheque and means
    // nothing without it, unlike an audit row, which is a record of what a
    // person did. Measured: 0 of the 129 carry a bill. `Notification.checkId`
    // is nullable and SET NULL, so any notification detaches quietly, as it
    // does for every other reference.
    const [bills, auditRows] = await Promise.all([
      tx.checkBill.count({ where: { checkId: check.id } }),
      tx.auditLog.count({ where: { checkId: check.id } }),
    ])

    await writeAudit(tx, {
      // No `checkId` — see the note above. The row is about a cheque that is
      // about to stop existing, and the pointer would be nulled by the delete
      // below before anyone could read it.
      actorType: 'USER',
      userId: args.userId,
      action: 'incomplete_check_deleted',
      details: {
        checkId: check.id,
        checkNumber: check.checkNumber,
        cvNumber: check.cvNumber,
        companyId: check.companyId,
        companyCode: check.company.code,
        payeeName: check.payeeName,
        status: check.status,
        checkDate: check.checkDate?.toISOString() ?? null,
        currency: check.currency,
        // Stated as null rather than omitted: "the amount was not recorded" is
        // the fact that made this deletable, and a missing key would read as an
        // oversight.
        amount: null,
        eligibility: check.eligibility,
        sourceSheet: check.sourceSheet,
        sourceRow: check.sourceRow,
        deletedAt: args.now.toISOString(),
        detachedAuditRows: auditRows,
        deletedBills: bills,
      },
      remarks:
        `Deleted incomplete cheque ${check.company.code} ${check.checkNumber} — ` +
        `${check.payeeName ?? 'no payee recorded'} (${check.status}, no amount recorded). ` +
        args.reason,
    })

    // The delete itself. The FK actions do the rest: audit rows detach, bills
    // cascade, notifications detach, and a portal event would have refused
    // above.
    await tx.check.delete({ where: { id: check.id } })
  })
}

export async function cancelCheck(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check> {
  if (!args.reason || args.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A reason is required to cancel a check.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    assertTransition(check.status as CheckStatus, 'CANCELLED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'CANCELLED',
        cancelledById: args.userId,
        cancelledAt: args.now,
        cancelReason: args.reason,
      },
    })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'cancelled', remarks: args.reason,
    })
    return updated
  })
}
