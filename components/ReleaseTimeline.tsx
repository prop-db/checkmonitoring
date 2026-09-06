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
export function ReleaseTimeline({
  summary, selection,
}: {
  summary: TimelineSummary
  selection: DashboardSelection
}) {
  const nodes = buildReleaseTimeline(summary, selection)

  return (
    <nav aria-label="Release workflow" className="rounded-2xl bg-white p-4 ring-1 ring-hairline">
      <p className="text-[11px] font-semibold tracking-widest text-slate-400">RELEASE WORKFLOW</p>
      <ol className="mt-3 flex flex-wrap items-stretch gap-1">
        {nodes.map((node, i) => (
          <li key={node.id} className="flex items-stretch gap-1">
            {i > 0 && (
              <span aria-hidden="true" className="self-center px-1 text-slate-300">→</span>
            )}
            <Link
              href={node.href}
              aria-current={node.selected ? 'true' : undefined}
              className={`flex min-w-[8.5rem] flex-col justify-center rounded-xl px-4 py-2.5 transition ${
                node.selected
                  ? 'bg-navy-bg ring-2 ring-navy'
                  : 'bg-ground ring-1 ring-hairline hover:ring-navy'
              }`}
            >
              <span className="text-lg font-semibold tabular-nums text-navy">
                {node.count.toLocaleString('en-PH')}
              </span>
              <span className="text-[11px] font-semibold tracking-wide text-slate-500">
                {node.label}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  )
}
