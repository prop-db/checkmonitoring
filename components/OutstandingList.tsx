import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import type { OutstandingLine } from '@/lib/recon/summary'

const fmtDay = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const fmtIso = (day: string | null) => (day ? fmtDay(new Date(`${day}T00:00:00Z`)) : '—')

/** The cheques behind one account's figure. */
export function OutstandingList({ lines }: { lines: readonly OutstandingLine[] }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">CHECK NUMBER</th><th className="px-4 py-3">PAYEE</th><th className="px-4 py-3">CHECK DATE</th>
            <th className="px-4 py-3">ISSUED</th><th className="px-4 py-3 text-right">DAYS</th><th className="px-4 py-3">CLEARING</th>
            <th className="px-4 py-3 text-right">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-b border-slate-100 odd:bg-white even:bg-ground">
              <td className="px-4 py-3 tabular-nums"><Link prefetch={false} href={`/checks/${l.id}`} className="underline underline-offset-2">{l.checkNumber}</Link></td>
              <td className="px-4 py-3">{l.payee ?? '—'}</td>
              <td className="px-4 py-3">{fmtDay(l.checkDate)}</td>
              <td className="px-4 py-3">
                {fmtIso(l.issuedDay)}
                {l.basis === 'CHECK DATE' && <span className="ml-2 text-xs text-slate-500">from register</span>}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{l.days ?? '—'}</td>
              <td className="px-4 py-3">{l.clearingStatus}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMoney(l.amount, l.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
