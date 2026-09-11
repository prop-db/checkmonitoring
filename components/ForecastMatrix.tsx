import { formatMoney } from '@/lib/money'
import type { Matrix, Cell } from '@/lib/forecast/matrix'

/**
 * One matrix: buckets down, columns across, count and amount per currency in
 * each cell. A server component — nothing here is interactive.
 *
 * A cell with nothing in it is a dash, never a zero: "no cheques" and "cheques
 * worth nothing" are different facts, the same rule `formatMoney` applies to a
 * null amount.
 */
function CellView({ cell }: { cell: Cell }) {
  if (cell.count === 0) return <span className="text-slate-300">—</span>
  return (
    <div className="space-y-0.5">
      {cell.totals.map((t) => (
        <div key={t.currency} className="tabular-nums">
          <span className="text-slate-500">{cell.count.toLocaleString('en-PH')} · </span>
          {formatMoney(t.total, t.currency)}
        </div>
      ))}
    </div>
  )
}

export function ForecastMatrix({ title, matrix }: { title: string; matrix: Matrix }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <h2 className="px-6 pb-4 pt-6 text-[11px] font-semibold tracking-widest text-slate-400">{title}</h2>
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">PRESENTABLE</th>
            {matrix.columns.map((c) => <th key={c} className="px-4 py-3 text-right">{c}</th>)}
            <th className="px-4 py-3 text-right">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((r) => (
            <tr key={r.bucket} className="border-b border-slate-100 odd:bg-white even:bg-ground">
              <td className="whitespace-nowrap px-4 py-3 font-medium">{r.bucket}</td>
              {matrix.columns.map((c) => (
                <td key={c} className="px-4 py-3 text-right"><CellView cell={r.cells[c]} /></td>
              ))}
              <td className="px-4 py-3 text-right font-medium"><CellView cell={r.total} /></td>
            </tr>
          ))}
          <tr className="border-t border-hairline bg-navy-bg font-semibold">
            <td className="px-4 py-3">TOTAL</td>
            {matrix.columns.map((c) => (
              <td key={c} className="px-4 py-3 text-right"><CellView cell={matrix.total.cells[c]} /></td>
            ))}
            <td className="px-4 py-3 text-right"><CellView cell={matrix.total.total} /></td>
          </tr>
        </tbody>
      </table>
    </section>
  )
}
