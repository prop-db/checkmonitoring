'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatMoney } from '@/lib/money'
import type { PlannedOutflowRow } from '@/lib/planned-outflow/query'
import { markPlannedOutflowPaidAction, cancelPlannedOutflowAction, type PlannedActionResult } from '@/app/forecast/planned/actions'
import { PlannedOutflowForm } from './PlannedOutflowForm'

const fmtDay = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const fmtWhen = (d: Date | null) =>
  d ? d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '—'
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Open lines with their three controls; closed lines as facts. `amount`
 * arrives as a decimal string and is formatted here — never parsed.
 */
export function PlannedOutflowList({
  rows, banks, companies, today, categories,
}: {
  rows: PlannedOutflowRow[]
  banks: { id: string; code: string }[]
  companies: { id: string; code: string; name: string }[]
  /** Today's Manila day, YYYY-MM-DD, for the PAID ON default. */
  today: string
  categories: readonly string[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, PlannedActionResult>>({})

  const submit = (id: string, action: (f: FormData) => Promise<PlannedActionResult>, form: HTMLFormElement) => {
    const f = new FormData(form)
    f.set('id', id)
    startTransition(async () => {
      const r = await action(f)
      setResults((prev) => ({ ...prev, [id]: r }))
      if (r.ok) router.refresh()
    })
  }

  const small = 'h-9 rounded-lg border border-hairline bg-white px-2 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const button = 'h-9 rounded-lg border border-hairline bg-white px-3 text-xs font-medium tracking-wide text-navy hover:bg-ground disabled:opacity-50'

  return (
    <ul className="divide-y divide-hairline">
      {rows.map((r) => {
        const open = r.status === 'PLANNED'
        const result = results[r.id]
        return (
          <li key={r.id} className="space-y-3 px-6 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{r.description}</p>
                <p className="text-xs tracking-wide text-slate-500">
                  {fmtDay(r.date)} · {r.bankCode} · {r.companyCode}{r.category ? ` · ${r.category}` : ''} · added by {r.createdBy}
                </p>
                {r.status === 'PAID' && <p className="text-xs text-success-ink">PAID {fmtDay(r.paidAt)} · recorded by {r.paidBy}</p>}
                {r.status === 'CANCELLED' && <p className="text-xs text-slate-500">CANCELLED {fmtWhen(r.cancelledAt)} by {r.cancelledBy}: {r.cancelReason}</p>}
              </div>
              <p className="text-lg font-semibold tabular-nums text-navy">{formatMoney(r.amount, r.currency)}</p>
            </div>

            {open && editing !== r.id && (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={button} disabled={pending} onClick={() => setEditing(r.id)}>EDIT</button>
                <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit(r.id, markPlannedOutflowPaidAction, e.currentTarget) }}>
                  <label htmlFor={`paid-${r.id}`} className="text-[11px] font-semibold tracking-widest text-slate-400">PAID ON</label>
                  <input id={`paid-${r.id}`} name="paidOn" type="date" defaultValue={today} max={today} required className={small} disabled={pending} />
                  <button type="submit" className={button} disabled={pending}>MARK PAID</button>
                </form>
                <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit(r.id, cancelPlannedOutflowAction, e.currentTarget) }}>
                  <input name="reason" placeholder="Reason — required" required className={`${small} w-56`} disabled={pending} />
                  <button type="submit" className={button} disabled={pending}>CANCEL LINE</button>
                </form>
              </div>
            )}

            {open && editing === r.id && (
              <PlannedOutflowForm
                id={r.id} banks={banks} companies={companies} categories={categories} onDone={() => setEditing(null)}
                initial={{
                  date: isoDay(r.date), amount: r.amount, currency: r.currency, bankId: r.bankId,
                  companyId: r.companyId, description: r.description, category: r.category ?? '',
                }}
              />
            )}

            {result && !result.ok && (
              <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
