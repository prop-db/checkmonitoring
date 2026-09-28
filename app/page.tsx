import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  getSummary, getTodaysRelease, listChecks, countChecks, toTableRow, getFilterOptions,
} from '@/lib/queries'
import { resolveDashboardQuery } from '@/lib/dashboard-params'
import {
  clearFiltersHref, dashboardScreen, describeView, incompleteHref,
  releaseConfirmHref, releaseCancelHref,
} from '@/lib/dashboard-view'
import { AppHeader } from '@/components/AppHeader'
import { SummaryCards } from '@/components/SummaryCards'
import { ReleaseTimeline } from '@/components/ReleaseTimeline'
import { TodaysReleasePanel } from '@/components/TodaysReleasePanel'
import { QuickActions } from '@/components/QuickActions'
import { FilterBar } from '@/components/FilterBar'
import { CheckTable } from '@/components/CheckTable'
import { getSyncOverview } from '@/lib/admin/sync-overview'
import { describeStaleness } from '@/lib/sync/staleness'
import { SyncStatusLine } from '@/components/SyncStatusLine'
import { loadSettings } from '@/lib/settings/read'

/**
 * THE DASHBOARD.
 *
 * ── THE ORDER OF THIS PAGE (client brief, 2026-09-06) ─────────────────────
 * "Everything has the same weight, so users don't immediately know what needs
 * to be released today. Since this is an internal finance tool, I'd design it
 * around action first, data second."
 *
 * So the screen is ordered by what it has to answer, and the first three
 * answers are on it before anything is scrolled:
 *
 *   1  KPI ROW          what is ready, what is signed and waiting, what is with
 *                       a signatory, what is it all worth. Four cards — there
 *                       was a fifth, INCOMPLETE, removed on 2026-09-06.
 *   2  TODAY'S RELEASE  the action itself, and the only control that hands
 *                       money over.
 *   3  RELEASE TIMELINE where the queue is jammed — 1,034 on SIGNED beside 80
 *                       on READY is the fact no single card states.
 *   4  the secondary row, the quick actions, the filters, the table.
 *
 * RELEASED (9,545) and TOTAL CHECKS (11,671) are the two largest numbers in the
 * system and the two least actionable. They are demoted into a small secondary
 * row inside `SummaryCards` — still clickable views, because the cards ARE the
 * view selector and that model has not changed.
 *
 * ── TWO SCREENS (client, 2026-09-25) ──────────────────────────────────────
 * "Just only show the totals. Once it is click, it will only the list so i
 * can have more space." A bare `/` renders TOTALS — the KPI row, TODAY'S
 * RELEASE, the timeline and a search box, nothing narrowed. Choosing a card,
 * a timeline node, a search or a filter writes a parameter that narrows the
 * view, and that alone switches the page to LIST — the full-width table with
 * its filter bar, quick actions and export. `dashboardScreen` (Task 1) is the
 * one place that reads the resolved selection and says which screen a URL is;
 * neither screen loads the other's data.
 * ──────────────────────────────────────────────────────────────────────────
 */
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
    releasedFrom?: string
    releasedTo?: string
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
  // `settings` rides along so the sync overview's thresholds, and everything
  // below that reads a setting, come from the same read every screen shares
  // rather than a hard-coded default nobody can change.
  const [summary, options, settings] = await Promise.all([
    getSummary(prisma),
    getFilterOptions(prisma),
    loadSettings(prisma),
  ])

  /**
   * Every URL parameter is validated, the view is resolved and the filters are
   * assembled — all of it in `resolveDashboardQuery`, which is the ONE place
   * that turns a dashboard URL into a query.
   *
   * It lives outside this file because `app/api/export/route.ts` and
   * `app/print/page.tsx` run it too. The Excel export and the printed sheet
   * have to hold exactly what the reader is looking at, and the only way to
   * guarantee that is for all three to run the same code: a second parser that
   * agreed today would drift the first time a filter is added to one of them.
   *
   * The company and cash account ids are checked against the options loaded
   * above — the same list the dropdowns render, so the two cannot disagree
   * about what is selectable.
   *
   * Only the TABLE is scoped by any of this. `getSummary` above takes none of
   * these filters and goes on counting system-wide: a card that quietly
   * reported the filtered subset would read as a total while meaning something
   * else.
   *
   * The ONE narrowing the cards share with the table is the exclusion of the
   * cheques with no recorded amount, and it is shared on purpose — `getSummary`
   * applies it itself, `buildWhere` applies it here, and a PENDING SIGNATURE
   * card whose table opened five rows short is the drift that would otherwise
   * appear the moment the table stopped showing them. The count that is left out
   * is printed above the table with a link that shows it.
   */
  const {
    q, status, companyId, cashAccountId, eligibility, incomplete, showAll, selection, filters,
    releasedFrom, releasedTo,
  } = resolveDashboardQuery(params, options)

  const screen = dashboardScreen(selection)

  if (screen === 'TOTALS') {
    // TOTALS never narrows, so `getTodaysRelease` and the sync overview are the
    // only queries it needs beyond the three already fetched above; `listChecks`
    // and `countChecks` belong to the LIST screen and do not run here.
    const [todaysRelease, syncOverview] = await Promise.all([
      getTodaysRelease(prisma),
      // Two cheap findFirsts per tenant on an indexed column, for the staleness
      // line below. It reads `settings` above, so it cannot join the
      // `Promise.all` those three run in.
      getSyncOverview(prisma, undefined, settings.values['sync.abandonedAfterMinutes']),
    ])

    const staleness = describeStaleness(
      // The latest run that finished with no failed row — `lastSuccess` — is the
      // read; a run that never reached the feed read nothing.
      syncOverview.tenants.map((t) => ({ tenant: t.tenant, lastReadAt: t.lastSuccess?.startedAt ?? null })),
      new Date(),
      settings.values['sync.staleAfterHours'],
    )

    return (
      <main className="mx-auto max-w-[1600px] space-y-6 p-8">
        <AppHeader user={user} title="CHECK RELEASE" />

        {/* When Acumatica was last read. Above the cards, because every number
            on them is only as current as this line says. */}
        <SyncStatusLine staleness={staleness} isAdmin={user.role === 'FINANCE_ADMIN'} />

        {/* The cards ARE the view selector — which set of cheques the table shows
            — and they carry the narrowing filters forward so choosing a view does
            not widen the table back out. `base` deliberately excludes status,
            scope and incomplete: those are the view and its toggle.

            `todaysRelease` is handed to the READY FOR RELEASE card for its value
            line rather than queried again, so the card and the panel below it
            cannot report different money for the same set of cheques. */}
        <SummaryCards summary={summary} todaysRelease={todaysRelease} selection={selection} />

        {/* ── THE DISCLOSURE, TOTALS' COPY ──────────────────────────────────
            See the LIST screen below for the full explanation of why this is
            not optional. Here it sits directly under the cards themselves,
            because TOTALS has no table to say "not listed below" about. */}
        {summary.incomplete > 0 && (
          <p className="text-xs font-medium tracking-wide text-slate-500">
            EXCLUDING {summary.incomplete.toLocaleString('en-PH')} CHEQUE
            {summary.incomplete === 1 ? '' : 'S'} WITH NO RECORDED AMOUNT — not counted in the
            cards above.{' '}
            <Link href={incompleteHref(selection)} className="underline underline-offset-2">
              Show them
            </Link>.
          </p>
        )}

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

        {/* Where the cheques are stuck. Five counts off the summary already
            fetched, five links through `cardHref` — no query and no URL of its
            own. SIGNED lives here rather than in the KPI row: it is a rung, and a
            rung is what a timeline is for. */}
        <ReleaseTimeline summary={summary} selection={selection} />

        {/* Finding one cheque by its number is the commonest reason to open the
            list, so the totals keep one box for it. It submits to `/?q=…`, which
            `dashboardScreen` reads as the LIST. */}
        <form action="/" method="get" className="flex max-w-xl items-center gap-2" role="search">
          <label htmlFor="totals-search" className="sr-only">Search cheques</label>
          <input
            id="totals-search" name="q" type="search"
            placeholder="Search cheque no., payee, CV or AP voucher"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold tracking-wide text-white">
            SEARCH
          </button>
        </form>
      </main>
    )
  }

  // LIST never loads TODAY'S RELEASE or the sync overview — that state belongs
  // to the totals screen, and this table has its own row counts to state.
  //
  // With a DATE RELEASED range in force, a third count: the released cheques
  // in this same view that carry NO release instant and so cannot match any
  // range. Same filters, range removed, narrowed to RELEASED with a null
  // `releasedAt` — so the number is the number of rows the reader's own view
  // would have shown had those releases been recorded here.
  const releasedRange = Boolean(filters.releasedFrom || filters.releasedTo)
  const [rows, matching, undatedReleases] = await Promise.all([
    listChecks(prisma, filters),
    countChecks(prisma, filters),
    releasedRange
      ? countChecks(prisma, {
          ...filters,
          releasedFrom: undefined,
          releasedTo: undefined,
          status: 'RELEASED',
          statusIn: undefined,
          noReleaseDate: true,
        })
      : Promise.resolve(0),
  ])

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <AppHeader user={user} title="CHECK RELEASE" />

      {/* The list gets the page (client, 2026-09-25): one slim bar says where
          you are and how to get back, and the export and print act on exactly
          what is listed below it. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 ring-1 ring-hairline">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/" className="text-sm font-semibold tracking-wide text-navy underline-offset-2 hover:underline">
            ← BACK TO TOTALS
          </Link>
          <span className="text-xs font-medium tracking-wide text-slate-600">
            {describeView(selection)} · {matching.toLocaleString('en-PH')} CHEQUE{matching === 1 ? '' : 'S'}
          </span>
        </div>
        <QuickActions selection={selection} />
      </div>

      {/* ── THE DISCLOSURE ──────────────────────────────────────────────────
          The client asked for the cheques with no recorded amount to be
          taken out of the counts and the table: "ignore them mean you have
          to remove them, dont consider them becuase they dont have amount"
          (2026-09-06). They are still in the database — 25 of them RELEASED
          — and nothing was deleted.

          This line is the price of hiding them, and it is not optional. A
          register that shrinks by 129 with no explanation is how somebody
          concludes money went missing, and by the time they ask, the number
          they remember is a month old. So the count is stated, and the link
          beside it opens exactly those cheques.

          Only when the toggle is OFF: with it on, the reader is already
          looking at them and `describeView` above says so. */}
      {!incomplete && summary.incomplete > 0 && (
        <p className="text-xs font-medium tracking-wide text-slate-500">
          EXCLUDING {summary.incomplete.toLocaleString('en-PH')} CHEQUE
          {summary.incomplete === 1 ? '' : 'S'} WITH NO RECORDED AMOUNT — not counted in the
          totals and not listed below.{' '}
          <Link href={incompleteHref(selection)} className="underline underline-offset-2">
            Show them
          </Link>.
        </p>
      )}

      {/* ── THE OTHER DISCLOSURE ────────────────────────────────────────────
          `releasedAt` is written only by `markReleased`, when a cheque is
          released THROUGH THIS APP. Every release the register load imported
          and every one the two catch-ups moved has none — on purpose: a
          timestamp fabricated from a spreadsheet on a release record is worse
          than none (CLAUDE.md). Since 2026-09-28 the register's stated day
          fills the gap for the cheques it names (`statedReleaseDate`, its own
          column); what is left is the cheques with neither date, and this line
          counts exactly those, or a short table reads as the whole picture. */}
      {releasedRange && undatedReleases > 0 && (
        <p className="text-xs font-medium tracking-wide text-slate-500">
          NOT MATCHED: {undatedReleases.toLocaleString('en-PH')} RELEASED{' '}
          {undatedReleases === 1 ? 'CHEQUE CARRIES' : 'CHEQUES CARRY'} NO RELEASE DATE — neither recorded
          here nor stated in the register. Only a cheque with one of those dates can fall inside a range.
        </p>
      )}

      <FilterBar
        options={options}
        showAll={showAll}
        q={q}
        status={status ?? ''}
        companyId={companyId ?? ''}
        cashAccountId={cashAccountId ?? ''}
        eligibility={eligibility ?? ''}
        incomplete={incomplete}
        releasedFrom={releasedFrom}
        releasedTo={releasedTo}
        showReleasedRange={status === 'RELEASED' || showAll}
        clearHref={clearFiltersHref(selection)}
      />

      {incomplete && (
        <p className="rounded-lg bg-warning-bg px-4 py-2 text-sm text-warning-ink">
          SHOWING ONLY THE INCOMPLETE RECORDS — cheques whose amount the register never recorded.
          They are real cheques and they are still here; they are simply left out of the
          dashboard&rsquo;s counts and its table, and out of every currency total, because there
          is no figure of theirs to add.{' '}
          {/* The toggle's own off-link, so clearing it keeps the view. */}
          <Link href={incompleteHref(selection)} className="underline underline-offset-2">
            Back to the cheques with amounts
          </Link>.
        </p>
      )}

      {matching > rows.length && (
        <p className="rounded-lg bg-warning-bg px-4 py-2 text-sm text-warning-ink">
          SHOWING {rows.length.toLocaleString('en-PH')} OF {matching.toLocaleString('en-PH')} MATCHING CHECKS.
          Narrow the search or filters to see the rest.
        </p>
      )}

      {/* Mapped, not passed straight through: the table is a client component
          and a Prisma Decimal cannot be serialised across that boundary. See
          toTableRow in lib/queries.ts. */}
      <CheckTable
        rows={rows.map(toTableRow)}
        canRelease={user.role === 'FINANCE_ADMIN'}
        bulkCap={settings.values['caps.bulkSelection']}
      />
    </main>
  )
}
