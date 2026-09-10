# Voucher screen — design

**What it is.** A page in this application, `/vouchers`, that answers *"which cheque pays this AP
voucher, and where is it?"* on screen, with the Excel index as its extract. It replaces the
handover that asked a Finance user to repoint three `VLOOKUP`s in the Executive Report.

**Why.** Client decision, 2026-09-10, on being shown that handover: *"why do i need to calibrate
the excel formula? I want the report to be done in the portal. And report can be extracted from
there."* That is the same premise as *the system is the record*: Excel is what leaves this system,
not what anybody maintains. The morning's "feed the workbook" decision is superseded.

Everything that shipped as the voucher index — the resolver, the read, the workbook, the route —
is this screen's engine, unchanged in its judgement. This design adds the front of it and takes the
formulas away.

## The page — `app/vouchers/page.tsx`

`requireUser()` on the first line, as every page. Any Finance role: this discloses less than the
dashboard (no amounts) and Finance users are the people who ask the question.

Server-rendered, no client component. One `<form method="get">`, like the dashboard's filter bar:

| control | parameter | |
| --- | --- | --- |
| SEARCH | `q` | voucher **contains**, case-insensitive. Pushed into the SQL, not filtered in memory. |
| STATUS | `status` | one of the eight `CheckStatus` words, or `CONTESTED`, `ALL CANCELLED`, `NOT KEYED`. Applied after resolution — the three synthetic statuses exist only then. |
| APPLY / RESET | | RESET only when a filter is set, as the dashboard does. |

**First 200 rows, with the true count stated** — *1,032 VOUCHERS · SHOWING FIRST 200 · narrow the
search to see the rest*. The same cap-and-say pattern as the dashboard table and both exports.

**EXPORT EXCEL** on the page is a plain anchor to the existing `/api/export/vouchers`. Beside it, in
words: *the file holds every voucher this system knows, not the filtered view* — a lookup extract
has to cover everything, and a reader who filtered to CONTESTED must not think the file did too.

## The table

VOUCHER · CHECK NUMBER · BANK · COMPANY · STATUS · CHECK DATE · PAYEE · SUPERSEDES · REMARKS.

- **CHECK NUMBER links to `/checks/[id]`.** `CheckCandidate` and `VoucherRow` gain `checkId`
  (`string | null`, null exactly when `checkNumber` is). The workbook ignores it.
- **STATUS**: a real cheque status renders with the existing `StatusPill`. The three synthetic
  statuses get a pale amber pill from a separate map, `VOUCHER_STATUS_PILL_CLASS`, in
  `lib/status-pill.ts`. `STATUS_PILL_CLASS` is `Record<CheckStatus, string>` and tested for gaps;
  it must not learn words that are not cheque statuses.
- **CHECK DATE** in `en-PH`, as `CheckTable` renders it. **REMARKS** wraps; everything else does
  not.
- Zero rows: `EmptyState`, saying what was searched for.

Under the table, **what a blank cheque number means** — the same three-row explanation that was in
the handover, now on the screen where the blank is: CONTESTED, ALL CANCELLED, NOT KEYED, and the
no-row case. This is the text the client asked not to have to read in a document.

## Plumbing

- `listVoucherCandidates(db, filter?: { voucher?: string })` — when `voucher` is given, both
  queries add `where v.voucher ilike '%' || ${voucher} || '%'` as a bound parameter inside the
  tagged template. Never string-built.
- `lib/vouchers-view.ts` — **pure**: `parseVoucherStatusParam`, the status list the select
  offers (`VOUCHER_STATUS_OPTIONS`), `filterByStatus(rows, status)`, `vouchersHref({ q, status })`,
  and `describeVoucherView(count, shown, q, status)` for the count line. Tested with literals, the
  way `dashboard-view.ts` is. The page reads these; it decides nothing itself.
- `VOUCHER_SCREEN_ROW_LIMIT = 200` lives there too.

## Navigation

- `AppHeader` gains a `VOUCHERS` link, shown to every signed-in user, before ADMINISTRATION. Hidden
  on the vouchers page itself, as ADMINISTRATION is hidden on the admin pages.
- The `VOUCHER INDEX (ALL CHEQUES)` anchor comes **off** `QuickActions`. The export now lives on
  the page that explains it. The component's doc comment goes back to describing three actions,
  and the sentence about parameters becomes simply true again.

## Retired

- `docs/voucher-index-handover.md` is **deleted**. Nobody repoints a formula.
- The `CLAUDE.md` bullet written this afternoon is rewritten: the Executive Report is not fed; the
  question it was asking is answered on `/vouchers`, and `CHECK BY VOUCHER.xlsx` is the extract.
  The fixed filename, fixed sheet name and `$A$2` timestamp are kept — they cost nothing and an
  extract with a stable shape is still the right extract — but they are no longer load-bearing.

## Testing

Targeted, never the full suite:

- `tests/export/voucher-query.test.ts` — the `voucher` filter narrows both queries; case-insensitive.
- `tests/export/voucher-index.test.ts` — `checkId` passes through; null when the number is blank.
- `tests/vouchers-view.test.ts` — the pure module: an unknown status parses to `undefined`;
  `filterByStatus` on the synthetic and real statuses; hrefs; the count line at 0, under and over
  the cap.
- `tests/status-pill.test.ts` (existing) — still passes; the new map is tested to cover exactly
  the three synthetic statuses.
- `npx tsc --noEmit` and `npx next build`, which lists `/vouchers`.

No page test. No page in this repository has one; the pure module and the queries carry the tests.

## Not in this design

- **Paste-a-list.** A textarea of vouchers resolved in one go would need a POST path and results
  that survive a refresh. The bulk path today is EXPORT EXCEL. Offered, declined for now.
- **The AP ageing report.** What `AP Local` actually is — every open payable with its buckets —
  needs the open-AP bills feed from Acumatica, which this system has never read. Its own spec, and
  the same feed the hedging report needs.
