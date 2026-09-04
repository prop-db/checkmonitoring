import type { CheckStatus, StagedReason } from '@prisma/client'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  countStagedChecks, getStagedSummary, listStagedChecks, type StagedScope,
} from '@/lib/admin/staged-queue'
import { formatMoney } from '@/lib/money'

/**
 * The staged queue: rows the importer could not write, kept whole.
 *
 * **This is a reading surface, not a data-entry one.** Measured 2026-09-04:
 * 2,467 of the register's 2,766 staged rows are cheques already handed over and
 * 214 are cancelled, leaving about 28 that anyone has to do anything about, and
 * Finance already reconciles the closed ones in the Supplier Portal or in
 * Acumatica. A bulk correction workflow here would serve twenty-eight rows.
 * What it needs to be is legible, filterable, and opened on the live ones —
 * which is why the scope below defaults to LIVE rather than to everything.
 */

const n = (v: number) => v.toLocaleString('en-PH')

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const SCOPES: readonly StagedScope[] = ['LIVE', 'CLOSED', 'ALL']
const REASONS: readonly StagedReason[] = ['NO_COMPANY', 'AMBIGUOUS_COMPANY', 'NO_CHECK_NUMBER']
const STATUSES: readonly CheckStatus[] = [
  'GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE',
  'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED',
]

function Card({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl p-5 ring-1 ${accent ? 'bg-amber-50 ring-amber-200' : 'bg-white ring-slate-200'}`}>
      <p className="text-xs font-medium tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  )
}

export default async function StagedPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; reason?: string; impliedStatus?: string; q?: string }>
}) {
  await requireAdmin()
  const params = await searchParams

  // Everything off the URL is validated rather than cast. A hand-edited or
  // stale bookmarked link would otherwise hand Prisma an invalid enum value and
  // crash the page.
  const scope = SCOPES.includes(params.scope as StagedScope) ? (params.scope as StagedScope) : 'LIVE'
  const reason = REASONS.includes(params.reason as StagedReason)
    ? (params.reason as StagedReason) : undefined
  const impliedStatus = STATUSES.includes(params.impliedStatus as CheckStatus)
    ? (params.impliedStatus as CheckStatus) : undefined

  const filters = { scope, reason, impliedStatus, q: params.q }

  const [summary, rows, matching] = await Promise.all([
    getStagedSummary(prisma),
    listStagedChecks(prisma, filters),
    countStagedChecks(prisma, filters),
  ])

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-6">
        <Card label="STILL IN THE RELEASE WORKFLOW" value={n(summary.live)} accent />
        <Card label="ALREADY RELEASED OR CANCELLED" value={n(summary.closed)} />
        <Card label="NO COMPANY" value={n(summary.byReason.NO_COMPANY)} />
        <Card label="AMBIGUOUS COMPANY" value={n(summary.byReason.AMBIGUOUS_COMPANY)} />
        <Card label="NO CHECK NUMBER" value={n(summary.byReason.NO_CHECK_NUMBER)} />
        <Card label="SINCE PLACED BY A SYNC" value={n(summary.promoted)} />
      </section>

      <p className="max-w-4xl rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">
        These {n(summary.total)} rows were kept whole because they could not be written as cheques.
        Most of them are closed history — Finance reconciles those in the Supplier Portal or in
        Acumatica, and this system is not their system of record. The {n(summary.live)} still in the
        release workflow are the ones worth reading. Nothing here is deleted: a staged row is the
        record of why a cheque was held, and the Acumatica sync places some of them automatically.
      </p>

      <form className="flex flex-wrap gap-3" method="get">
        <input
          name="q" defaultValue={params.q ?? ''}
          placeholder="SEARCH CHECK NO., WHAT THE CELL SAID, OR PAYEE"
          className="w-96 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <select name="scope" defaultValue={scope}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="LIVE">STILL IN THE RELEASE WORKFLOW</option>
          <option value="CLOSED">RELEASED OR CANCELLED</option>
          <option value="ALL">ALL — LIVE ROWS FIRST</option>
        </select>
        <select name="reason" defaultValue={params.reason ?? ''}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">ANY REASON</option>
          {REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
        </select>
        <select name="impliedStatus" defaultValue={params.impliedStatus ?? ''}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">ANY IMPLIED STATUS</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          APPLY
        </button>
      </form>

      {matching > rows.length && (
        <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">
          SHOWING {n(rows.length)} OF {n(matching)} MATCHING ROWS. Narrow the filters to see the rest.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 ring-1 ring-slate-200">
          NO STAGED ROWS MATCH THESE FILTERS.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">CHECK NUMBER</th>
                <th className="px-4 py-3">PAYEE</th>
                <th className="px-4 py-3">CHECK DATE</th>
                <th className="px-4 py-3 text-right">AMOUNT</th>
                <th className="px-4 py-3">WHY IT IS HERE</th>
                <th className="px-4 py-3">REGISTER IMPLIES</th>
                <th className="px-4 py-3">CASH ACCOUNT</th>
                <th className="px-4 py-3">CHECK BOOK</th>
                <th className="px-4 py-3">COMPANIES CLAIMED</th>
                <th className="px-4 py-3">SOURCE</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  {/* For a NO_CHECK_NUMBER row the cheque number is null and
                      this shows what the cell actually held — which is what a
                      human replaces with the real number. It is never promoted
                      into `checkNumber`. */}
                  <td className="px-4 py-3 font-medium">{r.checkNumber ?? r.statedCheckRef ?? '—'}</td>
                  <td className="px-4 py-3">{r.payeeName ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{fmtDate(r.checkDate)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatMoney(r.amount, r.currency ?? 'PHP')}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.reason.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3">{r.impliedStatus.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3 text-slate-600">{r.cashAccountCode ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{r.checkBookCode ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {r.conflictingCompanies.length ? r.conflictingCompanies.join(' / ') : r.companyCode ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {r.source === 'WORKBOOK'
                      ? `${r.sourceSheet} row ${r.sourceRow}`
                      : `Acumatica ${r.acumaticaTenant} ${r.acumaticaRef}`}
                    {r.promotedCheckId && (
                      <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] tracking-wide text-emerald-800">
                        PLACED
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
