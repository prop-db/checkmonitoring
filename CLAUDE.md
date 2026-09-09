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

## Commands

```bash
npm run dev                    # local dev server
npm test                       # full suite (Vitest, hits the TEST database)
npx tsc --noEmit               # REQUIRED before claiming done - see below
npx next build
npm run db:migrate             # dev migrations
npm run db:seed                # dev seed, WITH demo cheques and known-password accounts
npm run db:seed:reference      # production seed: reference data only, no cheques, no accounts
npm run create-admin           # bootstrap the first FINANCE_ADMIN on a fresh database
npx tsx scripts/backfill-incomplete.ts --dry-run   # re-derive Check.isIncomplete; idempotent
npx tsx scripts/backfill-apv-numbers.ts "CHECK MONITORING 9.1.2026.xlsx" --dry-run  # fill Check.apvNumbers
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

## Things that will catch you out

**`npx tsc --noEmit` is not optional.** Vitest transpiles with esbuild, which erases types — this
project has repeatedly had a fully green suite over unsound types. Overrides spread from a
union-typed `it.each` tuple also escape excess-property checking; that hid a real bug here.

**`middleware.ts` does not run.** The middleware manifest is empty after a clean build:
`export const runtime = 'nodejs'` is unsupported in Next 15.5.25 and the file is silently never
registered. The app is protected by the page-level `requireUser()` / `requireAdmin()` guards, which
Plan 1 added precisely so "a bad matcher edit cannot silently expose pages". **Every request-time
control must live in the request path** — a page guard, a server action, or `authorize`. A control
placed in middleware passes tests that import it directly and protects nothing.

**One agent at a time against the test database.** All test files share one Neon database and
`resetDb()` truncates it. Concurrent runs produce `40P01` deadlocks and spurious FK failures, and
they destroy an in-flight import. `fileParallelism: false` prevents this within a run and cannot
prevent it across processes.

**The Neon connection string contains `&`.** Spawn the Prisma CLI with the URL as an argv entry and
`shell: false`, or the shell mangles it.

**`.env` values are quoted; Vercel stores quotes literally.** `dotenv` strips them locally, so
`DATABASE_URL="postgresql://…"` works on a laptop and fails on Vercel with *"the URL must start with
the protocol postgresql://"*. `scripts/set-vercel-env.mjs` strips them.

**Tests must never point at the application database.** `tests/helpers/test-db-url.ts` refuses to
run when `DATABASE_URL_TEST` is unset or equal to `DATABASE_URL`.

## Layout

| Path | Responsibility |
| --- | --- |
| `lib/domain/` | Pure rules. No database, network, filesystem, clock. `check-status.ts` (the ladder), `eligibility.ts` (the portal gate). `actions.ts` is the deliberate exception — it takes `db` and is the only module that changes a status. |
| `lib/import/` | Workbook parsing → `parse.ts`, `field-sniffer.ts`, `company.ts`, `implied-status.ts`, `bills.ts`, and `upsert.ts` — the single write path where duplicate prevention lives. |
| `lib/integrations/acumatica/` | OData reader and mapper. |
| `lib/sync/run.ts` | Incremental sync, watermark with a 120-minute overlap. |
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
- **A refused approval-workbook row lands in `StagedBill` and shows on `/admin/staged`.** This is
  why `AP-ST042652` was missed: the importer refused the row correctly and reported it correctly, to
  a terminal, once, during a run nobody was watching. `StagedBill` is deliberately **not** a
  `StagedCheck` — every staged cheque carries an `impliedStatus` and a bill has none, and this
  workbook's `FINANCE REMARKS = AVAILABLE` is evidence, never an instruction. It carries no amount
  and no vendor, because a bill's `Detail Total` displayed beside cheque amounts is read as a
  cheque's figure sooner or later.
- **Acumatica bank-prefixes 90% of its cheque references** (`BPI 6000240287`) while the register
  writes them bare. `canonicalCheckNumber` reconciles them — without it the same cheque stores twice.
- **`Branch` from Acumatica is space-padded** (`"A1+       "`). `orNull` trims it; an untrimmed read
  resolves every payment to no company.
- **`PaymentMethod` decides `isCheque`**, alongside the China-branch rule. `DEBIT ADV` and `CASH` are
  not cheques and must not offer a SIGN button.
- A voided cheque is **two feed rows** under one reference; the original's positive amount survives.

## State

Plans 1 and 2 complete. Plan 3 (portal automation) paused after Task 1 at the client's request —
the portal needs an `encoder` service account that does not yet exist, and until then events simply
queue. 942 tests across 53 files.

Production is `check_monitoring_prod` on Neon — created clean, reference data only, one real admin,
no demo cheques. The historical import was running at last handoff; it is idempotent, so if it was
interrupted, re-run it:

```bash
npx.cmd tsx scripts/import-workbook.ts "CHECK MONITORING 9.1.2026.xlsx" --dry-run
npx.cmd tsx scripts/import-workbook.ts "CHECK MONITORING 9.1.2026.xlsx"
```

Outstanding: promote a second FINANCE_ADMIN (one forgotten password currently locks administration);
create the `check_monitoring_app` database role so the dormant `REVOKE` on `audit_log` activates;
decide whether to delete `middleware.ts` or make it Edge-compatible.

**Not yet applied to production (2026-09-07):** migration
`20260907000000_check_apv_numbers_and_staged_bill` is applied to the TEST database only, and
`scripts/backfill-apv-numbers.ts` has not been run anywhere but a dry run against the test database.
Apply the migration, then dry-run the backfill, then run it. Re-import the approval workbook
afterwards, not before — its row 81 can only resolve once the register's vouchers are in.
