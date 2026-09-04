import type { Prisma, PrismaClient, CheckStatus, Eligibility } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type CheckFilters = {
  q?: string
  status?: CheckStatus
  /**
   * A set of statuses, for the dashboard's default view of the cheques that
   * still need Finance. Ignored when `status` names a single one — an explicit
   * choice from the dropdown wins over the default scope, otherwise picking
   * RELEASED would return nothing and look like a broken filter.
   *
   * The list itself is never written here: `LIVE_STATUSES` in
   * lib/domain/check-status.ts is the one place it exists, and a restatement is
   * how a ninth status ends up live in one file and closed in another.
   */
  statusIn?: readonly CheckStatus[]
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

  // A single explicit status wins; the scope list applies only when none was
  // chosen. An empty `statusIn` is treated as no filter rather than as "match
  // nothing", so a miscomputed scope can never hide every cheque.
  if (filters.status) where.status = filters.status
  else if (filters.statusIn && filters.statusIn.length > 0) where.status = { in: [...filters.statusIn] }
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

/**
 * The dashboard table's row, as it crosses into the browser.
 *
 * The table is a client component (it holds the tick-box selection), and a
 * `CheckRow` cannot cross that boundary: `amount` is a `Prisma.Decimal`, a class
 * instance, and React refuses to serialise one — "only plain objects can be
 * passed to Client Components". Every bill carries a Decimal too.
 *
 * So the amount crosses as a DECIMAL STRING, which is what rule 8 requires
 * anyway: never a JS number, because a float round-trip loses centavos. `Date`
 * survives serialisation intact and is left alone.
 *
 * Narrow on purpose. A whole `Check` row carries fields the table never shows —
 * cancellation reasons, portal sync state, source sheet and row — and shipping
 * them to the browser puts them in the page source of a screen anyone in
 * Finance can leave open on a shared machine.
 */
export type CheckTableRow = {
  id: string
  checkNumber: string
  apvNumbers: string[]
  payeeName: string | null
  companyCode: string
  checkDate: Date | null
  amount: string | null
  currency: string
  status: CheckStatus
  eligibility: Eligibility
  isCheque: boolean
  availablePickupDate: Date | null
  scheduledPickupDate: Date | null
}

export function toTableRow(r: CheckRow): CheckTableRow {
  return {
    id: r.id,
    checkNumber: r.checkNumber,
    // Every bill, not just the first: search matches APV/PO across all of them,
    // and showing one arbitrary bill would display a different APV than the one
    // the user searched for.
    apvNumbers: r.bills.map((b) => b.apvNumber),
    payeeName: r.payeeName,
    companyCode: r.company.code,
    checkDate: r.checkDate,
    // `?.toString() ?? null`, never `Number(...)`: null is "no amount was
    // recorded" — 129 cheques in production — and it is not zero.
    amount: r.amount?.toString() ?? null,
    currency: r.currency,
    status: r.status,
    eligibility: r.eligibility,
    isCheque: r.isCheque,
    availablePickupDate: r.availablePickupDate,
    scheduledPickupDate: r.scheduledPickupDate,
  }
}
