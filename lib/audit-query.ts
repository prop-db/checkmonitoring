import type { Prisma, PrismaClient } from '@prisma/client'
import { AUDIT_PAGE_SIZE, type AuditFilters, type AuditCursor } from './audit-view'

type Db = PrismaClient | Prisma.TransactionClient

export type AuditRow = {
  id: string
  createdAt: Date
  actorType: string
  action: string
  remarks: string | null
  details: unknown
  userName: string | null
  checkId: string | null
  /** The cheque's number; for a detached row, the number its details recorded; else null. */
  checkNumber: string | null
  /**
   * Set when the row is about a planned outflow line, not a cheque
   * (2026-09-12). Such a row has `checkId` null because no cheque was ever
   * involved — it is NOT a detached row, and must not be shown as one.
   */
  plannedOutflowId: string | null
}

/**
 * The audit screen's reads. READ ONLY — `writeAudit` in lib/audit.ts is the
 * only writer and the database trigger makes rows append-only.
 *
 * The default population is people's actions (`actorType = USER`): measured
 * 2026-09-11, 4 of 65,269 rows. `system: true` drops that clause and shows
 * everything, which is where the 1,958 company restorations of 10 September
 * live. The CHECK filter goes through the join, so a detached row (cheque
 * since deleted) cannot match it — the page says so.
 */
function whereFor(filters: AuditFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {}
  if (!filters.system) where.actorType = 'USER'
  if (filters.action) where.action = filters.action
  if (filters.userId) where.userId = filters.userId
  if (filters.checkNumber) where.check = { checkNumber: filters.checkNumber }
  if (filters.from || filters.to) where.createdAt = { gte: filters.from, lte: filters.to }
  return where
}

function detailsPlannedOutflowId(details: unknown): string | null {
  if (details && typeof details === 'object' && 'plannedOutflowId' in details) {
    const v = (details as { plannedOutflowId?: unknown }).plannedOutflowId
    return typeof v === 'string' ? v : null
  }
  return null
}

function detailsCheckNumber(details: unknown): string | null {
  if (details && typeof details === 'object' && 'checkNumber' in details) {
    const v = (details as { checkNumber?: unknown }).checkNumber
    return typeof v === 'string' ? v : null
  }
  return null
}

/**
 * One page, newest first, by KEYSET. `cursor` is the last row of the previous
 * page; the next page is everything strictly before it in (createdAt, id)
 * order. Prisma has no tuple comparison, so the two-column "less than" is
 * spelled out as an OR. 101 rows are fetched so `hasMore` is a fact, not a
 * guess from a full page.
 */
export async function listAuditRows(
  db: Db, filters: AuditFilters, cursor: AuditCursor | null,
): Promise<{ rows: AuditRow[]; hasMore: boolean }> {
  const where = whereFor(filters)
  const keyset: Prisma.AuditLogWhereInput | undefined = cursor
    ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
    : undefined

  const found = await db.auditLog.findMany({
    where: keyset ? { AND: [where, keyset] } : where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: AUDIT_PAGE_SIZE + 1,
    select: {
      id: true, createdAt: true, actorType: true, action: true, remarks: true, details: true, checkId: true,
      user: { select: { name: true } },
      check: { select: { checkNumber: true } },
    },
  })

  const rows = found.slice(0, AUDIT_PAGE_SIZE).map((r) => ({
    id: r.id, createdAt: r.createdAt, actorType: r.actorType, action: r.action, remarks: r.remarks,
    details: r.details, userName: r.user?.name ?? null, checkId: r.checkId,
    checkNumber: r.check?.checkNumber ?? detailsCheckNumber(r.details),
    plannedOutflowId: detailsPlannedOutflowId(r.details),
  }))
  return { rows, hasMore: found.length > AUDIT_PAGE_SIZE }
}

export async function countAuditRows(db: Db, filters: AuditFilters): Promise<number> {
  return db.auditLog.count({ where: whereFor(filters) })
}

/**
 * Every action the trail has ever recorded, sorted. Never hard-coded: 21
 * today, and the next is a code change away.
 *
 * A raw query rather than Prisma's `distinct`: Prisma does not document
 * whether `distinct` executes as SQL DISTINCT or as a full fetch deduplicated
 * inside the engine, while CLAUDE.md states this select IS a SELECT DISTINCT.
 * The raw form makes that true by construction and is served by the
 * (action, createdAt) index; over 65,269 rows, the other strategy would be a
 * page load rather than a query.
 */
export async function listAuditActions(db: Db): Promise<string[]> {
  const rows = await db.$queryRaw<{ action: string }[]>`select distinct "action" from "AuditLog" order by "action" asc`
  return rows.map((r) => r.action)
}

export async function listAuditUsers(db: Db): Promise<{ id: string; name: string }[]> {
  return db.user.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } })
}
