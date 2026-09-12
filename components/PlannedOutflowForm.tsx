'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createPlannedOutflowAction, updatePlannedOutflowAction, type PlannedActionResult } from '@/app/forecast/planned/actions'

export type PlannedOutflowFormValues = {
  date: string; amount: string; currency: string; bankId: string; companyId: string; description: string; category: string
}

const EMPTY: PlannedOutflowFormValues = { date: '', amount: '', currency: 'PHP', bankId: '', companyId: '', description: '', category: '' }

/**
 * One line, typed. Used to add (no `id`) and to edit an open line (with one).
 * The amount is a text box, not a number input: rule 8 — it reaches the server
 * as the string the user typed and is validated as money there.
 */
export function PlannedOutflowForm({
  id, initial, banks, companies, categories, onDone,
}: {
  id?: string
  initial?: PlannedOutflowFormValues
  banks: { id: string; code: string }[]
  companies: { id: string; code: string; name: string }[]
  categories: readonly string[]
  onDone?: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<PlannedActionResult | null>(null)
  const v = initial ?? EMPTY

  const field = 'h-10 w-full rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const label = 'block text-[11px] font-semibold tracking-widest text-slate-400'
  const p = id ? `edit-${id}` : 'add'

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const form = e.currentTarget
        const formData = new FormData(form)
        if (id) formData.set('id', id)
        startTransition(async () => {
          const r = id ? await updatePlannedOutflowAction(formData) : await createPlannedOutflowAction(formData)
          setResult(r)
          if (r.ok) {
            if (!id) form.reset()
            router.refresh()
            onDone?.()
          }
        })
      }}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <label htmlFor={`${p}-date`} className={label}>DATE — LEAVES THE BANK ON</label>
          <input id={`${p}-date`} name="date" type="date" required defaultValue={v.date} disabled={pending} className={field} />
        </div>
        <div>
          <label htmlFor={`${p}-amount`} className={label}>AMOUNT</label>
          <input id={`${p}-amount`} name="amount" inputMode="decimal" required placeholder="1250000.00" defaultValue={v.amount} disabled={pending} className={`${field} text-right tabular-nums`} />
        </div>
        <div>
          <label htmlFor={`${p}-currency`} className={label}>CURRENCY</label>
          <input id={`${p}-currency`} name="currency" defaultValue={v.currency} disabled={pending} className={field} />
        </div>
        <div>
          <label htmlFor={`${p}-bank`} className={label}>BANK</label>
          <select id={`${p}-bank`} name="bankId" required defaultValue={v.bankId} disabled={pending} className={field}>
            <option value="">—</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${p}-company`} className={label}>COMPANY</label>
          <select id={`${p}-company`} name="companyId" required defaultValue={v.companyId} disabled={pending} className={field}>
            <option value="">—</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${p}-category`} className={label}>CATEGORY</label>
          <select id={`${p}-category`} name="category" defaultValue={v.category} disabled={pending} className={field}>
            <option value="">—</option>
            {v.category && !categories.includes(v.category) && (
              <option value={v.category} disabled>{v.category} (no longer on the list)</option>
            )}
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="md:col-span-3">
          <label htmlFor={`${p}-description`} className={label}>DESCRIPTION</label>
          <input id={`${p}-description`} name="description" required placeholder="September 2nd-half payroll" defaultValue={v.description} disabled={pending} className={field} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50">
          {pending ? 'SAVING…' : id ? 'SAVE CHANGES' : 'ADD LINE'}
        </button>
        {onDone && (
          <button type="button" onClick={onDone} disabled={pending} className="text-sm text-slate-500 underline underline-offset-2">CANCEL EDIT</button>
        )}
      </div>
      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
    </form>
  )
}
