'use client'

import { useState, useTransition } from 'react'
import type { AdminActionResult } from '@/app/admin/actions'

export function PortalActionButton({ label, action, pending }: {
  label: string
  action: () => Promise<AdminActionResult>
  pending: string
}) {
  const [isPending, start] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() => start(async () => { const r = await action(); setMessage(r.ok ? 'Done.' : r.message) })}
        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold tracking-wide text-white disabled:opacity-50"
      >
        {isPending ? pending : label}
      </button>
      {message ? <span className="text-xs text-slate-600">{message}</span> : null}
    </span>
  )
}
