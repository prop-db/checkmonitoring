import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import type { ReconSummary, AccountTotal } from '@/lib/recon/summary'
import { reconHref, type ReconParams } from '@/lib/recon-view'

function Totals({ totals }: { totals: AccountTotal[] }) {
  if (totals.length === 0) return <span className="text-slate-300">—</span>
  return (
    <div className="space-y-0.5">
      {totals.map((t) => (
        <div key={t.currency} className="tabular-nums">
          <span className="text-slate-500">{t.count.toLocaleString('en-PH')} · </span>{formatMoney(t.total, t.currency)}
        </div>
      ))}
    </div>
  )
}

/** One row per cash account, in the Cash Balance sheet's order; each links to its list. */
export function ReconTable({ summary, params }: { summary: ReconSummary; params: ReconParams }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">ACCOUNT</th><th className="px-4 py-3">BANK</th><th className="px-4 py-3">COMPANY</th>
            <th className="px-4 py-3 text-right">OUTSTANDING · AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          {summary.accounts.map((a) => (
            <tr key={a.accountId ?? a.account} className="border-b border-slate-100 odd:bg-white even:bg-ground">
              <td className="px-4 py-3 font-medium">
                {a.accountId
                  ? <Link href={reconHref({ ...params, account: a.accountId })} className="underline underline-offset-2">{a.account}</Link>
                  : a.account}
              </td>
              <td className="px-4 py-3">{a.bank ?? '—'}</td>
              <td className="px-4 py-3">{a.company ?? '—'}</td>
              <td className="px-4 py-3 text-right"><Totals totals={a.totals} /></td>
            </tr>
          ))}
          <tr className="border-t border-hairline bg-navy-bg font-semibold">
            <td className="px-4 py-3" colSpan={3}>TOTAL</td>
            <td className="px-4 py-3 text-right"><Totals totals={summary.totals} /></td>
          </tr>
        </tbody>
      </table>
    </section>
  )
}
