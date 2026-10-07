import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { buildReleaseTimeline, type TimelineSummary } from '@/lib/release-timeline'
import { cardHref, TODAYS_RELEASE_ANCHOR, type DashboardSelection } from '@/lib/dashboard-view'
import type { TodaysRelease } from '@/lib/queries'

/**
 * THE TOTALS SCREEN'S ONE ROW (user request 2026-10-07: "this looks redundant").
 *
 * Until then READY appeared four times (hero, card, TODAY'S RELEASE, workflow
 * strip) and SIGNED, PENDING and RELEASED twice each. Now every figure appears
 * once: the release ladder, left to right, each step linking to its list via
 * `cardHref` (the same URLs the cards used), with READY carrying the day's
 * money and the RELEASE ALL step. GENERATED shows only when something sits on
 * it. ALL CHECKS and the no-amount exclusion sit underneath as one line.
 *
 * Every count is the summary the page already fetched (`buildReleaseTimeline`),
 * READY's money is `getTodaysRelease` — the same set, so the count and the
 * amount cannot disagree. Money per currency, never summed (rule 8).
 */
const STEP: Record<string, { bg: string; ink: string; dot: string; note: string }> = {
  GENERATED: { bg: 'bg-slate-100', ink: 'text-slate-700', dot: 'bg-slate-400', note: 'JUST CREATED' },
  SIGNATURE_PENDING: { bg: 'bg-warning-bg', ink: 'text-warning-ink', dot: 'bg-warning-ink/70', note: 'WAITING ON A SIGNATORY' },
  SIGNED: { bg: 'bg-sky-bg', ink: 'text-sky-ink', dot: 'bg-sky-ink/70', note: 'IN HAND · TICK READY' },
  READY_FOR_RELEASE: { bg: 'bg-success-bg', ink: 'text-success-ink', dot: 'bg-success-ink/70', note: 'READY TO HAND OVER' },
  RELEASED: { bg: 'bg-lavender-bg', ink: 'text-lavender-ink', dot: 'bg-lavender-ink/70', note: 'HANDED OVER' },
}

export function WorkflowRow({
  summary, total, incomplete, incompleteHref, todays, selection, canRelease, confirming, confirmHref,
}: {
  summary: TimelineSummary
  /** ALL CHECKS: every status, the cheque inventory. */
  total: number
  /** Cheques with no recorded amount, left out of every figure here. */
  incomplete: number
  incompleteHref: string
  todays: TodaysRelease
  selection: DashboardSelection
  /** FINANCE_ADMIN. The server re-checks it; this only decides what is drawn. */
  canRelease: boolean
  /** On the confirmation step: the page draws the confirm block below the row instead. */
  confirming: boolean
  confirmHref: string
}) {
  const nodes = buildReleaseTimeline(summary, selection).filter((n) => n.id !== 'GENERATED' || n.count > 0)
  const cols = nodes.length === 5 ? 'lg:grid-cols-6' : 'lg:grid-cols-5'

  return (
    <section className="space-y-2">
      <nav aria-label="Release workflow">
        <ol className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${cols}`}>
          {nodes.map((node, i) => {
            const s = STEP[node.id]
            const isReady = node.id === 'READY_FOR_RELEASE'
            const frame = `${s.bg} ${node.selected ? 'ring-2 ring-navy' : 'ring-1 ring-black/5'}`
            return (
              <li
                key={node.id}
                id={isReady && !confirming ? TODAYS_RELEASE_ANCHOR : undefined}
                className={`relative flex ${isReady ? 'sm:col-span-2' : ''}`}
              >
                {i > 0 && (
                  <span aria-hidden="true" className="absolute -left-2.5 top-1/2 hidden -translate-y-1/2 text-lg text-slate-300 lg:block">›</span>
                )}
                <div className={`flex w-full flex-col rounded-2xl p-4 shadow-sm transition ${frame}`}>
                  <Link href={node.href} aria-current={node.selected ? 'true' : undefined} className="group block">
                    <span className={`flex items-center gap-2 text-[11px] font-semibold tracking-widest ${s.ink}`}>
                      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${s.dot}`} />
                      {isReady ? 'READY FOR RELEASE' : node.label}
                    </span>
                    <span className={`mt-1 block text-3xl font-semibold tabular-nums group-hover:underline ${s.ink}`}>
                      {node.count.toLocaleString('en-PH')}
                    </span>
                    {isReady && todays.totalsByCurrency.length > 0 ? (
                      <span className={`mt-0.5 block text-lg font-semibold tabular-nums ${s.ink}`}>
                        {todays.totalsByCurrency.map((t) => formatMoney(t.total, t.currency)).join(' + ')}
                      </span>
                    ) : (
                      <span className="mt-0.5 block text-[11px] font-medium tracking-wide text-slate-600">
                        {isReady && node.count === 0 ? 'NOTHING WAITING TO BE HANDED OVER' : s.note}
                      </span>
                    )}
                  </Link>
                  {/* A link, not a submit: one click can only ask for the confirmation. */}
                  {isReady && todays.count > 0 && !confirming && (
                    canRelease ? (
                      <Link
                        href={confirmHref}
                        className="mt-3 inline-block self-start rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold tracking-wide text-white shadow-sm transition hover:bg-rose-800"
                      >
                        RELEASE ALL {todays.count.toLocaleString('en-PH')}
                      </Link>
                    ) : (
                      <p className="mt-3 text-[11px] font-medium tracking-wide text-slate-600">ONLY A FINANCE ADMIN CAN RECORD A RELEASE.</p>
                    )
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </nav>

      <p className="text-xs font-medium tracking-wide text-slate-500">
        <Link href={cardHref('TOTAL_CHECKS', selection)} className="font-semibold text-slate-700 underline-offset-2 hover:underline">
          ALL CHECKS {total.toLocaleString('en-PH')} ›
        </Link>
        {incomplete > 0 && (
          <>
            {'  ·  '}EXCLUDING {incomplete.toLocaleString('en-PH')} WITH NO RECORDED AMOUNT —{' '}
            <Link href={incompleteHref} className="underline underline-offset-2">show them</Link>
          </>
        )}
      </p>
    </section>
  )
}
