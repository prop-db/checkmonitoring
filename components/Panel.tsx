/**
 * A white card on the tinted ground — the one surface shape this application
 * uses.
 *
 * The dashboard settled it: `rounded-2xl bg-white ring-1 ring-hairline`, with a
 * small tracked heading in the quietest ink on the page. Every other screen was
 * repeating that by hand and drifting — `ring-slate-200` here, `ring-slate-100`
 * there, a heading at `text-sm font-semibold` on one page and `text-xs` on the
 * next — which is how an internal tool ends up looking like three products.
 *
 * Deliberately not a layout component. It draws a bordered box with a title and
 * decides nothing about what goes inside it, so a table, a form and a
 * description list can all sit in one without this file knowing about any of
 * them. `p-0` via `bodyClassName` is how a table gets to touch the card's edge.
 */
export function Panel({
  title, aside, children, className = '', bodyClassName = '',
}: {
  /** Omitted for a card that is its own heading — a figure, say. */
  title?: string
  /** The right-hand end of the heading row: a count, a pill, a link. */
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={`rounded-2xl bg-white shadow-sm ring-1 ring-hairline ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-baseline justify-between gap-3 px-6 pb-4 pt-6">
          {title && <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">{title}</h2>}
          {aside}
        </div>
      )}
      <div className={bodyClassName || `px-6 pb-6 ${title || aside ? '' : 'pt-6'}`}>{children}</div>
    </section>
  )
}

/**
 * A label over a value. The detail page is two dozen of these and they have to
 * line up.
 *
 * `tabular` exists for one reason: an amount. Right-aligned and tabular-figured
 * so the decimal point sits where the eye expects it, exactly as the dashboard
 * table renders the same column — a figure that reads differently on the two
 * screens showing it is a figure somebody will double-check by hand.
 */
export function Field({
  label, value, tabular = false, wide = false,
}: {
  label: string
  value: React.ReactNode
  tabular?: boolean
  wide?: boolean
}) {
  return (
    <div className={wide ? 'sm:col-span-2 md:col-span-3' : undefined}>
      <dt className="text-[11px] font-semibold tracking-widest text-slate-400">{label}</dt>
      <dd
        className={`mt-1 text-sm text-slate-900 ${
          tabular ? 'text-right font-medium tabular-nums' : 'break-words'
        }`}
      >
        {value}
      </dd>
    </div>
  )
}
