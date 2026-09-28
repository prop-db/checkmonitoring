# Stated release date from the register — design

**Date:** 2026-09-28
**Request:** With the DATE RELEASED filter set to 24–25 September the dashboard showed one
cheque. The user asked why no cheque released on 25 September appeared, was told the 228
pick-ups that day were moved by the register catch-up with no timestamp, and ruled:
**"it should have the date stated in the summary."** Asked where the stated date should
live, the user chose its own column, filled from the register, over writing it into the
app's own timestamp.
**Status:** approved in conversation, 2026-09-28. Follows
`2026-09-28-released-date-filter-design.md`.

## What is being built

1. A new nullable column on `Check`, `statedReleaseDate`: the day the retired register's
   DATE RELEASED column states, for a cheque that was released outside this app.
2. A one-off script that fills it from the RELEASED sheets of a register file, under the
   same matching rules the two catch-ups used, with a dry run, a snapshot and one audit row
   per cheque.
3. The DATE RELEASED filter matches a cheque when **either** its app timestamp or its
   stated date falls in the range; the NOT MATCHED disclosure counts cheques with neither.
4. The table's DATE RELEASED column shows the app timestamp when there is one, otherwise
   the stated date with a REGISTER tag.

## What is deliberately kept apart

`releasedAt` keeps its one meaning: the instant `markReleased` in `lib/domain/actions.ts`
recorded a release through this system. Nothing here writes it. `lib/recon/outstanding.ts`
reads it as "the app recorded the release" and goes on doing so; the outstanding-cheques
report is not touched by this change.

`statedReleaseDate` means "the register states this day". It is evidence Finance typed by
hand into a spreadsheet, and the same register's amounts and companies were measured wrong
at scale (CLAUDE.md), so the two dates are stored apart, shown apart, and never one
written into the other. This is the ruling in CLAUDE.md ("a fabricated timestamp on a
release record is worse than none") kept intact, with the stated day given a home of its
own rather than smuggled into the timestamp.

## Schema

```prisma
  releasedById       String?
  releasedAt         DateTime?
  // The day the retired register's DATE RELEASED column states, for a cheque
  // released outside this app (2026-09-28). Filled once by
  // scripts/backfill-stated-release-dates.ts from a register file; never by
  // the import, never by markReleased, never a substitute for releasedAt.
  statedReleaseDate  DateTime?
```

plus `@@index([statedReleaseDate])` beside the existing `@@index([checkDate])`.

Migration `20260928000100_check_stated_release_date`:

```sql
ALTER TABLE "Check" ADD COLUMN "statedReleaseDate" TIMESTAMP(3);
CREATE INDEX "Check_statedReleaseDate_idx" ON "Check"("statedReleaseDate");
```

It must reach the TEST database before the suite runs (`node scripts/migrate.mjs test`)
and PRODUCTION before the deploy (`node scripts/migrate.mjs prod --confirm`, the user's
action).

**Stored as the day's UTC midnight** — `2026-09-25` becomes `2026-09-25T00:00:00.000Z` —
the same convention `checkDate` follows from the register's Excel serials. That instant is
08:00 on the 25th in Manila, so it falls inside the Manila-day bounds the filter builds
(`2026-09-24T16:00Z` to `2026-09-25T15:59:59.999Z`) and renders as the 25th whether the
server clock is UTC or Manila.

## Import classification

`statedReleaseDate` is added to `NEVER_WRITTEN_BY_IMPORT` in
`tests/import/upsert.test.ts`, beside `expectedOutflowDate`, with the comment
"the register's stated day, written only by the stated-release-dates backfill". The
exhaustiveness test would otherwise fail on the new column. It is not in
`IMMUTABLE_ON_UPDATE` because the import does not set it on create either.

## The backfill

`lib/admin/stated-release-dates.ts` (pure reading and judging; database only in the plan
and apply functions, like `register-releases.ts`) and
`scripts/backfill-stated-release-dates.ts "<register>.xlsx" [--apply]`.

**Reading.** `readRegisterReleases` from `lib/admin/register-releases.ts` is reused
unchanged: it already yields, per released cheque number, its company codes and every
RELEASED-sheet row with `dateReleased` as `YYYY-MM-DD` when the cell was a date, verbatim
text otherwise, null when blank. From that, per cheque:

| Rows' `dateReleased`                        | Outcome                                    |
| ------------------------------------------- | ------------------------------------------ |
| exactly one distinct `YYYY-MM-DD` (text and nulls ignored) | that day is the stated date |
| two or more distinct `YYYY-MM-DD`           | `CONFLICTING_DATES`, left, listed          |
| no `YYYY-MM-DD` at all                      | `NO_USABLE_DATE`, left, counted; verbatim texts listed |

A value is a day in exactly two spellings (`asDay`): `YYYY-MM-DD`, which is how the
reader renders an Excel date cell, and `MM/DD/YYYY` typed as text. **The second was added
after measuring the 9.25 register** (2026-09-28): 222 of the 228 rows it dates 25
September hold the text `09/25/2026`, and month/day/year is the only order a Finance
workstation here shows or types, so reading it is not a guess. `isIsoDay` validates the
result either way. No other text is read.

**A stated day outside a plausible window is refused, and the whole cheque with it**: the
window is `2015-01-01` to the Manila day the script runs (the same file states
`2081-05-08` on one row). The cheque is `NO_USABLE_DATE` and listed with what was typed,
rather than the bad value being dropped so another row's day could win.

**Matching.** The cheque number is the identity and the register's company only breaks a
tie — the same rule `judge` in `register-releases.ts` applies and for the same measured
reason (1,690 of the register's released numbers sit under a company Acumatica
contradicts). Then:

| Cheque here                                   | Outcome                              |
| --------------------------------------------- | ------------------------------------ |
| none                                          | `NOT_IN_SYSTEM`, counted             |
| more than one after the tie-break             | `AMBIGUOUS`, counted                 |
| not `RELEASED`                                | `NOT_RELEASED_HERE`, counted, listed |
| `statedReleaseDate` already equal to the day  | `ALREADY_STATED`, counted, skipped   |
| `statedReleaseDate` set to a different day    | `DIFFERENT_DATE_STATED`, left, listed |
| `RELEASED`, column null                       | `WRITE`                              |

A cheque that also carries `releasedAt` still gets its stated date written: the register
had a row for it, the day is a fact about the register, and the table prefers the app
timestamp anyway.

**Writing.** Dry run by default; prints counts and cheque numbers only, never a payee or
an amount. `--apply` writes `snapshots/stated-release-dates-<ts>.json` holding every
cheque about to change (id, cheque number, company, status, `statedReleaseDate` before)
and then, per cheque in its own transaction with the 30-second `TX_OPTIONS`:

- `updateMany({ where: { id, status: 'RELEASED', statedReleaseDate: null }, data: { statedReleaseDate } })`;
  a count of 0 means somebody moved it since the plan, and it is skipped and counted as
  `raced`.
- one SYSTEM audit row, action `stated_release_date_from_register`, details
  `{ file, statedReleaseDate: 'YYYY-MM-DD', registerRows: [{ sheet, row, dateReleased }] }`,
  remarks naming the file and sheet rows and stating that only the stated date was
  written and that `releasedAt` is untouched.

Nothing else is written. Idempotent: a second run over the same file finds every cheque
`ALREADY_STATED`.

## Query

`CheckFilters` (`lib/queries.ts`):

- `releasedFrom` / `releasedTo` keep their names and their Manila-bound semantics. In
  `buildWhere` the clause becomes, when either bound is set:
  ```ts
  where.AND = [
    ...(where.AND as Prisma.CheckWhereInput[] ?? []),
    { OR: [
      { releasedAt: { gte: filters.releasedFrom, lte: filters.releasedTo } },
      { statedReleaseDate: { gte: filters.releasedFrom, lte: filters.releasedTo } },
    ] },
  ]
  ```
  under `AND`, not on `where.OR`, because the search already owns `where.OR` and a second
  `OR` at the top level would replace it.
- `releasedAtIsNull?: true` is **renamed `noReleaseDate?: true`** and now means
  `releasedAt: null AND statedReleaseDate: null`. It was added earlier the same day and has
  one caller (`app/page.tsx`) and one test; the rename keeps the name honest.
- `CheckTableRow` and `toTableRow` gain `statedReleaseDate: Date | null`.

## Dashboard

`app/page.tsx`: the disclosure count uses `noReleaseDate: true`, and the line reads

> NOT MATCHED: {count} RELEASED CHEQUE(S) CARRY NO RELEASE DATE — neither recorded here
> nor stated in the register. Only a cheque with one of those dates can fall inside a
> range.

The resolver, the bar, the export route and the print sheet need no change: the
parameters, the bounds and the title-block description are the same.

## Table

`components/CheckTable.tsx`, the DATE RELEASED cell:

```tsx
{shows('releasedAt') && (
  <td className="px-4 py-3 text-slate-600">
    {r.releasedAt
      ? fmtDate(r.releasedAt)
      : r.statedReleaseDate
        ? <>{fmtDate(r.statedReleaseDate)}<span className="ml-1 text-[10px] font-semibold tracking-widest text-slate-400">REGISTER</span></>
        : '—'}
  </td>
)}
```

The column key stays `releasedAt` and the label stays DATE RELEASED; a saved column
preference is unaffected.

## Out of scope

- No column in the Excel export or the print sheet, as in the previous spec.
- No change to `/recon`, `/forecast`, the cards, TODAY'S RELEASE or the timeline.
- No automatic re-run: the script is a catch-up over a file the user names, and the
  register is retired.
- No parsing of text dates like "SEPT 22" or "CLEARED" into days. They are listed for a
  human. `MM/DD/YYYY` is the one text form read — see "The backfill".

## Tests

| File                                          | Cases                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/admin/stated-release-dates.test.ts`    | reading: one day, conflicting days, text-only, blank; judging: each verdict in the matching table; plan against the test database; apply writes the column, the audit row and nothing else, snapshot shape, idempotent second run, raced update skipped. |
| `tests/queries.test.ts`                       | range matches a stated date; a cheque with both dates matches on either; `noReleaseDate` counts only cheques with neither; `toTableRow` carries `statedReleaseDate`; the range still composes with a search (the `AND` wrapping). |
| `tests/import/upsert.test.ts`                 | the exhaustiveness list gains the column (existing test).                                                                                                          |

`node scripts/migrate.mjs test` before any of these; `npx tsc --noEmit` before claiming done.

## Files

- `prisma/schema.prisma`, `prisma/migrations/20260928000100_check_stated_release_date/migration.sql`
- `lib/admin/stated-release-dates.ts` (new), `scripts/backfill-stated-release-dates.ts` (new)
- `lib/queries.ts`, `app/page.tsx`, `components/CheckTable.tsx`
- `tests/import/upsert.test.ts`, `tests/queries.test.ts`, `tests/admin/stated-release-dates.test.ts` (new)
- `CLAUDE.md`: the DATE RELEASED note and the commands list.
