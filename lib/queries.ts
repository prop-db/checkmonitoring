import type { Prisma, PrismaClient, CheckStatus, Eligibility } from '@prisma/client'
import { LIVE_STATUSES, CLOSED_STATUSES } from './domain/check-status'
import { ELIGIBILITIES } from './domain/eligibility'

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
    //
    // `cashAccount.bank` feeds the BANK column. One nested include, not a
    // second query per row.
    include: {
      company: true,
      cashAccount: { include: { bank: true } },
      bills: { orderBy: { apvNumber: 'asc' } },
    },
    /**
     * `nulls: 'last'`, and it is not cosmetic.
     *
     * Postgres sorts NULLs FIRST on a descending sort. `checkDate` is nullable
     * — 38 live cheques carry no date — so a plain `{ checkDate: 'desc' }` put
     * every one of them at the top and the dashboard opened on a first screen
     * of nothing but em dashes, with the cheques Finance actually has to act on
     * pushed below the fold. Pinned by test in tests/queries.test.ts.
     */
    orderBy: [{ checkDate: { sort: 'desc', nulls: 'last' } }, { checkNumber: 'asc' }],
    take: limit,
  })
}

// Companion to `listChecks`: the number of rows the same filters match, ignoring
// the display limit. The table needs this to say "SHOWING 200 OF 12,264" rather
// than silently truncating under a summary card reporting the full count.
export async function countChecks(db: Db, filters: CheckFilters): Promise<number> {
  return db.check.count({ where: buildWhere(filters) })
}

/**
 * The values the filter bar's dropdowns offer, read from the database.
 *
 * Loaded, never hardcoded: a ninth company or a seventh cash account has to
 * appear on the filter bar without a code change, and a hardcoded list would
 * quietly stop offering whatever was added last.
 *
 * The shape is plain strings only — this is rendered by a server component but
 * is also the set an id is validated against, and keeping it serialisable means
 * it can cross to the browser unchanged if the filter bar ever becomes
 * interactive.
 */
export type CompanyOption = { id: string; code: string; name: string }
export type CashAccountOption = { id: string; code: string; bankCode: string }
export type FilterOptions = { companies: CompanyOption[]; cashAccounts: CashAccountOption[] }

export async function getFilterOptions(db: Db): Promise<FilterOptions> {
  const [companies, cashAccounts] = await Promise.all([
    db.company.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
    db.cashAccount.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, bank: { select: { code: true } } },
    }),
  ])
  return {
    companies,
    cashAccounts: cashAccounts.map((a) => ({ id: a.id, code: a.code, bankCode: a.bank.code })),
  }
}

/**
 * Every status on the ladder, assembled from the two lists that already
 * partition it rather than restated. `lib/domain/check-status.ts` carries a
 * compile-time proof that LIVE and CLOSED cover `CheckStatus` exactly once
 * each, so this can neither miss a status nor offer one twice.
 */
export const ALL_STATUSES: readonly CheckStatus[] = [...LIVE_STATUSES, ...CLOSED_STATUSES]

export { ELIGIBILITIES }

/**
 * The URL parameter validators.
 *
 * Every one of these answers `undefined` for a value it does not recognise,
 * which `buildWhere` reads as "do not filter on this". That is deliberate and
 * is the behaviour `status` already had: a hand-edited or stale bookmarked link
 * must open the dashboard unfiltered rather than hand Prisma an invalid enum
 * value and 500 the page. Never widen these to a cast.
 */
export function parseStatusParam(value: string | undefined): CheckStatus | undefined {
  return value && (ALL_STATUSES as readonly string[]).includes(value)
    ? (value as CheckStatus)
    : undefined
}

export function parseEligibilityParam(value: string | undefined): Eligibility | undefined {
  return value && (ELIGIBILITIES as readonly string[]).includes(value)
    ? (value as Eligibility)
    : undefined
}

/**
 * A company or cash account id, checked against the rows actually loaded from
 * the database. Unlike a status this could not crash Prisma — any string is a
 * legal id — but an unrecognised one returns a silently empty table that reads
 * as "there are no cheques" rather than "that filter no longer exists".
 */
export function parseOptionId(
  value: string | undefined,
  options: readonly { id: string }[],
): string | undefined {
  return value && options.some((o) => o.id === value) ? value : undefined
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
  /**
   * The BANK column. `cashAccountCode` is the label Finance uses out loud
   * ("BPI STK"); `bankCode` is the institution behind it. Both are plain
   * strings or null — NOT the `CashAccount` or `Bank` model instance, which is
   * a class and would throw at the server/client boundary. Null because
   * `Check.cashAccountId` is nullable, and an empty string would read as an
   * account whose code is blank.
   */
  cashAccountCode: string | null
  bankCode: string | null
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
    // `?? null`, so a cheque with no cash account says so rather than crossing
    // the boundary as `undefined` and rendering as a gap indistinguishable from
    // a rendering fault.
    cashAccountCode: r.cashAccount?.code ?? null,
    bankCode: r.cashAccount?.bank.code ?? null,
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
