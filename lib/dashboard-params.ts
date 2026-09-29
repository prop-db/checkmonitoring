import type { CheckStatus, Eligibility } from '@prisma/client'
import type { CheckFilters, FilterOptions } from './queries'
import { parseStatusParam, parseEligibilityParam, parseOptionId } from './queries'
import { viewStatusFilter, type DashboardSelection } from './dashboard-view'
import { bankLabel, describeFilters, exportViewLabel } from './export/report'
import { isIsoDay } from './domain/details'
import { manilaDayStart, manilaDayEnd } from './audit-view'

/**
 * The dashboard's URL parameters, resolved into the one filter object that
 * reaches Prisma.
 *
 * Extracted from `app/page.tsx` when the Excel export arrived. The export is
 * required to hold EXACTLY what the reader is looking at, and the only way to
 * guarantee that is for the page and the route handler to run the same code —
 * a second parser that agreed today would drift the first time a filter is
 * added to one of them. So the page reads its filters from here, and so does
 * `app/api/export/route.ts`.
 *
 * Pure. `options` is passed in — the ids are validated against the rows the
 * dropdowns actually offer, not against the database directly — so every branch
 * below is testable without one.
 */

export type DashboardSearchParams = {
  q?: string
  status?: string
  company?: string
  cashAccount?: string
  eligibility?: string
  incomplete?: string
  scope?: string
  /** DATE RELEASED bounds, `YYYY-MM-DD` Manila days. */
  releasedFrom?: string
  releasedTo?: string
}

export type DashboardQuery = {
  /** The trimmed search text, as the search box should render it back. */
  q: string
  /** The validated DATE RELEASED days as the bar should render them back, or `''`. */
  releasedFrom: string
  releasedTo: string
  status: CheckStatus | undefined
  eligibility: Eligibility | undefined
  companyId: string | undefined
  cashAccountId: string | undefined
  incomplete: boolean
  showAll: boolean
  /** What the cards are lit against, and what every dashboard link is built from. */
  selection: DashboardSelection
  /** The one object `buildWhere` ANDs together. */
  filters: CheckFilters
  /** The view's short name — "READY FOR RELEASE", "ALL CHEQUES". */
  viewLabel: string
  /** The narrowing filters in words, for the export's title block. */
  filterDescription: string
  /**
   * The narrowing the TOTALS screen applies, in words — the three dropdowns
   * it has and nothing else. 'No filters applied' when none is set; the page
   * prints it only when one is.
   */
  narrowingDescription: string
}

/** A `YYYY-MM-DD` that is a real calendar day, else nothing. Never an error. */
function parseDayParam(value: string | undefined): string | undefined {
  const v = value?.trim() ?? ''
  return isIsoDay(v) ? v : undefined
}

export function resolveDashboardQuery(
  params: DashboardSearchParams,
  options: FilterOptions,
): DashboardQuery {
  const showAll = params.scope === 'all'
  const live = params.scope === 'live'

  /**
   * Every parameter is validated before it reaches Prisma. Casting
   * `params.status` straight to `CheckStatus` would hand Prisma an invalid enum
   * value on a hand-edited or stale bookmarked link and crash the request; a
   * company id nobody recognises would return an empty result that reads as
   * "there are no cheques". Each parser answers `undefined` for anything it
   * does not recognise, which `buildWhere` reads as no filter.
   */
  const status = parseStatusParam(params.status)
  const eligibility = parseEligibilityParam(params.eligibility)
  const companyId = parseOptionId(params.company, options.companies)
  const cashAccountId = parseOptionId(params.cashAccount, options.cashAccounts)

  /**
   * The checkbox submits `incomplete=1`; the dashboard's "Show them" link
   * writes the same. Only "1" turns it on — an unrecognised value leaves it off
   * rather than guessing, which is how every parameter above behaves too.
   *
   * OFF is not "no filter" any more. `CheckFilters.incomplete` is a tri-state,
   * and this boolean feeds it directly: `true` shows only the cheques with no
   * recorded amount, `false` EXCLUDES them, which is the dashboard's default
   * since the client asked for it on 2026-09-06. The bookmark behaviour is
   * unchanged — `?incomplete=1` still opens exactly what it always did — but a
   * URL WITHOUT the parameter now opens a smaller register than it used to, and
   * the page says so above the table.
   */
  const incomplete = params.incomplete === '1'

  const q = params.q?.trim() ?? ''

  /**
   * DATE RELEASED applies only where a released cheque can be: the RELEASED
   * view and ALL CHEQUES. On any other view the two are dropped exactly as an
   * unrecognised company id is — a live cheque has no release instant, so the
   * range could only empty the table without saying why — and, being dropped
   * here, they leave `base` and the description too, so a card link out of
   * RELEASED does not carry a filter the destination cannot honour.
   */
  const releasedRangeApplies = status === 'RELEASED' || showAll
  const releasedFrom = releasedRangeApplies ? parseDayParam(params.releasedFrom) : undefined
  const releasedTo = releasedRangeApplies ? parseDayParam(params.releasedTo) : undefined

  const selection: DashboardSelection = {
    status: status ?? null,
    showAll,
    incomplete,
    live,
    // Built from the VALIDATED values, so an unrecognised one is dropped
    // everywhere at once: it does not filter, and it does not survive into a
    // card's link or the export's URL either.
    base: Object.fromEntries(
      Object.entries({
        q,
        company: companyId ?? '',
        cashAccount: cashAccountId ?? '',
        eligibility: eligibility ?? '',
        releasedFrom: releasedFrom ?? '',
        releasedTo: releasedTo ?? '',
      }).filter(([, v]) => v !== ''),
    ),
  }

  const filters: CheckFilters = {
    q: q || undefined,
    companyId,
    cashAccountId,
    eligibility,
    incomplete,
    // Manila calendar days become inclusive instants: the day's first and last
    // millisecond in UTC+8. FROM after TO is passed through as given.
    releasedFrom: releasedFrom ? manilaDayStart(releasedFrom) : undefined,
    releasedTo: releasedTo ? manilaDayEnd(releasedTo) : undefined,
    ...viewStatusFilter(selection),
  }

  // The labels a reader recognises, not the ids. A title block reading
  // "COMPANY: cmf3x9..." tells a manager nothing.
  const company = options.companies.find((c) => c.id === companyId)
  const account = options.cashAccounts.find((a) => a.id === cashAccountId)

  return {
    q,
    releasedFrom: releasedFrom ?? '',
    releasedTo: releasedTo ?? '',
    status,
    eligibility,
    companyId,
    cashAccountId,
    incomplete,
    showAll,
    selection,
    filters,
    viewLabel: exportViewLabel(selection),
    filterDescription: describeFilters({
      company: company?.code ?? null,
      bank: account ? bankLabel(account.code, account.bankCode) : null,
      eligibility: eligibility ?? null,
      q,
      incomplete,
      releasedFrom: releasedFrom ?? null,
      releasedTo: releasedTo ?? null,
    }),
    narrowingDescription: describeFilters({
      company: company?.code ?? null,
      bank: account ? bankLabel(account.code, account.bankCode) : null,
      eligibility: eligibility ?? null,
      q: '',
      incomplete: undefined,
      releasedFrom: null,
      releasedTo: null,
    }),
  }
}
