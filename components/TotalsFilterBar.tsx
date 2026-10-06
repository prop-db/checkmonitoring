import Link from 'next/link'
import { ELIGIBILITIES } from '@/lib/queries'
import type { FilterOptions } from '@/lib/queries'
import { bankLabel } from '@/lib/export/report'
import type { StatusOption } from '@/lib/status-options'
import { FilterAutoSubmit } from './FilterAutoSubmit'
import { StatusSelect } from './StatusSelect'

const APPLY_ID = 'totals-filter-apply'

/**
 * The TOTALS screen's filter bar (client request 2026-09-29: "should have
 * filter in every summary").
 *
 * COMPANY, BANK / CASH ACCOUNT and ELIGIBILITY — the three narrowing filters
 * the list already reads, under the same parameter names, so a card on a
 * narrowed screen links to the list narrowed the same way. Submitting writes
 * `/?company=…`, which `dashboardScreen` keeps on TOTALS: every figure on the
 * screen narrows, and nothing opens the list.
 *
 * No search box here. The search form beneath the cards stays a plain submit,
 * because `FilterAutoSubmit` would navigate to the list after 400 ms of typing
 * and lose the caret; it carries these three as hidden fields instead.
 *
 * The bank label comes from `bankLabel`, which the list's bar and the export
 * use, so the three cannot spell an account differently.
 */
export function TotalsFilterBar({
  options, companyId, cashAccountId, eligibility, description, statusOptions,
}: {
  /** The STATUS dropdown's options, with counts. */
  statusOptions: StatusOption[]
  options: FilterOptions
  companyId: string
  cashAccountId: string
  eligibility: string
  /** `narrowingDescription` from `resolveDashboardQuery`; printed only when a filter is set. */
  description: string
}) {
  const anyFilter = Boolean(companyId || cashAccountId || eligibility)

  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <section className="space-y-2">
      {/* Keyed on the values in force: React does not re-apply `defaultValue`
          to a select that is already mounted, so after a client-side navigation
          (RESET, a card, BACK TO TOTALS) the form must remount to show them. */}
      <form
        key={`${companyId}|${cashAccountId}|${eligibility}`}
        className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline"
        method="get"
      >
        <StatusSelect options={statusOptions} />

        <label className="sr-only" htmlFor="totals-company">COMPANY</label>
        <select id="totals-company" name="company" defaultValue={companyId} className={field}>
          <option value="">ALL COMPANIES</option>
          {options.companies.map((c) => (
            <option key={c.id} value={c.id}>{c.code}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="totals-cash-account">BANK / CASH ACCOUNT</label>
        <select id="totals-cash-account" name="cashAccount" defaultValue={cashAccountId} className={field}>
          <option value="">ALL BANKS / CASH ACCOUNTS</option>
          {options.cashAccounts.map((a) => (
            <option key={a.id} value={a.id}>{bankLabel(a.code, a.bankCode)}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="totals-eligibility">ELIGIBILITY</label>
        <select id="totals-eligibility" name="eligibility" defaultValue={eligibility} className={field}>
          <option value="">ALL ELIGIBILITIES</option>
          {ELIGIBILITIES.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>

        <button id={APPLY_ID} type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium text-white">
          APPLY
        </button>

        {anyFilter && (
          <Link href="/" className="h-10 rounded-lg px-3 py-2 text-sm font-medium text-navy underline underline-offset-2 hover:text-slate-900">
            RESET
          </Link>
        )}

        <FilterAutoSubmit applyButtonId={APPLY_ID} />
      </form>

      {/* A narrowed screen that did not say so would read as the whole
          company's figures. Stated once, under the bar; the incomplete
          exclusion has its own line with a count beneath the cards. */}
      {anyFilter && (
        <p className="text-xs font-medium tracking-wide text-slate-600">
          SHOWING {description}
        </p>
      )}
    </section>
  )
}
