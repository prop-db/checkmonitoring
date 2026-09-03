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
  totalsByCurrency: CurrencyTotal[]
}

function Card({ label, value, accent = false }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className={`rounded-2xl p-5 ring-1 ${accent ? 'bg-emerald-50 ring-emerald-200' : 'bg-white ring-slate-200'}`}>
      <p className="text-xs font-medium tracking-wide text-slate-500">{label}</p>
      {/* A plain number renders as text; a currency breakdown renders block-level
          markup (dl/div), which HTML forbids inside <p>. The wrapper has to be a
          <div> to legally hold either. */}
      <div className="mt-2 text-2xl font-semibold text-slate-900">{value}</div>
    </div>
  )
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

// Card order follows the spec's priority: READY FOR RELEASE is the primary
// daily Finance activity and leads the row.
export function SummaryCards({ summary }: { summary: Summary }) {
  return (
    <section className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-7">
      <Card label="READY FOR RELEASE" value={String(summary.readyForRelease)} accent />
      <Card label="SCHEDULED" value={String(summary.scheduled)} />
      <Card label="PENDING SIGNATURE" value={String(summary.pendingSignature)} />
      <Card label="RELEASED" value={String(summary.released)} />
      <Card label="SIGNED" value={String(summary.signed)} />
      <Card label="TOTAL CHECKS" value={String(summary.total)} />
      <Card label="TOTAL CHECK VALUE" value={<CurrencyBreakdown totalsByCurrency={summary.totalsByCurrency} />} />
    </section>
  )
}
