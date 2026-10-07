import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getPortalOverview } from '@/lib/admin/portal-overview'
import { PortalActionButton } from '@/components/PortalRetryButton'
import { deliverPortalNowAction, retryPortalEventAction } from './actions'

const fmt = (d: Date) => d.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default async function AdminPortalPage() {
  await requireAdmin()
  const o = await getPortalOverview(prisma)
  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">SUPPLIER PORTAL · OUTBOX</h2>
          <PortalActionButton label="DELIVER NOW" pending="DELIVERING…" action={deliverPortalNowAction} />
        </div>
        <p className="mt-2 text-sm text-slate-700">
          {o.counts.PENDING} pending · {o.counts.IN_FLIGHT} in flight · {o.counts.FAILED} retrying · {o.counts.PARKED} parked · {o.closed.delivered} delivered · {o.closed.superseded} superseded · {o.closed.stale} closed as stale · {o.closed.unmatchable} closed as unmatchable
        </p>
      </section>
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">NEEDS ATTENTION</h2>
        {o.attention.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nothing is parked or retrying.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs text-slate-400">
              <tr><th>CHECK</th><th>PAYEE</th><th>EVENT</th><th>STATUS</th><th>TRIES</th><th>LAST ERROR</th><th>NEXT</th><th></th></tr>
            </thead>
            <tbody>
              {o.attention.map((r) => (
                <tr key={r.id} className="border-t border-hairline">
                  <td className="py-2"><a className="underline" href={`/checks/${r.checkId}`}>{r.checkNumber}</a></td>
                  <td>{r.payeeName ?? '—'}</td>
                  <td>{r.kind}</td>
                  <td>{r.status}</td>
                  <td>{r.attempts}</td>
                  <td className="max-w-md truncate" title={r.lastError ?? ''}>{r.lastError ?? '—'}</td>
                  <td>{r.status === 'FAILED' ? fmt(r.nextAttemptAt) : '—'}</td>
                  <td>
                    <PortalActionButton label="RETRY" pending="…" action={async () => {
                      'use server'
                      const f = new FormData(); f.set('eventId', r.id)
                      return retryPortalEventAction(f)
                    }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
