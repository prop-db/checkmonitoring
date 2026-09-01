import { formatPhp } from '@/lib/money'

type Summary = {
  total: number; pendingSignature: number; signed: number
  readyForRelease: number; scheduled: number; released: number; totalValue: string
}

function Card({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl p-5 ring-1 ${accent ? 'bg-emerald-50 ring-emerald-200' : 'bg-white ring-slate-200'}`}>
      <p className="text-xs font-medium tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
    </div>
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
      <Card label="TOTAL CHECK VALUE" value={formatPhp(summary.totalValue)} />
    </section>
  )
}
