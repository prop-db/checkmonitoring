# Voucher index export — design

**What it is.** A generated workbook, one row per AP voucher, that answers *"which cheque pays this
payable, and where is it?"* for the Finance Executive Report. It replaces three `VLOOKUP` formulas
that stopped working when the register was retired.

Every number in this document was measured against production on 2026-09-10. Nothing is inferred.

## Why now

`Finance Report/Finance Executive Report as of 9.10.2026.xlsx` is the group's treasury workbook —
25 sheets: `2026 Cash Budget`, `Summary`, `Cash Balance`, `AR`, `AP Pivot` / `AP Local` /
`AP Importation`, `RMB`, `Loans`, `Inventory`. Row 2 of its `AP Local` sheet is **the same 24-column
Acumatica header `lib/import/bills.ts` already reads**, and its last three working columns are:

```
VLOOKUP(C:C, '[7]MBTC P&P RELEASED'!$H:$K,       4, 0)
VLOOKUP(C:C, '[7]STK P&P RELEASED'!$H$93:$Q$474, 4, 0)
VLOOKUP(C:C, '[8]MBTC P&P RELEASED'!$H:$L,       4, 0)
```

`C:C` is `Reference Nbr.` — the AP voucher. `$H` is the register's column 8, `VOUCHER NUMBER`. Those
three externals are **sheets of `CHECK MONITORING <date>.xlsx`**, the workbook the client retired on
2026-09-10 with *"No more updating thru excel."*

So the Executive Report is downstream of a record that has stopped being maintained. The link does
not fail loudly; a `VLOOKUP` to a stale external returns the last cached value and keeps returning it
until somebody notices the cheque numbers have stopped changing. That is the same silent-failure
shape that lost `AP-ST042652`.

This system holds the answer those formulas were reaching for. 9,224 cheques carry an AP voucher in
`Check.apvNumbers`, and the GIN index over that column exists precisely to answer containment.

## What the formulas could actually answer, and what we can answer instead

`AP Local` is the **open** payables ledger — bills still owed. Measured over its 1,472 distinct
vouchers:

| | vouchers | |
| --- | ---: | --- |
| name exactly one cheque here | **986** | 951 live; 35 name only a cancelled or voided cheque |
| name more than one | **54** | 46 resolve to a single **live** cheque plus voided predecessors; 6 name two live cheques; 2 name only dead ones |
| name no cheque here | **432** | 51 of them sit in `StagedCheck` |

Status of the cheques found: 551 `SIGNED` · 233 `READY_FOR_RELEASE` · 223 `SIGNATURE_PENDING` ·
57 `CANCELLED` · 30 `VOIDED` · **2 `RELEASED`**.

**Two.** The formulas looked only into the register's *released* sheets, so on an open payables
ledger they could answer 2 rows out of 1,472. The formula was close to useless before it broke.

What this system answers instead, for **1,032 of the 1,472 (70%)**, is where the cheque sits on the
ladder: a cheque is already cut for this payable and is waiting for a signature, waiting for release,
or was cancelled. For an open payable that is the question being asked. Do not restore the released-
only semantics in the name of matching the old behaviour — the old behaviour was the defect.

## The sheet

**One worksheet, named `INDEX`.** Fixed, like the filename, and for the same reason: it is half of
the external reference the workbook stores.

**Grain: one row per voucher, unique.** Forced by the consumer. Exact-match `VLOOKUP` returns the
first row it finds, so a second row for the same voucher does not raise an error — it answers with
whichever happened to sort first. Every case below therefore collapses to one row, and the resolver
is where the collapsing happens.

| column | |
| --- | --- |
| `VOUCHER` | the key. **Leftmost** — `VLOOKUP` searches the first column of its range and cannot be told otherwise. |
| `CHECK NUMBER` | blank when this system cannot say which cheque; see the case table |
| `BANK` | from `checkBook.bank`, falling back to `cashAccount.bank` |
| `COMPANY` | the company code |
| `STATUS` | the ladder position — the column the old formula had no way to produce |
| `CHECK DATE` | |
| `PAYEE` | `payeeName`, or the vendor's canonical name |
| `RELEASED` | `releasedAt`. **Empty on every row today** — `releasedAt` is null on all 11,923 cheques, because the backfills that set `RELEASED` deliberately wrote no timestamp they could not know. It fills in as Finance releases through the app. An empty column that will populate is honest; a fabricated date is not. |
| `SUPERSEDES` | the cancelled/voided cheque numbers this cheque replaced |
| `REMARKS` | why a cell is blank, in words |

**No amount column.** A cheque can settle several bills, so the cheque's amount is not the
`Detail Total` sitting beside it on `AP Local`, and the two will eventually be subtracted from one
another. This is the same reason `StagedBill` carries no amount: *a bill's `Detail Total` displayed
beside cheque amounts is read as a cheque's figure sooner or later*, and here the hazard runs the
other way round. Client decision, 2026-09-10.

### How each case lands

| case | measured | `CHECK NUMBER` | `REMARKS` |
| --- | ---: | --- | --- |
| one cheque, live | 951 | the number | — |
| one cheque, cancelled or voided | 35 | the number, `STATUS` says which | — |
| re-issue: one live + dead predecessors | 46 | the **live** number, dead ones in `SUPERSEDES` | — |
| contested: two live cheques | 6 | **blank** | both numbers named |
| staged: register knew a number, never resolved to a company | 51 | **blank** | the sheet and row on `/admin/staged` |
| no cheque at all | 381 | *no row* | — |

The 46 re-issues are **not** an ambiguity. One live cheque with voided predecessors has an obvious
right answer, and refusing to give it would throw away 46 answers to protect against 6.

The 6 contested and the 51 staged are refused the same way `bills.ts` refuses `AMBIGUOUS_CHECK`: the
lookup returns nothing rather than the wrong cheque. A staged row *does* carry a cheque number, but
not a company — and therefore not a bank. A number with no bank feeding the workbook's `bank` column
is exactly the guess that staging exists to prevent. It goes in `REMARKS`, where a human reads it,
never in `CHECK NUMBER`, where a formula does.

`#N/A` for the 381 is the correct answer. It means no cheque has been cut for that payable.

### Coverage

**Every voucher this system knows — roughly 10,985 — not just the 1,472 on today's `AP Local`.** The
ledger's contents change every month and a lookup table must not have to be regenerated to match it.

That exceeds `EXPORT_ROW_LIMIT` (10,000), so this export carries **its own cap**:
`VOUCHER_INDEX_ROW_LIMIT = 15_000`. The 10,000 was measured for the register export's row — ten
columns wide including amounts, plus a summary sheet, at 162 MB of heap. This row is narrower and
there is no second sheet, so the same memory budget buys more rows. 15,000 leaves ~37% headroom over
today's ~10,985 and must be **re-measured** the way the original was, not assumed. Like the register
export's cap it is **written into the title block when it bites**, so a short file cannot be mistaken
for a small result.

### Cheques with no recorded amount are excluded

The 129 `isIncomplete` cheques are out, consistent with the ruling of 2026-09-06 and with the
dashboard, the export and the printed sheet.

The cost is 17 vouchers. Measured: 75 distinct vouchers sit on an incomplete cheque, and 58 of those
are also carried by a complete cheque, so they still get a row. Only 17 go from answered to absent,
out of ~10,985. One rule across every output, for a rounding error.

## Architecture

| file | responsibility |
| --- | --- |
| `lib/export/voucher-index.ts` | **Pure.** Candidates in, sheet rows out. Every rule in the case table lives here, plus the cap and the filename. No database, no ExcelJS, no clock — so a test hands it literals. Same split as `lib/export/report.ts`. |
| `lib/export/voucher-query.ts` | One query over `unnest("apvNumbers")` joined to `Check`, plus a pass over `StagedCheck`. Returns **candidates**. Resolves nothing. |
| `lib/export/voucher-workbook.ts` | ExcelJS rendering, beside `workbook.ts`. |
| `app/api/export/vouchers/route.ts` | `getSessionUser()` on the first line. |

The query lives in `lib/export/` rather than in `lib/queries.ts` for two reasons: that file is already 515 lines and serves the dashboard, and a `lib/queries/` directory beside a `lib/queries.ts` module is an import ambiguity waiting to be resolved wrongly. Everything this feature owns changes together, so it lives together.

The pure/rendering split is not stylistic. The decisions worth pinning — which cheque wins a
re-issue, when a cell goes blank, what the cap is — are decisions, and a test that has to open a
spreadsheet to check them is a test nobody runs.

### The route

`middleware.ts` does not run in this project; the manifest is empty after a clean build. A route
handler has **nothing** in front of it, so this one authenticates on its own first line, before it
reads anything at all — and returns **401, not a redirect**, because this is fetched as a download
and a 307 to `/login` arrives as an HTML login page saved under an `.xlsx` filename. `runtime =
'nodejs'` (ExcelJS is Node-only) and `dynamic = 'force-dynamic'`.

It **never writes**. It is a read path, like `/api/export`.

### The fixed filename, and what it costs

`CHECK BY VOUCHER.xlsx`, always. A stable path is what an external `VLOOKUP` needs; a dated filename
would break the link every time the file was regenerated, which is the failure being fixed.

The price is that a stale copy is indistinguishable from a fresh one by name. So the generation
timestamp goes in a **fixed cell, `$A$2`**, and the Executive Report displays it:

```
='…\[CHECK BY VOUCHER.xlsx]INDEX'!$A$2
```

A sheet that states its own age beats a filename nobody reads. Finance saves it to one agreed folder;
a lookup to a moved file fails the same silent way the current one does.

## Testing

- The pure resolver: one case per row of the case table — single live, single dead, re-issue,
  contested, staged, and the incomplete exclusion. Literals in, rows out.
- The workbook: generate to a buffer and read cells back, as `tests/export/workbook.test.ts` does.
  Assert `VOUCHER` is column A, and that `$A$2` holds the timestamp.
- The route: an unauthenticated request never touches the database.
- `npx tsc --noEmit`. The suite cannot substitute for it — Vitest transpiles with esbuild, which
  erases types, and this project has repeatedly had a green suite over unsound types.

Tests run one process at a time against the shared test database.

## Rollout

Three formulas in `AP Local` — the working columns at 23, 24 and 25 — collapse into one lookup
against one sheet. The `bank` column comes from the same row rather than from a third workbook.

## What this is not

It is not a bank reconciliation, a cash position, a hedging report or a foreign outlook. Those were
the four reports asked for on 2026-09-10; this is the one seam of them that is **broken today**.

Measured for the record, so the next person does not re-derive it:

- **Hedging and foreign outlook have no source in this system.** All 11,923 cheques are `PHP`, and
  foreign payables settle by TT or LC — they never become a cheque. Their sources are
  `MANAGER TRAINEE REPORT <date>.xlsx` (`HEDGING SUMMARY`, 1,496 rows; `FOREIGN OUTLOOK`, a weekly
  rate log) and the Executive Report's `AP Importation`. That is the foreign-currency half of the
  same Acumatica AP feed `lib/import/bills.ts` already parses, so it is reachable — but it is a new
  data stream, not a feed of an existing one, and it needs its own spec.
- **Outstanding cheques for the bank rec cannot be computed.** `clearingStatus` is `NONE` on all
  9,594 `RELEASED` cheques and `clearedDate` is null on all 11,923. `recordClearing` exists and has
  never been used. The `OC` column on `Cash Balance` is a workflow change before it is a report.
- **The cash-outflow forecast is buildable now** from `READY_FOR_RELEASE` and `SCHEDULED` with
  `availablePickupDate` / `scheduledPickupDate`, and would feed the daily cash position. It is the
  natural next seam.
