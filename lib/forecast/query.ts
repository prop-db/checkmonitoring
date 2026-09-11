import type { CheckStatus, Prisma, PrismaClient } from '@prisma/client'
import { LIVE_STATUSES } from '@/lib/domain/check-status'

type Db = PrismaClient | Prisma.TransactionClient

export type ForecastFilters = {
  /** A `Bank.code`. Matched against the checkbook's bank, else the cash account's. */
  bankCode?: string
  companyId?: string
  stage?: CheckStatus
}

/** One cheque of the population. `amount` is a decimal STRING — rule 8. */
export type ForecastRow = {
  id: string
  checkNumber: string
  payee: string | null
  bank: string | null
  company: string
  stage: CheckStatus
  currency: string
  amount: string
  checkDate: Date | null
}

/**
 * THE POPULATION: written, and not yet handed over.
 *
 * Live statuses only — a released cheque has left the counter, and with
 * clearing never recorded (measured 2026-09-11: `clearingStatus = NONE` on all
 * 9,594) its fate is unknowable here; a cancelled or voided one will never
 * leave. Real cheques only: a DEBIT ADV or CASH payment has no paper to
 * present. And only cheques with a recorded amount, consistent with every
 * other output since the ruling of 2026-09-06 — the page states the exclusion
 * and its count.
 *
 * `amount: { not: null }` is stated as well as `isIncomplete: false`, because
 * `isIncomplete` is a stored derivation of the former and a rule about money
 * reads the fact, not the cache of it — the same reason `checkDeletable` does.
 *
 * Returned as rows, not groups: the two matrices and the DETAIL sheet are all
 * struck over this one list in the pure layer, so they cannot disagree.
 */
export async function listForecastRows(db: Db, filters: ForecastFilters = {}): Promise<ForecastRow[]> {
  const where: Prisma.CheckWhereInput = {
    status: filters.stage ? filters.stage : { in: [...LIVE_STATUSES] },
    isCheque: true,
    isIncomplete: false,
    amount: { not: null },
  }
  if (filters.companyId) where.companyId = filters.companyId
  if (filters.bankCode) {
    // The bank a cheque draws on is the checkbook's when it has one — 9,072
    // cheques do — and the cash account's for the 1,342 that carry only that.
    // The filter says the same thing in Prisma's grammar: a checkbook bank
    // that matches, or no checkbook at all and a cash-account bank that does.
    where.OR = [
      { checkBook: { bank: { code: filters.bankCode } } },
      { checkBookId: null, cashAccount: { bank: { code: filters.bankCode } } },
    ]
  }

  const checks = await db.check.findMany({
    where,
    orderBy: [{ checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: {
      id: true, checkNumber: true, payeeName: true, currency: true, amount: true,
      checkDate: true, status: true,
      company: { select: { code: true } },
      checkBook: { select: { bank: { select: { code: true } } } },
      cashAccount: { select: { bank: { select: { code: true } } } },
      vendor: { select: { canonicalName: true } },
    },
  })

  return checks.flatMap((c) => {
    // Guarded above by the where clause; narrowed here for the type, never
    // defaulted — a cheque with no amount is not worth 0.00.
    if (c.amount === null) return []
    return [{
      id: c.id,
      checkNumber: c.checkNumber,
      payee: c.payeeName ?? c.vendor?.canonicalName ?? null,
      bank: c.checkBook?.bank.code ?? c.cashAccount?.bank.code ?? null,
      company: c.company.code,
      stage: c.status,
      currency: c.currency,
      // `.toFixed(2)`, not `.toString()`: decimal.js drops a trailing zero
      // (`Decimal('1234.50').toString()` is `'1234.5'`), and the column is
      // `Decimal(18,2)` — the two stored digits are exact, not display
      // rounding. `tests/import/bills.test.ts` and
      // `tests/admin/backfill-apv-numbers.test.ts` compare the same way.
      amount: c.amount.toFixed(2),
      checkDate: c.checkDate,
    }]
  })
}

/** Every bank, for the filter's dropdown. Never hard-coded: a new bank appears without a code change. */
export async function listBankCodes(db: Db): Promise<string[]> {
  const banks = await db.bank.findMany({ orderBy: { code: 'asc' }, select: { code: true } })
  return banks.map((b) => b.code)
}
