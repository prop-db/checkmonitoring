import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getSummary, listChecks, countChecks, toTableRow } from '@/lib/queries'
import { LIVE_STATUSES } from '@/lib/domain/check-status'
import { AppHeader } from '@/components/AppHeader'
import { SummaryCards } from '@/components/SummaryCards'
import { CheckTable } from '@/components/CheckTable'
import type { CheckStatus } from '@prisma/client'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; incomplete?: string; scope?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  // `status` comes from the URL. Casting it straight to CheckStatus would hand
  // Prisma an invalid enum value on a hand-edited or stale bookmarked link and
  // crash the page with a 500. Validate, and ignore anything unrecognised.
  const VALID: readonly string[] = [
    'GENERATED', 'SIGNATURE_PENDING', 'SIGNED',
    'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED',
  ]
  const status = params.status && VALID.includes(params.status)
    ? (params.status as CheckStatus)
    : undefined

  // The checkbox submits `incomplete=1`; the summary card links to the same.
  // Only "1" turns it on — an unrecognised value leaves the filter off rather
  // than guessing, which is how the status parameter above behaves too.
  const incomplete = params.incomplete === '1'

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

  const filters = {
    q: params.q,
    status: foldsScheduled ? undefined : status,
    incomplete,
    // An explicit status from the dropdown wins over the scope — including
    // RELEASED, which the live list excludes.
    statusIn: foldsScheduled ? AVAILABLE : status || showAll ? undefined : LIVE_STATUSES,
  }

  const [summary, rows, matching] = await Promise.all([
    getSummary(prisma),
    listChecks(prisma, filters),
    countChecks(prisma, filters),
  ])

  // Every link that flips the scope keeps the filters the user has already set.
  const scopeHref = (scope: 'live' | 'all') => {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    if (params.status) qs.set('status', params.status)
    if (incomplete) qs.set('incomplete', '1')
    if (scope === 'all') qs.set('scope', 'all')
    const s = qs.toString()
    return s ? `/?${s}` : '/'
  }

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

      <form className="flex flex-wrap gap-3" method="get">
        {/* The scope survives a search. Without this the form would drop
            ?scope=all and silently pull the user back to the live list. */}
        {showAll && <input type="hidden" name="scope" value="all" />}
        <input
          name="q" defaultValue={params.q ?? ''}
          placeholder="SEARCH CHECK NO., APV, PO OR SUPPLIER"
          className="w-96 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <select name="status" defaultValue={params.status ?? ''}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">ALL STATUSES</option>
          {['SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        {/* The 129 cheques whose amount the register never recorded. A
            checkbox, not a third option on the status dropdown: incompleteness
            cuts across every status (50 SIGNATURE_PENDING, 48 CANCELLED, 25
            RELEASED, 6 READY_FOR_RELEASE), so it has to narrow alongside a
            status rather than replace one. */}
        <label className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <input type="checkbox" name="incomplete" value="1" defaultChecked={incomplete} />
          INCOMPLETE ONLY (NO AMOUNT)
        </label>
        <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          APPLY
        </button>
      </form>

      {status && !showAll && (
        <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">
          FILTERED TO {status.replace(/_/g, ' ')} — a chosen status overrides the NEEDS ACTION scope.
        </p>
      )}

      {incomplete && (
        <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">
          SHOWING INCOMPLETE RECORDS ONLY — cheques whose amount the register never recorded.
          They are counted everywhere but are absent from every currency total, because there is
          no figure of theirs to add. <Link href="/" className="underline underline-offset-2">Clear the filter</Link>.
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
