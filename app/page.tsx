import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  getSummary, getTodaysRelease, listChecks, countChecks, toTableRow, getFilterOptions,
} from '@/lib/queries'
import { resolveDashboardQuery } from '@/lib/dashboard-params'
import {
  cardHref, clearFiltersHref, describeView,
  releaseConfirmHref, releaseCancelHref, exportHref,
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
   * Every URL parameter is validated, the view is resolved and the filters are
   * assembled — all of it in `resolveDashboardQuery`, which is the ONE place
   * that turns a dashboard URL into a query.
   *
   * It lives outside this file because `app/api/export/route.ts` runs it too.
   * The Excel export has to hold exactly what the reader is looking at, and the
   * only way to guarantee that is for both to run the same code: a second
   * parser that agreed today would drift the first time a filter is added to
   * one of them.
   *
   * The company and cash account ids are checked against the options loaded
   * above — the same list the dropdowns render, so the two cannot disagree
   * about what is selectable.
   *
   * Only the TABLE is scoped by any of this. `getSummary` above is called with
   * no filter at all and goes on counting every cheque in the system: a card
   * that quietly reported the filtered subset would read as a total while
   * meaning something else.
   */
  const {
    q, status, companyId, cashAccountId, eligibility, incomplete, showAll, selection, filters,
  } = resolveDashboardQuery(params, options)

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-slate-600">
          VIEWING: {describeView(selection)}
        </p>

        {/* Beside the line that names the view, because that is precisely what
            the file will contain: the same view, the same filters, the same
            rows. A plain anchor, not a button with an onClick — the download
            has to work on a Finance workstation whose JavaScript has failed,
            the same reasoning as the filter bar and the sign-out form.

            `download` is deliberately absent: the filename is set by the
            route's Content-Disposition, which is the only place that knows the
            view and the date the file was actually generated. */}
        <a
          href={exportHref(selection)}
          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium tracking-wide text-white hover:bg-emerald-800"
        >
          EXPORT TO EXCEL
        </a>
      </div>

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
