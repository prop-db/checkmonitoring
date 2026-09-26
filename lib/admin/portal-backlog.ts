import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { portalRoute, type Eligibility } from '@/lib/domain/eligibility'
import { kindMatchesStatus } from '@/lib/sync/portal-outbox'

type Db = PrismaClient | Prisma.TransactionClient

const OPEN = ['PENDING', 'FAILED', 'IN_FLIGHT'] as const

/**
 * What the worker WOULD deliver, without delivering (spec §2.5): the newest
 * non-terminal event per cheque, and how many older ones it would close as
 * superseded. Reviewed with the client before the first production run.
 * No amounts: this is printed to a console.
 *
 * `stale` marks a winner the worker would close unsent because its kind no
 * longer matches the cheque's status - the same rule, kindMatchesStatus
 * (final review 2026-09-26).
 */
export async function summariseBacklog(db: Db) {
  const open = await db.portalEvent.findMany({
    where: { status: { in: [...OPEN] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { check: { select: { checkNumber: true, payeeName: true, status: true, eligibility: true } } },
  })
  const newest = new Map<string, (typeof open)[number]>()
  const byKind: Record<string, number> = {}
  for (const ev of open) { newest.set(ev.checkId, ev); byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1 }
  const winners = [...newest.values()].map((ev) => ({
    eventId: ev.id, kind: ev.kind, checkNumber: ev.check.checkNumber, payeeName: ev.check.payeeName,
    checkStatus: ev.check.status, eligibility: ev.check.eligibility, createdAt: ev.createdAt,
    stale: !kindMatchesStatus(ev.kind, ev.check.status),
  }))
  return {
    total: open.length, winners, superseded: open.length - winners.length,
    stale: winners.filter((w) => w.stale).length, byKind,
  }
}

/**
 * The backlog's data step (final review 2026-09-26). Before this branch
 * cancelCheck and voidCheck queued nothing for the portal, so a cheque that
 * was announced available and later cancelled or voided has an open
 * MARK_AVAILABLE and no CANCELLED event: the worker closes that row as stale,
 * and the portal would never learn the cheque is gone. This finds those
 * cheques and, with `apply`, queues the CANCELLED event cancelCheck would
 * have queued - one per cheque, with a SYSTEM audit row in the same
 * transaction. Idempotent: a cheque that has any CANCELLED event is skipped,
 * so a second apply queues nothing.
 */
export async function queueCancelledForStale(db: Db, args: { now: Date; apply: boolean }) {
  const candidates = await db.check.findMany({
    where: {
      eligibility: { not: 'INTERNAL' },
      status: { in: ['CANCELLED', 'VOIDED'] },
      portalEvents: {
        some: { kind: 'MARK_AVAILABLE', status: { in: [...OPEN] } },
        none: { kind: 'CANCELLED' },
      },
    },
    orderBy: [{ checkNumber: 'asc' }, { id: 'asc' }],
    select: { id: true, checkNumber: true, payeeName: true, status: true, eligibility: true },
  })
  // portalRoute is the rule; the query's `not INTERNAL` only narrows the read.
  const cheques = candidates.filter((c) => portalRoute(c.eligibility as Eligibility) !== null)
  if (!args.apply) return { found: cheques.length, queued: 0, cheques }

  const runIso = args.now.toISOString()
  let queued = 0
  for (const c of cheques) {
    const created = await atomically(db, async (tx) => {
      // Re-checked inside the transaction so a concurrent cancel (or a second
      // apply) cannot leave the cheque with two CANCELLED events.
      const existing = await tx.portalEvent.count({ where: { checkId: c.id, kind: 'CANCELLED' } })
      if (existing) return false
      const ev = await tx.portalEvent.create({
        data: {
          checkId: c.id, direction: 'OUT', kind: 'CANCELLED', status: 'PENDING',
          idempotencyKey: `${c.id}:CANCELLED:backfill-${runIso}`,
          payload: { action: 'CANCELLED', checkNumber: c.checkNumber },
        },
      })
      await tx.check.update({
        where: { id: c.id },
        data: { portalSyncStatus: 'PENDING', portalDomain: portalRoute(c.eligibility as Eligibility) },
      })
      await writeAudit(tx, {
        checkId: c.id, actorType: 'SYSTEM', action: 'portal_event_backfilled',
        details: { eventId: ev.id, kind: 'CANCELLED', checkStatus: c.status, reason: 'cancelled/voided before cancellations were queued' },
      })
      return true
    })
    if (created) queued += 1
  }
  return { found: cheques.length, queued, cheques }
}

async function atomically<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return '$transaction' in db ? db.$transaction((tx) => fn(tx)) : fn(db)
}
