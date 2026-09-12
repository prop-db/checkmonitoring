import type { Prisma, PrismaClient } from '@prisma/client'
import type { OutstandingRow } from './summary'

type Db = PrismaClient | Prisma.TransactionClient

export type ReconFilters = { bankCode?: string; companyId?: string; cashAccountId?: string }

/**
 * THE POPULATION the as-of rule is applied to, minus the amount rule: every
 * released real cheque, whatever its clearing — `listOutstandingCandidates`
 * adds the amount clause and `countExcludedIncomplete` the opposite one, so
 * the exclusion a page states is struck over the same rows. The rule in
 * `lib/recon/outstanding.ts` decides per day, and it runs in the pure layer
 * so the page and the extract are struck over the same rows.
 *
 * The bank filter reads the cash account's bank, and for a cheque with no
 * cash account the checkbook's; the account filter is the cash account.
 */
function populationWhere(filters: ReconFilters): Prisma.CheckWhereInput {
  const where: Prisma.CheckWhereInput = { status: 'RELEASED', isCheque: true }
  if (filters.companyId) where.companyId = filters.companyId
  if (filters.cashAccountId) where.cashAccountId = filters.cashAccountId
  if (filters.bankCode) {
    where.OR = [
      { cashAccount: { bank: { code: filters.bankCode } } },
      { cashAccountId: null, checkBook: { bank: { code: filters.bankCode } } },
    ]
  }
  return where
}

export async function listOutstandingCandidates(db: Db, filters: ReconFilters = {}): Promise<OutstandingRow[]> {
  const checks = await db.check.findMany({
    where: { ...populationWhere(filters), isIncomplete: false, amount: { not: null } },
    orderBy: [{ cashAccount: { code: 'asc' } }, { checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: {
      id: true, checkNumber: true, payeeName: true, currency: true, amount: true, checkDate: true,
      releasedAt: true, clearingStatus: true, clearedDate: true, status: true,
      company: { select: { code: true } },
      cashAccount: { select: { id: true, code: true, bank: { select: { code: true } } } },
      checkBook: { select: { bank: { select: { code: true } } } },
      vendor: { select: { canonicalName: true } },
    },
  })
  return checks.flatMap((c) => {
    if (c.amount === null) return []
    return [{
      id: c.id,
      checkNumber: c.checkNumber,
      payee: c.payeeName ?? c.vendor?.canonicalName ?? null,
      accountId: c.cashAccount?.id ?? null,
      account: c.cashAccount?.code ?? null,
      bank: c.cashAccount?.bank.code ?? c.checkBook?.bank.code ?? null,
      company: c.company.code,
      currency: c.currency,
      amount: c.amount.toFixed(2),
      checkDate: c.checkDate,
      releasedAt: c.releasedAt,
      clearingStatus: c.clearingStatus,
      clearedDate: c.clearedDate,
      status: c.status,
    }]
  })
}

/** This report's own exclusion, under the same population and filters. */
export async function countExcludedIncomplete(db: Db, filters: ReconFilters = {}): Promise<number> {
  return db.check.count({ where: { ...populationWhere(filters), isIncomplete: true } })
}
