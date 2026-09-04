import type { CheckStatus, Prisma, PrismaClient, StagedCheck, StagedReason } from '@prisma/client'
import { CLOSED_STATUSES, LIVE_STATUSES } from '@/lib/domain/check-status'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * The staged queue: rows the importer could not write, kept whole.
 *
 * **This is not a bulk correction workflow, and must not become one.** Measured
 * 2026-09-04, the register's 2,766 staged rows break down as
 *
 *   RELEASED  2,467   the cheque was already handed over
 *   CANCELLED   214
 *   live           19
 *   no number      66   mostly FT & MC transfers and already-released rows
 *
 * so about 28 of them are work anybody has to do, and Finance already
 * reconciles the closed ones in the Supplier Portal's payment module or in
 * Acumatica. Building a data-entry surface for 2,766 rows would be building it
 * for 28. What this needs to be is *legible and filterable*, opening on the
 * handful that is live rather than on the two and a half thousand that is not.
 *
 * The historical rows stay. They cost nothing to hold, they are what makes the
 * reports and pickup-pattern analysis possible, and the Acumatica sync places
 * some of them automatically. Holding them is cheap; deleting them is
 * irreversible.
 */

export type StagedScope = 'LIVE' | 'CLOSED' | 'ALL'

export type StagedFilters = {
  /** Defaults to LIVE. See the note above on why. */
  scope?: StagedScope
  reason?: StagedReason
  impliedStatus?: CheckStatus
  /** Cheque number, the reference printed where one belongs, or the payee. */
  q?: string
}

export type StagedSummary = {
  total: number
  live: number
  closed: number
  byReason: Record<StagedReason, number>
  byImpliedStatus: { status: CheckStatus; count: number }[]
  /**
   * Rows the Acumatica sync has since linked to a cheque. The staged row is
   * linked, never deleted — it is the evidence of why the cheque was held — so
   * without this count the backlog never appears to move.
   */
  promoted: number
}

// Deterministic, and by the cell a human is pointed at rather than by insertion
// order: two people reading the same filter must see the same list in the same
// order, and `createdAt` is identical to the second across a bulk import.
const ORDER: Prisma.StagedCheckOrderByWithRelationInput[] = [
  { sourceSheet: 'asc' }, { sourceRow: 'asc' }, { acumaticaRef: 'asc' },
]

function baseWhere(filters: StagedFilters): Prisma.StagedCheckWhereInput {
  const where: Prisma.StagedCheckWhereInput = {}
  if (filters.reason) where.reason = filters.reason
  if (filters.impliedStatus) where.impliedStatus = filters.impliedStatus

  const q = filters.q?.trim()
  if (q) {
    where.OR = [
      { checkNumber: { contains: q, mode: 'insensitive' } },
      { statedCheckRef: { contains: q, mode: 'insensitive' } },
      { payeeName: { contains: q, mode: 'insensitive' } },
      { cvNumber: { contains: q, mode: 'insensitive' } },
    ]
  }
  return where
}

// Scope is applied as a second, explicit `impliedStatus` clause rather than by
// sorting on the enum. Prisma will sort an enum by its DECLARATION order in the
// schema, which today happens to put RELEASED, CANCELLED and VOIDED last — a
// coincidence, not a guarantee, and one that a future reordering of
// `CheckStatus` would silently reverse. The status lists are stated in
// `lib/domain/check-status.ts` and asserted to partition the enum.
function scopedWhere(filters: StagedFilters, scope: 'LIVE' | 'CLOSED'): Prisma.StagedCheckWhereInput {
  return {
    ...baseWhere(filters),
    impliedStatus: filters.impliedStatus
      ? filters.impliedStatus
      : { in: [...(scope === 'LIVE' ? LIVE_STATUSES : CLOSED_STATUSES)] },
  }
}

/**
 * Live rows first, always — including under a display limit, which is the case
 * that matters. `ALL` is two queries and a concatenation rather than one
 * ordered query for exactly that reason: a single `take: 200` over the pooled
 * set could return two hundred released cheques and none of the nineteen that
 * need doing.
 */
export async function listStagedChecks(
  db: Db,
  filters: StagedFilters,
  limit = 200,
): Promise<StagedCheck[]> {
  const scope = filters.scope ?? 'LIVE'

  // An explicit status is narrower than the coarse live/closed scope and makes
  // it redundant. Splitting an already-fixed status into a live pass and a
  // closed pass would return the same rows twice.
  if (scope !== 'ALL' || filters.impliedStatus) {
    return db.stagedCheck.findMany({
      where: scopedWhere(filters, scope === 'ALL' ? 'LIVE' : scope),
      orderBy: ORDER,
      take: limit,
    })
  }

  const live = await db.stagedCheck.findMany({
    where: scopedWhere(filters, 'LIVE'), orderBy: ORDER, take: limit,
  })
  if (live.length >= limit) return live

  const closed = await db.stagedCheck.findMany({
    where: scopedWhere(filters, 'CLOSED'), orderBy: ORDER, take: limit - live.length,
  })
  return [...live, ...closed]
}

/** What the same filters match, ignoring the display limit — so the page can
 * say "showing 200 of 2,639" instead of quietly truncating. */
export async function countStagedChecks(db: Db, filters: StagedFilters): Promise<number> {
  const scope = filters.scope ?? 'LIVE'
  if (scope === 'ALL' || filters.impliedStatus) {
    return db.stagedCheck.count({ where: baseWhere(filters) })
  }
  return db.stagedCheck.count({ where: scopedWhere(filters, scope) })
}

export async function getStagedSummary(db: Db): Promise<StagedSummary> {
  const [total, live, byReason, byStatus, promoted] = await Promise.all([
    db.stagedCheck.count(),
    db.stagedCheck.count({ where: { impliedStatus: { in: [...LIVE_STATUSES] } } }),
    db.stagedCheck.groupBy({ by: ['reason'], _count: { _all: true } }),
    db.stagedCheck.groupBy({ by: ['impliedStatus'], _count: { _all: true } }),
    db.stagedCheck.count({ where: { promotedCheckId: { not: null } } }),
  ])

  const counts: Record<StagedReason, number> = { NO_COMPANY: 0, NO_CHECK_NUMBER: 0, AMBIGUOUS_COMPANY: 0 }
  for (const g of byReason) counts[g.reason] = g._count._all

  return {
    total,
    live,
    // Derived, not counted separately: `live + closed === total` is then true by
    // construction rather than by two queries agreeing.
    closed: total - live,
    byReason: counts,
    byImpliedStatus: byStatus.map((g) => ({ status: g.impliedStatus, count: g._count._all })),
    promoted,
  }
}
