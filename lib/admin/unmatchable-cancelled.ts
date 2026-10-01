import type { Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { portalApvs } from '@/lib/integrations/portal/apvs'

type Db = PrismaClient | Prisma.TransactionClient

/** Each row is four round trips to ap-southeast-1; Prisma's 5s default would kill the run. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

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
      const check = await tx.check.findUnique({
        where: { id: r.checkId }, select: { apvNumbers: true, bills: { select: { apvNumber: true } } },
      })
      if (!check || portalApvs(check).length > 0) return false
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
    }, TX_OPTIONS)
    if (done) closed += 1
  }
  return closed
}
