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

export async function listChecks(db: Db, filters: CheckFilters, limit = 200) {
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
    where.OR = [
      { checkNumber: { contains: q, mode: 'insensitive' } },
      { cvNumber: { contains: q, mode: 'insensitive' } },
      { payeeName: { contains: q, mode: 'insensitive' } },
      { bills: { some: { apvNumber: { contains: q, mode: 'insensitive' } } } },
      { bills: { some: { poNumber: { contains: q, mode: 'insensitive' } } } },
    ]
  }

  return db.check.findMany({
    where,
    include: { company: true, cashAccount: true, bills: { take: 1 } },
    orderBy: [{ checkDate: 'desc' }, { checkNumber: 'asc' }],
    take: limit,
  })
}

export type CheckRow = Awaited<ReturnType<typeof listChecks>>[number]
