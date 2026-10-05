# Check Release Monitoring

Internal Finance system for the RCL group (Starkson / A1+ and related companies). It tracks a
cheque from the moment Acumatica generates it until it is physically handed to a supplier:

```
ACUMATICA  →  CHECK RELEASE MONITORING  →  FINANCE CONFIRMATION  →  SUPPLIER PORTAL
```

The automation it exists for: **when Finance ticks READY FOR RELEASE, the Supplier Portal updates
without anyone re-encoding the cheque.**

Next.js 15 (App Router) · Prisma 6 · PostgreSQL on Neon (ap-southeast-1) · NextAuth v5 + argon2id ·
Vitest · TypeScript strict. Deployed on Vercel at `checkmonitoring.rclcompanies.com`.

## THIS SYSTEM IS THE RECORD. THE SPREADSHEET IS NOT.

Client decision, 2026-09-10: **"No more updating thru excel."** `CHECK MONITORING <date>.xlsx`
stops being maintained. The 9 September load was the last register import, and there should never
be another.

That is a change of premise, not a preference. Until now the spreadsheet was the real record and
this app was catching up to it; from here the app IS the record and the register is history.
It follows that:

- **Do not build anything that assumes a future register file.** No incremental register import,
  no watcher, no re-import path. `scripts/import-workbook.ts` stays for the historical load it
  performed and for seeding a fresh database; it is not part of the routine.
- **The Acumatica sync is now the only way a cheque arrives**, which makes it load-bearing in a
  way it was not before. While Excel was maintained, a sync nobody ran meant stale data with a
  paper fallback. Now it means the cheque does not exist. **A scheduled sync is a prerequisite
  for switching the team off the spreadsheet**, not an improvement for later.
- **The approval workbook is NOT covered by this decision.** `APPROVAL FOR RELEASE <date>.xlsx` is
  exported from Acumatica rather than typed by hand — a report, not a parallel record. It
  continues, and `lib/import/bills.ts` continues with it.
- **Anything Finance used to type into the register must be typeable here**, or somebody will
  reach for Excel out of necessity and the two records will diverge again. The register carried
  remarks, point person, who is holding the cheque, and clearing details. The columns exist;
  each needs to be reachable on screen. **Built 2026-09-11:** remarks, point person, who is
  holding it and category are edited on the cheque page (FINANCE NOTES); the bank's clearing is
  recorded there on a RELEASED cheque or in bulk on `/clearing` from pasted statement lines;
  `NONE → CLEARED` is legal, because a statement is proof of clearing whether or not a deposit was
  recorded first.
- Where the two disagreed, **the register was wrong** — 94 amounts and 1,958 company assignments,
  measured below. That is the strongest argument for this decision, and worth repeating to
  anyone who wants the spreadsheet back.
- **Finance kept filling the register anyway, and one catch-up has been run.** Measured
  2026-09-24: `CHECK MONITORING 9.24.2026.xlsx` records **698 pick-ups since 9 September** that
  were never ticked here. On the user's request, `scripts/backfill-released-from-register.ts`
  (`lib/admin/register-releases.ts`) moved **940 cheques to RELEASED** — 398 SIGNED, 359
  SIGNATURE_PENDING, 183 READY_FOR_RELEASE; Acumatica said 528 Closed, 403 Balanced, 9 unknown.
  Status only, one `backfilled_released_from_register` audit row each carrying the sheet, row
  and the register's DATE RELEASED verbatim; `releasedAt`/`releasedById` stay null; snapshots in
  `snapshots/`. It left 61 CANCELLED/VOIDED here and **252 cheque numbers the app does not hold
  at all** (mostly STK P&P / MBTC P&P RELEASED) — nobody has yet found out why the sync never
  brought them. **Matching is on cheque number; the register's company only breaks a tie** —
  1,690 of its released numbers exist here exactly once under the company Acumatica assigned
  (STPP→STK 681, A1+→STK 536, A1PP→A1+ 322), and letting the register's company veto them
  matched only 312 of the 940. This is a catch-up, not a routine: every further run means
  releases are still happening outside the app, which is the problem to fix, not the script.
- **The for-release list changed shape on 2026-09-24, and `lib/import/bills.ts` cannot read it.**
  `FOR RELEASE 9.25.2026.xlsx` has `Detail1` (pivot drill-down, header on row 3, 939 vouchers all
  remarked AVAILABLE, no cheque number), `LOCAL` (BANK column first, header on row 2, 192),
  `BROKERS` (register-shaped, 42 cheques) and `PIVOT`. `isBillSheet` reads none of them.
  **User ruling 2026-09-24: all three sheets are the list.** `scripts/mark-ready-from-release-list.ts`
  (`lib/admin/release-list.ts`) finds a voucher or CHECK NUMBER header in rows 1-3 of each sheet,
  resolves each voucher to **exactly one live cheque** via `apvNumbers` (or the broker row's cheque
  number), and moved **522 cheques to READY_FOR_RELEASE** (387 SIGNED, 135 SIGNATURE_PENDING) — 572
  ready after. Status only; no `readyAt`/`readyById`/pickup date, no portal event, **no `CheckBill`
  row** — so **never run `scripts/backfill-available.ts` after it**: that script reads "has a bill"
  as "on the list" and would demote all 522. Left alone: 336 vouchers naming no cheque, 14 naming
  only cancelled/voided ones, 5 naming two live cheques, and **24 the list calls available that the
  9.24 register shows released on 21-22 September** — kept RELEASED; a stale list does not pull a
  release back. Nothing was demoted: the one READY_FOR_RELEASE cheque off the list (`6000352027`)
  was not released in the 9.24 register, and the user's instruction was to demote only on that.
  **Superseded 2026-09-25: the list is LOCAL + BROKERS only.** The 71.08M the app then showed as
  available did not match Finance's 20.47M, because `Detail1` is the PIVOT's drill-down ("Details
  for Sum of Detail Total - FINANCE REMARKS: AVAILABLE" — every bill Acumatica remarks AVAILABLE,
  117.8M), not the list; the PIVOT sums only LOCAL (11,657,821.01) and BROKERS (9,469,750.00).
  Finance's 20,471,260.80 uses LOCAL's row-1 11,001,510.80, the sum of the four overdue buckets
  only. The 428 cheques named only by `Detail1` (57,160,884.23) were NOT released — all sat on the
  9.24 register's AVAIL./unreleased sheets, 409 Balanced in Acumatica — and
  `scripts/revert-detail1-ready.ts` returned them to their prior status (352 SIGNED, 76
  SIGNATURE_PENDING; one `ready_reverted_detail1_not_release_list` audit row each, snapshot in
  `snapshots/`). After: 143 available, 13,922,609.81. `readReleaseList` now skips a sheet titled
  "Details for …". The rest of the gap to the list: 90 LOCAL vouchers (6.91M) name no cheque here,
  2 (256,160.00) name two live cheques. 11 of the 428 carry a `CheckBill`, so
  `scripts/backfill-available.ts` would re-promote them — another reason never to run it.
  The same day, on the user's instruction, the two LOCAL cheques READY here but `Voided` in
  Acumatica (`6000353108`, 6,000.00; `1791404779`, no amount) were voided through `voidCheck`,
  snapshot first. Available after: 142, 13,916,609.81.
  ~~Leave the 90 LOCAL vouchers with no cheque here, as not yet processed~~ — **wrong, and
  superseded the same day.** Read from Acumatica's `AP-PAYMENTS-WITH-BILLS`, every one of the 90
  was paid by exactly one live cheque this system already held at SIGNED; the link was missing
  because `apvNumbers` came only from the retired register and `AP-Checks and Payments` publishes
  no bill reference. **A voucher that "names no cheque here" means an unlinked cheque, not an
  unprocessed bill — look it up before concluding anything.** `scripts/link-vouchers-from-acumatica.ts`
  (`lib/admin/voucher-links.ts`: exactly one live CHK cheque, voided and ADR applications ignored,
  a list-stated cheque number must agree) linked 130 list vouchers (90 LOCAL, 40 BROKERS) — one
  `voucher_linked_from_acumatica` row each — and moved the 90 SIGNED cheques to READY_FOR_RELEASE,
  snapshot first. Available after: **233, 21,013,221.48**; 0 list vouchers unlinked. The bill
  column is `AdjdRefNbr` in Go-Live and `ReferenceNbr_2` in MANUFACTURING (a filter on the Go-Live
  name is a 500 there), and an `or` of several `eq` filters is a 500 in Go-Live. **Since 2026-10-01 the scheduled run reads it** (`lib/sync/bills.ts`, `runScheduledBillsSync`, `SyncRun.mode = 'BILLS'`; feed in `lib/integrations/acumatica/bills.ts`, `BILL_FEED_COLUMNS`): every `CHK` → `Bill` application is unioned into the paying cheque's `apvNumbers`, matched on the payment's own reference (`acumaticaPaymentId`), add-only, never status. The first read is `npx tsx scripts/sync.ts <TENANT> --bills` from a terminal (it snapshots to `snapshots/bills-<tenant>-<timestamp>.json` first; `--dry-run` reads and writes nothing). The run message names up to 10 payments the inquiry shows that are not held here, because the watermark moves past them for good — `scripts/sync.ts <TENANT> --bills --full` relinks them once their cheques exist (idempotent, add-only). **First reads done:** GOLIVE 2026-10-01 19:09 Manila (MANUAL) — 755 vouchers added to 755 cheques, 3,343 payments in the inquiry not held here (not yet examined; most are expected to be outside the sync's 2026-and-CHK scope); MANUFACTURING 2026-10-02 11:38 Manila — 180 fetched, 52 not CHK → Bill, 22 vouchers added to 22 cheques, 2 not held here, 0 errors, snapshot `snapshots/bills-MANUFACTURING-2026-10-02T03-38-32-602Z.json`. The cron runs BILLS for a tenant only after that tenant's payment read RAN (`SKIPPED_PAYMENT_NOT_RUN` otherwise, not a failure) — a failed payment read's cheques would otherwise count as not held and be skipped for good. The watermark is held (the run finishes with none, so the previous one stays) when any cheque's write failed, and the problem names its payment reference. Only a cheque with something missing opens a transaction; a re-read of an already-linked set costs one lookup. `upsertCheck` now writes `apvNumbers` only when the merge adds a voucher, so the payment sync cannot erase a BILLS append. A cheque's PO NUMBER is `CheckBill.poNumber` ∪ the real POs Acumatica's `AP-Bills and Adjustments` names in `VendorRef` for any APV the cheque shows (spec `2026-10-05-po-from-acumatica-design.md`, client 2026-10-05 "only real POs"): `lib/sync/bill-refs.ts` mirrors it into `AcumaticaBill` (keyed by APV, reference data — no `Check` column, no audit row per bill, deleted when the ref stops naming a PO), `SyncRun.mode = 'BILL_REFS'`, its own watermark, run by the cron after BILLS for a tenant whose payment read RAN; the first read is `npx tsx scripts/sync.ts <TENANT> --bill-refs` (snapshot `snapshots/bill-refs-<tenant>-<timestamp>.json` first). `extractPoNumbers` (`lib/integrations/acumatica/bill-refs.ts`) keeps only the measured PO shapes; ONE column map serves both tenants for this inquiry. `displayPoNumbers` in `lib/queries.ts` is the one definition — list, Excel, print, PO sort, PO filter and search all read it or its SQL twin `acumaticaPoMatch`. The list, Excel and print show a PO NUMBER column (Excel AMOUNT moved to column 8; the column-choice storage key is now `check-monitoring.columns.v2`).
  **`FOR RELEASE 9_1.25.2026v2.xlsx`** (same day): LOCAL unchanged; BROKERS 39 cheques / 8,174,750.00,
  with a new SCM REMARKS column (DELIVERED …), unused. Added `6000354012` and `6000354067` (linked
  and readied by the link script). Dropped `6000354001`/`05`/`06`/`13` (2,285,000.00) — **user
  ruling: dropped off the list = pulled, not released** — back to SIGNED, one
  `ready_reverted_off_release_list` row each, snapshot first. This reverses the 2026-09-10
  "dropped = released" reading for this list; ask each time rather than assume either. App after:
  **231 available, 19,724,221.48**, exactly the list's cheques; 0 off-list.
  **Second register catch-up, 2026-09-26**, on the user's request: `CHECK MONITORING 9.25.2026.xlsx`
  showed 240 pick-ups not RELEASED here — 228 dated 25 Sep, 12 dated 18-24 Sep that were typed
  after the 9.24 file — all Balanced in Acumatica; 160 were READY_FOR_RELEASE, 80 SIGNED. All 240
  moved to RELEASED by `backfill-released-from-register.ts`, snapshot first. Available after:
  **71, 3,162,018.70**. Still 252 register cheque numbers the app does not hold, and 78 it holds as
  CANCELLED/VOIDED, both left.
  `6000352027` (2,180.36, on no sheet of the 9.25 list) was confirmed released by the user and set
  RELEASED — status only, `released_confirmed_by_user` audit row, snapshot first. Available after:
  141, 13,914,429.45 — every one of them on LOCAL or BROKERS. Then `6000353477` (Voided in
  Acumatica) was voided, and its re-issue `6000353478` and `1791404780` — the live cheques of the
  two LOCAL vouchers that had named two — were moved SIGNED → READY_FOR_RELEASE on the user's
  instruction. Available after: 143, 14,168,302.31. **LOCAL's own total is wrong**: S1's
  11,001,510.80 sums `O3:O185` while the data runs to row 194, missing 9 BPI P&P vouchers
  (656,310.21); the true total is 11,657,821.01, which the PIVOT agrees with. BROKERS row 29
  (`6000353108`, 6,000.00) is a cheque Acumatica voided — the list still calls it available.
  **User ruling 2026-09-25: follow Acumatica on voids.** `scripts/void-acumatica-voided.ts --apply`
  (run by the user) voided the 35 cheques Acumatica reported Voided that were still live or
  RELEASED here — 18 SIGNED, 17 RELEASED (all imported from the register at RELEASED;
  `6000089687` keeps its supplier receipt and a `voided_after_release` row). 0 left after.

## Commands

```bash
npm run dev                    # local dev server
npm test                       # full suite (Vitest, hits the TEST database)
npx tsc --noEmit               # REQUIRED before claiming done - see below
npx next build
npm run db:migrate             # dev migrations
node scripts/migrate.mjs test             # apply migrations to the TEST database (URL never touches a shell)
node scripts/migrate.mjs prod --confirm   # the same against PRODUCTION; migrate BEFORE you deploy
npm run db:seed                # dev seed, WITH demo cheques and known-password accounts
npm run db:seed:reference      # production seed: reference data only, no cheques, no accounts
npm run create-admin           # bootstrap the first FINANCE_ADMIN on a fresh database
npx tsx scripts/backfill-incomplete.ts --dry-run   # re-derive Check.isIncomplete; idempotent
npx tsx scripts/backfill-apv-numbers.ts "CHECK MONITORING 9.1.2026.xlsx" --dry-run  # fill Check.apvNumbers
npx tsx scripts/backfill-available.ts --dry-run                     # the approval list IS ready-for-release
npx tsx scripts/backfill-released-dropped.ts <older> <newer> --dry-run   # dropped off that list = released
npx tsx scripts/repair-cr-receipts.ts            # dry run: the register's CR numbers out of crNumber
npx tsx scripts/repair-cr-receipts.ts --apply    # snapshot to snapshots/, then repair, one audit row each
npx tsx scripts/backfill-released-from-register.ts "CHECK MONITORING 9.24.2026.xlsx"   # dry run: register pick-ups not yet RELEASED
npx tsx scripts/backfill-released-from-register.ts "<register>.xlsx" --apply           # snapshot, then status only, one audit row each
npx tsx scripts/backfill-stated-release-dates.ts "CHECK MONITORING 9.25.2026.xlsx"     # dry run: the register's DATE RELEASED onto RELEASED cheques
npx tsx scripts/backfill-stated-release-dates.ts "<register>.xlsx" --apply              # snapshot, then statedReleaseDate only, one audit row each
npx tsx scripts/mark-ready-from-release-list.ts "FOR RELEASE 9.25.2026.xlsx"            # dry run: listed cheques not yet READY_FOR_RELEASE
npx tsx scripts/mark-ready-from-release-list.ts "<for-release>.xlsx" --apply            # snapshot, then status only; never follow with backfill-available
npx tsx scripts/revert-detail1-ready.ts "<for-release>.xlsx" <ready-from-list snapshot> [--apply]  # Detail1-only READY back to prior status (run 2026-09-25)
npx tsx scripts/void-acumatica-voided.ts [--apply]                # void what Acumatica voided (live or RELEASED here)
npx tsx scripts/close-unmatchable-cancelled.ts [--apply]         # parked CANCELLED events whose cheque has no APV: close unsent
npx tsx scripts/backfill-check-books.ts GOLIVE [--apply]       # Acumatica cheques with no cheque book: record it from CashAccount (MANUFACTURING likewise)
npx tsx scripts/link-vouchers-from-acumatica.ts "<for-release>.xlsx" [--apply]  # link list vouchers via AP-PAYMENTS-WITH-BILLS, ready their cheques
npx tsx scripts/sync.ts GOLIVE --bills --dry-run     # read AP-PAYMENTS-WITH-BILLS, write nothing (MANUFACTURING likewise)
npx tsx scripts/sync.ts GOLIVE --bills               # snapshot, then union vouchers into apvNumbers; add --full to re-read
npx tsx scripts/sync.ts GOLIVE --bill-refs --dry-run  # read AP-Bills and Adjustments, write nothing (MANUFACTURING likewise)
npx tsx scripts/sync.ts GOLIVE --bill-refs            # snapshot AcumaticaBill, then mirror bill -> PO; add --full to re-read
```

**On Windows, use `npx.cmd` / `npm.cmd`.** PowerShell's execution policy is `Undefined` (i.e.
`Restricted`) and blocks `npx.ps1`.

## Rules that must not be broken

These are safety properties, not preferences. Each exists because of a specific failure.

1. **INTERNAL USE ONLY.** No supplier login, supplier dashboard, or supplier-facing page. Suppliers
   never log in here.
2. **An `INTERNAL` cheque must never produce a portal call.** Payroll, tax, fund transfers and
   inter-company payments are classified `INTERNAL` by `lib/domain/eligibility.ts`, and the portal
   client asserts it again before building any request. Two independent checks, deliberately.
3. **Acumatica is read-only.** `lib/integrations/acumatica/client.ts` exposes no mutating method,
   and a test asserts it. Read-only by construction, not by callers being careful.
4. **An import never changes a cheque's status.** Acumatica does not know whether Finance has signed
   or released anything, so a sync that wrote `status` would silently undo a Finance user's work.
   The immutable field list is `IMMUTABLE_ON_UPDATE` in `lib/import/upsert.ts`, with an
   exhaustiveness test that fails when a new `Check` column is added and not classified.
5. **The portal may never mark a cheque RELEASED.** Physical release is Finance-only.
6. **No delete-user path exists anywhere.** A `User` is referenced by `AuditLog` and five `Check`
   relations; deleting one orphans the record of who released real money. Removal is deactivation,
   and the last active admin cannot be deactivated or demoted.
7. **Audit rows are append-only**, enforced by a database trigger. `app.allow_audit_purge` appears
   only in `tests/helpers/db.ts` and the trigger migration — anywhere else is a defect. The trigger
   has exactly one exemption, added in `20260905000100_audit_log_detach_on_check_delete`: the FK's
   `ON DELETE SET NULL` may blank `checkId` when the cheque it points at is already gone, and only
   when every other column is unchanged. Without it no cheque with any audit history could be
   deleted at all, because Postgres implements SET NULL as an UPDATE. Content stays unwritable.
8. **Amounts are decimal strings end to end.** Never a JS number. The column is `Decimal(18,2)` and
   float round-trips lose centavos.
9. **Never commit or print** the two `.xlsx` workbooks (real vendor names and amounts), `.env`, or
   any credential.
10. **A cheque is deleted only through `deleteIncompleteCheck`**, which refuses everything except a
   FINANCE_ADMIN removing a cheque with no amount that is not RELEASED, SCHEDULED or
   READY_FOR_RELEASE and carries no `releasedAt`. It writes the deletion's own audit row first, in
   the same transaction, because the detached rows would otherwise point at nothing. There is no
   bulk version and must not be one. Measured 2026-09-04: 98 of the 129 incomplete cheques qualify;
   the other 31 (25 RELEASED, 6 READY_FOR_RELEASE) do not, and that is the answer, not a gap.
11. **A supplier's receipt is never written to `crNumber`.** The OR/CR box on the release form is
   the paper the supplier hands over when they collect — Official Receipt or Collection Receipt —
   and it lives in `orNumber` / `orDate` / `receiptType`. `crNumber` sits beside `clearingStatus`
   and `clearedDate` and holds the **bank's** clearing reference, recorded weeks later. The two
   abbreviate alike and mean nothing like each other: a receipt number in `crNumber` reads, to every
   report and every reconciliation, as evidence that the money cleared — for a cheque that was
   merely handed across a counter. `markReleased` and `recordReceipt` write only the three receipt
   columns; `recordClearing` is the only writer of `crNumber` — the one exception is the one-off
   repair below, which only ever sets it to null. Pinned by `tests/actions/receipt.test.ts`.
   **Since 2026-09-25 the list takes a receipt per ticked row** (`lib/row-receipts.ts`,
   `readRowReceipts` in `lib/receipt-form.ts`): ticking a READY FOR RELEASE, SCHEDULED or
   RELEASED-without-OR row opens that row's own OR / CR box; RELEASE and SAVE RECEIPTS
   (`bulkRecordReceiptsAction`) write through `markReleased` / `recordReceipt` only. The old refusal
   of one box for a batch is replaced, not loosened — every box now has one owner — and a receipt
   keyed to an unticked cheque, a number with no type, and the old unkeyed fields are all refused
   before anything is written.
   The **type is stored, not parsed back out of the reference** — "OR-000123", "4471" and "CR 88"
   are all references a supplier writes, and a prefix rule over them is a guess dressed as a fact.
   **This hazard happened at scale before the rule existed.** The 9 September load wrote 2,727
   values shaped `CR 1234` into `crNumber`, taken from the register's column headed **REMARKS** —
   because the sniffer classified any `CR <digits>` cell as a clearing reference on the prefix
   alone. Client ruling 2026-09-11: they are the supplier's **Collection Receipts**.
   `scripts/repair-cr-receipts.ts` moves them to `orNumber` + `receiptType = CR` (`crNumber` back to
   null, one `receipt_reclassified_from_register` audit row each, a JSON snapshot first), and the
   sniffer now reads such a cell as `RECEIPT_REF`, written on create to the receipt columns and
   never to `crNumber`. Every `crNumber` in production after the repair is one Finance typed.
    **Since 2026-10-02 the receipt also has an amount and a scanned file, both add-only.** The
    amount is `Check.receiptAmount` (`Decimal(18,2)`, sent to the portal as a 2-decimal string,
    never a JS number); the file (PDF/JPG/PNG, at most 3 MB, signature-checked) is stored in
    `CheckReceiptFile` (BYTEA) and read only when a RECEIPT is delivered. Once recorded neither is
    overwritten: `attachReceiptFile` adds a missing amount or file later and refuses to replace one
    that is there. They travel to the portal as the `RECEIPT` outbox event, queued only for a
    portal-routed cheque with an APV (an INTERNAL or APV-less cheque records the receipt here and
    queues nothing). Server actions allow a 4 MB body (`bodySizeLimit` in `next.config.ts`).
    **The outbox has two lanes per cheque.** Status lane: MARK_AVAILABLE, REVERT, RELEASED,
    RELEASE_REVERSED, CANCELLED. Receipt lane: RECEIPT. Latest-wins supersedes within a lane only,
    so a RECEIPT never closes a status event. A RECEIPT is held until the cheque's newest
    status-lane event is SYNCED, across runs and while that event is PARKED. A RECEIPT settling
    never writes `Check.portalSyncStatus` or `portalTradeId`, and it is skipped when less than 6 s
    of the run remain (`lib/sync/portal-outbox.ts`); the receipt actions kick delivery with 25 s, the
    other actions with 8 s. Rollback is forward-fix only: Postgres cannot drop the `RECEIPT` enum
    value, so older code must not run while RECEIPT rows exist (review 2026-10-02).
12. **The portal client sends only.** Nothing reads a status from the portal into a cheque;
    `lib/integrations/portal/client.ts` has one method.

## Things that will catch you out

**The dashboard has two screens, and the URL decides which** (`dashboardScreen` in
`lib/dashboard-view.ts`, client request 2026-09-25). A bare `/` is TOTALS — cards, TODAY'S
RELEASE, timeline, a search box — and loads no rows. **Since 2026-09-29 so is a URL carrying
only `company`, `cashAccount` or `eligibility`** ("should have filter in every summary", spec
`2026-09-29-totals-filters-and-all-checks-design.md`): the TOTALS screen has those three
dropdowns (`components/TotalsFilterBar.tsx`) and every figure on it narrows — `getSummary`,
`getTodaysRelease` and `listTodaysReleaseIds` take a `SummaryNarrowing`, so RELEASE ALL releases
the set the narrowed panel counted, and a filter value that is present but unrecognised REFUSES
the release rather than widening it. A card, `scope=all`, `incomplete=1`, a search, or
**`scope=live`** is LIST: a BACK TO TOTALS bar and the full-width table. `scope=live` is the
NEEDS ACTION list said out loud — the list's filter bar carries it on that view so filtering
inside the list cannot land on `/?company=…`, which is now the totals; it changes no filter. ALL
CHECKS (card id `TOTAL_CHECKS`, `scope=all`, labelled TOTAL CHECKS until 2026-09-29) is a primary
card and **keeps the filters** like every other card — it is the cheque inventory; it no longer
clears them, RESET does. Export and print read the same URL and know nothing about screens. A
link that should open the list must carry one of the LIST parameters; a bare `/` or a
company/bank/eligibility-only URL never shows a table. `dashboardScreen` fails closed: any
`base` key outside `TOTALS_KEYS` (company, cashAccount, eligibility) opens the LIST, and RESET
and the incomplete toggle write `scope=live` on NEEDS ACTION so they cannot land on the totals.
**Since 2026-10-01 (part C) a `sort`/`dir` pair and every `f.*` filter-row parameter are LIST
parameters too** — `dashboardScreen` counts `selection.sort`, and the `f.*` values ride in `base`.
The LIST screen's "EXCLUDING N WITH NO RECORDED AMOUNT" count is the list's own:
`countChecks({ ...filters, incomplete: true })`, every list filter (view, search, company, bank,
eligibility, DATE RELEASED and the filter row), so N is exactly what "Show them" opens. BACK TO
TOTALS keeps company, bank and eligibility via `totalsHref` — narrowing to STK, opening SIGNED
and coming back lands on STK's totals.

**DATE RELEASED on the filter bar matches either of two dates that are never merged**
(2026-09-28, specs `2026-09-28-released-date-filter-design.md` and
`2026-09-28-stated-release-date-design.md`). `releasedAt` is the app's own record of a
release and only `markReleased` writes it; `statedReleaseDate` is the day the retired
register states, written once by `scripts/backfill-stated-release-dates.ts` from the
RELEASED sheets of a register file (exactly one calendar day per cheque — an Excel date
cell or the text `MM/DD/YYYY`, which is how 222 of the 228 rows dated 25 September were
typed, nothing else parsed, and nothing before 2015 or after the run day; exactly one
RELEASED cheque per number; never overwritten; one `stated_release_date_from_register`
audit row each; snapshot first). **Run once, 2026-09-28, from `CHECK MONITORING 9.25.2026.xlsx`
on the user's go-ahead: 10,494 stated days written (228 of them 25 September), 0 raced,
snapshot `snapshots/stated-release-dates-2026-09-28T09-48-10-422Z.json`; left alone 66
VOIDED here, 25 with two days, 168 with no usable date (68 say CLEARED), 234 not held here.**
`releasedFrom` / `releasedTo` are Manila days, honoured
only on the RELEASED and ALL CHEQUES views; the table shows the app timestamp or, failing
that, the stated day tagged REGISTER; the LIST screen counts the cheques with neither. Do
not write the stated day into `releasedAt`, and do not read `statedReleaseDate` as "the app
recorded a release" — `lib/recon/outstanding.ts` deliberately reads only `releasedAt`.

**The list sorts, filters per column and reorders** (part C, 2026-10-01, spec
`2026-10-01-signing-schedule-apv-and-table-design.md`). **Sort:** the order in force is the URL's
`sort=<column>&dir=asc|desc`, else the `cm_sort` cookie (`<key>:<dir>`, a year, `SameSite=Lax`,
written in the browser on a header click), else the default — the cookie is never written into a
URL, and RESET clears both. It is server-side over every matching cheque, nulls last both ways,
with `id asc` as the final tiebreak so a page boundary is stable. APV, PO, BANK and DATE RELEASED
are ordered in the app over the FULL matching set (`APP_SORTED_KEYS`, `lib/list-sort.ts`) because
Prisma cannot order by them; every other key is `listChecks`'s `orderBy`. Export and print read the
same cookie. **Filters:** the `f.*` parameters (`lib/column-filters.ts`; COMPANY, BANK and DATE
RELEASED keep their old names). **An unreadable box refuses, never widens**: `CheckFilters.refused`
makes `buildWhere` match nothing (`id IN ()`), so the list shows no rows with the boxes still
there and the bad one marked red; the export answers 400, print shows the refusal, and EXPORT
EXCEL / PRINT are drawn disabled. SIGN ALL honours the column filters — the server re-parses them
from the confirm form's hidden `f.*` fields, and the button is offered only when `signAllOffered`
(`lib/dashboard-view.ts`) says so; RELEASE ALL refuses any column filter. **Columns:** `cols=` on
EXPORT EXCEL reorders the file's columns and never drops one. The preference stays under
`check-monitoring.columns.v2` as an ordered list of visible columns (a part-B value reads as the
default order); a column forced visible because a filter is set on it is shown but never
persisted. Print keeps its fixed columns.

**`/welcome` is the public front door, and it is public by name** (2026-09-27, spec
`2026-09-27-landing-login-and-theme-design.md`). The landing page and `/login` both render
`components/MoneyMachines.tsx` — a cash register and a cheque register, inline SVG moved by the
`mm-*` keyframes in `app/globals.css`, running for as long as nobody is signed in; either page
redirects a signed-in visitor to `/`. `/welcome` is listed in `isPublicPath` (exact match, pinned),
the middleware sends an anonymous bare `/` there and every other guarded path to `/login` as
before, and sign-out lands on `/welcome`. `requireUser()` still redirects to `/login`. The page
reads no data and must never show a figure: it is the one page a stranger can load.

**A void or cancel of a cheque with no APV queues nothing for the portal** (2026-10-01, spec
`2026-10-01-cheque-numbering-and-cancel-guard-design.md`). The portal matches on APV and the client
refuses an event with none, so such an event parked on its first attempt and RETRY parked it again —
which is how `6000354350` and `1791259553` reached `/admin/portal`. `voidCheck` / `cancelCheck` now
ask `portalApvs` (`lib/integrations/portal/apvs.ts`, the same rule the client uses) first; a routed
cheque with none gets `portalSyncStatus = NOT_APPLICABLE` and `portalNotified: false` on its audit
row. Only CANCELLED is guarded. `scripts/close-unmatchable-cancelled.ts` closes the ones already
parked (`unmatchable: no APV numbers`, counted on `/admin/portal`). **Run once, 2026-10-01, by the
user with `--apply`: closed 2 of 2 (`6000354350`, `1791259553`), 0 left, snapshot
`snapshots/close-unmatchable-cancelled-2026-10-01T10-08-40-568Z.json`.** It ran just BEFORE that
day's deploy rather than after a cron delivery, so a no-APV CANCELLED still PENDING then could park
once more on the next run; if `/admin/portal` shows one, run the script again.

**NUMBERING (`/numbering`) checks cheque consecutives per cheque book.** Every cheque of every
status — VOIDED, CANCELLED and no-amount included — in BigInt order; each unused number between a
book's first and last is one MISSING line, however large (user ruling 2026-10-01: "every number
counts", not a booklet heuristic). The cheque book is the series key — Acumatica's CashAccount value
(spec §D, 2026-10-02); cheques with no book are a stated count. MISSING is bounded by the sync's scope (2026 onward, CHK only). A number Acumatica
re-used with a trailing dot — a second payment document on the same cheque number, which Acumatica
will not accept twice on one cash account — sits on `/admin/staged` as NO_CHECK_NUMBER and is shown
as a **STAGED** line, never MISSING (`stagedSeriesNumber`, spec §C, 2026-10-02). Measured that day:
169 staged payments end in dots, 66 of them on a number a different payment already holds here under
the same company — **do not strip the dot at import**; it would collapse two payments onto one
`(companyId, checkNumber)` cheque. Memo-numbered cheques (`PCF26-00001`) still hide behind MISSING;
the page says so. `next build` failed with *Cannot mix BigInt
and other types* (Next's file tracer) on `1n`-style literal arithmetic in `lib/numbering/series.ts`;
it uses `BigInt(0)` / `BigInt(1)` constants instead — keep it that way.

**A `|` inside `-t` breaks `npx.cmd vitest` under Git Bash.** `npx.cmd vitest run file -t "a|b"`
mis-tokenises the pipe; `node node_modules/vitest/vitest.mjs run file -t "a|b"` is the same
runner without the `.cmd` shim and works.

**`npx tsc --noEmit` is not optional.** Vitest transpiles with esbuild, which erases types — this
project has repeatedly had a fully green suite over unsound types. Overrides spread from a
union-typed `it.each` tuple also escape excess-property checking; that hid a real bug here.

**`middleware.ts` does not run LOCALLY — and DOES run on Vercel.** A clean local `next build` leaves
the middleware manifest empty (`export const runtime = 'nodejs'`, Next 15.5.25), which is where the
earlier claim that it never runs came from. **Measured 2026-09-11 against production:** an
unauthenticated GET of `/api/cron/sync` — a route with no session guard of its own — answered
**307 to `/login` with NextAuth's `__Host-authjs.csrf-token` cookie set**, and so did the same
request carrying a bearer. Only the `auth()` middleware wrapper does that. Vercel's build registers
the file; the local one does not. Two consequences, both binding:

- The page-level `requireUser()` / `requireAdmin()` guards remain the **primary** control and must
  stay — a local build that drops the middleware must leave the app protected, and a bad matcher
  edit must not be able to expose a page. **Every request-time control still lives in the request
  path.**
- **A route that a machine calls with a bearer and no session must be listed in `isPublicPath`
  (`lib/public-paths.ts`, tested) and must guard itself.** The scheduled sync was deployed without
  that and every evening's run would have been a 307 to a login page — reported as success, reading
  nothing. `tests/public-paths.test.ts` pins `/api/cron/` open and everything else closed.

**One agent at a time against the test database.** All test files share one Neon database and
`resetDb()` truncates it. Concurrent runs produce `40P01` deadlocks and spurious FK failures, and
they destroy an in-flight import. `fileParallelism: false` prevents this within a run and cannot
prevent it across processes.

**Prisma’s interactive-transaction defaults are far too tight for an import.** 5s to run, 2s to
acquire a connection. One row of `upsertCheck` is four round trips to ap-southeast-1, so across
9,515 rows one row eventually runs long and kills the WHOLE run — surfacing as *"Transaction not
found. Transaction ID is invalid, refers to an old closed transaction"*, which reads as a connection
fault and sends you to look at Neon rather than at the default. It killed the 9 September register
load after about 5,000 cheques. `TX_OPTIONS` in `lib/import/upsert.ts` raises it to 30s. Any new
long-running write loop needs the same; the import is idempotent, so a killed run costs only time.

**The Neon connection string contains `&`, and `prisma migrate dev` refuses a non-interactive
shell.** `node scripts/migrate.mjs test` and `node scripts/migrate.mjs prod --confirm` apply the
migrations with the URL passed in `argv` and no shell, printing the host and database first. Every
migration must reach the TEST database before the suite is run, or every database test fails on a
missing column. Any other script that spawns the Prisma CLI must do the same: URL as an argv entry,
`shell: false`.

**`.env` values are quoted; Vercel stores quotes literally.** `dotenv` strips them locally, so
`DATABASE_URL="postgresql://…"` works on a laptop and fails on Vercel with *"the URL must start with
the protocol postgresql://"*. `scripts/set-vercel-env.mjs` strips them.

**Tests must never point at the application database.** `tests/helpers/test-db-url.ts` refuses to
run when `DATABASE_URL_TEST` is unset or equal to `DATABASE_URL`.

**A threshold is a setting, and the constant is only its default.** Since 2026-09-12 `STALE_AFTER_HOURS`,
`ABANDONED_AFTER_MINUTES`, `SYNC_IN_PROGRESS_MINUTES`, `MAX_BULK_SELECTION`, `EXPORT_ROW_LIMIT`,
`VOUCHER_SCREEN_ROW_LIMIT`, `autoSign.mondayEnabled` and the three login-throttle allowances are the DEFAULTS in
`lib/settings/registry.ts`; the value in force comes from `loadSettings` at request time, and every
function that uses one takes it as a parameter. A new call site that reads the constant directly
silently ignores the admin's setting. The category list is a setting too, and the domain refuses a
category not on it.

## Layout

| Path | Responsibility |
| --- | --- |
| `lib/domain/` | Pure rules. No database, network, filesystem, clock. `check-status.ts` (the ladder), `eligibility.ts` (the portal gate), `receipt.ts` (the OR/CR box — see rule 11). `actions.ts` is the deliberate exception — it takes `db` and is the only module that changes a status. |
| `lib/import/` | Workbook parsing → `parse.ts`, `field-sniffer.ts`, `company.ts`, `implied-status.ts`, `bills.ts`, and `upsert.ts` — the single write path where duplicate prevention lives. |
| `lib/integrations/acumatica/` | OData reader and mapper. |
| `lib/sync/run.ts` | Incremental sync, watermark with a 120-minute overlap. |
| `lib/sync/bills.ts` | The BILLS read: `AP-PAYMENTS-WITH-BILLS` applications unioned into `Check.apvNumbers` by `acumaticaPaymentId`; own watermark, `runScheduledBillsSync` for the cron. |
| `lib/integrations/acumatica/bills.ts` | The inquiry's per-tenant columns (`BILL_FEED_COLUMNS`), `ge` date filters, read-only. |
| `lib/sync/bill-refs.ts` | The BILL_REFS read: `AP-Bills and Adjustments` → `AcumaticaBill` (APV → real POs); own watermark, `runScheduledBillRefsSync` for the cron. |
| `lib/integrations/acumatica/bill-refs.ts` | `extractPoNumbers` (real PO shapes only), the inquiry's one column map (both tenants), `mapBillRef`. Pure. |
| `lib/sync/modes.ts` | `SyncRun` modes that are not the payment feed (`BILLS`, `BILL_REFS`); every payment-side reader excludes `NON_PAYMENT_MODES`. |
| `lib/integrations/portal/` | Supplier Portal client: `client.ts` builds the event body from the cheque at delivery time (asserts rule 2 again, pre-checks the portal's validation) and POSTs it with the bearer and a timeout; `from-env.ts` reads `PORTAL_BASE_URL` / `PORTAL_TOKEN`. Sends only (rule 12). |
| `lib/sync/portal-outbox.ts` | The outbox worker: latest event per cheque wins, stale kinds closed unsent (`kindMatchesStatus`), exclusive claims, backoff, `PARKED` for a human, a 401 stops the run. |
| `lib/sync/portal-kick.ts` | Best-effort delivery within a time budget, from an action (`afterResponse`), the cron and `/admin/portal`; never throws, `{ skipped }` when the env is unset. |
| `lib/admin/portal-backlog.ts` | Backlog dry run for `scripts/portal-backlog.ts` (winners, superseded, `stale`) and `queueCancelledForStale` (`--queue-cancelled [--apply]`). |
| `lib/forecast/` | Cash outflow by cheque date: `buckets.ts` (the ageing buckets, pure), `query.ts` (the population — live, real, with an amount), `matrix.ts` (bucket × bank and bucket × stage, centavo-exact, pure). `/forecast` and `/api/export/forecast` sit on it. Since 2026-09-12 a cheque's typed `expectedOutflowDate` wins over its cheque date, and `PlannedOutflow` lines (`lib/planned-outflow/`, `/forecast/planned`) join the population as their own PLANNED column. |
| `lib/recon/` | Outstanding cheques: `outstanding.ts` (the as-of rule, pure), `summary.ts` (per account, centavo-exact, pure), `query.ts` (the released population). `/recon` and `/api/export/recon` sit on it. |
| `lib/list-sort.ts` | The list's order: params, the `cm_sort` cookie, database and in-app keys. Pure. |
| `lib/column-filters.ts` | The filter row's `f.*` parameters: parsing, refusal, description. Pure. |
| `lib/normalised-row.ts` | The one shape both ingestion paths converge on. |
| `lib/settings/` | The eleven settings: `registry.ts` (pure — defaults from the constants, bounds, parsing), `read.ts` (one query per request, never cached), `actions.ts` (admin-only writes, audited). `/admin/settings`. |
| `docs/superpowers/specs/` | The approved design, and the Supplier Portal API evidence. |
| `docs/superpowers/plans/` | Plans 1–3. Plan 4 (reports, notifications) not yet written. |
| `docs/deployment.md` | Vercel procedure and blockers. |

## Data facts, measured — do not re-derive by assumption

The register (`CHECK MONITORING 9.1.2026.xlsx`) has 15 sheets and 12,227 data rows.

- **The payee is column E and the amount is column J on every sheet.** Read positionally. Guessing
  produced four classes of wrong payee (amounts, cash-account labels, point-person names) and, at
  one point, cheque numbers fabricated out of amounts.
- Import outcome: **9,461 rows import → 9,247 distinct cheques**; 2,639 stage for no company, 61 for
  an ambiguous company, 66 for no cheque number. Every row is accounted for; nothing is dropped.
- **129 of the register-derived cheques carry no amount** (production, re-measured 2026-09-06).
  The register's amount cell was blank or held the word "CANCELLED". They break down
  48 CANCELLED / 29 SIGNATURE_PENDING / 25 RELEASED / 23 SIGNED / 4 VOIDED, and 83 name a real
  payee. `Check.isIncomplete` flags them; `scripts/backfill-incomplete.ts` re-derives it.

  **MOST OF THEM ARE CANCELLED CHEQUES, which is the client's own reading and it is right.** 80 of
  the 129 carry at least one cancellation signal: 59 sit on the register's CANCELLED sheet, 52 hold
  a CANCELLED or VOIDED status here, and **45 are Voided in Acumatica** — a voided payment keeps no
  amount, so a blank cell is what a cancellation is supposed to look like, not a defect.

  An earlier note here claimed Acumatica "has no record of any of them". **That was measured on
  2026-09-04, before the full sync, and it is no longer true**: 51 now match (45 Voided, 4 Closed,
  2 Balanced). Re-measure before repeating a count from this file.

  49 carry no cancellation signal. 15 of those were released with no amount recorded in either
  system — 13 on the BDO RELEASED sheet, 1 on MBTC P&P RELEASED, 1 Closed in Acumatica.

  **CLIENT RULING 2026-09-06: leave them alone.** "Those 15 are released in the excel records but
  no amount. Ignore them." The cheques were handed over and the register says so; the amount was
  never written down and would have to come off a stub or a bank statement. Finance has decided
  that is not worth doing. **Do not raise this again, and do not write an amount for any of them** —
  a figure reconstructed from a bank statement and stored as if the register held it would be
  indistinguishable from a recorded one. They stay flagged `isIncomplete` and stay excluded from
  every total, which is the honest representation of a cheque whose value nobody knows.
  **They are excluded from every currency total rather than counted as zero** — SQL `SUM()` skips a
  null — and `tests/queries.test.ts` pins that. Do not "fix" it.
  **Since 2026-09-06 they are also out of the dashboard entirely**: "ignore them mean you have to
  remove them, dont consider them becuase they dont have amount". `CheckFilters.incomplete` is now a
  tri-state (`true` only them, `false` exclude, `undefined` no filter) and the dashboard, the export
  and the printed sheet all pass `false`. **Nothing was deleted** — rule 10 still stands — and the
  exclusion is stated on screen with the count and a link to `?incomplete=1`, which is the price of
  hiding them. `getSummary` narrows itself the same way `buildWhere` does, so a card's number is
  always the number of rows its table shows. There is no INCOMPLETE card any more.
- **The register's two reference columns hold the opposite of what their headers say.** Measured
  2026-09-07 over all fifteen sheets: the column headed `CHECKS APV` (column 4) holds **11,584 CV
  references and exactly one AP**, and the column headed `VOUCHER NUMBER` (column 8) holds **11,944
  AP references and no CV at all**. Do not read either positionally. `sniff` discriminates on the
  `AP-`/`CV-` prefix and always has, which is why `cvNumber` was right all along — the vouchers were
  parsed too and simply had nowhere to go, because `Check` had no column for them. It has one since
  2026-09-07 (`apvNumbers`), and `scripts/backfill-apv-numbers.ts` fills it for cheques that
  pre-date it.

  11,904 parsed rows carry at least one voucher, covering **11,552 of the register's 11,779 distinct
  cheque numbers**. Those keyed rows carry **10,973 distinct vouchers**; twelve more sit on rows
  that cannot be keyed at all and are staged `NO_CHECK_NUMBER`, for 10,985 across the whole
  register. An import **unions** them onto the
  cheque rather than replacing: 360 cheque numbers sit on more than one row and 11 of those state a
  different voucher on each, so last-writer-wins loses one. An empty incoming array — every
  Acumatica row, since the payments inquiry publishes no bill references — never clears what the
  register recorded; the vouchers arrive by the separate BILLS read instead.

  Three cells in that column are AP vouchers `sniff` does not classify: `AP-A1-02663` and
  `AP-A1-030274` (a dash the `APV` pattern does not allow) and `AP-1PP-AP-000014` (a mis-key of
  `A1PP-AP-000014`). They fall to free text and are **left alone** — widening the pattern re-classifies
  12,000 rows to recover three, which is the wrong trade until somebody re-measures it.
- **The approval workbook's sheet names change with every export; its header does not.** 4 Sep:
  `LIST` + `PIVOT`. 7 Sep: `local supplier` (227 rows) + `BROKERAGE` (11) + `Sheet3`, the pivot.
  10 Sep: the same two data sheets + `PIVOT` again. `lib/import/bills.ts` therefore identifies a
  data sheet by the **24-column Acumatica header on row 1** (`isBillSheet`) and reads every sheet
  that carries it — a pivot's row 1 is empty. **Do not reintroduce a sheet-name check**: pointed at
  the 7 September file, the `LIST`-only parser read zero rows and reported success. Every sheet is
  reported by name, read or skipped, by the CLI and on `/admin/import`.
  `local supplier` ∩ `BROKERAGE` on 7 Sep is **two vouchers, both naming the same cheque**, so the
  `(checkId, apvNumber)` unique index folds them and there is nothing to arbitrate. A voucher naming
  *different* cheques on two sheets would be a real conflict; it has not occurred.
  **`BROKERAGE` is a separate portal stream** (`POST /api/broker-checks/mark-available` vs
  `/api/checks/mark-available`). Nothing routes on it yet — Plan 3 — and the sheet is recorded on
  every bill's audit row and on every `StagedBill`. `CheckBill` has no `sourceSheet` column; adding
  one is the first thing Plan 3 will need.
- **The approval workbook's `check No.` column is not trustworthy.** Client instruction 2026-09-07:
  *"In CHECK MONITORING 9.4.2026 please use acumatica as reference for check numbers."* Row 81 of
  the `LIST` sheet holds the date `2026-08-13` where the cheque number belongs — that being cheque
  `6000353106`'s own date — and it is the only one of the 85 like that. Such a row is now resolved
  by its **voucher** against `Check.apvNumbers`, and only when that finds **exactly one** cheque;
  none or more than one and it is staged. A good cheque number that names no cheque here is *not*
  re-resolved by voucher — that would be overruling the workbook on evidence it did not offer.
  The 7 September workbook has **50 such rows**, not one — 47 on `local supplier`, 3 on `BROKERAGE`.
  Scale is not a reason to relax "exactly one match or stage it", and it has not been relaxed.
- **The approval workbook IS the release list, in both directions.** Two client rulings.
  *(2026-09-04)* A cheque carrying a bill from that workbook belongs at READY_FOR_RELEASE —
  `scripts/backfill-available.ts`, which also demotes any READY_FOR_RELEASE cheque NOT on the list.
  *(2026-09-10)* A voucher present on an OLDER approval workbook and absent from a NEWER one was
  released in between — `scripts/backfill-released-dropped.ts`.

  The second **writes RELEASED over an ERP that says otherwise**, knowingly: of the 51 vouchers that
  dropped between 4 and 7 September, 49 of the cheques they name were still `Balanced` in Acumatica
  and not one was `Closed`. On the usual rule that means "not released". The client resolved it:
  *"Those are not in the list of course will reflect balance in acumatica because no update yet for
  the released checks in acumatica."* The ERP entry lags the counter — the very lag this system
  exists to close. Every audit row records what Acumatica said at the time, so the disagreement is
  visible rather than buried. `releasedAt` and `releasedById` stay null: neither is knowable from a
  workbook, and a fabricated timestamp on a release record is worse than none.

- **A refused approval-workbook row lands in `StagedBill` and shows on `/admin/staged`.** This is
  why `AP-ST042652` was missed: the importer refused the row correctly and reported it correctly, to
  a terminal, once, during a run nobody was watching. `StagedBill` is deliberately **not** a
  `StagedCheck` — every staged cheque carries an `impliedStatus` and a bill has none, and this
  workbook's `FINANCE REMARKS = AVAILABLE` is evidence, never an instruction. It carries no amount
  and no vendor, because a bill's `Detail Total` displayed beside cheque amounts is read as a
  cheque's figure sooner or later.
- **THE REGISTER’S AMOUNTS ARE NOT RELIABLE. ACUMATICA’S ARE.** Measured 2026-09-10, and it is the
  strongest evidence yet for the client’s "follow Acumatica" ruling. The 9 September register import
  changed 94 amounts on cheques Acumatica also knows. All 94 were read back from the live ERP:
  **the register was wrong in every one, Acumatica right in every one.** Seven moved by more than
  PHP 10,000 and one turned 217,037.94 into 27,037.94 — a leading digit dropped. The small ones look
  like plausible net-to-gross corrections (3,928.57 -> 4,000.00 is exactly 12% VAT) and are not:
  they are wrong too. **Do not accept a register amount over an Acumatica one, and do not reason
  from the shape of the difference.**

  The same import also moved **1,958 cheques to a company Acumatica contradicts**, silently, because
  `companyId` and `amount` are both in `IMPORT_WRITABLE`. Both were restored from a pre-import
  snapshot, with 2,052 audit rows. **The ruling is still not enforced in code** — nothing in
  `upsertCheck` stops a register row overwriting a field the ERP owns, and this was caught only by
  diffing against a snapshot taken by hand beforehand. **Snapshot before any bulk write to
  production**: it is the only reason that recovery was exact rather than reconstructed.

- **Acumatica bank-prefixes 90% of its cheque references** (`BPI 6000240287`) while the register
  writes them bare. `canonicalCheckNumber` reconciles them — without it the same cheque stores twice.
- **`Branch` from Acumatica is space-padded** (`"A1+       "`). `orNull` trims it; an untrimmed read
  resolves every payment to no company.
- **`PaymentMethod` decides `isCheque`**, alongside the China-branch rule. `DEBIT ADV` and `CASH` are
  not cheques and must not offer a SIGN button.
- **Acumatica's `CashAccount` column is the CHEQUE BOOK, not this system's cash account.** It states
  `BPI-S-4636`, `MBT-A-4155`, `BDO-A-3838` — the eight `CheckBook` codes the register used — while
  `CashAccount` here holds six register labels (`BPI STK`, `MBTC A1+`, …). Until 2026-10-02 `map.ts`
  dropped it (`checkBookCode: null`) and looked it up as a cash account, which never matches: 3,844
  Acumatica cheques had no cheque book and 3,501 cheques neither, 1,091 of them dated since the register
  stopped. The sync now records it; `scripts/backfill-check-books.ts` fills the rest (company-checked:
  a book under another company is reported, never set). The sync applies the same company check as the
  repair: a book under another company is refused and noted (`checkBookRefused`) in the import audit
  row. NUMBERING groups by cheque book. **The dashboard BANK filter/column still keys on the
  cash-account label and sees only ~1,342 cheques** — an open follow-up. RECON's bank filter and BANK
  column, the forecast's bank split, `/vouchers`' BANK column and portal event bodies already fall back
  to the cheque book's bank, so they fill in as books are recorded; RECON still groups per cash
  account. `PCF-SITIO`, `PAYROLL`, `PCF-SILANG`, `RSB-S-0869`, `MBTC-S-988` are no cheque book.
- A voided cheque is **two feed rows** under one reference; the original's positive amount survives.
- **Which cheque pays an AP voucher is answered on `/vouchers`, and `CHECK BY VOUCHER.xlsx` is
  its extract.** The Finance Executive Report's `AP Local` sheet used to find a payable's cheque
  with three `VLOOKUP`s into the released sheets of `CHECK MONITORING <date>.xlsx`; the register
  was retired on 2026-09-10 and a `VLOOKUP` into a stale external returns its last cached value for
  ever rather than failing. A handover asking Finance to repoint those formulas was written and
  then withdrawn the same day on the client's ruling: *"I want the report to be done in the portal.
  And report can be extracted from there."* Measured over `AP Local`'s 1,472 distinct vouchers: 986
  name exactly one cheque, 54 name more than one (46 of them a re-issue with a single live cheque),
  432 name none. The old formulas could answer 2 of the 1,472, because they looked only at released
  cheques and `AP Local` is the OPEN payables ledger. `resolveVoucherRows` in
  `lib/export/voucher-index.ts` is the one judgement both the screen and the file are built from;
  do not add a second. The extract keeps its fixed filename, fixed sheet `INDEX` and the timestamp
  in `$A$2` — a stable shape costs nothing — but nothing outside this system depends on them now.

## State

Plans 1 and 2 complete. Plan 3 is superseded by `docs/superpowers/plans/2026-09-26-portal-outbox-delivery.md` (spec
`2026-09-26-check-monitoring-integration-design.md`): the outbox is delivered by
`lib/sync/portal-outbox.ts` to the portal's `POST /api/integrations/check-monitoring/events`
with `PORTAL_BASE_URL` / `PORTAL_TOKEN` (a bearer, no session), latest event per cheque wins,
`/admin/portal` shows what parked. Pickup confirmations back (old Task 6) remain a follow-up.
**1,913 tests across 130 files** (measured 2026-10-05 on `feature/po-from-acumatica` after merging
master b190a79: one full run, 1,903 passed and 10 failed on 5-second timeouts in 7 files while this
machine's connection to the Neon test database was intermittently dropping — "Can't reach database
server" — and all 7 files then passed when re-run alone, 185/185; PO from Acumatica added
`integrations/acumatica-bill-refs`, `sync/bill-refs`, `sync/modes` and extended `queries`,
`sync/cron-route`, `sync/run`, `sync/bills`, `admin/sync-overview`, `schema`, `export/route`) —
1,805 across 126 (measured, full run 2026-10-05, 45.4 minutes, on
`feature/check-books`: the cheque book from Acumatica, `backfill-check-books`, NUMBERING by book —
`admin/check-books` new, `import/upsert`, `integrations/acumatica-map`, `numbering/query`,
`export/numbering-route` extended. 5 cases in `admin/actions`, `admin/backfill-apv-numbers` and
`admin/repair-cr-receipts` hit the 5 s test timeout while the remote test database was slow and passed
when re-run alone, 35/35) — 1,792 across 125 (measured, full run 2026-10-02, 58.3 minutes — the remote test
database was slow that hour — 0 failures, on `feature/numbering-staged`: STAGED dotted re-uses on
NUMBERING, +15 in `numbering/series`, `numbering/query`, `export/numbering-workbook`) — 1,777 across 125 (measured, full run 2026-10-01, 31.0 minutes, 0 failures, on
`feature/apv-po-and-table` — parts B and C — after merging master) — +152 and 4 files over the 1,625:
`sync/bills` and `integrations/acumatica-bills` (new, the BILLS read), `list-sort` and `column-filters`
(new, part C), and `queries`, `dashboard-view`, `dashboard-links`, `table-columns`, `export/*`,
`actions/bulk-actions`, `import/upsert`, `sync/run`, `sync/cron-route`, `admin/sync-overview` extended.
1,625 across 121 (measured, full run 2026-10-01, 23.0 minutes, 0 failures, on the
merge of both branches below). Two branches measured from the same 1,543 base on 2026-10-01, each 0 failures:
**1,600 across 120** on `feature/numbering-cancel-guard` before its merge (22.2 minutes; the CANCELLED
guard, close-unmatchable-cancelled and NUMBERING, +57 across 7 new files), and **1,568 across 114** on
branch `feature/signing-schedule` before its merge (22.2 minutes) — the signing schedule
(`actions/revert-signature` new; `domain/auto-sign`, `sync/auto-sign`, `actions/auto-sign` rewritten;
`domain/check-status`, `settings/registry`, `sync/cron-route`, `queries`, `dashboard-view`,
`actions/bulk-actions`, `actions/server-actions`, `row-receipts` extended; `scripts/auto-sign-backlog.ts` deleted)
— 1,543 across 113 (measured, full run 2026-09-29, 21.8 minutes, 0 failures,
on branch `feature/totals-filters-all-checks` before its merge) — 1,537 across 113 before the final-review fixes
(`dashboard-view` +5: `totalsHref` 3, `dashboardScreen` fails closed 1, RESET / incomplete
toggle stay on the list 1; `actions/bulk-actions` +1: a whitespace filter refuses); 1,519 across 113 before the TOTALS-screen filters and ALL
CHECKS (`dashboard-view` +5, `export/dashboard-params` +3, `dashboard-links` +1, `queries` +6,
`actions/bulk-actions` +3; measured, full run 2026-09-28, 30.8 minutes; one case in
`actions/receipt` failed in that run and passed alone straight after — a timeout while a
production script shared the connection, not a defect) — 1,497 across 112 before the stated
release date (`admin/stated-release-dates` 18, `queries` +4); 1,479 across 112 before the DATE RELEASED filter (`queries` +5, `export/dashboard-params` +6, `export/report` +3, `table-columns` +2, `dashboard-links` +2); 1,404 across 104 before the portal outbox delivery (`schema` +1, `actions/portal-cancel` 3, `integrations/portal-client` 13+, `sync/portal-outbox` 25+, `sync/portal-kick` 5, `sync/cron-route` +1, `admin/portal-overview` 2, `admin/portal-actions` 3, `scripts/portal-backlog` 3, plus the void-path assertions in `actions` and `import/upsert`); 1,380 across 101 before the two-screen dashboard and per-row OR (`dashboard-view` +2, `queries` +1, `row-receipts` 7, `receipt-form` 6, `bulk-actions` +5 with four receipt cases rewritten, `release-keeps-receipt` 3); 1,380 across 101 measured earlier the same day — 1,350 across 98 before auto-sign (`domain/auto-sign` 9 —
Manila calendar days and the exact boundary, `actions/auto-sign` 3, `sync/auto-sign` 8 — the plan's
five plus NOT_FOUND-skip, time budget and the calendar-vs-72h list case,
`sync/cron-route` +3, `settings/registry` +1 and one case renamed); 1,344 across 97 before the for-release list (`admin/release-list` 6); 1,332 across 96 before the register catch-up (`admin/register-releases` 12); 1,327 across 95 before the module bar (`module-nav` 5); before that 1,290 across 89, then the outstanding-cheques report +37
(`recon/outstanding` 12, `recon/query` 7, `recon/summary` 6, `recon-view` 5, `export/recon-workbook` 4,
`export/recon-route` 3). Before that: 1,254 across 85, then the settings +36
(`settings/registry` 12, `settings/actions` 7, `settings/read` 5, `actions/settings-actions` 3, one case in each
of six consumer files, `actions/clearing-bulk` +1, `domain/details` +1, `planned-outflow/actions` +1).
Before that: 1,218 across 82, then the forecast calibration +36
(`planned-outflow/actions` 13, `domain/planned-outflow` 6, `forecast/query` +4, `actions/planned-outflow-actions` 3,
`domain/details` +2, `actions/update-details` +2, `forecast/matrix` +2, `actions/server-actions` +1,
`export/forecast-workbook` +1, `export/audit-workbook` +1, `admin/audit-query` +1). Before that: 1,176 across 77, then the Finance inputs +42
(`admin/repair-cr-receipts` 9, `clearing-paste` 9, `domain/details` 6, `actions/update-details` 6,
`actions/clearing-bulk` 5, `actions/server-actions` +4, `import/parse` +1, `import/upsert` +1,
`domain/check-status` +1). Before that: 1,048 across 61 after the voucher screen; then scheduled-sync +21
(`sync/run` +5, `sync/scheduled` 5, `sync/cron-route` 6, `sync/staleness` 5), the middleware hotfix
+4 (`public-paths`), the cash-outflow forecast +58 (`forecast/buckets` 19, `forecast/query` 14,
`forecast/matrix` 8, `forecast-view` 8, `export/forecast-workbook` 6, `export/forecast-route` 3),
the release reversal +18 (`domain/check-status` +1, `domain/reversal` 4, `actions/reverse-release`
10, `actions/server-actions` +3), and the audit screen +27 (`audit-view` 14, `admin/audit-query` 7,
`export/audit-workbook` 3, `export/audit-route` 3). The file count is read off disk
(`find tests -name "*.test.ts" | wc -l`, 2026-09-11).
Arithmetic on two measured figures, not a reading off one full-suite run: the whole suite takes ~20
minutes because every test crosses to ap-southeast-1, so it is run before a merge, not per change.

Production is `check_monitoring_prod` on Neon. Both outstanding migrations were applied on
2026-09-10 — `20260907000000_check_apv_numbers_and_staged_bill` and
`20260910000000_check_receipt_type` — so schema and database agree. As of that evening:
11,870 cheques, 9,224 carrying an AP voucher (from 84), 287 bills, 0 staged bills.
Migration `20261005000100_acumatica_bill` (the `AcumaticaBill` table) must reach production BEFORE the deploy that carries it: the list, export and print query the table on every request.

### What is missing, measured 2026-09-10 — in priority order

1. **The scheduled sync is LIVE** — deployed, `CRON_SECRET` set, production migrated, first
   scheduled run 2026-09-11 08:42 Manila: both tenants, one second each, 0 errors, 27 rows
   updated. Item 1 is closed; what follows is how it works and what switching it on took. `vercel.json` carries
   two crons on `/api/cron/sync`: `"0 4 * * *"` and `"0 10 * * *"` UTC — 12:00 and 18:00 Manila,
   daily. Hobby's limit is once per day PER JOB, so each further run is a further entry in
   `vercel.json`. The route authenticates with `CRON_SECRET` on its first line and refuses
   to run while it is unset; it never runs FULL — no watermark means a recorded refusal on
   `/admin/sync`, and a first read stays a terminal job (`scripts/sync.ts`). `runSync` now refuses
   to overlap another run of the same tenant inside `SYNC_IN_PROGRESS_MINUTES` (10), records
   `trigger` (MANUAL | SCHEDULED), and writes a true `finishedAt` — every run before 2026-09-11
   has `finishedAt = startedAt`, because `finish` wrote the start instant. The dashboard states
   ACUMATICA LAST READ per tenant and warns past `STALE_AFTER_HOURS` (30).
   **To go live:** set `CRON_SECRET` in Vercel, `node scripts/migrate.mjs prod --confirm`,
   `npx vercel --prod`, then trigger the job once from the Vercel dashboard and confirm two
   SCHEDULED rows on `/admin/sync`. Until that is done, item 1 is still open in production.
   **Auto-sign** (rewritten 2026-10-01, spec `2026-10-01-signing-schedule-apv-and-table-design.md`): the cron runs at 12:00 and 18:00 Manila (`0 4 * * *`, `0 10 * * *`); on a Manila Tuesday only, an Acumatica cheque first read on the Monday before and still at SIGNATURE_PENDING becomes SIGNED (`signedById` null, one `auto_signed` row, no portal event). Every other pending cheque is signed by SIGN ALL on the SIGNATURE PENDING list (server-confirmed like RELEASE ALL, every Finance user). `SIGNED -> SIGNATURE_PENDING` is `revertSignature`, every Finance user, reason optional, one `signature_reverted` row; a reverted cheque is never auto-signed again. Setting `autoSign.mondayEnabled` (1/0) replaces `autoSign.afterDays`. Every run writes one `auto_sign_run` row (read by LAST AUTO-SIGN on `/admin/sync`: "N Monday cheque(s) signed", "not a Tuesday - nothing due", "switched off in settings") - `IDLE` on a non-Tuesday; a FAILED run turns the cron response 500, and the route's 50-second time budget still applies. Nothing retries a failed run by hand: the 18:00 run retries what 12:00 left (same Monday window); anything left after 18:00 waits for SIGN ALL, and the FAILED message says which (`LAST_RUN_UTC_HOUR` in `lib/sync/auto-sign.ts`, tied to `vercel.json`). Rule 4 is untouched: the sync never writes status.
   SIGN ALL and RELEASE ALL share one unexported helper `runConfirmedAll` (`app/checks/bulk-actions.ts`) and one client form `components/ConfirmAllForm.tsx`; the confirm block stays mounted while `?confirm=` is set, so the success report stays on screen after a run. SIGN ALL is offered only on the SIGNATURE PENDING list with no search and the incomplete toggle off; its set excludes non-cheques (DEBIT ADV, CASH) and the page states how many. The bulk bar's REVERT TO PENDING has its own optional reason box.
2. **One active FINANCE_ADMIN**, of three active users. This stopped being housekeeping the moment
   admin-only actions shipped (revert availability; the release reversal below). One forgotten
   password locks administration, and one has already been forgotten on this system.
3. **The audit trail can be read** (built 2026-09-11): `/admin/audit`, FINANCE_ADMIN only. It opens
   on people's actions — measured that day, 4 of 65,269 rows; the rest are imports, backfills and
   the sync — with SYSTEM ROWS one toggle away, because the 10 September restorations are SYSTEM
   rows and are the record an auditor asks for. Filters: action (from `SELECT DISTINCT`, never a
   list), user, cheque number (through the join, so the 17,087 detached rows cannot match it and
   the page says so), Manila dates. Keyset pagination on `(createdAt, id)`; four indexes in
   `20260911000200_audit_log_indexes`, which must reach production before the deploy. Excel extract
   of the filtered range at `/api/export/audit`. `writeAudit` remains the only writer.
4. **No notifications at all.** A failed sync is silent; nobody is told a cheque is ready or that a
   supplier booked a pickup.
5. **3,718 staged rows with no owner** — no ageing, no alert, nobody assigned.
6. **"Acumatica wins" is not enforced in code.** See the amounts note above.
7. **No general snapshot step before a bulk write.** The 10 September recovery depended on one
   taken by hand. `scripts/repair-cr-receipts.ts` (2026-09-11) builds its own — a JSON of every
   affected row under `snapshots/`, written before the first write — and is the pattern for the
   next repair; nothing yet makes it automatic for `upsertCheck`.
8. **A release can be reversed** (built 2026-09-11, client design of 2026-09-10). `reverseRelease`
   in `lib/domain/actions.ts`: FINANCE_ADMIN only, mandatory reason, back to READY_FOR_RELEASE with
   the availability kept and the collection cleared, one `release_reversed` audit row recording
   what was undone. **Refused outright when a receipt is on record** — the supplier's own paper —
   and, an addition approved the same day, **when any clearing is recorded**: money the bank has
   paid cannot be un-handed-over. Both refusals live in `lib/domain/reversal.ts`, which the page
   reads too, so an admin is told why rather than shown a button that would refuse. The portal is
   told `RELEASE_REVERSED` — a fourth `PortalEventKind`, delivered via `POST /api/checks/:id` with
   `status: AVAILABLE_FOR_RELEASE` when Plan 3 delivers — and deliberately NOT `REVERT`, which the
   portal reads as withdrawn for re-upload. Measured before building: none of the 9,594 released
   cheques carries a receipt, `releasedAt`, or clearing, because `markReleased` has never run in
   production; both refusals are forward-looking. Migration
   `20260911000100_portal_event_release_reversed` must reach production before the deploy.
   (Reverting availability, READY_FOR_RELEASE -> SIGNED, has been on the detail page since
   2026-09-10.)
9. The test suite takes ~20 minutes because every test crosses the South China Sea. A local Postgres
   would make it ~2. It is the tax on every deploy.
10. **The cash-outflow forecast is BUILT** (2026-09-11) — `/forecast`, on the cheque date read as
   PRESENTABLE FROM, because no pickup or release date has ever been recorded (measured: null on
   every row) and a cheque's date is the day from which it can be presented. Live cheques by bank
   and by stage in Finance's own ageing buckets; the file is the view. What it cannot yet show is
   actual outflow by day: that begins the day releases go through the app and `releasedAt` fills.
   Of the other three reports Finance named, **the bank reconciliation's cheque side is built**
   (2026-09-12): `/recon` gives every cash account's outstanding cheques — released and not
   cleared — as of a day, the OC column of the Cash Balance sheet, with its extract; deposits in
   transit and the balances stay with the bank statement, whose import waits for a sample export.
   Hedging and the foreign outlook are not buildable here; the voucher-index spec's closing section
   records why. **Calibrated 2026-09-12:** Finance types the day a cheque is expected to leave the
   bank (EXPECTED OUT, on the cheque page; the forecast places it there) and planned non-cheque
   outflows — payroll, tax, loans, transfers — as one-off lines on `/forecast/planned`, open until
   marked PAID or CANCELLED, never deleted. The daily cash position is no longer cheques only.
11. **Cheque-book companies are unverified** (2026-10-02, spec §D). `CheckBook.companyId` comes from
   the retired register's cheque-book table — the same reference data the 2026-09-06 ruling called
   "wrong somewhere". The sync and `backfill-check-books.ts` refuse a book under another company than
   the cheque's (audited as `checkBookRefused`; reported as `companyMismatch`), and a cheque refiled
   to another company keeps its old book when Acumatica names none or a refused one — deliberately:
   the booklet a cheque was written from is a physical fact, and nulling it would drop the cheque out
   of its NUMBERING series and fake MISSING numbers. **Next:** count cheques whose book's company
   differs from theirs, grouped by (book, book company, cheque company), plus the dry run's
   `companyMismatch`; if a book is systematically under the wrong company, put it to the client and
   correct `CheckBook.companyId` in reference data (snapshot, audited) — not per cheque.
