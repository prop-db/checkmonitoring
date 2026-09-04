import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getSummary, listChecks, countChecks } from '@/lib/queries'
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

  // `status` comes from the URL. Casting it straight to CheckStatus would hand
  // Prisma an invalid enum value on a hand-edited or stale bookmarked link and
  // crash the page with a 500. Validate, and ignore anything unrecognised.
  const VALID: readonly string[] = [
    'GENERATED', 'SIGNATURE_PENDING', 'SIGNED',
    'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED',
  ]
  const status = params.status && VALID.includes(params.status)
    ? (params.status as CheckStatus)
    : undefined

  const filters = { q: params.q, status }

  const [summary, rows, matching] = await Promise.all([
    getSummary(prisma),
    listChecks(prisma, filters),
    countChecks(prisma, filters),
  ])

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-wide">CHECK RELEASE MONITORING</h1>
        <p className="flex items-baseline gap-4 text-sm text-slate-500">
          {/* Shown only to an admin. The route is guarded server-side either
              way (app/admin/layout.tsx); hiding the link keeps a Finance user
              from being offered a page that would bounce them back here. */}
          {user.role === 'FINANCE_ADMIN' && (
            <Link href="/admin/sync" className="underline underline-offset-2">ADMINISTRATION</Link>
          )}
          <span>{user.name} · {user.role.replace(/_/g, ' ')}</span>
        </p>
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

      {matching > rows.length && (
        <p className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">
          SHOWING {rows.length.toLocaleString('en-PH')} OF {matching.toLocaleString('en-PH')} MATCHING CHECKS.
          Narrow the search or filters to see the rest.
        </p>
      )}

      <CheckTable rows={rows} />
    </main>
  )
}
