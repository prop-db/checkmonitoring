'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateDetailsAction, type ActionResult } from '@/app/checks/actions'

/**
 * The register's four free-text fields, editable on the cheque. Pre-filled
 * with what is recorded; SAVE writes only what changed and the page re-reads.
 * Any status — a note belongs on a cancelled cheque as much as a live one.
 */
export function DetailsForm({
  checkId, values, categories,
}: {
  checkId: string
  values: {
    remarks: string | null; pointPerson: string | null; checksPossession: string | null; category: string | null
    expectedOutflowDate: string | null
  }
  categories: readonly string[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)

  const field = 'h-10 w-full rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const label = 'block text-[11px] font-semibold tracking-widest text-slate-400'

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const formData = new FormData(e.currentTarget)
        startTransition(async () => {
          const r = await updateDetailsAction(formData)
          setResult(r)
          if (r.ok) router.refresh()
        })
      }}
    >
      <input type="hidden" name="checkId" value={checkId} />
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="details-pointPerson" className={label}>POINT PERSON</label>
          <input id="details-pointPerson" name="pointPerson" defaultValue={values.pointPerson ?? ''} disabled={pending} className={field} />
        </div>
        <div>
          <label htmlFor="details-checksPossession" className={label}>WHO IS HOLDING IT</label>
          <input id="details-checksPossession" name="checksPossession" defaultValue={values.checksPossession ?? ''} disabled={pending} className={field} />
        </div>
        <div>
          <label htmlFor="details-category" className={label}>CATEGORY</label>
          <select id="details-category" name="category" defaultValue={values.category ?? ''} disabled={pending} className={field}>
            <option value="">—</option>
            {values.category && !categories.includes(values.category) && (
              <option value={values.category} disabled>{values.category} (no longer on the list)</option>
            )}
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="details-expectedOutflowDate" className={label}>EXPECTED OUT</label>
          <input id="details-expectedOutflowDate" name="expectedOutflowDate" type="date" defaultValue={values.expectedOutflowDate ?? ''} disabled={pending} className={field} />
          <p className="mt-1 text-[11px] text-slate-500">The day the money is expected to leave the bank. The forecast places the check on it. Clear it to go back to the check date.</p>
        </div>
        <div className="md:col-span-2">
          <label htmlFor="details-remarks" className={label}>REMARKS</label>
          <textarea id="details-remarks" name="remarks" rows={2} defaultValue={values.remarks ?? ''} disabled={pending}
            className="w-full rounded-lg border border-hairline bg-white px-3 py-2 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50">
          {pending ? 'SAVING…' : 'SAVE DETAILS'}
        </button>
        {result?.ok && <span className="text-xs text-success-ink">Saved. Every change is on the audit trail below.</span>}
      </div>
      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
    </form>
  )
}
