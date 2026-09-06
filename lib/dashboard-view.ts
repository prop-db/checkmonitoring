import type { CheckStatus } from '@prisma/client'
import { LIVE_STATUSES } from './domain/check-status'

/**
 * The dashboard's filtering model, as URL arithmetic.
 *
 * Pure: no database, no DOM, no `window`. Every card on the dashboard is a link
 * to a URL, so what each card does — and which one is lit — is decided here and
 * tested without rendering anything.
 *
 * THE MODEL (client decision, 2026-09-06). The summary cards are not a shortcut
 * to a dropdown; they are the VIEW SELECTOR — which set of cheques you are
 * looking at. The dropdowns on the filter bar then NARROW WITHIN the selected
 * view. There used to be a STATUS dropdown as well as the cards, both writing
 * `?status=`, and a NEEDS ACTION / ALL CHEQUES pair of tabs duplicating TOTAL
 * CHECKS: two controls for one thing, twice over.
 *
 * There are three views and one toggle:
 *
 *   NEEDS ACTION   the default, with no card selected. `LIVE_STATUSES` only.
 *   a status       one rung of the ladder; READY FOR RELEASE folds in SCHEDULED.
 *   ALL CHEQUES    the TOTAL CHECKS card. Every status, and nothing else set.
 *   INCOMPLETE     a toggle that COMPOSES with whichever view is selected.
 *
 * NEEDS ACTION stays the default deliberately. Production holds 9,287 cheques,
 * 7,433 of them RELEASED; opening on everything buries the cheques somebody has
 * to act on today under eight thousand nobody will touch again, and the row
 * limit means the live ones may not even be on the first page. Removing the
 * scope tabs removed the control, not the default — `describeView` exists so
 * the default is stated on screen rather than silently applied.
 *
 * The URL parameters are unchanged (`status`, `scope=all`, `incomplete=1`), so
 * a bookmark saved before this change still opens the view it named.
 */

/** The statuses the READY FOR RELEASE card and view cover. */
const AVAILABLE = ['READY_FOR_RELEASE', 'SCHEDULED'] as const satisfies readonly CheckStatus[]

/**
 * The cards that select a view, plus the one that does not.
 *
 * TOTAL CHECK VALUE is absent: it is not clickable, and giving it an id here
 * would invite a future edit to make it one.
 */
export const VIEW_CARDS = [
  'READY_FOR_RELEASE', 'SIGNATURE_PENDING', 'SIGNED', 'RELEASED', 'TOTAL_CHECKS',
  /**
   * GENERATED has no card of its own and is not meant to get one — the PENDING
   * SIGNATURE card counts it, because to Finance a freshly generated cheque is
   * a cheque waiting to be signed.
   *
   * It is a VIEW nonetheless: the release timeline shows the rung separately,
   * since a node's count has to be the number of rows its link opens and
   * `?status=SIGNATURE_PENDING` opens only the SIGNATURE_PENDING rows. Listing
   * it here means the timeline links through `cardHref` like every card does,
   * rather than concatenating a URL of its own.
   */
  'GENERATED',
] as const satisfies readonly string[]

export type ViewCardId = (typeof VIEW_CARDS)[number]
export type CardId = ViewCardId | 'INCOMPLETE'

/**
 * What the dashboard is currently showing, as the page read it back from the
 * validated URL parameters.
 *
 * `base` holds the filters that are NOT part of the view and that a card must
 * therefore never throw away: the search box, the company and cash-account
 * dropdowns, the eligibility. Before this existed, every card linked to an
 * absolute URL, so narrowing to one company and then clicking SIGNED silently
 * dropped the company and widened the table.
 *
 * `status` is already validated by `parseStatusParam` — an unrecognised value
 * arrives here as null, never as a string this module would pass on.
 */
export type DashboardSelection = {
  status: CheckStatus | null
  showAll: boolean
  incomplete: boolean
  base: Readonly<Record<string, string>>
}

type ViewState = Pick<DashboardSelection, 'status' | 'showAll'>

/**
 * A dashboard URL. `base` first so the narrowing filters keep a stable order,
 * then the view, then the toggle. An empty query string becomes `/` rather than
 * `/?`.
 */
function query(
  base: Readonly<Record<string, string>>,
  view: ViewState & { incomplete: boolean; confirmRelease?: boolean },
): string {
  const qs = new URLSearchParams(base)
  if (view.status) qs.set('status', view.status)
  if (view.showAll) qs.set('scope', 'all')
  if (view.incomplete) qs.set('incomplete', '1')
  // Only ever set by `releaseConfirmHref`. Every other caller omits it, which is
  // how choosing a card or clearing the filters also steps back out of a
  // half-made release rather than carrying the confirmation along.
  if (view.confirmRelease) qs.set('confirm', 'release')
  return qs.toString()
}

function href(
  base: Readonly<Record<string, string>>,
  view: ViewState & { incomplete: boolean; confirmRelease?: boolean },
): string {
  const s = query(base, view)
  return s ? `/?${s}` : '/'
}

/** NEEDS ACTION: the view a deselected card falls back to. */
const NEEDS_ACTION: ViewState = { status: null, showAll: false }

export function isCardSelected(card: CardId, sel: DashboardSelection): boolean {
  if (card === 'INCOMPLETE') return sel.incomplete
  // TOTAL CHECKS is the absence of a status, so it must not light up beside a
  // status card that is also on.
  if (card === 'TOTAL_CHECKS') return sel.showAll && sel.status === null
  return sel.status === card
}

/**
 * Where a card points.
 *
 * A selected view card links back to NEEDS ACTION, so clicking it again turns
 * it off: a filter you can switch on and cannot switch off sends people to the
 * browser's Back button to undo a click they just made.
 *
 * TOTAL CHECKS is the exception on the way in. It is the "show me everything,
 * start again" control, so selecting it drops the search, the dropdowns and the
 * incomplete toggle as well as any status. Every other card carries them along.
 *
 * INCOMPLETE is the exception on both sides: it is a toggle, not a view, so it
 * keeps whichever view is selected in both directions.
 */
export function cardHref(card: CardId, sel: DashboardSelection): string {
  const selected = isCardSelected(card, sel)

  if (card === 'INCOMPLETE') {
    return href(sel.base, { status: sel.status, showAll: sel.showAll, incomplete: !selected })
  }

  if (selected) return href(sel.base, { ...NEEDS_ACTION, incomplete: sel.incomplete })

  if (card === 'TOTAL_CHECKS') return href({}, { status: null, showAll: true, incomplete: false })

  return href(sel.base, { status: card, showAll: false, incomplete: sel.incomplete })
}

/**
 * CLEAR FILTERS on the filter bar: drop everything the bar controls and keep
 * the view being read. It is not a link to `/` — clearing a search should not
 * also throw the user back to a different set of cheques.
 */
export function clearFiltersHref(sel: DashboardSelection): string {
  return href({}, { status: sel.status, showAll: sel.showAll, incomplete: false })
}

/**
 * The anchor TODAY'S RELEASE is rendered under, so stepping into and out of the
 * confirmation returns the reader to the panel rather than to the top of a page
 * they have already scrolled past.
 */
export const TODAYS_RELEASE_ANCHOR = 'todays-release'

/**
 * RELEASE ALL's confirmation step, as a URL.
 *
 * Server-rendered, deliberately. The alternative — a `confirm()` dialog — is a
 * control that exists only once the bundle has loaded, on the one action in the
 * system that hands money over; and the whole page is server-rendered already.
 * The view and the narrowing filters are carried along, so cancelling puts the
 * reader back exactly where they were.
 */
export function releaseConfirmHref(sel: DashboardSelection): string {
  const url = href(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete, confirmRelease: true,
  })
  return `${url}#${TODAYS_RELEASE_ANCHOR}`
}

/** CANCEL: the same view, with the confirmation dropped. */
export function releaseCancelHref(sel: DashboardSelection): string {
  const url = href(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete,
  })
  return `${url}#${TODAYS_RELEASE_ANCHOR}`
}

export const EXPORT_PATH = '/api/export'

/**
 * EXPORT TO EXCEL, as a URL.
 *
 * The SAME parameters the dashboard is reading, so the file holds exactly what
 * is on screen — the view, the search, the dropdowns and the incomplete toggle.
 * Built here rather than in the page for the reason every other link on this
 * screen is: one function decides what a dashboard URL means, and the export
 * cannot drift from the table it claims to be a copy of.
 *
 * `confirm` is deliberately not carried. A half-made release is a state of the
 * screen, not of the data, and it has no business in a filename or a file.
 */
export function exportHref(sel: DashboardSelection): string {
  const s = query(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete,
  })
  return s ? `${EXPORT_PATH}?${s}` : EXPORT_PATH
}

/**
 * The dashboard URL for the selection as it stands — no card toggled, nothing
 * cleared. The way back from a page that was opened FROM the dashboard, so the
 * reader lands on the view they left rather than on `/` or on whatever the
 * Back button happens to hold.
 */
export function dashboardHref(sel: DashboardSelection): string {
  return href(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete,
  })
}

export const PRINT_PATH = '/print'

/**
 * PRINT RELEASE LIST, as a URL.
 *
 * The SAME parameters the dashboard is reading, for the same reason
 * `exportHref` carries them: a sheet somebody prints and walks to the vault
 * with has to hold exactly the cheques that were on screen when they pressed
 * the link. Two parsers that agreed today would drift the first time a filter
 * was added to one of them.
 *
 * `confirm` is not carried, exactly as the export does not carry it: a
 * half-made release is a state of the screen, not of the data, and it has no
 * business on a piece of paper.
 */
export function printHref(sel: DashboardSelection): string {
  const s = query(sel.base, {
    status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete,
  })
  return s ? `${PRINT_PATH}?${s}` : PRINT_PATH
}

/**
 * The status filter the selected view implies, in the shape `CheckFilters`
 * wants. `status` and `statusIn` are both returned so a caller cannot forget
 * one and leave a stale value behind.
 */
export function viewStatusFilter(view: ViewState): {
  status: CheckStatus | undefined
  statusIn: readonly CheckStatus[] | undefined
} {
  /**
   * READY FOR RELEASE means both rungs. To Finance the cheque is available and
   * waiting to be handed over; whether a supplier has booked a pickup slot in
   * the portal is a detail, not a separate queue. The card counts both, and the
   * filter has to agree — a card reading 406 that opens a table of 396 is a bug
   * report waiting to happen.
   */
  if (view.status === 'READY_FOR_RELEASE') return { status: undefined, statusIn: AVAILABLE }
  // An explicit status wins over the NEEDS ACTION default, including RELEASED,
  // which the live list excludes.
  if (view.status) return { status: view.status, statusIn: undefined }
  if (view.showAll) return { status: undefined, statusIn: undefined }
  return { status: undefined, statusIn: LIVE_STATUSES }
}

const words = (s: string) => s.replace(/_/g, ' ')

/**
 * The line above the table: which view is active, in words.
 *
 * The scope tabs used to say this. They are gone, and the default they carried
 * is not — so it is stated here instead of applied silently. The live statuses
 * are read from `LIVE_STATUSES` rather than restated: a ninth live status must
 * not be filtered in while going unmentioned.
 */
export function describeView(sel: DashboardSelection): string {
  const view = sel.status === 'READY_FOR_RELEASE'
    ? 'READY FOR RELEASE — INCLUDING SCHEDULED'
    : sel.status
      ? words(sel.status)
      : sel.showAll
        ? 'ALL CHEQUES — EVERY STATUS, INCLUDING RELEASED, CANCELLED AND VOIDED'
        : `NEEDS ACTION — ${LIVE_STATUSES.map(words).join(', ')}`

  // The toggle is named alongside the view, never instead of it: SIGNED +
  // INCOMPLETE is a narrower set than either, and a reader who sees only one of
  // the two has no way to explain the row count.
  return sel.incomplete ? `${view} + INCOMPLETE (NO AMOUNT)` : view
}
