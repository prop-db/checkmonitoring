import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { manilaDay } from '@/lib/forecast/buckets'
import { listPlannedOutflows, listBanks } from '@/lib/planned-outflow/query'
import { AppHeader } from '@/components/AppHeader'
import { Panel } from '@/components/Panel'
import { EmptyState } from '@/components/EmptyState'
import { PlannedOutflowForm } from '@/components/PlannedOutflowForm'
import { PlannedOutflowList } from '@/components/PlannedOutflowList'
import { loadSettings } from '@/lib/settings/read'

/**
 * PLANNED OUTFLOWS — the money that leaves the bank and is not a cheque.
 *
 * Payroll, tax, loan amortisation, transfers: typed one line at a time
 * (decided 2026-09-12), each with the day it leaves the bank. An open line is
 * on the forecast until somebody marks it PAID or CANCELLED — a past-dated
 * line still open is overdue, and shows as such rather than vanishing.
 * Nothing here is deleted.
 */
export default async function PlannedOutflowsPage({
  searchParams,
}: {
  searchParams: Promise<{ closed?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const includeClosed = params.closed === '1'
  const [rows, banks, options, settings] = await Promise.all([
    listPlannedOutflows(prisma, { includeClosed }),
    listBanks(prisma),
    getFilterOptions(prisma),
    loadSettings(prisma),
  ])
  const openCount = rows.filter((r) => r.status === 'PLANNED').length

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <AppHeader user={user} title="PLANNED OUTFLOWS" back={{ href: '/forecast', label: '← CASH OUTFLOW' }} />

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        Outflows that are not checks — payroll, tax, loan amortisation, transfers — typed with the day
        they leave the bank. An open line stays on the forecast until it is marked PAID or CANCELLED;
        a line whose day has passed is overdue, not gone. Nothing here is deleted.
      </p>

      <Panel title="ADD A LINE">
        <PlannedOutflowForm banks={banks} companies={options.companies} categories={settings.values.categories} />
      </Panel>

      <Panel
        title={`${openCount.toLocaleString('en-PH')} OPEN LINE${openCount === 1 ? '' : 'S'}`}
        aside={
          <Link href={includeClosed ? '/forecast/planned' : '/forecast/planned?closed=1'} className="text-xs text-slate-500 underline underline-offset-2">
            {includeClosed ? 'HIDE PAID AND CANCELLED' : 'SHOW PAID AND CANCELLED'}
          </Link>
        }
        bodyClassName="p-0"
      >
        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState title="NO PLANNED OUTFLOWS" tone="plain">Add the first one above. It will appear on the forecast at once.</EmptyState>
          </div>
        ) : (
          <PlannedOutflowList
            rows={rows} banks={banks} companies={options.companies} today={manilaDay(new Date())}
            categories={settings.values.categories}
          />
        )}
      </Panel>
    </main>
  )
}
