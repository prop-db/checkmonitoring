import type { Check, Prisma, PrismaClient, ClearingStatus as PrismaClearing } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from './errors'
import { portalRoute, type Eligibility } from './eligibility'
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
          status: 'PENDING',
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
          checkId: check.id, direction: 'OUT', status: 'PENDING',
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

export async function markReleased(
  db: Db,
  args: { checkId: string; userId: string; orNumber?: string; orDate?: Date; remarks?: string; now: Date },
): Promise<Check> {
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
        orNumber: args.orNumber ?? null,
        orDate: args.orDate ?? null,
        remarks: args.remarks ?? check.remarks,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
      },
    })

    if (pushes) {
      await tx.portalEvent.create({
        data: {
          checkId: check.id,
          direction: 'OUT',
          status: 'PENDING',
          payload: {
            action: 'RELEASED',
            checkNumber: check.checkNumber,
            releasedAt: args.now.toISOString(),
            orNumber: args.orNumber ?? null,
          },
        },
      })
    }

    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'released',
      remarks: args.remarks,
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
