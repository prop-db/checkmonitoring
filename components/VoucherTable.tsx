import Link from 'next/link'
import { voucherStatusPillClass } from '@/lib/status-pill'
import type { VoucherRow } from '@/lib/export/voucher-index'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

/**
 * One voucher per row, exactly as the Excel index lays it out, minus RELEASED
 * — empty on every row today and shown on the cheque's own page when it fills.
 *
 * A server component, on purpose: nothing here is interactive. The cheque
 * number is a link to the cheque, the status is a pill, and the remarks wrap.
 * Not `CheckTable`, whose column picker, checkboxes and bulk bar are about
 * cheques Finance can act on — nothing on this screen is acted on, it is read.
 *
 * A blank CHECK NUMBER is drawn as a dash, and the row's STATUS and REMARKS say
 * why. The explanation under the table on the page repeats it in full.
 */
export function VoucherTable({ rows }: { rows: readonly VoucherRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">VOUCHER</th>
            <th className="px-4 py-3">CHECK NUMBER</th>
            <th className="px-4 py-3">BANK</th>
            <th className="px-4 py-3">COMPANY</th>
            <th className="px-4 py-3">STATUS</th>
            <th className="px-4 py-3">CHECK DATE</th>
            <th className="px-4 py-3">PAYEE</th>
            <th className="px-4 py-3">SUPERSEDES</th>
            <th className="px-4 py-3">REMARKS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.voucher}
              className="border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground hover:bg-navy-bg"
            >
              <td className="whitespace-nowrap px-4 py-3 font-medium">{r.voucher}</td>
              <td className="whitespace-nowrap px-4 py-3">
                {r.checkId && r.checkNumber
                  ? (
                    <Link href={`/checks/${r.checkId}`} className="underline underline-offset-2">
                      {r.checkNumber}
                    </Link>
                  )
                  : '—'}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{r.bank ?? '—'}</td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{r.company ?? '—'}</td>
              <td className="whitespace-nowrap px-4 py-3">
                <span
                  className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide ${voucherStatusPillClass(r.status)}`}
                >
                  {r.status}
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmtDate(r.checkDate)}</td>
              <td className="px-4 py-3">{r.payee ?? '—'}</td>
              <td className="px-4 py-3 text-slate-600">{r.supersedes ?? '—'}</td>
              <td className="min-w-[24rem] px-4 py-3 text-slate-600">{r.remarks ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
