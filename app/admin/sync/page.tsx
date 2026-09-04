import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getSyncOverview, type TenantSync } from '@/lib/admin/sync-overview'
import { SyncNowButton } from '@/components/SyncNowButton'

// Spec §11's wording: "Last Sync: September 1, 2026 — 10:45 AM".
const fmtDateTime = (d: Date | null) =>
  d
    ? d.toLocaleString('en-PH', {
        month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null

const n = (v: number) => v.toLocaleString('en-PH')

const TENANT_LABEL: Readonly<Record<string, string>> = {
  GOLIVE: 'GO-LIVE',
  MANUFACTURING: 'MANUFACTURING',
}

function Counts({ run }: { run: NonNullable<TenantSync['lastAttempt']> }) {
  // Staged is shown beside imported and updated, never inferred from a
  // shortfall: 80 live cheques carry a memo where their number belongs and land
  // in staging on every single run. They used to be counted as errors, which is
  // why this figure is stated rather than left to be worked out.
  return (
    <p className="text-sm text-slate-700">
      {n(run.imported)} new checks imported, {n(run.updated)} records updated,{' '}
      {n(run.staged)} staged for review, {n(run.errors)} errors
    </p>
  )
}

function TenantCard({ t }: { t: TenantSync }) {
  const lastSuccess = fmtDateTime(t.lastSuccess?.startedAt ?? null)
  const lastAttempt = fmtDateTime(t.lastAttempt?.startedAt ?? null)

  return (
    <section className="space-y-4 rounded-2xl bg-white p-6 ring-1 ring-slate-200">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold tracking-wide">
          ACUMATICA · {TENANT_LABEL[t.tenant] ?? t.tenant}
        </h2>
        {/* Two different facts, and conflating them is what wasted half an hour
            on 2026-09-04: a run still working looks exactly like one whose
            process was killed, because runSync reports its counts only at the
            end. Past ABANDONED_AFTER_MINUTES the screen stops claiming the run
            is alive — it cannot see the process, and "SYNCING…" over a dead job
            is a statement this system has no basis for. */}
        {t.abandoned ? (
          <span className="rounded bg-rose-100 px-2 py-0.5 text-xs tracking-wide text-rose-900">
            RUN ABANDONED
          </span>
        ) : t.inFlight ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs tracking-wide text-amber-900">
            RUN NOT FINISHED
          </span>
        ) : null}
      </div>

      {/* A tenant that has never been read says so. An empty space here would
          be indistinguishable from a tenant that synced cleanly and imported
          nothing, which is the opposite fact. */}
      {t.lastAttempt === null ? (
        <p className="text-sm text-slate-500">This tenant has never been synced.</p>
      ) : t.abandoned ? (
        <div className="space-y-2 rounded-xl bg-rose-50 p-4 ring-1 ring-rose-200">
          <p className="text-sm font-medium text-rose-900">
            A run started {t.lastAttempt.startedAt.toISOString().slice(0, 16).replace('T', ' ')} and never
            reported finishing.
          </p>
          <p className="text-sm text-rose-800">
            Its process was almost certainly killed. A first full sync reads tens of thousands of rows
            and cannot complete inside a web request — whatever it wrote is committed and correct, but
            it stopped partway. Finish it from a terminal, where nothing imposes a timeout:
          </p>
          <code className="block rounded bg-white/70 px-3 py-2 text-xs text-rose-900">
            npx.cmd tsx scripts/sync.ts {t.tenant}
          </code>
          <p className="text-xs text-rose-800">
            Re-running is safe: the sync is idempotent, so rows already written are updated rather than
            duplicated.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-xs tracking-wide text-slate-500">LAST SUCCESSFUL SYNC</p>
            <p className="text-lg font-semibold text-slate-900">
              {lastSuccess ?? 'None — no run has finished without errors.'}
            </p>
            {t.lastSuccess && <Counts run={t.lastSuccess} />}
          </div>

          <div>
            <p className="text-xs tracking-wide text-slate-500">LAST ATTEMPT</p>
            <p className="text-sm text-slate-900">{lastAttempt}</p>
            <Counts run={t.lastAttempt} />
            {/* The run's own recorded problem text, truncated by `runSync`. It
                is the difference between "3 errors" and a diagnosis. */}
            {t.lastAttempt.message && (
              <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                {t.lastAttempt.message}
              </p>
            )}
          </div>

          <div>
            <p className="text-xs tracking-wide text-slate-500">NEXT RUN READS FROM</p>
            <p className="text-sm text-slate-700">
              {fmtDateTime(t.lastAttempt.watermark) ??
                'the beginning — no watermark has been recorded, so the next run is a full read'}
            </p>
          </div>
        </div>
      )}

      <SyncNowButton tenant={t.tenant} label={TENANT_LABEL[t.tenant] ?? t.tenant} />
    </section>
  )
}

export default async function SyncPage() {
  await requireAdmin()

  const [overview, recent] = await Promise.all([
    getSyncOverview(prisma),
    prisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 25 }),
  ])

  return (
    <div className="space-y-6">
      {/* One card per tenant, never one pooled figure. `SyncRun.tenant` exists
          because Go-Live `ST` is Starkson Packaging and MANUFACTURING `ST` is
          Starkson Paper and Plastic; a "last sync" across both would be a
          number about nothing. */}
      <div className="grid gap-4 lg:grid-cols-2">
        {overview.tenants.map((t) => <TenantCard key={t.tenant} t={t} />)}
      </div>

      {overview.untenantedRuns > 0 && (
        <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">
          {n(overview.untenantedRuns)} earlier run(s) predate the tenant column and are not
          attributed to either tenant. They are listed below.
        </p>
      )}

      <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
        <h2 className="p-6 pb-4 text-sm font-semibold tracking-wide">SYNC LOG</h2>
        {recent.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-slate-500">NO SYNC HAS EVER RUN.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">STARTED</th>
                <th className="px-4 py-3">TENANT</th>
                <th className="px-4 py-3">MODE</th>
                <th className="px-4 py-3 text-right">IMPORTED</th>
                <th className="px-4 py-3 text-right">UPDATED</th>
                <th className="px-4 py-3 text-right">STAGED</th>
                <th className="px-4 py-3 text-right">ERRORS</th>
                <th className="px-4 py-3">FINISHED</th>
                <th className="px-4 py-3">MESSAGE</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 text-slate-600">{fmtDateTime(r.startedAt)}</td>
                  {/* An em dash rather than a blank: a run with no tenant is a
                      run recorded before the column existed, not a rendering
                      fault. */}
                  <td className="px-4 py-3">{r.tenant ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{r.mode}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{n(r.imported)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{n(r.updated)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{n(r.staged)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${r.errors > 0 ? 'text-rose-700' : 'text-slate-600'}`}>
                    {n(r.errors)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {fmtDateTime(r.finishedAt) ?? 'NOT FINISHED'}
                  </td>
                  <td className="max-w-md px-4 py-3 text-slate-600">{r.message ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
