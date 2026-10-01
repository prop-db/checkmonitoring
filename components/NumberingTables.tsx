// components/NumberingTables.tsx
import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { StatusPill } from '@/components/StatusPill'
import { missingLabel, numberingHref } from '@/lib/numbering-view'
import type { NumberingAccount } from '@/lib/numbering/query'
import type { SeriesCheque, SeriesEntry } from '@/lib/numbering/series'

const fmtDay = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const fmtCount = (s: string) => (s.length <= 15 ? Number(s).toLocaleString('en-PH') : s)
const th = 'px-4 py-3'

/** One row per cash account. The account links to its own series. */
export function NumberingSummaryTable({ accounts, company }: { accounts: readonly NumberingAccount[]; company?: string }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className={th}>ACCOUNT</th><th className={th}>BANK</th><th className={th}>COMPANY</th>
            <th className={th}>FIRST</th><th className={th}>LAST</th>
            <th className={`${th} text-right`}>HELD</th><th className={`${th} text-right`}>VOIDED</th>
            <th className={`${th} text-right`}>CANCELLED</th><th className={`${th} text-right`}>MISSING</th>
            <th className={`${th} text-right`}>NOT NUMERIC</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => {
            const s = a.series.summary
            return (
              <tr key={a.accountId} className="border-b border-slate-100 odd:bg-white even:bg-ground">
                <td className={th}><Link prefetch={false} href={numberingHref({ company, account: a.accountId })} className="underline underline-offset-2">{a.account}</Link></td>
                <td className={th}>{a.bank}</td>
                <td className={th}>{a.company}</td>
                <td className={`${th} tabular-nums`}>{s.first ?? '—'}</td>
                <td className={`${th} tabular-nums`}>{s.last ?? '—'}</td>
                <td className={`${th} text-right tabular-nums`}>{s.held.toLocaleString('en-PH')}</td>
                <td className={`${th} text-right tabular-nums`}>{s.voided.toLocaleString('en-PH')}</td>
                <td className={`${th} text-right tabular-nums`}>{s.cancelled.toLocaleString('en-PH')}</td>
                <td className={`${th} text-right tabular-nums ${s.missingRuns ? 'font-semibold text-amber-700' : ''}`}>
                  {fmtCount(s.missingNumbers)}{s.missingRuns ? ` (${s.missingRuns.toLocaleString('en-PH')})` : ''}
                </td>
                <td className={`${th} text-right tabular-nums`}>{s.notNumeric.toLocaleString('en-PH')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

function ChequeRow({ c, note }: { c: SeriesCheque; note?: string }) {
  return (
    <tr className="border-b border-slate-100 odd:bg-white even:bg-ground">
      <td className={`${th} tabular-nums`}><Link prefetch={false} href={`/checks/${c.id}`} className="underline underline-offset-2">{c.checkNumber}</Link></td>
      <td className={th}>{fmtDay(c.checkDate)}</td>
      <td className={th}>{c.payeeName ?? '—'}</td>
      <td className={`${th} text-right tabular-nums`}>{formatMoney(c.amount, c.currency)}</td>
      <td className={th}><StatusPill status={c.status} />{note && <span className="ml-2 text-xs font-semibold text-amber-700">{note}</span>}</td>
    </tr>
  )
}

/** One account's series in number order, each MISSING run as one highlighted line. */
export function NumberingEntriesTable({ entries }: { entries: readonly SeriesEntry[] }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr><th className={th}>CHECK NUMBER</th><th className={th}>CHEQUE DATE</th><th className={th}>PAYEE</th><th className={`${th} text-right`}>AMOUNT</th><th className={th}>STATUS</th></tr>
        </thead>
        <tbody>
          {entries.map((e) => e.kind === 'MISSING'
            ? (
              <tr key={`m-${e.from}`} className="border-b border-amber-200 bg-amber-50">
                <td colSpan={5} className={`${th} font-semibold tabular-nums text-amber-800`}>{missingLabel(e)}</td>
              </tr>
            )
            : <ChequeRow key={e.cheque.id} c={e.cheque} note={e.duplicate ? 'DUPLICATE NUMBER' : undefined} />)}
        </tbody>
      </table>
    </section>
  )
}

/** Cheques whose number cannot be placed in the sequence. */
export function NotNumericTable({ cheques }: { cheques: readonly SeriesCheque[] }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <tbody>{cheques.map((c) => <ChequeRow key={c.id} c={c} />)}</tbody>
      </table>
    </section>
  )
}
