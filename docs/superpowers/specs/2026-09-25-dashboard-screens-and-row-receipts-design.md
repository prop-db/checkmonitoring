# Dashboard: a totals screen, a list screen, and an OR box on every ticked row

**Status:** approved in conversation 2026-09-25, awaiting review of this document.

## What the client asked

> "I want in the dashboard the it will just only show the totals. Once it is click, it will only
> the list so i can have more space to view. Also i want the OR to be filled is shown in the line so
> i dont need to click the checks. Once the box was clicked the box for the OR part will be
> fillable"

Three decisions settled what that means, made by the user in conversation:

| Question | Decision |
| --- | --- |
| How do totals and list split? | **Two screens.** Opening the dashboard shows only the totals; clicking a card opens a full-page list; BACK TO TOTALS returns. |
| Which box makes the OR fillable? | **The row's own tick box.** Ticking a row opens an OR box in that row, so several cheques can be ticked, each given its own OR, and saved together. |
| Which ticked rows get the box? | **Both** READY FOR RELEASE (and SCHEDULED) rows — released with their OR — and RELEASED rows that have no OR yet — a late receipt, saved without opening the cheque. |

## Part 1 — Two screens

### Which screen

Decided by the URL, in one pure function `dashboardScreen(selection, q)` in `lib/dashboard-view.ts`:

- **TOTALS** when nothing narrows the view: `selection.status === null`, `!selection.showAll`,
  `!selection.incomplete`, no key in `selection.base` (company, cash account, eligibility, search).
- **LIST** otherwise.

The cards, the timeline and the "Show them" link already build URLs through `cardHref` /
`incompleteHref`, so every one of them opens the LIST screen with no change of its own. Export
(`/api/export`) and print (`/print`) run `resolveDashboardQuery` over the same URL and are
untouched. A browser back button returns from list to totals, because the screen *is* the URL.

A client-side toggle was considered and rejected: the view would be lost on refresh, and export
and print would have no way to know which screen the reader was on.

### The TOTALS screen

In order: the Acumatica LAST READ line (`SyncStatusLine`), the cards (`SummaryCards`),
TODAY'S RELEASE (`TodaysReleasePanel`, with RELEASE ALL and its confirmation step unchanged), the
release timeline (`ReleaseTimeline`), and **a single search box** — `GET /` with `q` — because
finding one cheque by number is the commonest reason to open the list, and it lands on the LIST
screen with the matches.

No table, no filter bar, no quick actions. `listChecks` / `countChecks` are **not queried** on this
screen.

### The LIST screen

- A slim top bar: **← BACK TO TOTALS** (a link to `/`), then the view as `describeView(selection)`
  already words it and the matching count, then `QuickActions` (export, print) on the right.
- The "EXCLUDING N CHEQUES WITH NO RECORDED AMOUNT" disclosure and its "Show them" link — **kept**,
  because hiding cheques without saying so is how somebody concludes money went missing.
- `FilterBar`, the incomplete-only notice, the "SHOWING X OF Y" notice, and `CheckTable` at full
  width.
- Not on this screen: the cards, TODAY'S RELEASE, the timeline. `getTodaysRelease` is not queried
  here; `getSummary` still is, for the disclosure count.

## Part 2 — An OR box on every ticked row

### Which rows can be ticked

`selectable(row)` in `components/CheckTable.tsx` becomes:

- `row.isCheque && isLiveStatus(row.status)` — as today; **or**
- `row.isCheque && row.status === 'RELEASED' && !row.hasReceipt` — **new**.

`CheckTableRow` gains `hasReceipt: boolean` (true when `orNumber` is set), filled by `toTableRow`.
A RELEASED row that already records a receipt is not tickable — receipts are never overwritten
(`recordReceipt` refuses an overwrite, and stays the control; the tick box is a courtesy).

### The box

A ticked row whose status is **READY_FOR_RELEASE, SCHEDULED or RELEASED** shows, in a new **OR**
column, an **OR / CR** select and a **number** input. Other ticked rows (SIGNATURE_PENDING, SIGNED)
show no box — nothing can carry a receipt before it is handed over. The column is always present;
an unticked row shows its recorded receipt (`OR-000123 (OR)`) or `—`.

The receipt DATE is not in the row. It stays on the cheque page, to keep the row one line; a
receipt saved from the row has no date, exactly as a receipt entered today without one.

Unticking a row discards what was typed in its box.

### The actions

`BulkActionBar` gains **SAVE RECEIPTS**, beside the existing actions:

- **RELEASE** (FINANCE_ADMIN only, as today) — releases every ticked READY_FOR_RELEASE / SCHEDULED
  cheque, **each with its own box's receipt**; an empty box releases with no receipt, as today.
  The old single receipt box in the bar is removed.
- **SAVE RECEIPTS** (any signed-in Finance user, as `recordReceiptAction` is today) — records the
  typed receipt on every ticked RELEASED cheque whose box is filled; ticked released rows with an
  empty box are skipped and counted as such.

Both send `checkId` plus `orNumber:<checkId>` / `receiptType:<checkId>` per row. A number with no
OR/CR type is refused in the browser (the button stays disabled with the row named) and again on the
server.

### The server

- `bulkReleaseAction` (`app/checks/bulk-actions.ts`) reads a receipt **per cheque** from the keyed
  fields and passes each to `markReleased` unchanged. The refusal "a receipt reference belongs to one
  cheque, and N are ticked" is **removed**, because its reason — one box spread over a batch — no
  longer exists: every box belongs to one row. It is replaced, not loosened: a receipt keyed to a
  cheque that is not in the ticked selection is refused before anything is released.
- `bulkRecordReceiptsAction` (new, same file): parses the selection with `parseSelection` and the
  `caps.bulkSelection` cap, reads each row's receipt, skips empty ones, and calls the existing
  `recordReceipt` for each through `runEach` — one transaction per cheque, so one refusal (released
  by someone else a moment ago, receipt already added) does not stop the rest, and the result names
  each refused cheque with its reason.
- Per-cheque reading lives in `lib/receipt-form.ts` beside `readReceiptFields`:
  `readRowReceipts(formData, checkIds)` → a map of checkId → receipt, or a message naming the first
  row whose number has no type. The existing single-form readers stay for the cheque page.
- **Rule 11 is untouched:** `markReleased` and `recordReceipt` write only `orNumber` / `orDate` /
  `receiptType`; nothing here reaches `crNumber`. Each receipt gets its own audit row naming who
  typed it, exactly as today. No portal event is added.

## Out of scope

- Editing or correcting a receipt already recorded.
- The receipt date in the row.
- Changing TODAY'S RELEASE / RELEASE ALL.
- Any change to which statuses count as "live", or to the cards' figures.

## Tests

- `tests/dashboard-view.test.ts` (+): `dashboardScreen` — TOTALS for a bare URL; LIST for a status,
  `scope=all`, `incomplete=1`, a company / cash account / eligibility, and a search.
- `tests/receipt-form.test.ts` (new file): `readRowReceipts` — one receipt per keyed row, blanks omitted,
  a number with no type refused naming the row, a key for an unticked cheque refused.
- `tests/actions/bulk-actions.test.ts` (+):
  - RELEASE of three ticked cheques with two different ORs and one blank → all RELEASED, the two
    receipts on the right cheques, the blank cheque with none, `crNumber` null on all three.
  - SAVE RECEIPTS on two released cheques and one blank → two recorded, one skipped; a cheque that
    already has a receipt is refused by name while the others save; non-admin may save receipts but
    not release.
  - the cap is enforced.
- `tests/queries.test.ts` (+), where `toTableRow` is already tested: `hasReceipt`.
- `tests/actions/receipt.test.ts` must still pass unchanged — rule 11's pin.
