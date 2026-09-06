import Link from 'next/link'
import { formatMoney } from '@/lib/money'
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
  label, value, accent = false, tone = 'plain', href, selected = false,
}: {
  label: string
  value: React.ReactNode
  accent?: boolean
  tone?: 'plain' | 'warn'
  href?: string
  selected?: boolean
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
      {selected && (
        <p className="mt-1 text-[10px] font-medium tracking-wide text-slate-500">
          FILTERING — CLICK TO CLEAR
        </p>
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

/**
 * Which card is currently driving the table, and the filters to carry along.
 *
 * `base` holds the filters a card must NOT throw away — the search box, the
 * company and cash-account dropdowns, the eligibility. Before this, every card
 * linked to an absolute URL, so narrowing to one company and then clicking
 * SIGNED silently dropped the company and widened the table. A card is a filter
 * like the dropdowns are, and filters compose.
 */
export type CardSelection = {
  status: string | null
  incomplete: boolean
  showAll: boolean
  base: Readonly<Record<string, string>>
}

// Card order follows the spec's priority: READY FOR RELEASE is the primary
// daily Finance activity and leads the row.
export function SummaryCards({
  summary, selection,
}: {
  summary: Summary
  selection: CardSelection
}) {
  const { status, incomplete, showAll, base } = selection

  const href = (extra: Record<string, string>) => {
    const qs = new URLSearchParams(base)
    for (const [k, v] of Object.entries(extra)) qs.set(k, v)
    const s = qs.toString()
    return s ? `/?${s}` : '/'
  }

  /**
   * A selected card links to itself minus its own filter, so clicking it again
   * turns it off. A filter you can switch on and cannot switch off sends people
   * to the browser's Back button to undo a click they just made.
   */
  const statusCard = (want: string) => {
    const on = status === want && !incomplete
    return {
      selected: on,
      href: on ? href(showAll ? { scope: 'all' } : {}) : href({ status: want }),
    }
  }

  return (
    <section className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-7">
      {/* Every card filters the table below it. A number a user cannot act on
          invites them to hunt for the rows by hand, which is what the search
          box was being used for.

          SCHEDULED has no card of its own. To Finance the two are one state —
          the cheque is available and waiting to be handed over — and a card
          reading 0 forever is furniture. The STATUS is NOT removed: a portal
          pickup confirmation moves READY_FOR_RELEASE -> SCHEDULED and must
          still have somewhere to land, so the count is folded in here rather
          than dropped, and the link matches both. */}
      <Card
        label="READY FOR RELEASE"
        value={String(summary.readyForRelease + summary.scheduled)}
        accent
        {...statusCard('READY_FOR_RELEASE')}
      />
      <Card label="PENDING SIGNATURE" value={String(summary.pendingSignature)} {...statusCard('SIGNATURE_PENDING')} />
      <Card label="SIGNED" value={String(summary.signed)} {...statusCard('SIGNED')} />
      {/* RELEASED carries `scope=all` because the NEEDS ACTION default excludes
          it, and a card that opens an empty table reads as a bug in the count
          rather than a filter doing its job. */}
      <Card
        label="RELEASED"
        value={String(summary.released)}
        selected={status === 'RELEASED' && !incomplete}
        href={status === 'RELEASED' && !incomplete ? href({ scope: 'all' }) : href({ status: 'RELEASED', scope: 'all' })}
      />
      {/* Selected only when nothing else is: TOTAL CHECKS is the absence of a
          filter, so it must not light up beside a status card that is also on. */}
      <Card
        label="TOTAL CHECKS"
        value={String(summary.total)}
        selected={showAll && !status && !incomplete}
        href={showAll && !status && !incomplete ? href({}) : href({ scope: 'all' })}
      />
      {/* 129 cheques in production whose amount the register never recorded.
          They are NOT part of the value beside them and never were — SQL SUM()
          skips a null — so the two cards sit next to each other deliberately:
          the reader can see how many cheques the total cannot speak for. */}
      <Card
        label="INCOMPLETE (NO AMOUNT)"
        value={String(summary.incomplete)}
        tone={summary.incomplete > 0 ? 'warn' : 'plain'}
        selected={incomplete}
        href={incomplete ? href(showAll ? { scope: 'all' } : {}) : href({ incomplete: '1', scope: 'all' })}
      />
      <Card label="TOTAL CHECK VALUE" value={<CurrencyBreakdown totalsByCurrency={summary.totalsByCurrency} />} />
    </section>
  )
}
