# Cash outflow by cheque date — design

**What it is.** A page, `/forecast`, and its Excel extract, showing every cheque that has been
written and not yet handed over, bucketed by the cheque's own date and split by bank and by stage.
It is the cheque-side of the daily cash position Finance asked for on 2026-09-10.

Every figure here was measured against production on 2026-09-11.

## The premise, and why the cheque date is the axis

Finance named four reports on 2026-09-10; the daily cash position is the one this system can feed,
and the piece it can feed is outflow: cheques that will leave the bank. The obvious axis — when a
cheque is expected to go out — does not exist yet:

- **No cheque has ever carried a pickup date.** `availablePickupDate` and `scheduledPickupDate`
  are null on every row in the table, and `readyAt` is null on all 233 READY cheques: they were
  promoted by `scripts/backfill-available.ts` from the approval workbook, and the on-screen READY
  FOR RELEASE form — which requires a date — has never been used in production.
- **`releasedAt` is null on every released cheque**, because the backfills that set RELEASED
  deliberately wrote no timestamp they could not know. There is no daily outflow history.
- **Clearing has never been recorded**: `clearingStatus = NONE` on all 9,594 released cheques.

What every cheque has is `checkDate`, and the client's ruling (2026-09-11) is to forecast on it.
That is the right reading, not a compromise: a cheque's date is the day from which it can be
presented, and Finance's own `Cash Balance` sheet treats outstanding cheques exactly so. A cheque
dated in the past is not a missed forecast — it is **presentable now**, and how long it has been
presentable is the exposure. The page therefore says *presentable from*, never *expected on*.

Only 10 of 1,517 live cheques are post-dated; the future buckets will usually be small. The past
buckets are the report.

## Population

Every cheque with a live status — `SIGNATURE_PENDING`, `SIGNED`, `READY_FOR_RELEASE`,
`SCHEDULED` — that is a real cheque (`isCheque`) and has a recorded amount (`isIncomplete = false`,
consistent with every other output; the exclusion and its count are stated on screen with the
`?incomplete=1` link, as the dashboard does). `GENERATED` is included if it ever occurs; it is a
live status and today holds no cheques.

Released cheques are out. They have left the counter, and with clearing unrecorded their fate is
unknowable here. Cancelled and voided are out because they will never leave.

Measured: 1,517 cheques, PHP 247.7M — SIGNATURE_PENDING 446 / 100.5M, SIGNED 839 / 124.0M,
READY_FOR_RELEASE 232 / 23.2M (BPI 139 / 15.9M, MBTC 93 / 7.3M). 257 of them, PHP 32.8M, carry a
cheque date more than eight weeks old.

## The buckets

On `checkDate` relative to today (the Manila calendar day, computed once per request), in this
order:

| bucket | rule |
| --- | --- |
| `OVER 90 DAYS` | dated more than 90 days ago |
| `61–90 DAYS` | 61 to 90 days ago |
| `31–60 DAYS` | 31 to 60 |
| `8–30 DAYS` | 8 to 30 |
| `1–7 DAYS` | 1 to 7 days ago |
| `TODAY` | dated today |
| `THIS WEEK` | dated after today, up to and including this week's Sunday |
| `NEXT WEEK` | the following Monday to Sunday |
| `LATER` | anything after that |
| `NO DATE` | `checkDate` null — counted, never bucketed by time |

The five past buckets are the ones Finance already uses on `AP Local` (1-30 / 31-60 / 61-90 /
over 90), with the first split at seven days because a cheque presentable for a week is a
different fact from one presentable for a month. Boundaries are inclusive on the upper edge and
tested at every edge. Days are whole calendar days, never hours.

## The page — `app/forecast/page.tsx`

`requireUser()` first. Any Finance role. Server-rendered; a plain `GET` form.

**Filters:** BANK (from `Bank`, resolved per cheque as checkbook's bank, else cash account's bank),
COMPANY, STAGE (the live statuses). RESET when any is set.

**Matrix 1 — bucket × bank.** Rows are the buckets in the order above, columns one per bank
present in the population (BPI, MBTC, and any other that appears — never a hard-coded list), then a
TOTAL column. Each cell: count and amount **per currency**, never summed across currencies; a cell
with no cheques shows a dash. A TOTAL row at the bottom. Amounts are decimal strings summed in
centavos (`toCentavos` / `fromCentavos` from `lib/export/report.ts`) and rendered with
`formatMoney`.

**Matrix 2 — bucket × stage.** Same rows; columns SIGNATURE PENDING · SIGNED · READY FOR RELEASE
· SCHEDULED · TOTAL. PHP 100M waiting on a signatory and PHP 23M ready to hand over are different
exposures, and Finance will ask.

**Above both**, one paragraph, always shown:

> Dates are the cheque's own date — the day from which it can be presented. A cheque dated in the
> past can leave on any day; the buckets say how long it has been presentable. No pickup or
> release dates have been recorded yet; as Finance releases through this system, the RELEASED
> view will begin to show actual outflow by day.

and the incomplete-cheque exclusion line, with the live count and link.

**`EXPORT EXCEL`** — a plain anchor to `/api/export/forecast` carrying the same filter parameters.
Here the file IS the view, unlike the voucher index: a filtered forecast exported is the filtered
forecast, and the title block says which filters were in force, as the register export does.

## The extract — `cash-outflow-<date>.xlsx`

Two sheets, built on `lib/export/sheet-style.ts`:

- `SUMMARY` — a title block (report name, filters in force, generated by/at, the exclusion), then
  Matrix 1, a blank row, Matrix 2. Amounts as Excel numbers in the cells (the one sanctioned use,
  as `workbook.ts` documents), one row per currency within a bucket when more than one currency
  appears.
- `DETAIL` — one row per cheque: CHECK NUMBER · PAYEE · BANK · COMPANY · STAGE · CHECK DATE ·
  DAYS PRESENTABLE (negative for future-dated, blank for undated) · BUCKET · CURRENCY · AMOUNT.
  Sorted oldest cheque date first, undated last. Capped at `EXPORT_ROW_LIMIT` (10,000) with the
  cap stated in the title block, as the register export does; today's population is 1,517.

The filename is dated, like the register export's — `cash-outflow-2026-09-11.xlsx` — because
nothing external links to it and a report's date is part of its name.

## Plumbing

| file | responsibility |
| --- | --- |
| `lib/forecast/buckets.ts` | **Pure.** `BUCKETS` in order, `bucketFor(checkDate, today)`, `daysPresentable(checkDate, today)`, the Manila-day helper. Tested at every boundary. |
| `lib/forecast/query.ts` | One read of the population with its filters; returns rows (id, number, payee, bank, company, stage, currency, amount string, checkDate). Grouping happens in the pure layer so the matrix and the detail sheet are struck over one list. |
| `lib/forecast/matrix.ts` | **Pure.** `buildMatrices(rows, today)` → the two matrices with centavo-exact totals per currency. Tested with literals. |
| `lib/forecast-view.ts` | **Pure.** Parameter parsing, hrefs, the filter description — the `vouchers-view.ts` pattern. |
| `lib/export/forecast-workbook.ts` | ExcelJS rendering of both sheets. |
| `app/forecast/page.tsx`, `app/api/export/forecast/route.ts` | Guarded exactly as `/vouchers` and `/api/export/vouchers` are — `requireUser()` first on the page, `getSessionUser()` first on the route, 401 not a redirect. |
| `components/AppHeader.tsx` | `FORECAST` link beside `VOUCHERS`. |

Bank resolution is the voucher index's: checkbook's bank, else cash account's bank, else
`(NO BANK)` — shown as its own column, never dropped, because a cheque with no bank is still money.

## Testing

Targeted, never the full suite: `tests/forecast/buckets.test.ts` (every boundary, today, null,
this week / next week across a Sunday, the Manila day), `tests/forecast/matrix.test.ts` (two
currencies never summed; a bank with no cheques in a bucket; totals in centavos), `tests/forecast/
query.test.ts` (population rules: released out, incomplete out, non-cheque out; each filter),
`tests/forecast-view.test.ts`, `tests/export/forecast-workbook.test.ts` (cells read back),
`tests/export/forecast-route.test.ts` (401, no database touch, filename). `npx tsc --noEmit` and
`next build`.

## Not in this design

- **A forecast on pickup or release dates.** None exist. The RELEASED view by `releasedAt` is the
  natural next step once releases go through the app; it is one more bucket set over a different
  population, not a redesign.
- **Bank balances or the float** (released, not cleared). Clearing is never recorded;
  `recordClearing` exists and is unused. This report's population deliberately stops at the counter.
- **Notifications** on stale paper. CLAUDE.md item 4.
