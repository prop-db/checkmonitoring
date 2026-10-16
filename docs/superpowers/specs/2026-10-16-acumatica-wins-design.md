# Acumatica wins over the register: design

Date: 2026-10-16. Status: approved in conversation (user, 2026-10-16: "Acumatica wins", then "okay proceed").

## Why

CLAUDE.md, "What is missing", item 6: *"Acumatica wins" is not enforced in code.* On 9 September
the register import changed 94 amounts and moved 1,958 checks to a company Acumatica contradicts.
The register was wrong in every case. It was caught only because a snapshot had been taken by hand.
`amount` and `companyId` are in `IMPORT_WRITABLE`, so nothing in `upsertCheck` stops a register row
from overwriting a value the ERP owns.

The register was retired on 2026-09-10, but the path is still open. `/admin/import` accepts a
register upload and writes it through `importRows` → `upsertCheck`. `scripts/import-workbook.ts`
does the same from a terminal. One upload of an old file would repeat 9 September.

## User ruling (2026-10-16)

When a register row disagrees with Acumatica on a check Acumatica holds, **Acumatica wins**. The
register upload stays available, and register-only checks import as before.

## The rule

A check is **Acumatica-held** when `acumaticaPaymentId` is not null: the sync has read its payment.

When a row with `source === 'WORKBOOK'` UPDATES an Acumatica-held check, `upsertCheck` writes none of
the fields in a new list, `ACUMATICA_OWNED` (`lib/import/upsert.ts`):

| field | why Acumatica owns it |
| --- | --- |
| `amount`, `isIncomplete` | the 94 amounts; `isIncomplete` derives from `amount` |
| `checkDate`, `payeeName`, `currency`, `cvNumber` | facts of the payment document |
| `isCheque` | from Acumatica's PaymentMethod |
| `companyId` | the 1,958 companies (the "misfiled" refile; `COMPANY_RULING_BASIS`) |
| `cashAccountId`, `checkBookId` | the account and book, from Acumatica's CashAccount (spec §E) |
| `eligibility`, `portalDomain`, `portalSyncStatus` | derived from the payee; the register's payee would flip them |

On those checks the register still writes:
- **new vouchers** in `apvNumbers` (added to the stored list, never replacing it), because a voucher
  is a fact the register prints and Acumatica's payments feed does not;
- `sourceSheet` / `sourceRow`;
- nothing else in `IMPORT_WRITABLE` changes. `acumaticaPaymentId`, `checkNumber`, the `acumatica*`
  fields and `lastModifiedOn` are already never written by a register row (its values are null, and
  `keep()` skips a null; `checkNumber` is written only on an Acumatica renumber).

Unchanged by this design:
- the Acumatica sync (`source === 'ACUMATICA'`) still writes every field it writes today;
- a register row on a check Acumatica does not hold (`acumaticaPaymentId` null) still writes as today;
- a register row that CREATES a check still writes as today (there is no Acumatica value to protect);
- `IMMUTABLE_ON_UPDATE` (Finance-owned fields) is unchanged.

`ACUMATICA_OWNED` is a subset of `IMPORT_WRITABLE`. A second list, `REGISTER_MAY_WRITE_ON_HELD`,
names the rest of `IMPORT_WRITABLE`. A test fails if any `IMPORT_WRITABLE` field is in neither list,
or in both. Adding an import-writable column then forces a decision, as the existing
`IMMUTABLE_ON_UPDATE` exhaustiveness test already does for `Check` columns.

## Making a disagreement visible

For a held check, every `ACUMATICA_OWNED` field (except the four derived ones, `isIncomplete`,
`eligibility`, `portalDomain`, `portalSyncStatus`) where the register row offers a **non-null value
that differs from the stored one** is a *refused* value. When a row has any, `upsertCheck` writes one
audit row in the same transaction:

- `action: 'register_value_refused'`, `actorType: 'SYSTEM'`
- `details: { source: 'WORKBOOK', sourceSheet, sourceRow, basis, refused: { <field>: { kept, offered } } }`
  — values as strings: decimals via `toString()` (never a number, rule 8), dates as ISO days,
  `companyId` / `cashAccountId` / `checkBookId` as their codes.
- `remarks`: "The register offered a different <fields> for this check. Acumatica's values were kept
  (<basis>)."

`basis` is a new constant, `ACUMATICA_WINS_BASIS = 'User ruling of 2026-10-16: Acumatica wins over
the register on any check Acumatica holds'`.

A null offered value is not a disagreement (the register did not state it), so it is not recorded.

`UpsertResult`'s `UPDATED` outcome gains `refusedFields: number` (0 when nothing was refused).
`ImportSummary` gains `keptAcumatica`: the number of rows with at least one refused value. It is shown:
- on `/admin/import` (`components/ImportWorkbookForm.tsx`), in the register summary beside
  updated, as "kept Acumatica's values on N check(s)";
- by `scripts/import-workbook.ts`, as a line `kept Acumatica values`.

The import invariant `rows === created + updated + staged` is unchanged: a row with refused values is
still `updated`.

Nothing is thrown. One disagreement never aborts an import.

## What this does not do

- It does not revisit past data. The 9 September damage was restored then, and nothing is changed now.
- It does not touch the approval-workbook import (`lib/import/bills.ts`), which writes `CheckBill`
  rows, not `Check` fields.
- It does not stop the register upload. (The user chose not to retire it.)

## Testing

`tests/import/upsert.test.ts`, new cases:
1. A register row on an Acumatica-held check with a different amount, check date, payee and company:
   none of them change; `apvNumbers` gains the register's new voucher; one `register_value_refused`
   row names the four fields with kept and offered values; the result is `UPDATED` with
   `refusedFields: 4`.
2. The same row with null amount and an equal payee: nothing is refused and no audit row is written.
3. A register row on a register-only check (`acumaticaPaymentId` null): amount and company change as
   today (pins that the guard is scoped).
4. An Acumatica row on an Acumatica-held check: amount changes as today.
5. A held check whose register row's payee would classify INTERNAL: `eligibility` is unchanged.
6. Exhaustiveness: `ACUMATICA_OWNED` and `REGISTER_MAY_WRITE_ON_HELD` partition `IMPORT_WRITABLE`.
7. `importRows` counts `keptAcumatica`.

Then `npx tsc --noEmit` and `next build`.

## Go-live

No migration, no data change. A normal deploy.
