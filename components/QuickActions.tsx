import { exportHref, printHref, type DashboardSelection } from '@/lib/dashboard-view'
import { VOUCHER_INDEX_HREF } from '@/lib/export/voucher-index'

/**
 * The four things a Finance user does with the list in front of them.
 *
 * Every live action is a plain anchor, not a button with an onClick: the
 * export, the print sheet and the voucher index have to work on a workstation
 * whose JavaScript has failed, the same reasoning as the filter bar and the
 * sign-out form.
 *
 * The first two carry the SAME parameters the dashboard is reading, so the file
 * and the sheet hold exactly the view on screen. THE VOUCHER INDEX DOES NOT,
 * and that is the one thing to notice about this component: it is a lookup
 * table, so it has to cover every voucher rather than the ones that survived a
 * filter. Its label and its `title` both say so, because a file that quietly
 * held more than the screen did would be discovered by someone finding rows
 * they thought they had excluded.
 */
export function QuickActions({ selection }: { selection: DashboardSelection }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* `download` is deliberately absent: the filename is set by the route's
          Content-Disposition, which is the only place that knows the view and
          the date the file was actually generated. */}
      <a
        href={exportHref(selection)}
        className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
      >
        EXPORT EXCEL
      </a>

      <a
        href={printHref(selection)}
        className="rounded-lg bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy ring-1 ring-hairline transition hover:ring-navy"
      >
        PRINT RELEASE LIST
      </a>

      {/**
        * THE VOUCHER INDEX — the file the Finance Executive Report looks into.
        *
        * Unlike the two anchors above it, this one carries NO dashboard
        * parameters, because it is not the view on screen: it is every voucher
        * this system knows, which is what a lookup table has to be. The label
        * says so, rather than leaving a reader to discover it by opening the
        * file and finding rows they had filtered out.
        */}
      <a
        href={VOUCHER_INDEX_HREF}
        title="Every AP voucher and the cheque that pays it. Ignores the filters on this page — a lookup table has to cover everything. Save it where the Finance Executive Report expects to find it."
        className="rounded-lg bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy ring-1 ring-hairline transition hover:ring-navy"
      >
        VOUCHER INDEX (ALL CHEQUES)
      </a>

      {/**
        * UPLOAD READY CHECKS — the Supplier Portal push.
        *
        * DISABLED, and drawn as disabled. Plan 3 stopped after Task 1 at the
        * client's request: the portal needs an `encoder` service account that
        * does not exist yet, so until it does, portal events queue and nothing
        * is pushed.
        *
        * Rendered rather than hidden, and rendered greyed rather than styled
        * like the two beside it. A button that looks live and does nothing is
        * worse than no button on the one screen where a Finance user is deciding
        * whether a supplier has been told their cheque is ready — and a button
        * that is simply absent leaves the reader unable to tell "not built" from
        * "you are not allowed". `title` says which it is, and the text below
        * says it again for anyone who never hovers.
        *
        * `aria-disabled` alongside `disabled` so a screen reader announces the
        * state rather than skipping the control silently.
        */}
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="The Supplier Portal connection is not yet configured. Cheques cannot be pushed to the portal until the encoder service account exists."
        className="cursor-not-allowed rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium tracking-wide text-slate-400 ring-1 ring-hairline"
      >
        UPLOAD READY CHECKS
      </button>
      <span className="text-xs text-slate-400">SUPPLIER PORTAL NOT YET CONNECTED</span>
    </div>
  )
}
