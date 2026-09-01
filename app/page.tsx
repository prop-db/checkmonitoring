import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getSummary, listChecks } from '@/lib/queries'
import { SummaryCards } from '@/components/SummaryCards'
import { CheckTable } from '@/components/CheckTable'
import type { CheckStatus } from '@prisma/client'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const [summary, rows] = await Promise.all([
    getSummary(prisma),
    listChecks(prisma, {
      q: params.q,
      status: params.status ? (params.status as CheckStatus) : undefined,
    }),
  ])

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-wide">CHECK RELEASE MONITORING</h1>
        <p className="text-sm text-slate-500">{user.name} · {user.role.replace(/_/g, ' ')}</p>
      </header>

      <SummaryCards summary={summary} />

      <form className="flex flex-wrap gap-3" method="get">
        <input
          name="q" defaultValue={params.q ?? ''}
          placeholder="SEARCH CHECK NO., APV, PO OR SUPPLIER"
          className="w-96 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <select name="status" defaultValue={params.status ?? ''}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">ALL STATUSES</option>
          {['SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          APPLY
        </button>
      </form>

      <CheckTable rows={rows} />
    </main>
  )
}
