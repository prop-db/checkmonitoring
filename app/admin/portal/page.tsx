import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getPortalOverview } from '@/lib/admin/portal-overview'
import { PortalActionButton } from '@/components/PortalRetryButton'
import { KitTable, type KitRow } from '@/components/table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { instantValue } from '@/lib/table-kit/match'
import { PORTAL_RELEASES_MODE } from '@/lib/sync/modes'
import { listOpenPortalReleaseLooks } from '@/lib/sync/portal-releases'
import { deliverPortalNowAction, retryPortalEventAction } from './actions'

const fmt = (d: Date) => d.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default async function AdminPortalPage() {
  await requireAdmin()
  const o = await getPortalOverview(prisma)
  const lastPortalRead = await prisma.syncRun.findFirst({
    where: { mode: PORTAL_RELEASES_MODE, finishedAt: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true, imported: true, updated: true, staged: true, errors: true, message: true },
  })
  // Every open item across runs (final review 2026-10-19, I2), not only the latest run's message.
  const LOOK_LIMIT = 200
  const looks = await listOpenPortalReleaseLooks(prisma, LOOK_LIMIT)
  const distinct = (vals: string[]) => [...new Set(vals)].sort().map((v) => ({ value: v, label: v }))
  const columns: KitColumn[] = [
    { key: 'check', label: 'CHECK', kind: 'text', locked: true },
    { key: 'payee', label: 'PAYEE', kind: 'text' },
    { key: 'kind', label: 'EVENT', kind: 'enum', options: distinct(o.attention.map((r) => r.kind)) },
    { key: 'status', label: 'STATUS', kind: 'enum', options: distinct(o.attention.map((r) => r.status)) },
    { key: 'tries', label: 'TRIES', kind: 'amount' },
    { key: 'lastError', label: 'LAST ERROR', kind: 'text', className: 'max-w-md truncate' },
    { key: 'next', label: 'NEXT', kind: 'date' },
    { key: 'retry', label: '', kind: 'text', noSort: true, noFilter: true, locked: true },
  ]
  const rows: KitRow[] = o.attention.map((r) => ({
    key: r.id,
    values: {
      check: r.checkNumber, payee: r.payeeName, kind: r.kind, status: r.status, tries: String(r.attempts),
      lastError: r.lastError, next: r.status === 'FAILED' ? instantValue(r.nextAttemptAt) : null,
    },
    cells: {
      check: <a className="underline" href={`/checks/${r.checkId}`}>{r.checkNumber}</a>,
      payee: r.payeeName ?? '—',
      kind: r.kind,
      status: r.status,
      tries: r.attempts,
      lastError: <span title={r.lastError ?? ''}>{r.lastError ?? '—'}</span>,
      next: r.status === 'FAILED' ? fmt(r.nextAttemptAt) : '—',
      retry: (
        <PortalActionButton label="RETRY" pending="…" action={async () => {
          'use server'
          const f = new FormData(); f.set('eventId', r.id)
          return retryPortalEventAction(f)
        }} />
      ),
    },
  }))
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
          <div className="mt-3">
            <KitTable
              tableId="portal-attention" columns={columns} rows={rows} frameClassName="" cellClassName="py-2 pr-4"
              capped={o.attention.length >= 200}
            />
          </div>
        )}
      </section>
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">RELEASES READ FROM THE SUPPLIER PORTAL</h2>
        {lastPortalRead ? (
          <div className="mt-2 space-y-1 text-sm text-slate-700">
            <p>Last read {fmt(lastPortalRead.startedAt)}: {lastPortalRead.imported} released here, {lastPortalRead.updated} already released, {lastPortalRead.staged} new item(s) needing a look, {lastPortalRead.errors} error(s).</p>
            {lastPortalRead.message ? <p className="text-slate-700">{lastPortalRead.message}</p> : null}
          </div>
        ) : <p className="mt-2 text-sm text-slate-500">Not read yet.</p>}
        <h3 className={`mt-4 text-[11px] font-semibold tracking-widest ${looks.length ? 'text-warning-ink' : 'text-slate-400'}`}>
          PORTAL RELEASES NEEDING A LOOK ({looks.length}{looks.length >= LOOK_LIMIT ? '+' : ''})
        </h3>
        {looks.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nothing needing a look.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-sm text-slate-700">
              <thead className="text-[11px] tracking-widest text-slate-400">
                <tr>
                  <th className="py-2 pr-4">LISTED</th><th className="py-2 pr-4">KIND</th><th className="py-2 pr-4">CHECK</th>
                  <th className="py-2 pr-4">RELEASE DATE</th><th className="py-2 pr-4">OR</th><th className="py-2 pr-4">RELEASED BY</th>
                  <th className="py-2 pr-4">DETAIL</th>
                </tr>
              </thead>
              <tbody>
                {looks.map((l) => (
                  <tr key={l.id} className="border-t border-hairline">
                    <td className="py-2 pr-4 whitespace-nowrap">{fmt(l.createdAt)}</td>
                    <td className="py-2 pr-4">{l.kind}</td>
                    <td className="py-2 pr-4">
                      {l.checkId ? <a className="underline" href={`/checks/${l.checkId}`}>{l.checkNumber}</a> : l.checkNumber}
                      <span className="ml-1 text-xs text-slate-400">{l.domain}</span>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{l.releaseDate ?? '—'}</td>
                    <td className="py-2 pr-4">{l.orNumber ?? '—'}</td>
                    <td className="py-2 pr-4">{l.releasedByName ?? '—'}</td>
                    <td className="py-2 pr-4 max-w-md truncate" title={l.detail ?? ''}>{l.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">DEAD_HERE: released on the portal but CANCELLED or VOIDED here. NOT_FOUND: no check here with that number and APV (re-checked every read, so it is released once the APV is linked). AMBIGUOUS: more than one live check. BEFORE_GO_LIVE: released on the portal before 19 October 2026; never applied here. An item leaves the list when the release is read back onto a check.</p>
      </section>
    </div>
  )
}
