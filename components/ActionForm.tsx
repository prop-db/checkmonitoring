'use client'

import { useState, useTransition } from 'react'
import type { ActionResult } from '@/app/checks/actions'

export function ActionForm({
  action, checkId, label, className, children,
}: {
  action: (formData: FormData) => Promise<ActionResult>
  checkId: string
  label: string
  className?: string
  children?: React.ReactNode
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionResult | null>(null)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        const formData = new FormData(e.currentTarget)
        startTransition(async () => setResult(await action(formData)))
      }}
    >
      <input type="hidden" name="checkId" value={checkId} />
      {children}
      <button type="submit" disabled={pending} className={className}>
        {pending ? 'SAVING…' : label}
      </button>
      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
    </form>
  )
}
