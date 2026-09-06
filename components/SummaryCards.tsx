import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { cardHref, isCardSelected, type CardId, type DashboardSelection } from '@/lib/dashboard-view'
import type { CurrencyTotal } from '@/lib/queries'

// `CurrencyTotal` is imported rather than restated. It was declared twice —
// here and in lib/queries.ts — and the two had already drifted apart on
// `total`'s nullability, which is precisely the drift a duplicated type
// invites: the query started returning null and this file went on promising a
// string.

type Summary = {
  total: number; pendingSignature: number; signed: number
  readyForRelease: number; scheduled: number; released: number
  incomplete: number
  totalsByCurrency: CurrencyTotal[]
}

function Card({
  label, value, accent = false, tone = 'plain', href, selected = false, hint,
}: {
  label: string
  value: React.ReactNode
  accent?: boolean
  tone?: 'plain' | 'warn'
  href?: string
  selected?: boolean
  hint?: string
}) {
  const skin = tone === 'warn'
    ? 'bg-amber-50 ring-amber-200'
    : accent ? 'bg-emerald-50 ring-emerald-200' : 'bg-white ring-slate-200'

  /**
   * The selected card keeps its own colour and gains a heavy dark outline.
   *
   * Colour alone would not do it: READY FOR RELEASE is already green and
   * INCOMPLETE already amber, so "the tinted one" cannot mean "the chosen one"
   * as well. The ring is a second channel, which also means the selection is
   * still visible to someone who cannot separate those hues.
   */
  const ring = selected ? 'ring-2 ring-slate-900 shadow-sm' : `ring-1 ${skin.split(' ').pop()}`
  const bg = skin.split(' ')[0]

  const body = (
    <>
      <p className="text-xs font-medium tracking-wide text-slate-500">{label}</p>
      {/* A plain number renders as text; a currency breakdown renders block-level
          markup (dl/div), which HTML forbids inside <p>. The wrapper has to be a
          <div> to legally hold either. */}
      <div className="mt-2 text-2xl font-semibold text-slate-900">{value}</div>
      {selected && hint && (
        <p className="mt-1 text-[10px] font-medium tracking-wide text-slate-500">{hint}</p>
      )}
    </>
  )

  // A card with somewhere to go is a link; the rest stay plain divs. Wrapping
  // every card in an anchor "for consistency" would offer six dead links.
  //
  // `aria-current` rather than colour alone: a screen reader announces which
  // card is filtering the table, which the outline cannot convey.
  return href
    ? (
      <Link
        href={href}
        aria-current={selected ? 'true' : undefined}
        className={`block rounded-2xl p-5 transition ${bg} ${ring} hover:ring-slate-400`}
      >
        {body}
      </Link>
    )
    : <div className={`rounded-2xl p-5 ${bg} ${ring}`}>{body}</div>
}

// One line per currency, never one summed figure: a PHP total and a CNY total
// are not the same unit and must never be added together.
function CurrencyBreakdown({ totalsByCurrency }: { totalsByCurrency: CurrencyTotal[] }) {
  if (totalsByCurrency.length === 0) {
    return <div>{formatMoney('0', 'PHP')}</div>
  }
  return (
    <dl className="space-y-1">
      {totalsByCurrency.map((t) => (
        <div key={t.currency} className="flex items-baseline justify-between gap-3">
          <dt className="text-lg font-semibold text-slate-900">{formatMoney(t.total, t.currency)}</dt>
          <dd className="text-xs text-slate-500">{t.count} {t.currency}</dd>
        </div>
      ))}
    </dl>
  )
}

// Re-exported so a caller rendering these cards has one import, not two. The
// type itself is declared with the logic, in lib/dashboard-view.ts.
export type { DashboardSelection } from '@/lib/dashboard-view'

/**
 * The cards are the dashboard's VIEW SELECTOR, not a shortcut to a dropdown.
 *
 * Selecting one chooses which set of cheques the table shows; the filter bar's
 * COMPANY, BANK and ELIGIBILITY dropdowns then narrow within it. There is no
 * STATUS dropdown and no scope tabs any more — they wrote the same URL
 * parameters as these cards, and the client never read the cards as filters
 * while a dropdown was competing with them.
 *
 * All of the URL arithmetic lives in `lib/dashboard-view.ts`, which is pure and
 * tested. This file decides what a card looks like, never what it means.
 *
 * Card order follows the spec's priority: READY FOR RELEASE is the primary
 * daily Finance activity and leads the row.
 */
export function SummaryCards({
  summary, selection,
}: {
  summary: Summary
  selection: DashboardSelection
}) {
  /**
   * A selected view card links back to NEEDS ACTION, so clicking it again turns
   * it off. A view you can switch on and cannot switch off sends people to the
   * browser's Back button to undo a click they just made.
   *
   * The hint says which of the two things a lit card is doing: a view card is
   * the table's scope, INCOMPLETE only narrows whatever scope is already there.
   */
  const card = (id: CardId) => ({
    selected: isCardSelected(id, selection),
    href: cardHref(id, selection),
    hint: id === 'INCOMPLETE'
      ? 'ALSO NARROWED TO THESE — CLICK TO STOP'
      : 'VIEWING — CLICK FOR NEEDS ACTION',
  })

  return (
    <section className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-7">
      {/* SCHEDULED has no card of its own. To Finance the two are one state —
          the cheque is available and waiting to be handed over — and a card
          reading 0 forever is furniture. The STATUS is NOT removed: a portal
          pickup confirmation moves READY_FOR_RELEASE -> SCHEDULED and must
          still have somewhere to land, so the count is folded in here rather
          than dropped, and the view matches both. */}
      <Card
        label="READY FOR RELEASE"
        value={String(summary.readyForRelease + summary.scheduled)}
        accent
        {...card('READY_FOR_RELEASE')}
      />
      <Card label="PENDING SIGNATURE" value={String(summary.pendingSignature)} {...card('SIGNATURE_PENDING')} />
      <Card label="SIGNED" value={String(summary.signed)} {...card('SIGNED')} />
      {/* An explicit status wins over the NEEDS ACTION default, which excludes
          RELEASED — so this opens a full table without widening the view to
          everything, as it used to. */}
      <Card label="RELEASED" value={String(summary.released)} {...card('RELEASED')} />
      {/* "Show me everything, start again": every status, and no company, bank,
          eligibility, search or incomplete filter left over. */}
      <Card label="TOTAL CHECKS" value={String(summary.total)} {...card('TOTAL_CHECKS')} />
      {/* 129 cheques in production whose amount the register never recorded.
          They are NOT part of the value beside them and never were — SQL SUM()
          skips a null — so the two cards sit next to each other deliberately:
          the reader can see how many cheques the total cannot speak for.

          The one card that is not a view: incompleteness cuts across every
          status, so it composes with the selected view rather than replacing
          it, and both cards light up together when both are on. */}
      <Card
        label="INCOMPLETE (NO AMOUNT)"
        value={String(summary.incomplete)}
        tone={summary.incomplete > 0 ? 'warn' : 'plain'}
        {...card('INCOMPLETE')}
      />
      {/* Not clickable: there is no "cheques worth this much" set to view. */}
      <Card label="TOTAL CHECK VALUE" value={<CurrencyBreakdown totalsByCurrency={summary.totalsByCurrency} />} />
    </section>
  )
}
