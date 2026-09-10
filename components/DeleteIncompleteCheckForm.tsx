'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteIncompleteCheckAction } from '@/app/checks/actions'
import type { ActionResult } from '@/app/checks/actions'

/**
 * Deleting an incomplete cheque record. Deliberately not an `ActionForm`.
 *
 * Three things this needs that the shared form does not do, each because the
 * act is irreversible:
 *
 *  - a typed reason, which the domain requires and which is the only part of
 *    the surviving audit row a future reader cannot reconstruct;
 *  - an explicit confirmation step, so the button that deletes is never the
 *    button under the cursor;
 *  - a redirect afterwards, because the page it was rendered on is now a 404.
 *
 * The screen only renders it for a cheque the guard actually permits — but the
 * server checks again regardless. This is a browser control, not a security
 * one.
 */
export function DeleteIncompleteCheckForm({ checkId, checkNumber }: { checkId: string; checkNumber: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)
  const [armed, setArmed] = useState(false)
  const [reason, setReason] = useState('')

  if (!armed) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="rounded-lg px-4 py-2 text-sm font-medium tracking-wide text-danger-ink ring-1 ring-danger-ink/25 transition hover:bg-danger-bg"
        >
          DELETE THIS INCOMPLETE RECORD
        </button>
        <p className="text-xs text-slate-500">
          Permanent. The audit trail survives the deletion, detached from the cheque and intact.
        </p>
      </div>
    )
  }

  return (
    <form
      className="space-y-3 rounded-2xl bg-danger-bg p-4 ring-1 ring-danger-ink/20"
      onSubmit={(e) => {
        e.preventDefault()
        const formData = new FormData(e.currentTarget)
        startTransition(async () => {
          const r = await deleteIncompleteCheckAction(formData)
          setResult(r)
          // Back to the dashboard: this page no longer has anything to show.
          // `refresh()` first so the summary counts the reader lands on are the
          // ones after the deletion, not the cached ones from before it.
          if (r.ok) { router.refresh(); router.push('/') }
        })
      }}
    >
      <input type="hidden" name="checkId" value={checkId} />
      <p className="text-sm text-danger-ink">
        <strong>Delete cheque {checkNumber} permanently?</strong> This removes the record itself.
        Its audit rows survive, detached, so what was done to it stays on the record — but the
        cheque, and any bill lines on it, are gone.
      </p>
      <label className="block text-[11px] font-semibold tracking-widest text-danger-ink">
        REASON (REQUIRED)
        <input
          name="reason" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Why this record is being removed"
          className="mt-1.5 block h-10 w-full rounded-lg border border-hairline bg-white px-3 text-sm font-normal tracking-normal text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          // Refused server-side too — this only spares the round trip.
          disabled={pending || reason.trim() === ''}
          className="rounded-lg bg-danger-ink px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-danger-ink/90 disabled:opacity-50"
        >
          {pending ? 'DELETING…' : 'CONFIRM DELETE'}
        </button>
        <button
          type="button" onClick={() => setArmed(false)} disabled={pending}
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium tracking-wide text-slate-700 ring-1 ring-hairline transition hover:ring-navy"
        >
          CANCEL
        </button>
      </div>
      {result && !result.ok && (
        <p className="rounded-lg bg-warning-bg p-3 text-sm text-warning-ink">{result.message}</p>
      )}
    </form>
  )
}
