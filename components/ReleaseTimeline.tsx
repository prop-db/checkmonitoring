import Link from 'next/link'
import { buildReleaseTimeline, type TimelineSummary } from '@/lib/release-timeline'
import type { DashboardSelection } from '@/lib/dashboard-view'

/**
 * The release workflow, drawn.
 *
 * GENERATED → PENDING → SIGNED → READY → RELEASED, each node carrying its live
 * count and linking to that view. It answers the question the cards do not:
 * not "how many are ready" but "where is the queue jammed" — 1,034 sitting on
 * SIGNED beside 80 on READY is a fact about the department's week that no
 * single card states.
 *
 * Every count comes from the summary the page already fetched and every link
 * from `cardHref`. No query, no URL built here. See lib/release-timeline.ts.
 *
 * The arrows are `aria-hidden` and rendered as separate elements rather than
 * baked into the labels: a screen reader reading "GENERATED 12 → PENDING 230"
 * gains nothing from the arrow and loses the list structure, so the nodes are a
 * list and the arrows are decoration.
 */
/** Each rung's own pastel and ink, so the ladder reads as a progression. */
const RUNG: Record<string, { bg: string; ink: string; dot: string }> = {
  GENERATED: { bg: 'bg-slate-100', ink: 'text-slate-700', dot: 'bg-slate-400' },
  SIGNATURE_PENDING: { bg: 'bg-warning-bg', ink: 'text-warning-ink', dot: 'bg-warning-ink/70' },
  SIGNED: { bg: 'bg-sky-bg', ink: 'text-sky-ink', dot: 'bg-sky-ink/70' },
  READY_FOR_RELEASE: { bg: 'bg-success-bg', ink: 'text-success-ink', dot: 'bg-success-ink/70' },
  RELEASED: { bg: 'bg-lavender-bg', ink: 'text-lavender-ink', dot: 'bg-lavender-ink/70' },
}

export function ReleaseTimeline({
  summary, selection,
}: {
  summary: TimelineSummary
  selection: DashboardSelection
}) {
  const nodes = buildReleaseTimeline(summary, selection)

  return (
    <nav aria-label="Release workflow" className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-hairline">
      <p className="text-[11px] font-semibold tracking-widest text-slate-400">RELEASE WORKFLOW</p>
      <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {nodes.map((node, i) => (
          <li key={node.id} className="relative flex items-stretch">
            {i > 0 && (
              <span aria-hidden="true" className="absolute -left-2 top-1/2 hidden -translate-y-1/2 text-slate-300 lg:block">›</span>
            )}
            <Link
              href={node.href}
              aria-current={node.selected ? 'true' : undefined}
              className={`flex w-full flex-col justify-center rounded-xl px-4 py-3 transition hover:-translate-y-0.5 hover:shadow-sm ${RUNG[node.id].bg} ${
                node.selected ? 'ring-2 ring-navy' : 'ring-1 ring-black/5 hover:ring-navy'
              }`}
            >
              <span className={`flex items-center gap-2 text-[11px] font-semibold tracking-wide ${RUNG[node.id].ink}`}>
                <span aria-hidden="true" className={`h-2 w-2 rounded-full ${RUNG[node.id].dot}`} />
                {node.label}
              </span>
              <span className={`mt-1 text-2xl font-semibold tabular-nums ${RUNG[node.id].ink}`}>
                {node.count.toLocaleString('en-PH')}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  )
}
