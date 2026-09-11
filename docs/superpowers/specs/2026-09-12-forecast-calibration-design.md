# Forecast calibration — design

**What it is.** Two inputs the cash-outflow forecast could not take: the day Finance expects a
cheque to leave the bank, typed on the cheque; and outflows that are not cheques at all — payroll,
tax, loan amortisation, transfers — typed as planned lines. `/forecast` places a cheque on its
expected date when one is set, shows planned lines as their own column, and the file is still the
view.

Sub-project 2 of the "manageable reports" programme decided 2026-09-11. Designed with the client
2026-09-12: the expected date is **the day the money leaves the bank**; planned lines are
**one-off, typed as needed**; a past-dated line **stays until marked PAID or CANCELLED**; on
`/forecast` **one matrix, PLANNED as its own column**.

## Why

`/forecast` (built 2026-09-11) buckets 1,517 live cheques on their cheque date read as
*presentable from*, because no other date existed. That is a true statement about exposure and a
poor one about timing: a cheque Finance knows will be collected on the 20th sits in `31–60 DAYS`
because it was dated in July. And the daily cash position Finance asked for on 2026-09-10 is not
cheques only — payroll on the 15th and the BIR remittance on the 10th leave the same account and
appear nowhere in this system. Both gaps are inputs, not derivations; nothing can compute them.

## A. Expected outflow date on the cheque

`Check.expectedOutflowDate DateTime?` — a calendar day, stored at UTC midnight as every other date
column is.

**Typed** in the FINANCE NOTES panel on the cheque page as a fifth field, EXPECTED OUT, with a
date input and a clear control. It travels through `updateDetails` with the other four:
`DETAIL_FIELDS` gains it; in `DetailValues` it is the ISO day string (`YYYY-MM-DD`) or null, so
`normaliseDetails` and `diffDetails` stay string-typed and the audit row's `{ from, to }` reads as
days; `updateDetails` converts to a UTC-midnight `Date` at the write and back to the day at the
read. Anything that is not a valid day is refused with a `DomainError`, never coerced. Any Finance
user, any status — a note on a released cheque is still a note, and the date stays on the record.

**Never written by an import.** It goes in the upsert test's `NEVER_WRITTEN_BY_IMPORT` list beside
`remarks`; neither source can know it.

**On the forecast** a live cheque with an expected date is bucketed on that date; without one, on
its cheque date as today. `bucketFor` is unchanged; the caller chooses the date. `BucketedRow`
gains `expectedOutflowDate` and `dateBasis: 'EXPECTED' | 'CHEQUE DATE'`; `days` is struck on the
same date the bucket was. The page states how many of the cheques shown are placed on an expected
date. The DETAIL sheet gains EXPECTED OUT and DATE BASIS after CHECK DATE.

## B. Planned outflow lines

```prisma
model PlannedOutflow {
  id            String               @id @default(cuid())
  date          DateTime                                  // the day it leaves the bank
  amount        Decimal              @db.Decimal(18, 2)
  currency      String               @default("PHP")
  bankId        String
  companyId     String
  description   String                                    // "SEPTEMBER 2ND-HALF PAYROLL"
  category      String?                                   // PAYROLL, TAX, LOAN, TRANSFER — free text, upper-cased
  status        PlannedOutflowStatus @default(PLANNED)
  createdById   String
  createdAt     DateTime             @default(now())
  updatedAt     DateTime             @updatedAt
  paidById      String?
  paidAt        DateTime?
  cancelledById String?
  cancelledAt   DateTime?
  cancelReason  String?
  bank          Bank    @relation(fields: [bankId], references: [id])
  company       Company @relation(fields: [companyId], references: [id])
  createdBy     User    @relation("PlannedOutflowCreatedBy", fields: [createdById], references: [id])
  paidBy        User?   @relation("PlannedOutflowPaidBy", fields: [paidById], references: [id])
  cancelledBy   User?   @relation("PlannedOutflowCancelledBy", fields: [cancelledById], references: [id])
  @@index([status, date])
}
enum PlannedOutflowStatus { PLANNED PAID CANCELLED }
```

A `CHECK` constraint mirrors the status: `paidAt`/`paidById` set exactly when PAID,
`cancelledAt`/`cancelledById`/`cancelReason` set exactly when CANCELLED — the same discipline the
`Check` table keeps for its own actor columns.

**Rules**, in `lib/domain/planned-outflow.ts` (pure) and `lib/planned-outflow/actions.ts` (the
writers, taking `db` as `lib/domain/actions.ts` does):

| action | who | guard | writes |
| --- | --- | --- | --- |
| `createPlannedOutflow` | any Finance user | amount is money (`^\d+(\.\d{1,2})?$`, > 0); date is a day; bank and company exist; description non-blank | the row; audit `planned_outflow_created` |
| `updatePlannedOutflow` | any | status PLANNED only; same validation; nothing changed → no write | the changed fields; audit `planned_outflow_updated` with `{ field: { from, to } }` |
| `markPlannedOutflowPaid` | any | status PLANNED; a paid date (defaults to today, may be earlier) | `status PAID`, `paidAt`, `paidById`; audit `planned_outflow_paid` |
| `cancelPlannedOutflow` | any | status PLANNED; reason non-blank | `status CANCELLED`, the three cancel columns; audit `planned_outflow_cancelled`, `remarks: reason` |

No delete. No move out of PAID or CANCELLED — a wrong PAID is a new line. Amounts are decimal
strings in and out (rule 8); the row's `Decimal` is formatted with `toFixed(2)` at the read, as the
forecast query does.

**Audit rows** go through `writeAudit` with `checkId` null and `details.plannedOutflowId` set —
the table keys on cheques and this is not one. `/admin/audit` shows them as detached rows with the
description in `details`; that is enough for now and a `plannedOutflowId` column on `AuditLog` is
not added.

**The screen — `/forecast/planned`.** Any Finance user. Open lines first, soonest date first, each
with EDIT (inline: date, amount, bank, company, description, category), MARK PAID (paid date
pre-filled today) and CANCEL (reason required). A toggle SHOW PAID AND CANCELLED lists the rest,
newest first, with who and when. The ADD LINE form at the top: DATE · AMOUNT · CURRENCY (default
PHP) · BANK · COMPANY · DESCRIPTION · CATEGORY. Refusals are the domain's sentences. A PLANNED link
on `/forecast` beside EXPORT EXCEL; `/forecast/planned` links back.

## C. The forecast, with both

`lib/forecast/query.ts` gains `listPlannedRows(db, filters)`: status PLANNED, the bank and company
filters applied on the line's own bank and company, returned in the `ForecastRow` shape: `id` the
line's id, `checkNumber` the literal `PLANNED`, `payee` the description, `checkDate` the line's
date, `stage: 'PLANNED'`, `kind: 'PLANNED'`. `ForecastRow` gains `kind: 'CHEQUE' | 'PLANNED'` and
`expectedOutflowDate: Date | null` (always null on a planned row); `stage` widens to
`CheckStatus | 'PLANNED'`. One shape, so the matrices and the sheet need no second path.

`buildMatrices(rows, today)` takes the concatenated list. Bucketing: a PLANNED row on its `date`;
a cheque on `expectedOutflowDate ?? checkDate`. The by-bank matrix folds by `bank`; the by-stage
matrix's columns are the live stages present, then `PLANNED` last when any line is present. Cells,
totals and the centavo arithmetic are untouched.

**Stage filter** gains PLANNED: `parseStageParam` accepts it, `STAGE_OPTIONS` lists it last, and
with it set the cheque query is skipped. **The count line** reads
`N CHEQUES AND M PLANNED LINES · …`, and, when any cheque is placed on an expected date,
`K PLACED ON AN EXPECTED DATE`. The incomplete-cheque exclusion is unchanged.

**The extract**: DETAIL gains KIND as its first column, then EXPECTED OUT and DATE BASIS after
CHECK DATE. A planned row reads KIND `PLANNED`, CHECK NUMBER `PLANNED`, PAYEE the description,
CHECK DATE the line's date, DATE BASIS `PLANNED`. SUMMARY's two matrices carry the new column. The
title block states the two counts.

## D. One migration

`20260912000000_planned_outflow_and_expected_date`: the `Check` column, the enum, the table, its
index and CHECK constraint, three `User` relations. Additive. Applied to the test database before
any test; to production before the deploy (`node scripts/migrate.mjs prod --confirm`).

## Plumbing

| file | responsibility |
| --- | --- |
| `prisma/schema.prisma`, the migration | A and B's storage |
| `lib/domain/details.ts`, `lib/domain/actions.ts` (`updateDetails`) | the fifth field |
| `lib/domain/planned-outflow.ts` | **Pure.** `checkPlannedOutflowInput` (money, day, blanks), `normalisePlannedOutflow`, `diffPlannedOutflow`, status guards |
| `lib/planned-outflow/actions.ts` | the four writers, each one transaction with its audit row |
| `lib/planned-outflow/query.ts` | `listPlannedOutflows(db, { includeClosed })` for the screen |
| `lib/forecast/query.ts`, `matrix.ts`, `lib/forecast-view.ts`, `lib/export/forecast-workbook.ts` | C |
| `app/forecast/planned/page.tsx`, `app/forecast/planned/actions.ts`, `components/PlannedOutflowForm.tsx`, `components/PlannedOutflowList.tsx` | the screen |
| `app/forecast/page.tsx`, `app/api/export/forecast/route.ts`, `components/DetailsForm.tsx`, `app/checks/[id]/page.tsx` | the fifth field, the PLANNED link, the two counts |
| `lib/import/upsert.ts` (comment) and `tests/import/upsert.test.ts` (`NEVER_WRITTEN_BY_IMPORT`) | A is never imported |

## Testing

Targeted: `tests/domain/details.test.ts` (the date field: parse, null, diff as ISO days),
`tests/actions/update-details.test.ts` (+2), `tests/domain/planned-outflow.test.ts` (pure guards),
`tests/planned-outflow/actions.test.ts` (each writer, each refusal, the audit rows, nothing written
on refusal), `tests/planned-outflow/query.test.ts`, `tests/forecast/query.test.ts` (planned rows
under each filter; expected date carried), `tests/forecast/matrix.test.ts` (expected date wins;
PLANNED column last and only when present; totals include both), `tests/forecast-view.test.ts`
(PLANNED stage), `tests/export/forecast-workbook.test.ts` (the new columns read back),
`tests/actions/server-actions.test.ts` (the fifth field), `tests/import/upsert.test.ts` (the
column accounted for). `npx tsc --noEmit`; `next build`.

## Not in this design

- **Recurring schedules.** A line is typed each time it is due.
- **Actual outflow by day.** Begins when releases and clearings are recorded through the app.
- **Settings** (sub-project 3). **Bank statements and the outstanding-cheques report** (4).
- **Editing or deleting a PAID or CANCELLED line.**
