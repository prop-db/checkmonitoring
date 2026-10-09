import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { listChecks, toTableRow } from '@/lib/queries'
import { compareCheckNumbers } from '@/lib/transmittal'
import { AppHeader } from '@/components/AppHeader'
import { TransmittalBuilder, type TransmittalCandidate } from '@/components/TransmittalBuilder'

/**
 * CHECKS TRANSMITTAL — the sheet that goes with a batch of cheques to the
 * person who signs or collects them (client request 2026-10-06).
 *
 * The pick list is every real cheque still at SIGNATURE PENDING or SIGNED with
 * a recorded amount; `?released=1` adds the RELEASED ones too (client,
 * 2026-10-09), which is ~10,000 more rows, so it is asked for and not the default. The page only reads: nothing here changes a status —
 * releasing stays on the dashboard — so printing a transmittal is safe to do
 * twice. It is a page with a `@media print` stylesheet, like `/print`; "saved"
 * is the browser's Save as PDF. `requireUser()` first: it lists payees and
 * amounts.
 */
export const dynamic = 'force-dynamic'

/** Above this the pick list says it is short; today's population is ~1,400. */
const PICK_LIMIT = 5_000
/** With RELEASED included the population is ~12,000; the cap says so if it is ever passed. */
const PICK_LIMIT_WITH_RELEASED = 25_000

export default async function TransmittalPage({
  searchParams,
}: {
  searchParams: Promise<{ released?: string | string[] }>
}) {
  const user = await requireUser()
  const includeReleased = (await searchParams).released === '1'
  const limit = includeReleased ? PICK_LIMIT_WITH_RELEASED : PICK_LIMIT

  const rows = await listChecks(
    prisma,
    { statusIn: includeReleased ? ['SIGNATURE_PENDING', 'SIGNED', 'RELEASED'] : ['SIGNATURE_PENDING', 'SIGNED'], incomplete: false },
    limit,
    { key: 'checkNumber', dir: 'asc' },
  )

  const candidates: TransmittalCandidate[] = rows
    .map(toTableRow)
    // DEBIT ADV and CASH are not cheques; a transmittal of cheques excludes them.
    .filter((r) => r.isCheque)
    .map((r) => ({
      id: r.id,
      checkNumber: r.checkNumber,
      cashAccount: r.cashAccountCode ?? '',
      poNumber: r.poNumbers.join(', '),
      voucher: r.apvNumbers.join(', '),
      payee: r.payeeName ?? '',
      amount: r.amount,
      currency: r.currency,
      status: r.status === 'SIGNED' || r.status === 'RELEASED' ? r.status : ('SIGNATURE_PENDING' as const),
      company: r.companyCode,
    }))
    .sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber))

  return (
    <main className="space-y-4 px-4 py-5">
      <div className="print-hide">
        <AppHeader user={user} title="CHECKS TRANSMITTAL" back={{ href: '/', label: '← DASHBOARD' }} />
      </div>
      <TransmittalBuilder candidates={candidates} preparedBy={user.name} truncated={rows.length >= limit} includeReleased={includeReleased} />
    </main>
  )
}
