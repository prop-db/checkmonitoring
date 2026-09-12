import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  getSummary, getTodaysRelease, listChecks, countChecks, toTableRow, getFilterOptions,
} from '@/lib/queries'
import { resolveDashboardQuery } from '@/lib/dashboard-params'
import {
  clearFiltersHref, describeView, incompleteHref,
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
  //
  // These queries feed everything above the table. The KPI row's value
  // line and the timeline's five counts are both read off what is already here.
  const [summary, options, todaysRelease, settings] = await Promise.all([
    getSummary(prisma),
    getFilterOptions(prisma),
    getTodaysRelease(prisma),
    // Loaded alongside them so the sync overview's own thresholds — read next,
    // once this resolves — come from the same settings every other screen
    // reads rather than a hard-coded default nobody can change.
    loadSettings(prisma),
  ])

  // A fifth query, added for the staleness line. Two cheap findFirsts per
  // tenant on an indexed column; the comment above about "no fourth query"
  // was about the redesign of the KPI row, and this is not that. It reads
  // `settings` above, so it cannot join the `Promise.all` those four run in.
  const syncOverview = await getSyncOverview(prisma, undefined, settings.values['sync.abandonedAfterMinutes'])

  const staleness = describeStaleness(
    // The latest run that finished with no failed row — `lastSuccess` — is the
    // read; a run that never reached the feed read nothing.
    syncOverview.tenants.map((t) => ({ tenant: t.tenant, lastReadAt: t.lastSuccess?.startedAt ?? null })),
    new Date(),
    settings.values['sync.staleAfterHours'],
  )

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
  } = resolveDashboardQuery(params, options)

  const [rows, matching] = await Promise.all([
    listChecks(prisma, filters),
    countChecks(prisma, filters),
  ])

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

      {/* The scope tabs used to say this. They are gone, because they set the
          same parameters the cards do, but the DEFAULT they carried is not: with
          no card selected the table still shows only the live statuses, and this
          line says so rather than leaving the reader to infer it from a row
          count.

          The quick actions sit beside it, because that line names precisely
          what the export and the printed sheet will contain: the same view, the
          same filters, the same rows. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            VIEWING: {describeView(selection)}
          </p>

          {/* ── THE DISCLOSURE ────────────────────────────────────────────
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
              cards above and not listed below.{' '}
              <Link href={incompleteHref(selection)} className="underline underline-offset-2">
                Show them
              </Link>.
            </p>
          )}
        </div>

        <QuickActions selection={selection} />
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
