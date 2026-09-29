import type { Prisma, PrismaClient, CheckStatus, Eligibility } from '@prisma/client'
import { LIVE_STATUSES, CLOSED_STATUSES } from './domain/check-status'
import { ELIGIBILITIES } from './domain/eligibility'
// Pure URL/view arithmetic, no database — imported so the READY FOR RELEASE
// card, the table view and TODAY'S RELEASE all read one definition of which
// statuses that view covers. `dashboard-view` does not import this module, so
// there is no cycle.
import { viewStatusFilter } from './dashboard-view'

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
   * DATE RELEASED, as a range over `releasedAt` — the instant `markReleased`
   * wrote when the cheque was released THROUGH THIS APP. Both bounds are
   * inclusive instants; the resolver builds them from Manila calendar days.
   *
   * A release nobody recorded here has no instant — every cheque the register
   * load imported at RELEASED and every one the two catch-ups moved — so it
   * never matches a bound on `releasedAt`.
   *
   * Since 2026-09-28 the range also matches `statedReleaseDate` — the day the
   * retired register states for a release the app never recorded — so a
   * cheque matches when EITHER date falls inside it. The two are never merged.
   */
  releasedFrom?: Date
  releasedTo?: Date
  /**
   * Only the cheques with NO release date of either kind — `releasedAt` null
   * and `statedReleaseDate` null. The disclosure's count, taken through the
   * same `buildWhere` as the table so it is narrowed by the same company,
   * bank, search and incompleteness. When set it replaces the range, never
   * combines with it — a cheque cannot be both.
   */
  noReleaseDate?: true
  /**
   * The cheques with no recorded amount — 129 in production. A TRI-STATE:
   *
   *   `true`       only those records
   *   `false`      EXCLUDE them
   *   `undefined`  do not filter on this
   *
   * ── WHY `false` NOW HIDES THEM (client decision, 2026-09-06) ─────────────
   * This field used to be two-state, and the comment here argued against a
   * tri-state on the grounds that accidentally hiding 129 cheques from a search
   * is worse than not filtering at all. That reasoning was sound, and the client
   * has overridden it: shown the INCOMPLETE card reading 129, they said
   * "ignore them mean you have to remove them, dont consider them becuase they
   * dont have amount".
   *
   * The warning it replaces still applies, so the risk is paid for rather than
   * ignored:
   *
   *   · NOTHING IS DELETED. These are real cheques — 25 RELEASED, 48 CANCELLED
   *     — and rule 10 forbids a bulk delete path outright. They stay in the
   *     database, in `Check.isIncomplete`, and in every audit row.
   *   · The dashboard states the exclusion ON SCREEN, with the count and a link
   *     that shows them (`?incomplete=1`). A number that quietly got smaller is
   *     how someone concludes money went missing.
   *   · The export and the printed sheet say the same thing in their title
   *     blocks, because they run the same `resolveDashboardQuery`.
   *
   * `undefined` — no filter — is still what a caller gets by leaving the field
   * off, so a query that has no opinion about incompleteness cannot acquire one
   * by accident.
   * ────────────────────────────────────────────────────────────────────────
   */
  incomplete?: boolean
}

// `total` is null when nothing in the group is known — see getSummary. It is
// not the same fact as a total of zero, and must not be rendered as one.
export type CurrencyTotal = { currency: string; total: string | null; count: number }

/**
 * The dashboard's scope, as a `where` fragment.
 *
 * CLIENT DECISION, 2026-09-06: the cheques with no recorded amount are out of
 * the dashboard's counts as well as out of its table. The counts and the table
 * MUST move together — a PENDING SIGNATURE card reading 213 that opens a table
 * of 208 is the drift this constant exists to make impossible, and it is exactly
 * what would happen if only the table were narrowed.
 *
 * `false`, not the absence of the key: `buildWhere` reads `false` as EXCLUDE and
 * `undefined` as no filter, and the dashboard means the former.
 */
const COMPLETE_ONLY = { isIncomplete: false } as const

/**
 * The narrowing the TOTALS screen applies to every figure on it (client
 * request 2026-09-29: "should have filter in every summary") — the three
 * dropdowns that screen has, and nothing else. A `Pick` of `CheckFilters`
 * rather than a new shape, so the cards and the table cannot disagree about
 * what a company or a bank means.
 */
export type SummaryNarrowing = Pick<CheckFilters, 'companyId' | 'cashAccountId' | 'eligibility'>

function narrowingWhere(narrow: SummaryNarrowing): Prisma.CheckWhereInput {
  const where: Prisma.CheckWhereInput = {}
  if (narrow.companyId) where.companyId = narrow.companyId
  if (narrow.cashAccountId) where.cashAccountId = narrow.cashAccountId
  if (narrow.eligibility) where.eligibility = narrow.eligibility
  return where
}

export async function getSummary(db: Db, narrow: SummaryNarrowing = {}) {
  // Applied to ALL FOUR figures, the disclosure included: a narrowed screen
  // whose "excluding N with no amount" line still counted the whole database
  // would be a number nobody could reconcile with the cards above it.
  const scope = narrowingWhere(narrow)
  const [grouped, currencyAgg, total, incomplete] = await Promise.all([
    // Every count on the dashboard is struck over the same population the table
    // shows — see COMPLETE_ONLY.
    db.check.groupBy({ by: ['status'], _count: { _all: true }, where: { ...scope, ...COMPLETE_ONLY } }),
    /**
     * Grouped by currency, never summed across them: adding a PHP amount to a
     * CNY amount produces a number with no meaning, so there is no code path
     * here that could do it — each currency gets its own row.
     *
     * NOT narrowed by COMPLETE_ONLY, and that is deliberate. This block is the
     * answer to "what is the money", and its behaviour towards a cheque with no
     * amount is the property tests/queries.test.ts pins and forbids "fixing":
     * SQL SUM() SKIPS a null rather than reading it as zero. Narrowing the group
     * would leave every figure identical while changing what the count beneath
     * it means, which is the same class of silent redefinition. The cards do not
     * render this count; the export's SUMMARY sheet does, and says what it is.
     */
    db.check.groupBy({
      by: ['currency'],
      _sum: { amount: true },
      _count: { _all: true },
      where: { ...scope, status: { not: 'CANCELLED' } },
    }),
    db.check.count({ where: { ...scope, ...COMPLETE_ONLY } }),
    // The one figure that counts them, because it is the DISCLOSURE: the number
    // the dashboard states on screen, beside the link that shows them. Counted,
    // never subtracted from anything, and never zero just because the rest of
    // this function stopped looking at them.
    db.check.count({ where: { ...scope, isIncomplete: true } }),
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
    /**
     * The ALL CHECKS card (labelled TOTAL CHECKS until 2026-09-29), and the
     * count the TOTAL VALUE line is struck over.
     *
     * It is the number of cheques the dashboard SHOWS, not the number of rows
     * in the table: since 2026-09-06 it excludes the ones with no recorded
     * amount, because the card links to `?scope=all`, which no longer lists
     * them. `incomplete` below is what it leaves out, and the page prints it.
     */
    total,
    /**
     * The PENDING SIGNATURE card: both rungs, because to Finance a freshly
     * generated cheque is a cheque waiting to be signed.
     *
     * The two rungs are ALSO reported separately below, for the release
     * timeline. No extra query — `grouped` already holds every status — and no
     * change to this figure, which the card and the export's SUMMARY sheet both
     * read.
     */
    pendingSignature: count('GENERATED') + count('SIGNATURE_PENDING'),
    /**
     * The rungs on their own. The timeline shows GENERATED as its own node
     * because a node's count must be the number of rows its link opens, and
     * `?status=SIGNATURE_PENDING` opens only the SIGNATURE_PENDING rows —
     * see lib/release-timeline.ts.
     */
    generated: count('GENERATED'),
    signaturePending: count('SIGNATURE_PENDING'),
    signed: count('SIGNED'),
    readyForRelease: count('READY_FOR_RELEASE'),
    scheduled: count('SCHEDULED'),
    released: count('RELEASED'),
    /**
     * Cheques with no recorded amount — 129 in production. Every OTHER count
     * here now excludes them (client decision, 2026-09-06), which makes this
     * number the disclosure rather than a card: the dashboard prints it above
     * the table, with a link that shows them, so a reader can always tell the
     * difference between "the register is smaller" and "money went missing".
     *
     * This number and the currency totals above are still answers to different
     * questions and must stay that way: flagging a cheque incomplete does NOT
     * enrol it in a total, and "fixing" the totals to count it as zero would
     * leave every figure looking identical while quietly meaning something else.
     */
    incomplete,
    totalsByCurrency,
  }
}

/**
 * The set TODAY'S RELEASE covers, as a filter.
 *
 * READY_FOR_RELEASE **and** SCHEDULED, and the pair is not restated here.
 * `viewStatusFilter` is already the one place that decides what the READY FOR
 * RELEASE card and view mean, and a panel offering to release 81 cheques above
 * a card reading 87 is precisely the drift a second copy of the list invites.
 *
 * `showAll: false` is inert alongside an explicit status — `viewStatusFilter`
 * only consults it when none was given — but it is spelled out because
 * `ViewState` requires it and a reader should not have to check.
 *
 * `incomplete: false` for the same anti-drift reason the pair is not restated:
 * the READY FOR RELEASE card counts `getSummary`, which excludes the cheques
 * with no recorded amount (client decision, 2026-09-06), and a panel offering to
 * RELEASE ALL 86 beneath a card reading 80 is precisely the disagreement this
 * module is arranged to prevent. Six of production's 129 are READY_FOR_RELEASE,
 * so this is a live case, not a hypothetical: they are not released in bulk any
 * more, and are still released one at a time from `/?incomplete=1`.
 */
export const TODAYS_RELEASE_FILTER: CheckFilters = {
  ...viewStatusFilter({ status: 'READY_FOR_RELEASE', showAll: false }),
  incomplete: false,
}

/**
 * The filter behind the panel and RELEASE ALL: the fixed READY FOR RELEASE
 * filter with exactly the three narrowings the dashboard reads, named one by
 * one. Spreading `narrow` instead would let any caller holding a full
 * `CheckFilters` (it is assignable to `SummaryNarrowing`) override
 * `statusIn` or `incomplete` — and RELEASE ALL acts on this set (review,
 * 2026-09-29).
 */
function todaysReleaseFilter(narrow: SummaryNarrowing): CheckFilters {
  return {
    ...TODAYS_RELEASE_FILTER,
    companyId: narrow.companyId,
    cashAccountId: narrow.cashAccountId,
    eligibility: narrow.eligibility,
  }
}

/** What the TODAY'S RELEASE panel shows, and what RELEASE ALL would act on. */
export type TodaysRelease = {
  /**
   * Every cheque in the set. There is no separate `incomplete` figure any more:
   * `TODAYS_RELEASE_FILTER` excludes the cheques with no recorded amount, so the
   * count and the totals below are struck over one population and cannot
   * legitimately disagree.
   */
  count: number
  /** Per currency, never summed across them. */
  totalsByCurrency: CurrencyTotal[]
}

/**
 * What is ready to hand over right now.
 *
 * The count is derived from the same grouping as the totals rather than counted
 * separately, so "81 cheques" and the currency rows beneath it cannot come from
 * two queries that saw different data.
 */
export async function getTodaysRelease(db: Db, narrow: SummaryNarrowing = {}): Promise<TodaysRelease> {
  // The same narrowing the cards read, spread over the same filter RELEASE ALL
  // reads below — the panel and the button are one set, narrowed or not.
  const where = buildWhere(todaysReleaseFilter(narrow))

  const grouped = await db.check.groupBy({
    by: ['currency'],
    _sum: { amount: true },
    _count: { _all: true },
    where,
  })

  // `?.toString() ?? null`, exactly as getSummary does it: a decimal STRING,
  // never a JS number, and null where no amount in the group is known — which
  // is not the same fact as a total of zero and must not render as one.
  const totalsByCurrency: CurrencyTotal[] = grouped.map((g) => ({
    currency: g.currency,
    total: g._sum.amount?.toString() ?? null,
    count: g._count._all,
  }))

  return {
    count: grouped.reduce((n, g) => n + g._count._all, 0),
    totalsByCurrency,
  }
}

/**
 * The ids RELEASE ALL acts on, oldest cheque first.
 *
 * Read here rather than submitted by the browser. The panel's button names a
 * count, not a list, and a form carrying 81 ids is a form somebody can edit —
 * the set has to be the one the server decided, from the same filter the panel
 * counted.
 *
 * Ordered so the longest-waiting cheque is released first, and so the per-cheque
 * outcome list comes back in a stable order a person can read against the pile
 * of paper in front of them. `nulls: 'last'` for the same reason `listChecks`
 * uses it: `checkDate` is nullable and Postgres sorts NULLs first on ascending
 * order too when asked for `nulls: 'first'`; being explicit keeps the undated
 * ones out of the front of the queue.
 */
export async function listTodaysReleaseIds(db: Db, narrow: SummaryNarrowing = {}): Promise<string[]> {
  const rows = await db.check.findMany({
    where: buildWhere(todaysReleaseFilter(narrow)),
    orderBy: [{ checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: { id: true },
  })
  return rows.map((r) => r.id)
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
  // The tri-state, spelled out. `true` narrows to the records with no recorded
  // amount, `false` EXCLUDES them (the dashboard's default since 2026-09-06 —
  // see `CheckFilters.incomplete`), and `undefined` leaves the column alone.
  // `!== undefined` rather than a truthiness test, so `false` cannot decay back
  // into "no filter" the way it used to.
  if (filters.incomplete !== undefined) where.isIncomplete = filters.incomplete
  if (filters.from || filters.to) {
    where.checkDate = { gte: filters.from, lte: filters.to }
  }
  if (filters.noReleaseDate) {
    where.releasedAt = null
    where.statedReleaseDate = null
  } else if (filters.releasedFrom || filters.releasedTo) {
    // Either date. Under AND rather than on `where.OR`, which the search owns
    // below — two top-level ORs would not both apply, the second would
    // replace the first. A null date satisfies neither bound, so a cheque with
    // neither date is left out without an extra clause.
    const bounds = { gte: filters.releasedFrom, lte: filters.releasedTo }
    where.AND = [{ OR: [{ releasedAt: bounds }, { statedReleaseDate: bounds }] }]
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
      // WHOLE VOUCHER, not a substring, and not case-insensitive. Postgres
      // array containment is the only filter available over a `text[]`; there
      // is no `contains` for an array element. Searching "AP-ST042652" finds
      // the cheque, searching "042652" does not — which is worth saying out
      // loud, but is far better than the column not being searchable at all.
      // Upper-cased because the parser stores vouchers upper-cased.
      { apvNumbers: { has: q.toUpperCase() } },
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
  /** When the release was recorded here; null for every release that was not. */
  releasedAt: Date | null
  /** The register's stated release day, when the app recorded no release. Shown tagged REGISTER. */
  statedReleaseDate: Date | null
  /**
   * The supplier's receipt (rule 11: never `crNumber`). Shown in the OR column,
   * and `hasReceipt` decides whether a RELEASED row may be ticked to add one:
   * a receipt is never overwritten.
   */
  orNumber: string | null
  receiptType: 'OR' | 'CR' | null
  hasReceipt: boolean
}

export function toTableRow(r: CheckRow): CheckTableRow {
  return {
    id: r.id,
    checkNumber: r.checkNumber,
    // Both sources, folded into one list, deduplicated and ordered.
    //
    // `Check.apvNumbers` is what the register states — 11,552 of its 11,779
    // cheque numbers carry at least one — and `bills` is the approval-for-
    // release workbook's per-bill ledger, which covers 85 rows of one day's
    // working list. They overlap where a cheque is on both, and a cheque is
    // usually on only one, so showing either alone leaves the column empty for
    // most of the register. Every bill, not just the first: search matches APV
    // across all of them, and showing one arbitrary bill would display a
    // different APV than the one the user searched for.
    apvNumbers: [...new Set([...r.apvNumbers, ...r.bills.map((b) => b.apvNumber)])].sort(),
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
    releasedAt: r.releasedAt,
    statedReleaseDate: r.statedReleaseDate,
    orNumber: r.orNumber,
    receiptType: r.receiptType,
    hasReceipt: r.orNumber !== null,
  }
}
