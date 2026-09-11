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
  each needs to be reachable on screen.
- Where the two disagreed, **the register was wrong** — 94 amounts and 1,958 company assignments,
  measured below. That is the strongest argument for this decision, and worth repeating to
  anyone who wants the spreadsheet back.

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
   columns; `recordClearing` is the only writer of `crNumber`. Pinned by `tests/actions/receipt.test.ts`.
   The **type is stored, not parsed back out of the reference** — "OR-000123", "4471" and "CR 88"
   are all references a supplier writes, and a prefix rule over them is a guess dressed as a fact.

## Things that will catch you out

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

## Layout

| Path | Responsibility |
| --- | --- |
| `lib/domain/` | Pure rules. No database, network, filesystem, clock. `check-status.ts` (the ladder), `eligibility.ts` (the portal gate), `receipt.ts` (the OR/CR box — see rule 11). `actions.ts` is the deliberate exception — it takes `db` and is the only module that changes a status. |
| `lib/import/` | Workbook parsing → `parse.ts`, `field-sniffer.ts`, `company.ts`, `implied-status.ts`, `bills.ts`, and `upsert.ts` — the single write path where duplicate prevention lives. |
| `lib/integrations/acumatica/` | OData reader and mapper. |
| `lib/sync/run.ts` | Incremental sync, watermark with a 120-minute overlap. |
| `lib/forecast/` | Cash outflow by cheque date: `buckets.ts` (the ageing buckets, pure), `query.ts` (the population — live, real, with an amount), `matrix.ts` (bucket × bank and bucket × stage, centavo-exact, pure). `/forecast` and `/api/export/forecast` sit on it. |
| `lib/normalised-row.ts` | The one shape both ingestion paths converge on. |
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
  register recorded.

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

Plans 1 and 2 complete. Plan 3 (portal automation) still paused: the portal needs an `encoder`
service account that does not exist, and until it does every `PortalEvent` simply queues.
**1,149 tests across 73 files** — 1,048 across 61 after the voucher screen; then scheduled-sync +21
(`sync/run` +5, `sync/scheduled` 5, `sync/cron-route` 6, `sync/staleness` 5), the middleware hotfix
+4 (`public-paths`), the cash-outflow forecast +58 (`forecast/buckets` 19, `forecast/query` 14,
`forecast/matrix` 8, `forecast-view` 8, `export/forecast-workbook` 6, `export/forecast-route` 3),
and the release reversal +18 (`domain/check-status` +1, `domain/reversal` 4,
`actions/reverse-release` 10, `actions/server-actions` +3). The file count is read off disk
(`find tests -name "*.test.ts" | wc -l`, 2026-09-11).
Arithmetic on two measured figures, not a reading off one full-suite run: the whole suite takes ~20
minutes because every test crosses to ap-southeast-1, so it is run before a merge, not per change.

Production is `check_monitoring_prod` on Neon. Both outstanding migrations were applied on
2026-09-10 — `20260907000000_check_apv_numbers_and_staged_bill` and
`20260910000000_check_receipt_type` — so schema and database agree. As of that evening:
11,870 cheques, 9,224 carrying an AP voucher (from 84), 287 bills, 0 staged bills.

### What is missing, measured 2026-09-10 — in priority order

1. **The scheduled sync is LIVE** — deployed, `CRON_SECRET` set, production migrated, first
   scheduled run 2026-09-11 08:42 Manila: both tenants, one second each, 0 errors, 27 rows
   updated. Item 1 is closed; what follows is how it works and what switching it on took. `vercel.json` carries
   `crons: [{ path: /api/cron/sync, schedule: "0 10 * * *" }]` — 18:00 Manila, daily, which is the
   Hobby plan's ceiling. The route authenticates with `CRON_SECRET` on its first line and refuses
   to run while it is unset; it never runs FULL — no watermark means a recorded refusal on
   `/admin/sync`, and a first read stays a terminal job (`scripts/sync.ts`). `runSync` now refuses
   to overlap another run of the same tenant inside `SYNC_IN_PROGRESS_MINUTES` (10), records
   `trigger` (MANUAL | SCHEDULED), and writes a true `finishedAt` — every run before 2026-09-11
   has `finishedAt = startedAt`, because `finish` wrote the start instant. The dashboard states
   ACUMATICA LAST READ per tenant and warns past `STALE_AFTER_HOURS` (30).
   **To go live:** set `CRON_SECRET` in Vercel, `node scripts/migrate.mjs prod --confirm`,
   `npx vercel --prod`, then trigger the job once from the Vercel dashboard and confirm two
   SCHEDULED rows on `/admin/sync`. Until that is done, item 1 is still open in production.
2. **One active FINANCE_ADMIN**, of three active users. This stopped being housekeeping the moment
   admin-only actions shipped (revert availability; the release reversal below). One forgotten
   password locks administration, and one has already been forgotten on this system.
3. **The audit trail is write-only.** 2,052 rows were written on 2026-09-10 alone and no screen in
   the app can read them. `/admin` has users, sync, import and staged — no audit.
4. **No notifications at all.** A failed sync is silent; nobody is told a cheque is ready or that a
   supplier booked a pickup.
5. **3,718 staged rows with no owner** — no ageing, no alert, nobody assigned.
6. **"Acumatica wins" is not enforced in code.** See the amounts note above.
7. **No snapshot step before a bulk write.** Today’s recovery depended on one taken by hand.
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
   The other three reports Finance named — bank reconciliation, hedging, foreign outlook — are not
   buildable here; the voucher-index spec's closing section records why and where their sources
   actually live.
