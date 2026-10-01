import type {
  Check, Prisma, PrismaClient, PortalEventKind,
  ClearingStatus as PrismaClearing,
} from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { portalApvs } from '@/lib/integrations/portal/apvs'
import { loadSettings } from '@/lib/settings/read'
import { DomainError } from './errors'
import { portalRoute, type Eligibility } from './eligibility'
import { checkDeletable } from './incomplete'
import { checkReceipt, normaliseReceipt, hasReceipt, type Receipt, type ReceiptType } from './receipt'
import { checkReleaseReversible } from './reversal'
import { normaliseDetails, diffDetails, dayToDate, isoDay, type DetailInput, type DetailValues } from './details'
import {
  assertTransition, assertClearing, assertReleasable, checkReadyForRelease,
  type CheckStatus, type ClearingStatus,
} from './check-status'
import { isDueForAutoSign, AUTO_SIGNED_ACTION, SIGNATURE_REVERTED_ACTION } from './auto-sign'

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
  const bills = check.apvNumbers.length
    ? []
    : await tx.checkBill.findMany({ where: { checkId: check.id }, select: { apvNumber: true } })
  return portalApvs({ apvNumbers: check.apvNumbers, bills }).length > 0
}

/** The audit keys for the portal decision; none for an unrouted (INTERNAL) cheque. */
function portalAuditDetails(routed: boolean, pushes: boolean): { portalNotified?: boolean; portalSkipReason?: string } {
  if (!routed) return {}
  return pushes ? { portalNotified: true } : { portalNotified: false, portalSkipReason: NO_APV_SKIP_REASON }
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
    // Guarded on SIGNED, as `autoSign` guards on SIGNATURE_PENDING: a change
    // between the read above and this write (a second revert, a mark-ready)
    // must refuse with the ladder's own error rather than overwrite it.
    const { count } = await tx.check.updateMany({
      where: { id: check.id, status: 'SIGNED' },
      data: { status: 'SIGNATURE_PENDING', signedById: null, signedAt: null },
    })
    if (count === 0) {
      const current = await tx.check.findUnique({ where: { id: check.id }, select: { status: true } })
      throw new DomainError(
        'ILLEGAL_TRANSITION',
        `Cannot move a check from ${current?.status ?? 'a changed status'} to SIGNATURE_PENDING.`,
      )
    }
    const reason = args.reason?.trim() || null
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: SIGNATURE_REVERTED_ACTION,
      details: {
        from: 'SIGNED', to: 'SIGNATURE_PENDING',
        previousSignerId: check.signedById, previousSignedAt: check.signedAt?.toISOString() ?? null,
      },
      ...(reason ? { remarks: reason } : {}),
    })
    return tx.check.findUniqueOrThrow({ where: { id: check.id } })
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
    // Same guard `markSigned` and `markReleased` apply: an import-derived row
    // can carry `isCheque: false` with status RELEASED, and reversing one
    // would land a DEBIT ADV or CASH payment at READY_FOR_RELEASE — a state
    // `markReadyForRelease` itself refuses for a non-cheque.
    assertReleasable({ isCheque: check.isCheque })
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

    /**
     * A receipt already on record must never be wiped or replaced by a
     * release. Before this guard, an empty box on a cheque that already
     * carried a receipt (possible via `recordReceipt` on a re-release path,
     * or any future caller) would write `orNumber: undefined`-normalised-to-
     * `null` over it — WIPING it — and a typed one would REPLACE it. Both are
     * the exact hazard rule 11 exists to prevent, just arriving through
     * `markReleased` instead of `recordReceipt`. The fix mirrors
     * `recordReceipt`'s own refusal: a typed receipt against an already-
     * recorded one is refused outright, naming what is there, rather than
     * silently discarded; an empty box against one already recorded simply
     * leaves the three receipt columns untouched.
     */
    const alreadyHasReceipt = check.orNumber !== null
    if (alreadyHasReceipt && hasReceipt(receipt)) {
      throw new DomainError(
        'RECEIPT_ALREADY_RECORDED',
        `This cheque already records receipt ${check.orNumber}. A recorded receipt is not ` +
        'overwritten from here — if it is wrong, raise it with a Finance Admin.',
      )
    }

    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'RELEASED',
        releasedById: args.userId,
        releasedAt: args.now,
        // Only written when this release actually carries a receipt, or the
        // cheque has none yet. Never written when the cheque already has one
        // and this release's box was empty — see the guard above.
        ...(alreadyHasReceipt
          ? {}
          : { orNumber: receipt.orNumber, orDate: receipt.orDate, receiptType: receipt.receiptType }),
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
            // The RECORDED reference, not necessarily this release's own
            // typed one: when the cheque already carried a receipt and this
            // release's box was empty, `receipt.orNumber` is null even though
            // the database keeps the original. Sending null there would tell
            // a future portal delivery (Plan 3) to wipe its own copy of a
            // receipt this release never touched.
            orNumber: alreadyHasReceipt ? check.orNumber : receipt.orNumber,
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

/**
 * The four register fields — remarks, point person, who is holding the
 * cheque, category. No status guard: a note can be added to a cancelled
 * cheque. Writes only the fields that changed, and nothing at all — no row,
 * no audit — when nothing did, so the trail records edits and not visits.
 * The audit row's `details` is `{ field: { from, to } }` for each change.
 */
export async function updateDetails(
  db: Db,
  args: { checkId: string; userId: string; fields: DetailInput; now: Date },
): Promise<Check> {
  return inTx(db, async (tx) => {
    const { values } = await loadSettings(tx)
    const check = await load(tx, args.checkId)
    const before: DetailValues = {
      remarks: check.remarks, pointPerson: check.pointPerson,
      checksPossession: check.checksPossession, category: check.category,
      expectedOutflowDate: isoDay(check.expectedOutflowDate),
    }
    const after = normaliseDetails(args.fields, before, { categories: values.categories })
    const changes = diffDetails(before, after)
    const changed = Object.keys(changes) as (keyof typeof changes)[]
    if (changed.length === 0) return check

    // The day string becomes the column's instant here and nowhere else.
    const data: Prisma.CheckUncheckedUpdateInput = {}
    for (const field of changed) {
      switch (field) {
        case 'expectedOutflowDate':
          data.expectedOutflowDate = after.expectedOutflowDate === null ? null : dayToDate(after.expectedOutflowDate)
          break
        default:
          data[field] = after[field]
      }
    }
    const updated = await tx.check.update({ where: { id: check.id }, data })
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'details_updated', details: changes,
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
 * Queues a `CANCELLED` `PortalEvent` for a portal-routed cheque (task 2026-09-26,
 * plan `portal-outbox-delivery`), the same shape `cancelCheck` queues: the
 * supplier portal must stop showing a cheque the ERP says no longer exists,
 * whichever side declared it gone. The payload carries no `reason` and no
 * distinction between a Finance cancel and an Acumatica void — the portal only
 * needs to know the cheque is CANCELLED, never why. Only when the cheque carries
 * an APV the portal can match it on (spec 2026-10-01 §A1); otherwise nothing is
 * queued and the audit row says so.
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

    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null && await portalCanMatch(tx, check)

    const updated = await tx.check.update({
      where: { id: check.id },
      // The release facts are left standing. They are what makes this void
      // alarming, and clearing them would erase the evidence that the cheque
      // was ever handed over.
      data: {
        status: 'VOIDED',
        voidedAt: args.now,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: route,
      },
    })

    if (pushes) await queueCancelled(tx, check.id, check.checkNumber, args.now)

    // A distinct action, not just distinct remarks: every audit query, filter
    // and screen that groups by action then separates this case for free,
    // whereas a warning buried in free text is one a list view never shows.
    const afterRelease = from === 'RELEASED'
    await writeAudit(tx, {
      checkId: check.id,
      actorType: 'SYSTEM',
      action: afterRelease ? 'voided_after_release' : 'voided',
      details: {
        fromStatus: from, releasedAt: check.releasedAt?.toISOString() ?? null,
        ...portalAuditDetails(route !== null, pushes),
      },
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

    const route = portalRoute(check.eligibility as Eligibility)
    const pushes = route !== null && await portalCanMatch(tx, check)

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
    const portal = portalAuditDetails(route !== null, pushes)
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId,
      action: 'cancelled', remarks: args.reason,
      ...(Object.keys(portal).length ? { details: portal } : {}),
    })
    return updated
  })
}
