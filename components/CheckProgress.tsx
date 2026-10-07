import { buildCheckProgress, type LadderId, type ProgressState } from '@/lib/release-timeline'

/**
 * WHERE THIS CHEQUE IS, drawn.
 *
 * The dashboard's `WorkflowRow` shows the rungs with a count on each and
 * answers "where is the queue jammed". This shows the same five rungs, in the
 * same order, at the same size, and answers "where is this one" — the reader
 * who learned the shape on the dashboard reads this one without being taught.
 *
 * The arithmetic is `buildCheckProgress` in lib/release-timeline.ts, which is
 * pure and tested. This file decides what a rung looks like, never which rung
 * a cheque is on — the same division as `StatusPill` and `lib/status-pill.ts`.
 *
 * ── COLOUR ────────────────────────────────────────────────────────────────
 * One rung is coloured: the one the cheque is on. Everything behind it is the
 * page's own ground with a tick, everything ahead is white. The client's
 * complaint was a screen where everything was tinted and nothing stood out, and
 * a five-stage spine in five colours is that complaint drawn.
 *
 * The current rung also carries a heavy navy ring, not colour alone: it is the
 * dashboard's own selected-card treatment, and it keeps the position visible to
 * a reader who cannot separate the tints.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `marks` are formatted on the server and passed in as strings — the dates are
 * already on the page and this component neither reads a clock nor holds a
 * `Date`. Anything not supplied simply has no line under it.
 */
export function CheckProgress({
  status, marks = {},
}: {
  status: string
  marks?: Partial<Record<LadderId, string | null>>
}) {
  const { steps, stopped } = buildCheckProgress(status)

  const skin: Record<ProgressState, string> = {
    DONE: 'bg-ground ring-1 ring-hairline',
    CURRENT: 'bg-navy-bg ring-2 ring-navy',
    UPCOMING: 'bg-white ring-1 ring-hairline',
  }

  const ink: Record<ProgressState, string> = {
    DONE: 'text-slate-500',
    CURRENT: 'text-navy',
    UPCOMING: 'text-slate-400',
  }

  return (
    // A list with decorative arrows between the items, exactly as the dashboard
    // timeline does it: a screen reader gains nothing from "SIGNED → READY" and
    // loses the list structure if the arrows are baked into the labels.
    <ol className="flex flex-wrap items-stretch gap-1">
      {steps.map((step, i) => (
        <li key={step.id} className="flex items-stretch gap-1">
          {i > 0 && <span aria-hidden="true" className="self-center px-1 text-slate-300">→</span>}
          <div
            // The rung the cheque is on is announced, not just tinted. A
            // cheque that has stopped is on no rung at all, so nothing here is
            // marked current and the pill after the ladder carries the fact.
            aria-current={step.state === 'CURRENT' ? 'step' : undefined}
            className={`flex min-w-[8.5rem] flex-col justify-center rounded-xl px-4 py-2.5 ${skin[step.state]} ${
              // A stopped cheque never walked this ladder as far as anything
              // here records, so the whole of it is drawn back rather than
              // half-lit in a way that would imply a position.
              stopped ? 'opacity-60' : ''
            }`}
          >
            <span className={`flex items-center gap-1.5 text-[11px] font-semibold tracking-wide ${ink[step.state]}`}>
              {step.state === 'DONE' && (
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                  <path d="M3.5 10.5 8 15l8.5-10" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {step.label}
            </span>
            {/* Never conditional on the rung being reached: an empty line here
                and no line at all would make the row change height as a cheque
                moves, and the movement reads as meaning. */}
            <span className="mt-0.5 text-[11px] tabular-nums text-slate-400">
              {marks[step.id] ?? ' '}
            </span>
          </div>
        </li>
      ))}

      {/* CANCELLED and VOIDED are not rungs — see buildCheckProgress. Stated
          after the ladder, in the danger tone the status pill already uses for
          them, so the two agree on this screen. */}
      {stopped && (
        <li className="flex items-stretch gap-1">
          <span aria-hidden="true" className="self-center px-1 text-slate-300">→</span>
          <div className="flex min-w-[8.5rem] flex-col justify-center rounded-xl bg-danger-bg px-4 py-2.5 ring-1 ring-danger-ink/20">
            <span className="text-[11px] font-semibold tracking-wide text-danger-ink">{stopped}</span>
            {/* Which of the two it is matters: CANCELLED is a Finance decision
                taken here and carries a reason; VOIDED arrives from Acumatica,
                and can arrive after the cheque was handed over. */}
            <span className="mt-0.5 text-[11px] text-danger-ink/70">
              {stopped === 'CANCELLED' ? 'FINANCE STOPPED IT' : 'VOIDED IN ACUMATICA'}
            </span>
          </div>
        </li>
      )}
    </ol>
  )
}
