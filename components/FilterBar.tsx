import Link from 'next/link'
import { ALL_STATUSES, ELIGIBILITIES } from '@/lib/queries'
import type { FilterOptions } from '@/lib/queries'

/**
 * The dashboard's filter bar.
 *
 * A plain `<form method="get">`, deliberately. Every control writes a URL
 * parameter, which is what makes a filtered view linkable, bookmarkable and
 * survivable across a refresh — and it keeps working on a Finance workstation
 * whose JavaScript has failed, the same reasoning as the sign-out form.
 *
 * The options are passed in, loaded from the database by the page. Nothing here
 * is hardcoded: a ninth company or a seventh cash account appears on this bar
 * without a code change. The statuses and eligibilities come from the domain's
 * own lists for the same reason — a restatement is how the ladder ends up with
 * eight rungs in one file and six in another.
 *
 * The page validates every value it reads back, so an unrecognised parameter is
 * ignored rather than passed to Prisma. See `parseStatusParam` and friends.
 */
export function FilterBar({
  options, showAll, q, status, companyId, cashAccountId, eligibility, incomplete, clearHref,
}: {
  options: FilterOptions
  showAll: boolean
  q: string
  status: string
  companyId: string
  cashAccountId: string
  eligibility: string
  incomplete: boolean
  clearHref: string
}) {
  // A CLEAR control that is always there is furniture, and on an unfiltered
  // screen it invites the user to wonder what it would clear.
  const anyFilter = Boolean(q || status || companyId || cashAccountId || eligibility || incomplete)

  const field = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900'

  return (
    <form className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200" method="get">
      {/* The scope survives a search. Without this the form would drop
          ?scope=all and silently pull the user back to the live list. */}
      {showAll && <input type="hidden" name="scope" value="all" />}

      <input
        name="q" defaultValue={q}
        placeholder="SEARCH CHECK NO., APV, PO OR SUPPLIER"
        className={`${field} w-80`}
      />

      <label className="sr-only" htmlFor="filter-company">COMPANY</label>
      <select id="filter-company" name="company" defaultValue={companyId} className={field}>
        <option value="">ALL COMPANIES</option>
        {options.companies.map((c) => (
          <option key={c.id} value={c.id}>{c.code}</option>
        ))}
      </select>

      {/* Labelled by the cash account code — "BPI STK" is what Finance says out
          loud, and the bank alone would not distinguish two accounts at the
          same bank. The bank code is shown beside it for the reader who knows
          the institution but not the account label. */}
      <label className="sr-only" htmlFor="filter-cash-account">BANK / CASH ACCOUNT</label>
      <select id="filter-cash-account" name="cashAccount" defaultValue={cashAccountId} className={field}>
        <option value="">ALL BANKS / CASH ACCOUNTS</option>
        {options.cashAccounts.map((a) => (
          <option key={a.id} value={a.id}>{a.code}{a.code.includes(a.bankCode) ? '' : ` (${a.bankCode})`}</option>
        ))}
      </select>

      <label className="sr-only" htmlFor="filter-status">STATUS</label>
      <select id="filter-status" name="status" defaultValue={status} className={field}>
        <option value="">ALL STATUSES</option>
        {ALL_STATUSES.map((s) => (
          <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
        ))}
      </select>

      <label className="sr-only" htmlFor="filter-eligibility">ELIGIBILITY</label>
      <select id="filter-eligibility" name="eligibility" defaultValue={eligibility} className={field}>
        <option value="">ALL ELIGIBILITIES</option>
        {ELIGIBILITIES.map((e) => (
          <option key={e} value={e}>{e}</option>
        ))}
      </select>

      {/* The 129 cheques whose amount the register never recorded. A checkbox,
          not a third option on the status dropdown: incompleteness cuts across
          every status (50 SIGNATURE_PENDING, 48 CANCELLED, 25 RELEASED, 6
          READY_FOR_RELEASE), so it has to narrow alongside a status rather than
          replace one. */}
      <label className={`flex items-center gap-2 ${field}`}>
        <input type="checkbox" name="incomplete" value="1" defaultChecked={incomplete} />
        INCOMPLETE ONLY (NO AMOUNT)
      </label>

      <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">
        APPLY
      </button>

      {anyFilter && (
        // A link, not a reset button: reset would restore the form's defaults,
        // which ARE the current filters, and appear to do nothing. This goes to
        // an unfiltered URL and keeps only the scope the user is reading in.
        <Link
          href={clearHref}
          className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900"
        >
          CLEAR FILTERS
        </Link>
      )}
    </form>
  )
}
