import Link from 'next/link'
import { actionWords } from '@/lib/audit-view'
import type { AuditRow } from '@/lib/audit-query'

const fmt = (d: Date) =>
  d.toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Manila',
  })

/** The JSON, as key/value lines. Nothing is parsed for meaning — least of all an amount. */
function Details({ details }: { details: unknown }) {
  if (details === null || details === undefined) return <span className="text-slate-300">—</span>
  const entries = typeof details === 'object' && !Array.isArray(details)
    ? Object.entries(details as Record<string, unknown>)
    : [['value', details] as const]
  return (
    // A native disclosure: server-rendered, no script, and it keeps a 300-row
    // page readable while leaving every field one click away.
    <details className="text-xs">
      <summary className="cursor-pointer text-slate-500">{entries.length} field{entries.length === 1 ? '' : 's'}</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {entries.map(([k, v]) => (
          <div key={String(k)} className="contents">
            <dt className="font-mono text-slate-400">{String(k)}</dt>
            <dd className="break-all font-mono text-slate-700">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

/**
 * The trail, newest first. Filled navy dot for a person, hollow for SYSTEM —
 * the same signal the per-cheque trail uses, and never the only one: the WHO
 * column says SYSTEM in words. The year is in every timestamp deliberately.
 */
export function AuditTable({ rows }: { rows: readonly AuditRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">WHEN</th>
            <th className="px-4 py-3">WHO</th>
            <th className="px-4 py-3">ACTION</th>
            <th className="px-4 py-3">CHECK</th>
            <th className="px-4 py-3">REMARKS</th>
            <th className="px-4 py-3">DETAILS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const system = r.actorType === 'SYSTEM'
            return (
              <tr key={r.id} className="border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground">
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600">{fmt(r.createdAt)}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span aria-hidden="true" className={`mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle ${system ? 'bg-white ring-2 ring-hairline' : 'bg-navy'}`} />
                  {system ? <span className="tracking-wide text-slate-400">SYSTEM</span> : <span className="font-medium">{r.userName ?? 'UNKNOWN USER'}</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-semibold text-navy">{actionWords(r.action)}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  {r.checkId && r.checkNumber
                    ? <Link prefetch={false} href={`/checks/${r.checkId}`} className="underline underline-offset-2">{r.checkNumber}</Link>
                    : r.checkNumber
                      ? <span className="text-slate-500" title="This check has since been removed; the number is what the row recorded.">{r.checkNumber}</span>
                      : r.plannedOutflowId
                        // Not a cheque at all: a planned outflow line (2026-09-12). Saying
                        // "(cheque removed)" here would assert a deletion that never happened.
                        ? <Link href="/forecast/planned" className="text-slate-500 underline underline-offset-2">PLANNED OUTFLOW</Link>
                        : <span className="text-slate-400">(check removed)</span>}
                </td>
                <td className="min-w-[16rem] px-4 py-3 text-slate-700">{r.remarks ?? <span className="text-slate-300">—</span>}</td>
                <td className="min-w-[14rem] px-4 py-3"><Details details={r.details} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
