import type { Prisma, PrismaClient, PortalEventStatus, PortalEventKind } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type PortalAttentionRow = {
  id: string; checkId: string; checkNumber: string; payeeName: string | null
  kind: PortalEventKind; status: PortalEventStatus; attempts: number
  lastError: string | null; nextAttemptAt: Date; createdAt: Date
}

export type PortalOverview = { counts: Record<PortalEventStatus, number>; attention: PortalAttentionRow[] }

const STATUSES: PortalEventStatus[] = ['PENDING', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'PARKED']

/** PARKED is the human's queue; FAILED is shown so a stuck retry is visible before it parks. */
export async function getPortalOverview(db: Db): Promise<PortalOverview> {
  const grouped = await db.portalEvent.groupBy({ by: ['status'], _count: { _all: true } })
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<PortalEventStatus, number>
  for (const g of grouped) counts[g.status] = g._count._all
  const rows = await db.portalEvent.findMany({
    where: { status: { in: ['PARKED', 'FAILED'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
    include: { check: { select: { checkNumber: true, payeeName: true } } },
  })
  return {
    counts,
    attention: rows.map((r) => ({
      id: r.id, checkId: r.checkId, checkNumber: r.check.checkNumber, payeeName: r.check.payeeName,
      kind: r.kind, status: r.status, attempts: r.attempts, lastError: r.lastError,
      nextAttemptAt: r.nextAttemptAt, createdAt: r.createdAt,
    })),
  }
}
