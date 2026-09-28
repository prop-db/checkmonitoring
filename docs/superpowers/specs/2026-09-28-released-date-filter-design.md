# DATE RELEASED filter on CHECK RELEASE — design

**Date:** 2026-09-28
**Request:** "for the check release, it should have filter date." Asked which date, the
user chose **the date released** over the cheque date.
**Status:** approved in conversation, 2026-09-28.

## What is being built

The CHECK RELEASE dashboard's filter bar gains a DATE RELEASED range: a FROM box and a
TO box. The range narrows the list, its count, the Excel export and the print sheet to
cheques whose release was recorded on a day inside it. The bar shows the two boxes only
when the reader is looking at released cheques — the RELEASED view or ALL CHEQUES —
because a live cheque has no release date and a range on any other view could only
empty the table.

## What the filter reads, and why history is mostly blank

The range is applied to `Check.releasedAt`, the instant `markReleased` in
`lib/domain/actions.ts` wrote when Finance released the cheque through this app. That
column is the only release timestamp the system holds.

It is **null on every release that did not go through the app**: the 9,594 cheques the
9 September register load imported at RELEASED, the 940 the first register catch-up
moved (2026-09-24) and the 240 the second moved (2026-09-26). That is deliberate and is
not changed here. CLAUDE.md records the rule — a timestamp fabricated from a spreadsheet
on a release record is worse than none — and the register's DATE RELEASED survives only
verbatim inside the catch-ups' audit rows, which is where a reader who needs it should
look.

So the filter answers "what did we hand over between these dates, as recorded here" and
nothing older. The page must say so with a count, the way it already discloses the
cheques with no amount, rather than let an empty or short table read as the whole
picture.

## URL

Two parameters, read by `resolveDashboardQuery` in `lib/dashboard-params.ts` and
therefore by the page, `/api/export` and `/print` alike:

| Parameter      | Value        | Meaning                                              |
| -------------- | ------------ | ---------------------------------------------------- |
| `releasedFrom` | `YYYY-MM-DD` | First Manila day of the range, inclusive. Optional. |
| `releasedTo`   | `YYYY-MM-DD` | Last Manila day of the range, inclusive. Optional.  |

Rules, each matching how every other parameter on this URL already behaves:

- A value that is not a real calendar day (`isIsoDay` in `lib/domain/details.ts`) is
  **ignored**: it filters nothing, and it does not survive into a card link or the
  export URL. Never an error page.
- Either box may be given alone: FROM alone is "on or after", TO alone is "on or
  before".
- The range is honoured **only when the view is RELEASED (`status=RELEASED`) or ALL
  CHEQUES (`scope=all`)**. On any other view the two parameters are dropped exactly as
  an unrecognised company id is: not applied, not carried into `selection.base`, not
  named in the filter description. A bookmark of `?status=SIGNED&releasedFrom=…` opens
  the SIGNED view unfiltered.
- FROM later than TO is **not swapped**. It matches nothing, and the filter description
  states the range as given; the table's empty state is the honest result of the
  question asked.

Days are **Manila calendar days**. FROM becomes the day's first instant and TO its last
through `manilaDayStart` / `manilaDayEnd` in `lib/audit-view.ts`, which the audit screen
already uses for the same purpose. A cheque released at 07:00 on the 25th is on the
25th, not on the 24th's UTC evening.

## Query

`CheckFilters` in `lib/queries.ts` gains:

```ts
releasedFrom?: Date   // inclusive lower bound on releasedAt
releasedTo?: Date     // inclusive upper bound on releasedAt
```

`buildWhere` applies them as `releasedAt: { gte, lte }` when either is set. A row with
`releasedAt` null never matches a bound, which is the right reading and needs no extra
clause. The existing `from` / `to` fields on `checkDate` are left exactly as they are;
nothing on the dashboard has ever set them and nothing here starts to.

`listChecks`, `countChecks`, the export route and the print page need no change of
their own: they already receive `query.filters` from the one resolver.

Because a release-date range only ever narrows RELEASED cheques, `getSummary` — the
cards — is untouched. The cards are counts of the whole register and never followed the
filter bar.

## Resolver

`resolveDashboardQuery`:

1. Reads `releasedFrom` / `releasedTo`, keeps each only if `isIsoDay` accepts it.
2. Decides whether the view admits the range: `status === 'RELEASED' || showAll`.
3. When it does, converts each kept day to its Manila bound and sets
   `filters.releasedFrom` / `filters.releasedTo`; adds the raw day strings to
   `selection.base` so card links, RESET-preserving links, export and print carry them.
4. When it does not, sets neither, and the two never enter `base`.

`DashboardQuery` gains `releasedFrom: string` and `releasedTo: string` (the validated
days, or `''`) for the bar to render back, alongside `q`.

`DashboardSearchParams` gains the two optional string keys.

## Filter description

`describeFilters` in `lib/export/report.ts` gains `releasedFrom?: string | null` and
`releasedTo?: string | null` (the days as typed) and emits one part, placed after
SEARCH and before the incomplete clause:

| Given                    | Line                                        |
| ------------------------ | ------------------------------------------- |
| both                     | `DATE RELEASED: 2026-09-01 TO 2026-09-15`   |
| FROM only                | `DATE RELEASED: FROM 2026-09-01`            |
| TO only                  | `DATE RELEASED: TO 2026-09-15`              |
| neither                  | nothing                                     |

This reaches the export's title block and the print sheet's header with no further
wiring, because both already print `filterDescription`.

## Filter bar

`components/FilterBar.tsx` takes `releasedFrom`, `releasedTo` and a boolean
`showReleasedRange` (true for RELEASED or ALL CHEQUES). When shown, two native
`<input type="date">` controls named `releasedFrom` and `releasedTo`, labelled
DATE RELEASED FROM / TO, sit between ELIGIBILITY and INCOMPLETE ONLY. They are ordinary
form controls: a native GET submit sends them, `FilterAutoSubmit` submits them on
change through the same `filterHref` as the dropdowns, and `filterHref` needs no change
because an empty date input is the empty string it already drops.

`anyFilter` counts them, so RESET appears when only a date is set. RESET already goes
to a URL with an empty `base`, which clears them.

The dashboard's card links are built from `selection.base`, so a reader in RELEASED
with a range who clicks SIGNED arrives in SIGNED with the range gone (the resolver
dropped it), and clicking RELEASED again arrives without it. That is the same
"dropped everywhere at once" behaviour every other invalid-for-this-view parameter has,
and it is what keeps a filter switchable off.

## Disclosure

When a range is in force, the LIST screen states, above the table and in the same style
as the no-amount disclosure:

> NOT MATCHED: {count} RELEASED CHEQUES CARRY NO RELEASE DATE — released before this
> system recorded releases, or moved from the register. Only releases recorded here can
> fall inside a date range.

The count is `countChecks` over the same filters with the range removed and
`status: 'RELEASED'` plus `releasedAt: null` applied. To keep it in the one query path,
`CheckFilters` gains `releasedAtIsNull?: true`, which `buildWhere` turns into
`releasedAt: null`; the page builds that filter from `query.filters` by dropping the two
bounds and adding the flag. It is narrowed by company, bank, eligibility, search and the
incomplete tri-state exactly as the table is, so the number is the number of rows the
reader's own view would have shown had they carried a date. When the count is zero the
line is not rendered.

The line appears on the dashboard only. The export's title block carries the range;
adding the undated count to the workbook is not part of this change.

## Table column

`lib/table-columns.ts` gains the key `releasedAt`, labelled `DATE RELEASED`, ordered
after `scheduledPickupDate` and before `action`. `CheckTableRow` and `toTableRow` in
`lib/queries.ts` carry `releasedAt: Date | null`; `components/CheckTable.tsx` renders it
through the existing `fmtDate`, an em dash when null.

A viewer who saved a column preference before this change will not see the new column
until they tick it: `normaliseColumns` keeps the stored keys plus the always-on ones and
adds nothing else. That is the existing contract and is left alone; the default set for
a fresh browser is every column, which now includes it.

Neither the Excel export nor the print sheet gains a DATE RELEASED column in this
change. Both already name the range in their title blocks; adding a column to the
workbook moves every cell index in `lib/export/workbook.ts` and is a separate decision.

## Out of scope, stated so nobody infers it

- No backfill of `releasedAt` from the register's DATE RELEASED. The rule against a
  fabricated release timestamp stands.
- No change to the cheque-date `from` / `to` filter fields, which stay unused.
- No date range on the TOTALS screen; the bar lives on LIST.
- No change to the cards, TODAY'S RELEASE, the timeline, `/recon` or `/forecast`.

## Tests

| File                                  | Cases                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/export/dashboard-params.test.ts` | both days on RELEASED become Manila bounds and enter `base`; FROM alone; TO alone; malformed day ignored; on SIGNED / NEEDS ACTION / READY the range is dropped from filters, `base` and description; on `scope=all` it applies; FROM after TO is kept as given. |
| `tests/queries.test.ts`               | `listChecks` / `countChecks` with a released range return only cheques whose `releasedAt` is inside it; a RELEASED cheque with null `releasedAt` is excluded; `releasedAtIsNull` counts exactly those; `toTableRow` carries `releasedAt`. |
| `tests/export/report.test.ts`         | the three `describeFilters` spellings, its position in the joined line, blank values ignored.                                                                                                                  |
| `tests/dashboard-links.test.ts`       | a card link built from a `base` holding the two days carries them; `filterHref` drops an empty date box.                                                                                                       |
| `tests/table-columns.test.ts`         | the new key is labelled, in canonical order, and a stored preference without it stays without it.                                                                                                             |

`npx tsc --noEmit` before claiming done. Only the touched test files are run — the
full suite is a twenty-minute network tax and is run before a merge.

## Files

- `lib/queries.ts` — `CheckFilters` (+3 fields), `buildWhere`, `CheckTableRow`, `toTableRow`.
- `lib/dashboard-params.ts` — parse, gate on view, Manila bounds, `base`, description.
- `lib/export/report.ts` — `FilterDescription` (+2), `describeFilters`.
- `lib/table-columns.ts` — `releasedAt` column.
- `components/FilterBar.tsx` — the two date inputs and the `anyFilter` count.
- `components/CheckTable.tsx` — the column.
- `app/page.tsx` — pass the new props; the undated-releases disclosure and its count.
- `app/api/export/route.ts` — read the two parameters into the resolver.
- No migration. `releasedAt` exists and has no index; a filter on it
  scans RELEASED rows, of which there are about 11,000, and that is acceptable at this
  size. Add an index later if the query shows on Neon's slow log, not before.
