import type { Check, Prisma, PrismaClient, ClearingStatus as PrismaClearing } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from './errors'
import {
  assertTransition, assertClearing, checkReadyForRelease,
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
    })
    if (!guard.ok) throw new DomainError(guard.code, guard.message)

    assertTransition(check.status as CheckStatus, 'READY_FOR_RELEASE')

    // Routing condition, NOT a guard: an INTERNAL check still changes status,
    // it simply never produces a portal event.
    const pushes = check.eligibility === 'SUPPLIER' || check.eligibility === 'BROKER'

    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'READY_FOR_RELEASE',
        readyById: args.userId,
        readyAt: args.now,
        availablePickupDate: args.availablePickupDate,
        portalSyncStatus: pushes ? 'PENDING' : 'NOT_APPLICABLE',
        portalDomain: pushes ? (check.eligibility === 'BROKER' ? 'BROKER' : 'LOCAL') : null,
      },
    })

    if (pushes) {
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

    const pushes = check.portalSyncStatus !== 'NOT_APPLICABLE'

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
    assertTransition(check.status as CheckStatus, 'RELEASED')
    const updated = await tx.check.update({
      where: { id: check.id },
      data: {
        status: 'RELEASED',
        releasedById: args.userId,
        releasedAt: args.now,
        orNumber: args.orNumber ?? null,
        orDate: args.orDate ?? null,
        remarks: args.remarks ?? check.remarks,
      },
    })
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
