'use client'

import { useState, useTransition } from 'react'
import { syncNowAction, type SyncNowResult } from '@/app/admin/actions'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'

/**
 * SYNC NOW, per tenant (spec §11).
 *
 * There is deliberately no "sync everything" button. The two Acumatica tenants
 * are separate instances that reuse branch codes for different companies, and a
 * single control would either read one of them and not say which, or read both
 * and report one pooled figure — which is a number about nothing.
 */
export function SyncNowButton({ tenant, label }: { tenant: AcumaticaTenant; label: string }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<SyncNowResult | null>(null)

  return (
    <div className="space-y-3">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const formData = new FormData(e.currentTarget)
          startTransition(async () => setResult(await syncNowAction(formData)))
        }}
      >
        <input type="hidden" name="tenant" value={tenant} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50"
        >
          {pending ? 'SYNCING…' : `SYNC NOW · ${label}`}
        </button>
      </form>

      {result && !result.ok && (
        <p className="rounded-lg bg-warning-bg p-3 text-sm text-warning-ink">{result.message}</p>
      )}

      {result && result.ok && (
        <div className="rounded-lg bg-success-bg p-3 text-sm text-success-ink">
          <p className="font-medium">{result.tenant} · {result.mode}</p>
          {/* Every figure the run reported, not just the flattering ones.
              `fetched = skipped + collapsed + imported + updated + staged + errors`
              is the invariant that makes "nothing was silently dropped"
              checkable, and it is only checkable if all of them are shown. */}
          <p>
            {result.fetched.toLocaleString('en-PH')} rows read ·{' '}
            {result.imported.toLocaleString('en-PH')} imported ·{' '}
            {result.updated.toLocaleString('en-PH')} updated ·{' '}
            {result.staged.toLocaleString('en-PH')} staged ·{' '}
            {result.skipped.toLocaleString('en-PH')} not payments ·{' '}
            {result.collapsed.toLocaleString('en-PH')} void pairs folded ·{' '}
            {result.promoted.toLocaleString('en-PH')} staged rows placed ·{' '}
            {result.errors.toLocaleString('en-PH')} errors
          </p>
          <p className="mt-1 text-xs">Reload the page to see the updated sync log.</p>
        </div>
      )}
    </div>
  )
}
