import Link from 'next/link'
import { ELIGIBILITIES } from '@/lib/queries'
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
 *
 * There is NO status dropdown. The summary cards above are the view selector —
 * which set of cheques you are looking at — and everything on this bar narrows
 * WITHIN that view. The dropdown wrote the same `?status=` the cards do, which
 * is two controls for one thing, and the client did not read the cards as
 * filters while a dropdown was competing with them.
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
  // The status is NOT counted. It is the view, not a filter, and CLEAR FILTERS
  // deliberately keeps it: a bar offering CLEAR on an otherwise untouched
  // SIGNED view would promise to clear something it does not clear.
  const anyFilter = Boolean(q || companyId || cashAccountId || eligibility || incomplete)

  const field = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900'

  return (
    <form className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200" method="get">
      {/* The VIEW survives a search. These two hidden fields are the whole
          reason the status dropdown could be removed safely: a GET submit sends
          only the form's own controls, so without them searching inside SIGNED
          would drop `status` and silently throw the user back to NEEDS ACTION. */}
      {status && <input type="hidden" name="status" value={status} />}
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

      <label className="sr-only" htmlFor="filter-eligibility">ELIGIBILITY</label>
      <select id="filter-eligibility" name="eligibility" defaultValue={eligibility} className={field}>
        <option value="">ALL ELIGIBILITIES</option>
        {ELIGIBILITIES.map((e) => (
          <option key={e} value={e}>{e}</option>
        ))}
      </select>

      {/* The 129 cheques whose amount the register never recorded. A narrowing
          filter, never a view: incompleteness cuts across every status (50
          SIGNATURE_PENDING, 48 CANCELLED, 25 RELEASED, 6 READY_FOR_RELEASE), so
          it composes with the selected view rather than replacing it. The
          INCOMPLETE card above is the same filter — this one stays because it
          sits with the other narrowing controls and clears with them. */}
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
        // an unfiltered URL and keeps only the VIEW the user is reading in.
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
