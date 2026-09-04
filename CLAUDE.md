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
- **129 of the 9,247 register-derived cheques carry no amount** (production, 2026-09-04; the table
  holds 21,817 rows in all, the rest from Acumatica). The register's amount cell was blank or held
  the word "CANCELLED". Acumatica was reconciled against all 129 and has no record of any of them —
  16 are 6-digit BDO numbers and 39 sit on a company whose tenant holds 142 payments in total, so
  they read as cheques never entered in the ERP rather than phantoms. 83 name a real payee. They
  break down 50 SIGNATURE_PENDING / 48 CANCELLED / 25 RELEASED / 6 READY_FOR_RELEASE, none with a
  `releasedAt`. `Check.isIncomplete` flags them; `scripts/backfill-incomplete.ts` re-derives it.
  **They are excluded from every currency total rather than counted as zero** — SQL `SUM()` skips a
  null — and `tests/queries.test.ts` pins that. Do not "fix" it.
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
queue. 628 tests across 39 files.

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
