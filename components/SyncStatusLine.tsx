import Link from 'next/link'
import type { Staleness } from '@/lib/sync/staleness'

const TENANT_LABEL: Readonly<Record<string, string>> = {
  GOLIVE: 'GO-LIVE',
  MANUFACTURING: 'MANUFACTURING',
}

/**
 * Manila, stated. Every other timestamp on the dashboard calls
 * `toLocaleString('en-PH', …)` with no zone and renders in the SERVER's zone —
 * which on Vercel is UTC, eight hours behind the office. For a line whose one
 * job is "how old is this", eight hours is the difference between fine and
 * stale, so the zone is named.
 */
const fmt = (d: Date) =>
  d.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })

/**
 * When Acumatica was last read, and — past the threshold — that it has not been.
 *
 * Since the register was retired, the sync is the only way a cheque arrives.
 * This line is what makes a sync nobody ran visible: on the once-a-day plan
 * the cron is the mechanism and this is the check on it. Shown to everyone;
 * the fix is offered only to an admin, because only an admin can press it.
 */
export function SyncStatusLine({ staleness, isAdmin }: { staleness: Staleness; isAdmin: boolean }) {
  const parts = staleness.tenants.map(
    (t) => `${TENANT_LABEL[t.tenant] ?? t.tenant} ${t.lastReadAt ? fmt(t.lastReadAt) : 'never'}`,
  )

  if (!staleness.warn) {
    return (
      <p className="text-xs font-medium tracking-wide text-slate-500">
        ACUMATICA LAST READ · {parts.join(' · ')}
      </p>
    )
  }

  const neverRead = staleness.tenants.filter((t) => t.lastReadAt === null)
  const headline = neverRead.length
    ? `ACUMATICA HAS NEVER BEEN READ FOR ${neverRead.map((t) => TENANT_LABEL[t.tenant] ?? t.tenant).join(' AND ')}`
    : `ACUMATICA NOT READ FOR ${staleness.oldestHours} HOURS`

  return (
    <div className="rounded-xl bg-warning-bg px-4 py-3 text-sm text-warning-ink ring-1 ring-warning-ink/20">
      <p className="font-semibold tracking-wide">{headline}</p>
      <p className="mt-1">
        Cheques generated in Acumatica since then are not on this board. {parts.join(' · ')}.{' '}
        {isAdmin ? (
          <>
            Press SYNC NOW on the{' '}
            <Link href="/admin/sync" className="underline underline-offset-2">administration page</Link>.
          </>
        ) : (
          'Ask an administrator to run SYNC NOW.'
        )}
      </p>
    </div>
  )
}
