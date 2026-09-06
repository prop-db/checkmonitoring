import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  getSummary, getTodaysRelease, listChecks, countChecks, toTableRow, getFilterOptions,
  parseStatusParam, parseEligibilityParam, parseOptionId,
} from '@/lib/queries'
import {
  cardHref, clearFiltersHref, describeView, viewStatusFilter,
  releaseConfirmHref, releaseCancelHref,
  type DashboardSelection,
} from '@/lib/dashboard-view'
import { AppHeader } from '@/components/AppHeader'
import { SummaryCards } from '@/components/SummaryCards'
import { TodaysReleasePanel } from '@/components/TodaysReleasePanel'
import { FilterBar } from '@/components/FilterBar'
import { CheckTable } from '@/components/CheckTable'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    status?: string
    company?: string
    cashAccount?: string
    eligibility?: string
    incomplete?: string
    scope?: string
    /**
     * TODAY'S RELEASE's confirmation step. It lives in the URL rather than in a
     * `confirm()` dialog so the step exists before any JavaScript does — on the
     * one action in this system that hands money over.
     */
    confirm?: string
  }>
}) {
  const user = await requireUser()
  const params = await searchParams

  /**
   * The table defaults to the cheques that still need Finance.
   *
   * Production holds 9,287 cheques, of which 7,433 are RELEASED and 531
   * CANCELLED. A default of "everything" buries the ones somebody has to act on
   * today under eight thousand that nobody will ever touch again, and the row
   * limit means the live ones may not even be on the first page.
   *
   * The NEEDS ACTION / ALL CHEQUES tabs that used to set this are gone — they
   * duplicated the TOTAL CHECKS card, which is exactly "all cheques". The
   * parameter stays: TOTAL CHECKS writes it, and a bookmark saved with it still
   * opens the view it named. The default it guards is not silent — the line
   * above the table names whichever view is active.
   *
   * Only the TABLE is scoped. `getSummary` is called with no filter at all and
   * goes on counting every cheque in the system: a card that quietly reported
   * the filtered subset would read as a total while meaning something else.
   */
  const showAll = params.scope === 'all'

  // The summary does not depend on the filters, and the dropdown options do not
  // depend on the summary — so both are fetched before the filters are known.
  //
  // TODAY'S RELEASE is fetched alongside them and, like the summary, takes NO
  // filters: it is what is ready to hand over right now, not what is ready
  // within whatever the reader happens to have narrowed the table to. A panel
  // offering to RELEASE ALL over a filtered subset while reading like a total
  // is the misunderstanding worth ruling out by construction.
  const [summary, options, todaysRelease] = await Promise.all([
    getSummary(prisma),
    getFilterOptions(prisma),
    getTodaysRelease(prisma),
  ])

  /**
   * Every URL parameter is validated before it reaches Prisma.
   *
   * Casting `params.status` straight to `CheckStatus` would hand Prisma an
   * invalid enum value on a hand-edited or stale bookmarked link and crash the
   * page with a 500; a company id nobody recognises would return an empty table
   * that reads as "there are no cheques". Each parser answers `undefined` for
   * anything it does not recognise, which `buildWhere` reads as no filter.
   *
   * The company and cash account ids are checked against the options actually
   * loaded above — the same list the dropdowns render, so the two cannot
   * disagree about what is selectable.
   */
  const status = parseStatusParam(params.status)
  const eligibility = parseEligibilityParam(params.eligibility)
  const companyId = parseOptionId(params.company, options.companies)
  const cashAccountId = parseOptionId(params.cashAccount, options.cashAccounts)

  // The checkbox submits `incomplete=1`; the summary card links to the same.
  // Only "1" turns it on — an unrecognised value leaves the filter off rather
  // than guessing, which is how every parameter above behaves too.
  const incomplete = params.incomplete === '1'

  const q = params.q?.trim() ?? ''

  /**
   * The selected view, and the filters that narrow within it.
   *
   * `base` is everything a card must carry forward — the search box and the
   * three dropdowns — built from the VALIDATED values rather than the raw
   * parameters, so an unrecognised one is dropped everywhere at once: it does
   * not filter the table and it does not survive into a card's link either.
   */
  const selection: DashboardSelection = {
    status: status ?? null,
    showAll,
    incomplete,
    base: Object.fromEntries(
      Object.entries({
        q,
        company: companyId ?? '',
        cashAccount: cashAccountId ?? '',
        eligibility: eligibility ?? '',
      }).filter(([, v]) => v !== ''),
    ),
  }

  // Every filter goes into ONE object, which `buildWhere` ANDs together. The
  // dropdowns therefore compose with each other, with the search box, with the
  // incomplete toggle and with the view, with no extra query logic here.
  //
  // The view's own status filter comes from `viewStatusFilter` — the same pure
  // function the cards are built from, so the table and the card that opened it
  // cannot disagree about what READY FOR RELEASE means.
  const filters = {
    q: q || undefined,
    companyId,
    cashAccountId,
    eligibility,
    incomplete,
    ...viewStatusFilter(selection),
  }

  const [rows, matching] = await Promise.all([
    listChecks(prisma, filters),
    countChecks(prisma, filters),
  ])

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <AppHeader user={user} title="CHECK RELEASE MONITORING" />

      {/* The cards ARE the view selector — which set of cheques the table shows
          — and they carry the narrowing filters forward so choosing a view does
          not widen the table back out. `base` deliberately excludes status,
          scope and incomplete: those are the view and its toggle. */}
      <SummaryCards summary={summary} selection={selection} />

      {/* Directly under the cards and above everything to do with the table:
          this is the answer to "what do I do today", and it is shown even when
          the count is zero so that "nothing is ready" and "the panel broke" can
          never look the same.

          `confirming` is an exact string match, like every other parameter on
          this page — an unrecognised value leaves the panel on its first step
          rather than guessing its way into a confirmation. */}
      <TodaysReleasePanel
        todays={todaysRelease}
        canRelease={user.role === 'FINANCE_ADMIN'}
        confirming={params.confirm === 'release'}
        confirmHref={releaseConfirmHref(selection)}
        cancelHref={releaseCancelHref(selection)}
      />

      {/* The scope tabs used to say this. They are gone, because they set the
          same parameters the cards do, but the DEFAULT they carried is not: with
          no card selected the table still shows only the live statuses, and this
          line says so rather than leaving the reader to infer it from a row
          count. */}
      <p className="text-xs font-medium tracking-wide text-slate-600">
        VIEWING: {describeView(selection)}
      </p>

      <FilterBar
        options={options}
        showAll={showAll}
        q={q}
        status={status ?? ''}
        companyId={companyId ?? ''}
        cashAccountId={cashAccountId ?? ''}
        eligibility={eligibility ?? ''}
        incomplete={incomplete}
        clearHref={clearFiltersHref(selection)}
      />

      {incomplete && (
        <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">
          NARROWED TO INCOMPLETE RECORDS — cheques whose amount the register never recorded.
          They are counted everywhere but are absent from every currency total, because there is
          no figure of theirs to add.{' '}
          {/* The card's own off-link, so clearing the toggle keeps the view. */}
          <Link href={cardHref('INCOMPLETE', selection)} className="underline underline-offset-2">
            Stop narrowing to them
          </Link>.
        </p>
      )}

      {matching > rows.length && (
        <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">
          SHOWING {rows.length.toLocaleString('en-PH')} OF {matching.toLocaleString('en-PH')} MATCHING CHECKS.
          Narrow the search or filters to see the rest.
        </p>
      )}

      {/* Mapped, not passed straight through: the table is a client component
          and a Prisma Decimal cannot be serialised across that boundary. See
          toTableRow in lib/queries.ts. */}
      <CheckTable rows={rows.map(toTableRow)} canRelease={user.role === 'FINANCE_ADMIN'} />
    </main>
  )
}
