'use client'

import { useState, useTransition } from 'react'
import type { AdminActionResult } from '@/app/admin/actions'

/** DISMISS for one PORTAL RELEASES look item on /admin/portal: a reason is required. */
export function PortalLookDismiss({ lookId, action }: {
  lookId: string
  action: (formData: FormData) => Promise<AdminActionResult>
}) {
  const [isPending, start] = useTransition()
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="text" value={reason} maxLength={500} placeholder="Reason"
        onChange={(e) => setReason(e.target.value)}
        className="w-40 rounded-lg px-2 py-1 text-xs ring-1 ring-hairline"
        aria-label="Reason for dismissing"
      />
      <button
        type="button"
        disabled={isPending || !reason.trim()}
        onClick={() => start(async () => {
          const f = new FormData(); f.set('lookId', lookId); f.set('reason', reason)
          const r = await action(f)
          setMessage(r.ok ? 'Dismissed.' : r.message)
        })}
        className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-semibold tracking-wide text-white disabled:opacity-50"
      >
        {isPending ? '…' : 'DISMISS'}
      </button>
      {message ? <span className="text-xs text-slate-600">{message}</span> : null}
    </span>
  )
}
