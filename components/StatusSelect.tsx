'use client'

import { useRouter } from 'next/navigation'
import type { StatusOption } from '@/lib/status-options'

/**
 * The STATUS dropdown (client, 2026-10-06): which set of cheques the dashboard
 * shows, as one control instead of a card per status. Choosing an option
 * navigates to its link, which `buildStatusOptions` built from `cardHref` so the
 * company / bank / eligibility filters survive.
 */
export function StatusSelect({ options }: { options: StatusOption[] }) {
  const router = useRouter()
  const current = options.find((o) => o.selected)?.id ?? 'NEEDS_ACTION'
  return (
    <>
      <label className="sr-only" htmlFor="status-view">STATUS</label>
      <select
        id="status-view"
        value={current}
        onChange={(e) => {
          const next = options.find((o) => o.id === e.target.value)
          if (next && next.href) router.push(next.href)
        }}
        className="h-10 rounded-lg border border-hairline bg-white px-3 text-sm font-medium text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
      >
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </>
  )
}
