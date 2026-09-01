import type { Prisma, PrismaClient, CheckStatus, Eligibility } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type CheckFilters = {
  q?: string
  status?: CheckStatus
  companyId?: string
  cashAccountId?: string
  eligibility?: Eligibility
  from?: Date
  to?: Date
}

export async function getSummary(db: Db) {
  const [grouped, valueAgg, total] = await Promise.all([
    db.check.groupBy({ by: ['status'], _count: { _all: true } }),
    db.check.aggregate({ _sum: { amount: true }, where: { status: { not: 'CANCELLED' } } }),
    db.check.count(),
  ])
  const count = (s: CheckStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0
  return {
    total,
    pendingSignature: count('GENERATED') + count('SIGNATURE_PENDING'),
    signed: count('SIGNED'),
    readyForRelease: count('READY_FOR_RELEASE'),
    scheduled: count('SCHEDULED'),
    released: count('RELEASED'),
    totalValue: (valueAgg._sum.amount ?? 0).toString(),
  }
}

// Shared by listChecks and countChecks so the table and its "showing N of M"
// count can never drift apart.
function buildWhere(filters: CheckFilters): Prisma.CheckWhereInput {
  const where: Prisma.CheckWhereInput = {}

  if (filters.status) where.status = filters.status
  if (filters.companyId) where.companyId = filters.companyId
  if (filters.cashAccountId) where.cashAccountId = filters.cashAccountId
  if (filters.eligibility) where.eligibility = filters.eligibility
  if (filters.from || filters.to) {
    where.checkDate = { gte: filters.from, lte: filters.to }
  }

  const q = filters.q?.trim()
  if (q) {
    // Prisma ANDs sibling keys with OR, so this narrows within the other
    // filters rather than widening past them.
    where.OR = [
      { checkNumber: { contains: q, mode: 'insensitive' } },
      { cvNumber: { contains: q, mode: 'insensitive' } },
      { payeeName: { contains: q, mode: 'insensitive' } },
      { bills: { some: { apvNumber: { contains: q, mode: 'insensitive' } } } },
      { bills: { some: { poNumber: { contains: q, mode: 'insensitive' } } } },
    ]
  }

  return where
}

export async function listChecks(db: Db, filters: CheckFilters, limit = 200) {
  const where = buildWhere(filters)

  return db.check.findMany({
    where,
    // All bills, not just the first: search matches APV/PO across every bill on
    // a check, so showing only `bills[0]` would display a different APV than the
    // one the user searched for — indistinguishable from a false positive.
    include: { company: true, cashAccount: true, bills: { orderBy: { apvNumber: 'asc' } } },
    orderBy: [{ checkDate: 'desc' }, { checkNumber: 'asc' }],
    take: limit,
  })
}

// Companion to `listChecks`: the number of rows the same filters match, ignoring
// the display limit. The table needs this to say "SHOWING 200 OF 12,264" rather
// than silently truncating under a summary card reporting the full count.
export async function countChecks(db: Db, filters: CheckFilters): Promise<number> {
  return db.check.count({ where: buildWhere(filters) })
}

export type CheckRow = Awaited<ReturnType<typeof listChecks>>[number]
