/**
 * NOTHING HERE, SAID OUT LOUD.
 *
 * An empty table with its headers still drawn is the worst of both: it looks
 * like data that failed to load, and it makes the reader count the rows to be
 * sure. Every list in this application — the staged queue, the approval rows
 * that attached to nothing, the sync log, a cheque's audit trail — now says
 * what its emptiness means instead.
 *
 * ── WHY THERE IS A `tone` ─────────────────────────────────────────────────
 * Because empty is not always the same news. A staged queue with nothing in it
 * means every row of the register found a cheque, which is the outcome this
 * system exists to produce and is worth a green tick. A sync log with nothing
 * in it means nobody has ever synced, which is neutral and slightly awkward.
 * Drawing both in the same grey would throw away the distinction; drawing both
 * in green would be a screen congratulating itself for a job not yet started.
 *
 * `good` is the only toned variant, and it is the palest tone in the palette.
 * The client's standing note is "avoid saturated colours", and an empty state
 * is the least important thing on any screen it appears on.
 * ──────────────────────────────────────────────────────────────────────────
 */
export function EmptyState({
  title, children, tone = 'plain',
}: {
  /** One line, stating the fact. Not "No results" — what is not there. */
  title: string
  /** Optional second line: what it means, or what to do about it. */
  children?: React.ReactNode
  tone?: 'plain' | 'good'
}) {
  const good = tone === 'good'

  return (
    <div className="rounded-2xl bg-white px-6 py-12 text-center ring-1 ring-hairline">
      <span
        className={`mx-auto flex h-10 w-10 items-center justify-center rounded-full ${
          good ? 'bg-success-bg text-success-ink' : 'bg-ground text-slate-400'
        }`}
      >
        {/* Decorative. The heading beneath already says what this is, and an
            icon that repeats it is announced twice. */}
        <svg
          className="h-5 w-5" viewBox="0 0 20 20" fill="none"
          stroke="currentColor" strokeWidth="1.8" aria-hidden="true"
        >
          {good
            ? <path d="M4.5 10.5 8.5 14.5l7-9" strokeLinecap="round" strokeLinejoin="round" />
            : <><circle cx="10" cy="10" r="7" /><path d="M7 10h6" strokeLinecap="round" /></>}
        </svg>
      </span>

      <p className="mt-3 text-sm font-semibold tracking-wide text-navy">{title}</p>
      {children && (
        <p className="mx-auto mt-1 max-w-xl text-sm leading-relaxed text-slate-500">{children}</p>
      )}
    </div>
  )
}
