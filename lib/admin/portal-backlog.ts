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
