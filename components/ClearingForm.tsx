'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { clearingAction, type ActionResult } from '@/app/checks/actions'

const WORDS: Record<string, string> = { DEPOSITED: 'DEPOSITED', ENCASHED: 'ENCASHED', CLEARED: 'CLEARED' }

/**
 * The bank's side of a released cheque. `clearingAction` existed from Plan 1
 * with nothing rendering it — every one of 9,594 released cheques stood at
 * NONE on 2026-09-11. Only forward moves are offered; the domain refuses the
 * rest. The reference typed here is the BANK's: the supplier's receipt has
 * its own page, linked above this form, so the two are never one box.
 */
export function ClearingForm({
  checkId, targets, current,
}: {
  checkId: string
  targets: readonly string[]
  current: { crNumber: string | null; clearedDate: string | null }
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
          const r = await clearingAction(formData)
          setResult(r)
          if (r.ok) router.refresh()
        })
      }}
    >
      <input type="hidden" name="checkId" value={checkId} />
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <label htmlFor="clearing-status" className={label}>CLEARING STATUS</label>
          <select id="clearing-status" name="clearingStatus" defaultValue={targets[targets.length - 1]} disabled={pending} className={field}>
            {targets.map((t) => <option key={t} value={t}>{WORDS[t] ?? t}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="clearing-ref" className={label}>BANK CLEARING REF</label>
          <input id="clearing-ref" name="crNumber" defaultValue={current.crNumber ?? ''} placeholder="As the statement shows it" disabled={pending} className={field} />
        </div>
        <div>
          <label htmlFor="clearing-date" className={label}>CLEARED DATE</label>
          <input id="clearing-date" name="clearedDate" type="date" defaultValue={current.clearedDate ?? ''} disabled={pending} className={field} />
        </div>
      </div>
      <p className="text-[11px] text-slate-500">
        The bank&rsquo;s reference and date, from the statement. This is not the supplier&rsquo;s receipt.
      </p>
      <button type="submit" disabled={pending}
        className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50">
        {pending ? 'SAVING…' : 'RECORD CLEARING'}
      </button>
      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
    </form>
  )
}
