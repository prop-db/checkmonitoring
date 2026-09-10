import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { Panel } from '@/components/Panel'
import { VoucherTable } from '@/components/VoucherTable'
import { listVoucherCandidates } from '@/lib/export/voucher-query'
import {
  resolveVoucherRows, VOUCHER_INDEX_HREF, CONTESTED, ALL_CANCELLED, NOT_KEYED,
} from '@/lib/export/voucher-index'
import {
  VOUCHERS_PATH, VOUCHER_SCREEN_ROW_LIMIT, VOUCHER_STATUS_OPTIONS,
  parseVoucherStatusParam, filterByStatus, describeVoucherView,
} from '@/lib/vouchers-view'

/**
 * VOUCHERS — which cheque pays this AP voucher, and where is it.
 *
 * The client, shown a document asking Finance to repoint three VLOOKUPs in the
 * Executive Report (2026-09-10): "why do i need to calibrate the excel formula?
 * I want the report to be done in the portal. And report can be extracted from
 * there." So the report is this page, and EXPORT EXCEL is the extract.
 *
 * Everything shown here is decided by `resolveVoucherRows` — the same judgement
 * the Excel index is built from, so the screen and the file can never disagree
 * about a voucher. The page reads parameters through `lib/vouchers-view.ts`
 * and decides nothing itself.
 *
 * A plain `<form method="get">`, like the dashboard's filter bar: a search is
 * linkable, bookmarkable, and works on a workstation whose JavaScript has
 * failed. The dashboard's auto-submit enhancement is wired to `/`, so this
 * form keeps its APPLY button.
 */
export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const q = params.q?.trim() ?? ''
  const status = parseVoucherStatusParam(params.status)

  // The search goes into the SQL; the status is applied after resolution,
  // because CONTESTED, ALL CANCELLED and NOT KEYED exist only once a voucher's
  // cheques have been looked at together.
  const candidates = await listVoucherCandidates(prisma, { voucher: q || undefined })
  const matching = filterByStatus(resolveVoucherRows(candidates), status)
  const rows = matching.slice(0, VOUCHER_SCREEN_ROW_LIMIT)

  const anyFilter = Boolean(q || status)
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <AppHeader
        user={user}
        title="VOUCHERS"
        back={{ href: '/', label: '← DASHBOARD' }}
        showVouchersLink={false}
      />

      <form className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline" method="get">
        <label className="sr-only" htmlFor="voucher-q">SEARCH VOUCHER</label>
        <input
          id="voucher-q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Voucher, e.g. AP-ST042652 or 042652"
          className={`${field} w-72`}
        />

        <label className="sr-only" htmlFor="voucher-status">STATUS</label>
        <select id="voucher-status" name="status" defaultValue={status ?? ''} className={field}>
          <option value="">ANY STATUS</option>
          {VOUCHER_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <button
          type="submit"
          className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
        >
          APPLY
        </button>

        {anyFilter && (
          <Link href={VOUCHERS_PATH} className="text-sm text-slate-500 underline underline-offset-2">
            RESET
          </Link>
        )}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-slate-600">
          {describeVoucherView(matching.length, rows.length, q || undefined, status)}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          {/* The whole index, NOT the filtered view: a lookup extract has to
              cover everything, and a reader who narrowed to CONTESTED must not
              think the file did too. Said beside the button, not in a tooltip. */}
          <span className="text-xs text-slate-500">The file holds every voucher, not this filtered view.</span>
          <a
            href={VOUCHER_INDEX_HREF}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
          >
            EXPORT EXCEL
          </a>
        </div>
      </div>

      {rows.length === 0
        ? (
          <EmptyState title={anyFilter ? 'NO VOUCHERS MATCH' : 'NO VOUCHERS ARE KNOWN'}>
            {anyFilter
              ? 'Nothing carries that voucher with that status. A voucher no cheque has been written for has no row here at all.'
              : 'No cheque carries an AP voucher yet. Vouchers arrive with the register import and the approval-for-release workbook.'}
          </EmptyState>
        )
        : <VoucherTable rows={rows} />}

      <Panel title="WHEN THE CHECK NUMBER IS BLANK">
        <p className="text-sm leading-relaxed text-slate-600">
          A blank cheque number is not a failure. It means this system will not guess, and
          the STATUS column says which of three reasons applies. REMARKS spells it out every time.
        </p>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-semibold text-navy">{CONTESTED}</dt>
            <dd className="mt-1 text-slate-600">
              Two live cheques both name this voucher. Naming one would tell a supplier the wrong
              thing. REMARKS names both, with their companies. Settle it on the cheques themselves.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-navy">{ALL_CANCELLED}</dt>
            <dd className="mt-1 text-slate-600">
              Every cheque that named this voucher was cancelled or voided. The payable still needs
              a cheque. REMARKS lists the cancelled ones.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-navy">{NOT_KEYED}</dt>
            <dd className="mt-1 text-slate-600">
              A staged row names this voucher and was never settled. REMARKS names the sheet and
              row; an administrator settles it on the STAGED QUEUE.
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          A voucher with <span className="font-semibold">no row at all</span> is the ordinary case: no cheque
          has been written for that payable yet.
        </p>
      </Panel>
    </main>
  )
}
