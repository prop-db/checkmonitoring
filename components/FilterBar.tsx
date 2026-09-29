import Link from 'next/link'
import { ELIGIBILITIES } from '@/lib/queries'
import type { FilterOptions } from '@/lib/queries'
import { bankLabel } from '@/lib/export/report'
import { FilterAutoSubmit } from './FilterAutoSubmit'

/** The APPLY button's id, so the enhancement can find and hide it. */
const APPLY_ID = 'filter-apply'

/**
 * The dashboard's filter bar: one row — SEARCH · COMPANY · BANK · ELIGIBILITY ·
 * DATE RELEASED (RELEASED and ALL CHEQUES views only) · INCOMPLETE · RESET.
 *
 * A plain `<form method="get">`, deliberately, and still one. Every control
 * writes a URL parameter, which is what makes a filtered view linkable,
 * bookmarkable and survivable across a refresh — and it keeps working on a
 * Finance workstation whose JavaScript has failed, the same reasoning as the
 * sign-out form.
 *
 * ── AUTO-SUBMIT, WITHOUT LOSING THAT ──────────────────────────────────────
 * The client asked for the APPLY button to go: the dropdowns should submit on
 * change and the search box should debounce. That is `FilterAutoSubmit`, an
 * enhancement mounted below.
 *
 * The button is still in the markup. It is hidden by the enhancement on mount,
 * so a reader with a working bundle never sees it, and a reader whose bundle
 * failed still has a way to submit. Deleting it outright would have left the
 * dropdowns inert without JavaScript — the no-JS path is the one property here
 * that is not negotiable, so the button is hidden rather than removed.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The options are passed in, loaded from the database by the page. Nothing here
 * is hardcoded: a ninth company or a seventh cash account appears on this bar
 * without a code change. The eligibilities come from the domain's own list for
 * the same reason — a restatement is how one file ends up with a value another
 * one has never heard of.
 *
 * The page validates every value it reads back, so an unrecognised parameter is
 * ignored rather than passed to Prisma. See `parseStatusParam` and friends.
 *
 * There is NO status dropdown. The summary cards and the release timeline above
 * are the view selector — which set of cheques you are looking at — and
 * everything on this bar narrows WITHIN that view. The dropdown wrote the same
 * `?status=` the cards do, which is two controls for one thing, and the client
 * did not read the cards as filters while a dropdown was competing with them.
 */
export function FilterBar({
  options, showAll, q, status, companyId, cashAccountId, eligibility, incomplete,
  releasedFrom, releasedTo, showReleasedRange, clearHref,
}: {
  options: FilterOptions
  showAll: boolean
  q: string
  status: string
  companyId: string
  cashAccountId: string
  eligibility: string
  incomplete: boolean
  /** The validated DATE RELEASED days, or `''`. */
  releasedFrom: string
  releasedTo: string
  /** True on the RELEASED and ALL CHEQUES views — the only views a release date can narrow. */
  showReleasedRange: boolean
  clearHref: string
}) {
  // A RESET control that is always there is furniture, and on an unfiltered
  // screen it invites the user to wonder what it would clear.
  // The status is NOT counted. It is the view, not a filter, and RESET
  // deliberately keeps it: a bar offering RESET on an otherwise untouched
  // SIGNED view would promise to clear something it does not clear.
  const anyFilter = Boolean(q || companyId || cashAccountId || eligibility || incomplete || releasedFrom || releasedTo)

  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    // Keyed on the values in force: React does not re-apply `defaultValue` to a
    // mounted input or select, so RESET (a client-side navigation) must remount
    // the form to clear what the reader had typed.
    <form
      key={`${q}|${status}|${companyId}|${cashAccountId}|${eligibility}|${incomplete}|${releasedFrom}|${releasedTo}`}
      className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline"
      method="get"
    >
      {/* The VIEW survives a search. These hidden fields are the whole
          reason the status dropdown could be removed safely: a GET submit sends
          only the form's own controls, so without them searching inside SIGNED
          would drop `status` and silently throw the user back to NEEDS ACTION.
          `filterHref` reads the same FormData, so the enhanced path carries the
          view for exactly the same reason. */}
      {status && <input type="hidden" name="status" value={status} />}
      {showAll && <input type="hidden" name="scope" value="all" />}
      {/* The NEEDS ACTION list, said out loud. Without it, clearing the search
          and choosing a company would submit `/?company=…`, which since
          2026-09-29 is the TOTALS screen for that company — the reader would
          be thrown off the list they were filtering. `status` and `scope=all`
          already open the list, so the marker is only needed when neither is
          set. See `DashboardSelection.live`. */}
      {!status && !showAll && <input type="hidden" name="scope" value="live" />}

      <label className="sr-only" htmlFor="filter-q">SEARCH</label>
      <input
        id="filter-q" name="q" type="text" defaultValue={q}
        placeholder="SEARCH CHECK NO., APV, PO OR SUPPLIER"
        className={`${field} min-w-[16rem] flex-1`}
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
          the institution but not the account. */}
      <label className="sr-only" htmlFor="filter-cash-account">BANK / CASH ACCOUNT</label>
      <select id="filter-cash-account" name="cashAccount" defaultValue={cashAccountId} className={field}>
        <option value="">ALL BANKS / CASH ACCOUNTS</option>
        {options.cashAccounts.map((a) => (
          <option key={a.id} value={a.id}>{bankLabel(a.code, a.bankCode)}</option>
        ))}
      </select>

      <label className="sr-only" htmlFor="filter-eligibility">ELIGIBILITY</label>
      <select id="filter-eligibility" name="eligibility" defaultValue={eligibility} className={field}>
        <option value="">ALL ELIGIBILITIES</option>
        {ELIGIBILITIES.map((e) => (
          <option key={e} value={e}>{e}</option>
        ))}
      </select>

      {/* DATE RELEASED — only where a released cheque can be. On NEEDS ACTION,
          READY, SIGNED and PENDING the boxes are not rendered at all: a live
          cheque has no release instant, so a range there could only empty the
          table, and the resolver drops the parameters on those views anyway.
          Two plain date inputs: a native GET submit sends them, the enhancement
          submits them on change like the dropdowns, and `filterHref` drops an
          empty one the way it drops an empty search. */}
      {showReleasedRange && (
        <>
          <label htmlFor="filter-released-from" className="whitespace-nowrap text-[11px] font-semibold tracking-widest text-slate-500">
            DATE RELEASED FROM
          </label>
          <input
            id="filter-released-from" name="releasedFrom" type="date" defaultValue={releasedFrom}
            className={field}
          />
          <label htmlFor="filter-released-to" className="whitespace-nowrap text-[11px] font-semibold tracking-widest text-slate-500">
            TO
          </label>
          <input
            id="filter-released-to" name="releasedTo" type="date" defaultValue={releasedTo}
            className={field}
          />
        </>
      )}

      {/* The 129 cheques whose amount the register never recorded. A narrowing
          filter, never a view: incompleteness cuts across every status (50
          SIGNATURE_PENDING, 48 CANCELLED, 25 RELEASED, 6 READY_FOR_RELEASE), so
          it composes with the selected view rather than replacing it.

          UNTICKED NOW MEANS "EXCLUDE THEM", not "do not filter" (client
          decision, 2026-09-06) — the dashboard's counts and its table both leave
          them out, and the page states the number above the table. This checkbox
          is the way back to them, and there is no INCOMPLETE card above it any
          more; that card was removed in the same change. */}
      <label className={`flex items-center gap-2 whitespace-nowrap ${field}`}>
        <input type="checkbox" name="incomplete" value="1" defaultChecked={incomplete} />
        INCOMPLETE ONLY
      </label>

      {/* Present for the no-script path, hidden by FilterAutoSubmit on mount.
          See the note at the top of this file. */}
      <button
        id={APPLY_ID}
        type="submit"
        className="h-10 rounded-lg bg-navy px-4 text-sm font-medium text-white"
      >
        APPLY
      </button>

      {anyFilter && (
        // A link, not a reset button: reset would restore the form's defaults,
        // which ARE the current filters, and appear to do nothing. This goes to
        // an unfiltered URL and keeps only the VIEW the user is reading in.
        <Link
          href={clearHref}
          className="h-10 rounded-lg px-3 py-2 text-sm font-medium text-navy underline underline-offset-2 hover:text-slate-900"
        >
          RESET
        </Link>
      )}

      <FilterAutoSubmit applyButtonId={APPLY_ID} />
    </form>
  )
}
