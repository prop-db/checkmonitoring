import Link from 'next/link'
import { formatPhp } from '@/lib/money'
import { StatusPill } from './StatusPill'
import type { CheckRow } from '@/lib/queries'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export function CheckTable({ rows }: { rows: CheckRow[] }) {
  if (rows.length === 0) {
    return <p className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 ring-1 ring-slate-200">NO CHECKS MATCH THESE FILTERS.</p>
  }
  return (
    <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">CHECK NUMBER</th>
            <th className="px-4 py-3">APV NUMBER</th>
            <th className="px-4 py-3">SUPPLIER NAME</th>
            <th className="px-4 py-3">COMPANY</th>
            <th className="px-4 py-3">CHECK DATE</th>
            <th className="px-4 py-3 text-right">AMOUNT</th>
            <th className="px-4 py-3">STATUS</th>
            <th className="px-4 py-3">AVAILABLE DATE</th>
            <th className="px-4 py-3">PICKUP SCHEDULE</th>
            <th className="px-4 py-3">ACTION</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
              <td className="px-4 py-3 font-medium">{r.checkNumber}</td>
              {/* Every bill, not just the first: search matches APV/PO across all
                  of them, and showing one arbitrary bill would display a different
                  APV than the user searched for. */}
              <td className="px-4 py-3 text-slate-600">
                {r.bills.length ? r.bills.map((b) => b.apvNumber).join(', ') : '—'}
              </td>
              <td className="px-4 py-3">
                {r.payeeName}
                {r.eligibility === 'INTERNAL' && (
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] tracking-wide text-slate-600">
                    INTERNAL
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-slate-600">{r.company.code}</td>
              <td className="px-4 py-3 text-slate-600">{fmtDate(r.checkDate)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatPhp(r.amount)}</td>
              <td className="px-4 py-3"><StatusPill status={r.status} /></td>
              <td className="px-4 py-3 text-slate-600">{fmtDate(r.availablePickupDate)}</td>
              <td className="px-4 py-3 text-slate-600">{fmtDate(r.scheduledPickupDate)}</td>
              <td className="px-4 py-3">
                <Link href={`/checks/${r.id}`} className="text-sm font-medium text-slate-900 underline underline-offset-2">
                  OPEN
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
