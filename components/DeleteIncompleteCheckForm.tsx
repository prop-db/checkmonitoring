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
          className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700"
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
      className="space-y-3 rounded-2xl bg-rose-50 p-4 ring-1 ring-rose-200"
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
      <p className="text-sm text-rose-900">
        <strong>Delete cheque {checkNumber} permanently?</strong> This removes the record itself.
        Its audit rows survive, detached, so what was done to it stays on the record — but the
        cheque, and any bill lines on it, are gone.
      </p>
      <label className="block text-xs font-medium tracking-wide text-slate-600">
        REASON (REQUIRED)
        <input
          name="reason" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Why this record is being removed"
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          // Refused server-side too — this only spares the round trip.
          disabled={pending || reason.trim() === ''}
          className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'DELETING…' : 'CONFIRM DELETE'}
        </button>
        <button
          type="button" onClick={() => setArmed(false)} disabled={pending}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
        >
          CANCEL
        </button>
      </div>
      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
    </form>
  )
}
