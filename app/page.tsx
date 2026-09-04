import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  getSummary, listChecks, countChecks, toTableRow, getFilterOptions,
  parseStatusParam, parseEligibilityParam, parseOptionId,
} from '@/lib/queries'
import { LIVE_STATUSES } from '@/lib/domain/check-status'
import { AppHeader } from '@/components/AppHeader'
import { SummaryCards } from '@/components/SummaryCards'
import { FilterBar } from '@/components/FilterBar'
import { CheckTable } from '@/components/CheckTable'
import type { CheckStatus } from '@prisma/client'

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
  }>
}) {
  const user = await requireUser()
  const params = await searchParams

  /**
   * The table defaults to the cheques that still need Finance.
   *
   * Production holds 9,287 cheques, of which 7,433 are RELEASED and 531
   * CANCELLED. A default of "everything" buries the ~400 that somebody has to
   * act on today under eight thousand that nobody will ever touch again, and
   * the row limit means the live ones may not even be on the first page.
   *
   * Only the TABLE is scoped. `getSummary` is called with no filter at all and
   * goes on counting every cheque in the system: a card that quietly reported
   * the filtered subset would read as a total while meaning something else.
   */
  const showAll = params.scope === 'all'

  // The summary does not depend on the filters, and the dropdown options do not
  // depend on the summary — so both are fetched before the filters are known.
  const [summary, options] = await Promise.all([
    getSummary(prisma),
    getFilterOptions(prisma),
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
   * READY FOR RELEASE means both rungs.
   *
   * To Finance the cheque is available and waiting to be handed over; whether a
   * supplier has booked a pickup slot in the portal is a detail, not a separate
   * queue, so the dashboard shows one card counting both. The filter has to
   * agree with the card — a card reading 406 that opens a table of 396 is a bug
   * report waiting to happen.
   *
   * The SCHEDULED status itself is untouched: a portal pickup confirmation
   * still moves READY_FOR_RELEASE -> SCHEDULED, and `applyPickupConfirmation`
   * still refuses every other transition.
   */
  const AVAILABLE: readonly CheckStatus[] = ['READY_FOR_RELEASE', 'SCHEDULED']
  const foldsScheduled = status === 'READY_FOR_RELEASE'

  // Every filter goes into ONE object, which `buildWhere` ANDs together. The
  // dropdowns therefore compose with each other, with the search box, with the
  // incomplete checkbox and with the scope, with no extra query logic here.
  const filters = {
    q: q || undefined,
    status: foldsScheduled ? undefined : status,
    companyId,
    cashAccountId,
    eligibility,
    incomplete,
    // An explicit status from the dropdown wins over the scope — including
    // RELEASED, which the live list excludes.
    statusIn: foldsScheduled ? AVAILABLE : status || showAll ? undefined : LIVE_STATUSES,
  }

  const [rows, matching] = await Promise.all([
    listChecks(prisma, filters),
    countChecks(prisma, filters),
  ])

  /**
   * The filters as a query string, built from the VALIDATED values rather than
   * from the raw parameters. An unrecognised value is dropped everywhere at
   * once: it does not filter the table, and it does not survive into the links
   * that carry the filters forward either.
   */
  const activeParams = () => {
    const qs = new URLSearchParams()
    if (q) qs.set('q', q)
    if (status) qs.set('status', status)
    if (companyId) qs.set('company', companyId)
    if (cashAccountId) qs.set('cashAccount', cashAccountId)
    if (eligibility) qs.set('eligibility', eligibility)
    if (incomplete) qs.set('incomplete', '1')
    return qs
  }

  // Every link that flips the scope keeps the filters the user has already set.
  const scopeHref = (scope: 'live' | 'all') => {
    const qs = activeParams()
    if (scope === 'all') qs.set('scope', 'all')
    const s = qs.toString()
    return s ? `/?${s}` : '/'
  }

  // CLEAR FILTERS drops every filter and keeps only the scope being read. It
  // is not a link to "/" when the user is on ALL CHEQUES: clearing a search
  // should not also throw them back to a different set of cheques.
  const clearHref = showAll ? '/?scope=all' : '/'

  const scopeTab = (active: boolean) =>
    `rounded-lg px-4 py-2 text-sm font-medium ring-1 ${
      active ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
    }`

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <AppHeader user={user} title="CHECK RELEASE MONITORING" />

      <SummaryCards summary={summary} />

      <div className="flex flex-wrap items-center gap-2">
        <Link href={scopeHref('live')} className={scopeTab(!showAll)}>NEEDS ACTION</Link>
        <Link href={scopeHref('all')} className={scopeTab(showAll)}>ALL CHEQUES</Link>
        <span className="text-xs tracking-wide text-slate-500">
          {showAll
            ? 'SHOWING EVERY CHEQUE, INCLUDING RELEASED, CANCELLED AND VOIDED.'
            : 'SHOWING GENERATED, SIGNATURE PENDING, SIGNED, READY FOR RELEASE AND SCHEDULED.'}
        </span>
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
        clearHref={clearHref}
      />

      {status && !showAll && (
        <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">
          FILTERED TO {status.replace(/_/g, ' ')} — a chosen status overrides the NEEDS ACTION scope.
        </p>
      )}

      {incomplete && (
        <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">
          SHOWING INCOMPLETE RECORDS ONLY — cheques whose amount the register never recorded.
          They are counted everywhere but are absent from every currency total, because there is
          no figure of theirs to add. <Link href={clearHref} className="underline underline-offset-2">Clear the filter</Link>.
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
