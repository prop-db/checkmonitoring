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
  /**
   * Only the records with no recorded amount. `true` narrows to them; `false`
   * and `undefined` both mean "do not filter on this", because the useful
   * question is "show me the gaps", never "hide them" — and a tri-state that
   * could hide 129 cheques from a search by accident is worse than no filter.
   */
  incomplete?: boolean
}

// `total` is null when nothing in the group is known — see getSummary. It is
// not the same fact as a total of zero, and must not be rendered as one.
export type CurrencyTotal = { currency: string; total: string | null; count: number }

export async function getSummary(db: Db) {
  const [grouped, currencyAgg, total, incomplete] = await Promise.all([
    db.check.groupBy({ by: ['status'], _count: { _all: true } }),
    // Grouped by currency, never summed across them: adding a PHP amount to a
    // CNY amount produces a number with no meaning, so there is no code path
    // here that could do it — each currency gets its own row.
    db.check.groupBy({
      by: ['currency'],
      _sum: { amount: true },
      _count: { _all: true },
      where: { status: { not: 'CANCELLED' } },
    }),
    db.check.count(),
    // Counted, never subtracted from anything. 129 cheques whose amount was
    // never recorded are 129 real cheques: they are IN `total`, they are in
    // their currency's `count`, and they are simply absent from its `total`
    // because there is nothing of theirs to add. See the note below.
    db.check.count({ where: { isIncomplete: true } }),
  ])
  const count = (s: CheckStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0
  // `amount` is nullable and 397 register rows have no amount. Verified against
  // the test database: SQL SUM() skips those rows rather than reading them as 0,
  // while COUNT(*) still counts them — so a currency's total is the sum of the
  // amounts that are actually known, over a count that includes the ones that
  // are not. That is the intended reading, not a defect: absorbing 397 unknowns
  // as zeroes would produce a total that understates reality while looking
  // authoritative.
  //
  // In the degenerate case where every row in a currency group has a null
  // amount, Postgres returns SUM() = NULL for the whole group. That is carried
  // through as null, NOT collapsed to zero: "no amount is known for any of
  // these cheques" and "these cheques are worth nothing" are different facts,
  // and a financial figure that reads ₱0.00 while meaning the former is a lie
  // the reader has no way to detect. `formatMoney` renders null as an em dash.
  // The group still appears, with its count, because hiding it would hide the
  // cheques.
  const totalsByCurrency: CurrencyTotal[] = currencyAgg.map((g) => ({
    currency: g.currency,
    total: g._sum.amount?.toString() ?? null,
    count: g._count._all,
  }))
  return {
    total,
    pendingSignature: count('GENERATED') + count('SIGNATURE_PENDING'),
    signed: count('SIGNED'),
    readyForRelease: count('READY_FOR_RELEASE'),
    scheduled: count('SCHEDULED'),
    released: count('RELEASED'),
    /**
     * Cheques with no recorded amount — 129 in production. This number and the
     * currency totals above are answers to different questions and must stay
     * that way: flagging a cheque incomplete does NOT enrol it in a total, and
     * "fixing" the totals to count it as zero would leave every figure looking
     * identical while quietly meaning something else.
     */
    incomplete,
    totalsByCurrency,
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
  // `=== true`, so `false` behaves like `undefined` and cannot silently hide
  // the incomplete records from an ordinary search.
  if (filters.incomplete === true) where.isIncomplete = true
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
