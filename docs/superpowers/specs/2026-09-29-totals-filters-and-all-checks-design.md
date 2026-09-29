# Filters on the TOTALS screen, and ALL CHECKS as the inventory view — design

**Date:** 2026-09-29
**Request:** "should have filter in every summary. And should ALL CHECKS in dashboard, to be
use in checks inventory." Asked which summaries, the user chose **the dashboard cards**; asked
what ALL CHECKS should become, the user chose **a filterable full list**; asked whether
RELEASE ALL should follow the filter, the user chose **yes, narrow it**.
**Status:** approved in conversation, 2026-09-29.

## What is being built

Two changes to the CHECK RELEASE dashboard (`app/page.tsx`).

1. **The TOTALS screen gets a filter bar.** COMPANY, BANK / CASH ACCOUNT and ELIGIBILITY
   dropdowns sit above the cards. Choosing one narrows **every figure on the screen**: the
   six cards, TODAY'S RELEASE and its RELEASE ALL button, the RELEASE WORKFLOW timeline and
   the "excluding N cheques with no recorded amount" line. Today the cards always count the
   whole database and the only way to narrow anything is to open the list first.
2. **TOTAL CHECKS becomes ALL CHECKS, in the primary row, and keeps the filters.** Today it
   is a small secondary card that deliberately clears every filter when clicked. After this
   it is one of five primary cards and carries the company, bank, eligibility and incomplete
   filters into the list like every other card does. "Every cheque STK holds at BPI, any
   status" is one click, and the Excel export and the print sheet, which already read the
   same URL, follow it. That list is the cheque inventory.

Nothing about what a status means, which statuses are live, or how the incomplete cheques
are excluded changes. The rule that a card's number is the number of rows its link opens
(`lib/dashboard-view.ts`) is kept, and extended: a card on a narrowed TOTALS screen links to
the list narrowed the same way.

## The screen rule

`dashboardScreen` in `lib/dashboard-view.ts` decides which of the two screens a URL opens.
Today: a bare `/` is TOTALS and **anything** in the URL is LIST. That has to change, because
`/?company=…` is now the TOTALS for one company.

New rule:

| URL holds                                                  | Screen |
| ---------------------------------------------------------- | ------ |
| nothing                                                    | TOTALS |
| only `company`, `cashAccount`, `eligibility` (any of them) | TOTALS |
| `status=…`                                                 | LIST   |
| `scope=all`                                                | LIST   |
| `scope=live`  (new, below)                                 | LIST   |
| `incomplete=1`                                             | LIST   |
| `q=…`                                                      | LIST   |

`releasedFrom` / `releasedTo` cannot occur without `status=RELEASED` or `scope=all`
(`resolveDashboardQuery` drops them otherwise), so they never decide the screen on their
own. `confirm=release` is a state of TODAY'S RELEASE, not a filter, and is not read here.

### `scope=live`: the NEEDS ACTION list, said out loud

The NEEDS ACTION view (no status, not all) has no card. Today it is reached only by the
search box, and once on it the reader can clear the search and narrow by company, landing on
`/?company=X` — which under the new rule would be the TOTALS for X, not the list. Filtering
inside the list must not bounce the reader back to the totals.

So the LIST screen's filter bar (`components/FilterBar.tsx`) carries a hidden `scope=live`
whenever it is showing the NEEDS ACTION view — exactly as it already carries `status` or
`scope=all` for every other view — and `scope=live` means "the NEEDS ACTION list, as a
list". It changes no filter: `viewStatusFilter` still answers `LIVE_STATUSES` for it, the
export label is still NEEDS ACTION, `describeView` says what it says today.

- `DashboardSelection` gains `live: boolean`, read by `resolveDashboardQuery` from
  `scope === 'live'`.
- `query()` in `lib/dashboard-view.ts` writes `scope=live` only when the view is NEEDS
  ACTION and `live` is set; `status` and `scope=all` win over it, so `?scope=live&status=SIGNED`
  is written back as `?status=SIGNED`.
- A deselected card (`cardHref` on a selected card) goes to the NEEDS ACTION **list**, so it
  writes `scope=live`. `clearFiltersHref`, `exportHref`, `printHref` and `dashboardHref`
  carry it along; the export and print read it harmlessly. `releaseConfirmHref` and
  `releaseCancelHref` never see it, because TODAY'S RELEASE is on the TOTALS screen.
- Any other `scope` value is ignored, as today.

## The TOTALS filter bar

A new component, `components/TotalsFilterBar.tsx`, rendered between the sync line and the
cards. One GET form to `/` with:

- COMPANY — the same options and labels as the list's bar.
- BANK / CASH ACCOUNT — the same options; the label comes from `bankLabel` in
  `lib/export/report.ts` so the two bars and the export cannot spell an account differently.
  `FilterBar.tsx` is changed to call `bankLabel` too, in place of its inline copy of the rule.
- ELIGIBILITY — the same three values.
- APPLY, hidden by `FilterAutoSubmit` when JavaScript is on, exactly as the list's bar does;
  a change submits through `filterHref`, which produces `/?company=…` and so stays on TOTALS.
- RESET — a link to `/`, shown only when a filter is set.

No search box in this form. The existing search form on the TOTALS screen stays a plain
submit, because `FilterAutoSubmit` would navigate to the list after 400 ms of typing and
lose the caret. It gains hidden `company`, `cashAccount` and `eligibility` inputs, so a
search from a narrowed TOTALS opens a list narrowed the same way.

When a filter is set the screen states it, under the bar, using the `filterDescription`
that `resolveDashboardQuery` already builds for the export ("COMPANY STK · BANK BPI-001").
A narrowed screen with no such line would read as the whole company's figures.

The parameters are the ones the list already reads, validated the same way: an id that
names no company or cash account is ignored, never an error, and does not survive into a
card link.

## The queries

`getSummary` and `getTodaysRelease` in `lib/queries.ts` today take only `db`. Both gain a
second parameter:

```ts
export type SummaryNarrowing = Pick<CheckFilters, 'companyId' | 'cashAccountId' | 'eligibility'>
export async function getSummary(db: Db, narrow: SummaryNarrowing = {})
export async function getTodaysRelease(db: Db, narrow: SummaryNarrowing = {})
export async function listTodaysReleaseIds(db: Db, narrow: SummaryNarrowing = {})
```

- `getSummary` applies the narrowing to all four of its queries — the status grouping, the
  currency totals, the total count and the incomplete count — so every card, the timeline
  and the disclosure line are struck over the same population. `COMPLETE_ONLY` and the
  `status != CANCELLED` rule on the value total stay exactly as they are.
- `getTodaysRelease` and `listTodaysReleaseIds` spread the narrowing over
  `TODAYS_RELEASE_FILTER` before `buildWhere`, so the panel and the set RELEASE ALL acts on
  are one filter, as they are today.
- The page passes `filters.companyId`, `filters.cashAccountId` and `filters.eligibility` from
  `resolveDashboardQuery`. The default `{}` keeps every existing caller and test unchanged.

## RELEASE ALL follows the filter

The panel on a narrowed screen counts one company's or one bank's ready cheques, and the
button beneath it must release exactly those. A button reading RELEASE ALL 12 that releases
81 is the mismatch this dashboard exists to prevent, and it is money.

- `ReleaseAllConfirm` receives the three narrowing values as strings (the validated ids the
  page already holds) and writes them as hidden inputs `company`, `cashAccount`,
  `eligibility`, beside `confirm` and `expectedCount`.
- `releaseAllReadyAction` in `app/checks/bulk-actions.ts` reads them, validates them with
  `parseOptionId` against `getFilterOptions(prisma)` and `parseEligibilityParam`, and passes
  the result to `listTodaysReleaseIds`.
- **A value that is present but not recognised refuses the release** with a message to
  reopen TODAY'S RELEASE, rather than being dropped. Dropping it would silently widen the set
  from one company to all of them — the one failure this step must not have. An absent
  value means no narrowing, which is the unfiltered screen and today's behaviour.
- The existing `expectedCount` check is unchanged and still refuses if more cheques are
  ready than were on screen.

Nothing else about the release path changes: `markReleased` per cheque, the outcome list,
the audit rows.

## ALL CHECKS

In `components/SummaryCards.tsx`:

- The primary grid becomes five across at `xl` (`xl:grid-cols-5`): READY FOR RELEASE, SIGNED,
  PENDING SIGNATURE, ALL CHECKS, TOTAL VALUE. ALL CHECKS is a `PrimaryCard` with its own
  inline icon (a small grid), value `summary.total`, support line "EVERY STATUS · INCLUDING
  RELEASED, CANCELLED AND VOIDED". The secondary row keeps RELEASED alone.
- The card id stays `TOTAL_CHECKS` and the parameter stays `scope=all`, so every bookmark,
  test and export label that names them is untouched; only the label on screen changes.
- `cardHref('TOTAL_CHECKS', sel)` becomes `href(sel.base, { status: null, showAll: true,
  incomplete: sel.incomplete })` — the same shape as a status card. The "show me everything,
  start again" behaviour is gone; RESET on either bar is the way to clear filters. Clicking
  the lit card still returns to NEEDS ACTION.
- `describeView` and `exportViewLabel` keep saying ALL CHEQUES. The screen already mixes the
  two spellings (CHECK RELEASE, CHEQUES) and renaming the export label would change the file
  header for no gain.

The list the card opens is the existing LIST screen with the existing row limit; the
inventory of 11,870 cheques is the export, which carries the same filters.

## Tests

Pure, in `tests/dashboard-view.test.ts`:

- `dashboardScreen`: company, cash account and eligibility alone open TOTALS; `live`, a
  search, a status, all cheques and the incomplete toggle open the LIST.
- TOTAL CHECKS carries the search, dropdowns and incomplete toggle, and no longer clears them.
- A deselected card writes `scope=live`; `clearFiltersHref`, `exportHref`, `dashboardHref` and
  `printHref` carry it; `status` and `scope=all` win over it.

`tests/export/dashboard-params.test.ts`: `scope=live` sets `selection.live` and nothing else;
`scope=all` does not set it; the status filter for `scope=live` is `LIVE_STATUSES`.

`tests/dashboard-links.test.ts`: `filterHref` passes a hidden `scope=live` through unchanged.

Database, in `tests/queries.test.ts`: `getSummary` narrowed by company, by cash account and by
eligibility — every count, the value total and the incomplete count — and unchanged with
`{}`; `getTodaysRelease` and `listTodaysReleaseIds` narrowed the same way.

Action, in `tests/actions/bulk-actions.test.ts`: RELEASE ALL with `company` releases that
company's ready cheques and no other; with an unrecognised `company` it refuses and releases
nothing; with none it behaves as today.

## Out of scope

- Filters on the FORECAST, RECON and VOUCHERS summaries (the second option offered; not
  chosen).
- A per-bank breakdown table on the ALL CHECKS view (the third option; not chosen).
- Any change to the row limit, the export, the print sheet or `describeView`.
