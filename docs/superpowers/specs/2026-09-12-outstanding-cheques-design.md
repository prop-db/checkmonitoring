# Outstanding cheques — design

**What it is.** `/recon` and its extract: for a date, every cash account's outstanding cheques —
released and not yet cleared — as a count and a total, and the list behind each. It is the OC
column of Finance's own `Cash Balance` sheet, computed from what this system now records.

Sub-project 4 of the "manageable reports" programme, re-scoped 2026-09-12: no bank statement
export has been supplied, so the statement importer waits; the report is built on the clearing
Finance records on the cheque page and on `/clearing`. Client decisions: build the report now;
**as-of date, defaulting to today**.

## Why

The `Cash Balance` sheet in the Finance Executive Report (measured 2026-09-12: 20 account rows;
columns cash inflow, cash outflow, RECON, Variance, BANK, CURRENCY, DIT, OC, RATE, PESO EQUIVALENT)
is Finance's bank reconciliation. Its OC figure — outstanding cheques per account — was typed from
the register, which is retired. This system knows every released cheque and, since 2026-09-11,
which have cleared. The figure is derivable; nothing derives it.

## A. The rule — `lib/recon/outstanding.ts`, pure

```ts
export type OutstandingInput = {
  status: CheckStatus; releasedAt: Date | null; checkDate: Date | null
  clearingStatus: ClearingStatus; clearedDate: Date | null; amount: string | null
}
export type IssueBasis = 'RELEASED AT' | 'CHEQUE DATE'
export function issuedOn(input): { day: string; basis: IssueBasis } | null
export function isOutstandingAsOf(input, asOfDay: string): boolean
```

A cheque is outstanding as of a Manila calendar day when **all** of:

1. `status === 'RELEASED'`. Cancelled and voided are never outstanding; a live cheque has not left.
2. It was **issued on or before the day**: `releasedAt`'s Manila day when recorded; else `checkDate`'s
   day (the 9,594 released before the app recorded a release carry no `releasedAt` — measured
   2026-09-11 — and a cheque's date is the day from which it can be presented). A released cheque
   with neither date is issued "always" and is outstanding on any day.
3. It had **not cleared by the day**: `clearingStatus !== 'CLEARED'`, or `clearedDate` is after the
   day. `CLEARED` with no `clearedDate` is treated as cleared on every day — nobody recorded when,
   and counting it outstanding would overstate the OC figure for ever.
4. `amount` is recorded — the standing rule since 2026-09-06; the exclusion and its count are
   stated on screen.

DEPOSITED and ENCASHED are outstanding: the bank has not paid.

## B. The read — `lib/recon/query.ts`

`listOutstandingCandidates(db, { asOf, bankCode?, companyId?, cashAccountId? })`: `status
RELEASED`, `isCheque`, `isIncomplete false`, the filters through the cash account, ordered by cash
account code then cheque date; returns rows in `OutstandingRow` shape (id, checkNumber, payee,
cashAccount {id, code}, bank, company, currency, amount as a decimal string, checkDate, releasedAt,
clearingStatus, clearedDate). The as-of test runs in the pure layer over these rows, so the page
and the extract cannot disagree. `countExcludedIncomplete(db, filters)` under the same population.
`listCashAccounts(db)` for the account table: code, bank code, company code, in bank-then-code
order (the sheet's order).

`lib/recon/summary.ts`, pure: `summariseByAccount(rows, asOfDay)` → one line per cash account
present (count, totals by currency via `toCentavos`/`fromCentavos`) plus totals by currency; and
`bucketed` rows with `daysOutstanding` (from the issue day to the as-of day) and `basis`.

## C. The page — `app/recon/page.tsx`

Any Finance user. Controls: AS OF (date, default `manilaDay(now)`), BANK, COMPANY; RESET. The
premise, stated once: *Outstanding means released and not yet cleared by the bank as of the date.
Where no release date was recorded, the cheque date stands in. Record clearing on the cheque or
on /clearing to move a cheque off this list.*

The account table: ACCOUNT · BANK · COMPANY · CURRENCY · OUTSTANDING (count) · AMOUNT, one row per
account with at least one outstanding cheque, a TOTAL row per currency. A released cheque with no
cash account (the register did not always name one) is grouped under `(NO ACCOUNT)`, with its bank
from the checkbook when it has one — never dropped, since a dropped cheque is an understated OC. Each account links to
`/recon?asOf=…&account=<id>`, which adds the cheque list below the table: CHECK NUMBER (linked) ·
PAYEE · CHEQUE DATE · ISSUED (the date, and `from register` when the basis is the cheque date) ·
DAYS · AMOUNT · CLEARING. The count line: `N CHEQUES OUTSTANDING AS OF <day> · <filters>`, with
the incomplete exclusion below it as on the forecast. A RECON link in `AppHeader`; EXPORT EXCEL
beside the count.

## D. The extract — `/api/export/recon`

Guarded as the forecast route is (`getSessionUser`, 401). SUMMARY: title `OUTSTANDING CHEQUES AS
OF <day>`, the filters, the premise sentence, the account table with a TOTAL per currency.
DETAIL: CHECK NUMBER · PAYEE · ACCOUNT · BANK · COMPANY · CHEQUE DATE · ISSUED · ISSUE BASIS ·
DAYS OUTSTANDING · CLEARING · CURRENCY · AMOUNT, capped at `caps.exportRows` with the cap stated.
Filename `outstanding-cheques-<as-of day>.xlsx`.

## Plumbing

| file | responsibility |
| --- | --- |
| `lib/recon/outstanding.ts` | **Pure.** `issuedOn`, `isOutstandingAsOf` |
| `lib/recon/summary.ts` | **Pure.** `summariseByAccount`, `daysOutstanding` |
| `lib/recon/query.ts` | `listOutstandingCandidates`, `countExcludedIncomplete`, `listCashAccounts` |
| `lib/recon-view.ts` | **Pure.** `RECON_PATH`, `RECON_EXPORT_PATH`, `parseAsOf` (a valid day or today), `reconHref`, `describeReconFilters`, `reconFilename` |
| `lib/export/recon-workbook.ts` | ExcelJS |
| `components/ReconTable.tsx`, `components/OutstandingList.tsx` | server components |
| `app/recon/page.tsx`, `app/api/export/recon/route.ts`, `components/AppHeader.tsx` | the page, the route, the link |
| `CLAUDE.md` | item 10's closing sentence: bank reconciliation's cheque side is buildable and built |

No migration. No writes.

## Testing

`tests/recon/outstanding.test.ts` (every clause of the rule, both bases, the no-date cases, the
CLEARED-without-date case, boundary days), `tests/recon/summary.test.ts` (centavo totals, per
currency, account order, days), `tests/recon/query.test.ts` (population and filters against the
database), `tests/recon-view.test.ts`, `tests/export/recon-workbook.test.ts`,
`tests/export/recon-route.test.ts` (401, no DB touch, filename). `tsc`; `next build`.

## Not in this design

- **Deposits in transit, book and bank balances, the variance.** Not knowable here.
- **Statement import.** Waits for one BPI and one MBTC export.
- **Writing the OC figure anywhere.** The sheet is Finance's; this is the source for its column.
