import { exportHref, printHref, type DashboardSelection } from '@/lib/dashboard-view'
import { ExportLink } from '@/components/ExportLink'

/**
 * The three things a Finance user does with the list in front of them.
 *
 * Both live actions are plain anchors, not buttons with an onClick: the export
 * and the print sheet have to work on a workstation whose JavaScript has
 * failed, the same reasoning as the filter bar and the sign-out form. Each
 * carries the SAME parameters the dashboard is reading, so the file and the
 * sheet hold exactly the view on screen.
 *
 * The voucher index is deliberately NOT here. It briefly was, on 2026-09-10,
 * and it did not belong: it ignores every parameter this bar carries, because
 * a lookup extract has to cover every voucher rather than the filtered view.
 * It lives on /vouchers, the screen that explains it, beside its own EXPORT.
 */
/** Shown on a disabled EXPORT EXCEL / PRINT while a filter box is refused. */
const REFUSED_TITLE = 'Fix the filter box marked in red first'

/**
 * A disabled stand-in for a link: an anchor with NO href is neither focusable
 * nor followable, so there is nothing to click into the export's 400 or a
 * print sheet that only states the refusal.
 */
function DisabledAction({ children }: { children: string }) {
  return (
    <a
      aria-disabled="true"
      title={REFUSED_TITLE}
      className="cursor-not-allowed rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium tracking-wide text-slate-400 ring-1 ring-hairline"
    >
      {children}
    </a>
  )
}

export function QuickActions({
  selection,
  refused = false,
}: {
  selection: DashboardSelection
  /** A filter box could not be read: the list shows nothing, so neither link is live. */
  refused?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* `download` is deliberately absent: the filename is set by the route's
          Content-Disposition, which is the only place that knows the view and
          the date the file was actually generated. */}
      {refused ? (
        <DisabledAction>EXPORT EXCEL</DisabledAction>
      ) : (
        <ExportLink
          href={exportHref(selection)}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
        >
          EXPORT EXCEL
        </ExportLink>
      )}

      {refused ? (
        <DisabledAction>PRINT RELEASE LIST</DisabledAction>
      ) : (
        <a
          href={printHref(selection)}
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy ring-1 ring-hairline transition hover:ring-navy"
        >
          PRINT RELEASE LIST
        </a>
      )}

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
