# Finance inputs on the cheque — design

**What it is.** The register carried remarks, a point person, who was holding the cheque, and
clearing details. None of it survived the load and none of it can be typed here. This sub-project
gives each a screen — and first repairs 2,727 cheques on which the importer filed a supplier's
receipt into the bank's clearing column.

Sub-project 1 of the "manageable reports" programme decided 2026-09-11: (1) Finance inputs on the
cheque, (2) forecast calibration, (3) settings, (4) statement import. Every figure here was measured
against production that day.

## Why

CLAUDE.md, since 2026-09-10: *anything Finance used to type into the register must be typeable
here, or somebody will reach for Excel out of necessity.* Measured:

| register column | populated here | editor on any screen |
| --- | ---: | --- |
| remarks | 0 of 11,950 | only on the release form, at the moment of release |
| point person | 0 | none |
| who is holding it | 0 | none |
| category | 101 | none |
| clearing status / cleared date | 0 / 0 | none — `recordClearing` and `clearingAction` exist with no form |
| bank clearing reference (`crNumber`) | 2,727 | none — every one at `clearingStatus = NONE` |

The reports Finance called "extracts that cannot be calibrated" are extracts because these inputs
do not exist. The `Setting` table is empty and nothing reads it.

## The 2,727 — a repair, and a ruling

All 2,727 `crNumber` values are shaped `CR <digits>`. They came from **column 12 of the RELEASED
sheets, headed `REMARKS`** — the same column that holds `DEPOSITED`, dates and names — because the
importer's sniffer classifies any cell matching `^CR\s?\d+$` as a `CLEARING_REF` on pattern alone.
That is also why `remarks` is empty on every cheque: the cell was consumed or dropped.

**Client ruling 2026-09-11: `CR 1234` in that column is the supplier's Collection Receipt** — the
paper handed over at collection — not the bank's reference. So 2,727 cheques hold a receipt in the
bank-clearing column: rule 11's exact hazard, at scale, since 2026-09-09. Treating them as clearing
evidence would have recorded 2,727 clearings that never happened.

`scripts/repair-cr-receipts.ts`:

- Selects cheques where `crNumber ~ '^CR\s?\d+$'`, `orNumber IS NULL`, `receiptType IS NULL`,
  `clearingStatus = 'NONE'`, `clearedDate IS NULL`. Measured: 2,727; any row failing a condition is
  reported and skipped, never guessed.
- `--dry-run` (default) prints the counts and writes nothing. With `--apply`, it first writes
  `snapshots/repair-cr-receipts-<timestamp>.json` holding every affected row's `id`, `checkNumber`,
  `crNumber`, `orNumber`, `receiptType`, `clearingStatus` — the snapshot CLAUDE.md item 7 says must
  precede a bulk write, built into the script rather than done by hand. `snapshots/` is gitignored.
- Then, per cheque in its own transaction: `orNumber = crNumber` (normalised through
  `normaliseReceipt`, exactly as the release form does), `receiptType = 'CR'`, `crNumber = null`,
  `orDate` left null (the register never recorded one), and one audit row
  `receipt_reclassified_from_register` with `details: { from: 'crNumber', value, sourceSheet,
  sourceRow, ruling: '2026-09-11 client: REMARKS CR-numbers are Collection Receipts' }`.
  `receiptType = CR` is set on the ruling for this column, recorded in the row, not on a prefix
  guess — the distinction rule 11 draws.
- Idempotent: a second run finds zero candidates.

**The sniffer stops making the mistake.** `CLEARING_REF` is removed from `field-sniffer.ts`; a
`CR <digits>` cell classifies as `RECEIPT_REF`, `parse.ts` carries it as `receiptRef`, and
`upsertCheck` writes it on CREATE only as `orNumber` + `receiptType = 'CR'` (both are immutable on
update, so a re-run never overwrites a receipt Finance recorded). The register is retired, so this
matters only to `scripts/import-workbook.ts` seeding a fresh database — but a fresh database must
not be seeded wrong. `NormalisedRow.clearingRef` is renamed `receiptRef`; nothing else in the app
reads it.

## B. Edit details

On the cheque page, for any Finance user, a form for the four free-text facts:

| field | column |
| --- | --- |
| REMARKS | `remarks` |
| POINT PERSON | `pointPerson` |
| WHO IS HOLDING IT | `checksPossession` |
| CATEGORY | `category` |

`updateDetails(db, { checkId, userId, fields, now })` in `lib/domain/actions.ts`: no status change,
no guard on status (a note can be added to a cancelled cheque), trims and stores empty as null, and
writes one `details_updated` audit row whose `details` carries `{ field: { from, to } }` for each
field that changed — nothing when nothing changed (the action returns without writing). All four
columns are already outside `IMPORT_WRITABLE`; a sync cannot overwrite them.

## C. Record clearing

On a RELEASED cheque, the form `clearingAction` never had: CLEARING STATUS (DEPOSITED / ENCASHED /
CLEARED), BANK REFERENCE (`crNumber` — labelled as the bank's, with the receipt shown separately
above it so the two are never confused), CLEARED DATE. Shown only when a forward move exists; a
CLEARED cheque shows its clearing as facts.

**One ladder change:** `NONE → CLEARED` becomes legal. A bank statement is proof of clearing whether
or not a deposit was recorded first; refusing it would force Finance to record a DEPOSITED they
never observed. `DEPOSITED → ENCASHED` and any move out of CLEARED stay illegal.

## D. Bulk mark-cleared — `/clearing`

Any Finance user. A textarea: one cheque per line, `number` or `number, date, bank ref` (comma or
tab separated; the date `YYYY-MM-DD` or `DD/MM/YYYY`). APPLY shows a **preview** — will be
CLEARED / already CLEARED / not RELEASED / unknown number / ambiguous (two companies share the
number) — and only CONFIRM writes, through the existing sequential bulk runner, `recordClearing`
per cheque with `CLEARED`, the date, the reference. Per-cheque outcomes are listed afterwards.
An ambiguous number is never resolved by picking; it is refused and named.

This is what makes "outstanding cheques" — RELEASED and not CLEARED — a number this system can
state, and it is the cheque side of the bank reconciliation. The report itself is sub-project 4.

## E. Show the fields

The cheque page shows remarks and category today; it gains POINT PERSON and WHO IS HOLDING IT,
and the receipt block shows a reclassified receipt with a note that it came from the register.

## Plumbing

| file | responsibility |
| --- | --- |
| `scripts/repair-cr-receipts.ts` | the repair, with `--dry-run` / `--apply`, the snapshot, the audit rows |
| `lib/import/field-sniffer.ts`, `parse.ts`, `map-row.ts`, `upsert.ts`, `lib/normalised-row.ts` | `CLEARING_REF` → `RECEIPT_REF` / `receiptRef`, written on create as the receipt |
| `lib/domain/check-status.ts` | `NONE → CLEARED` |
| `lib/domain/actions.ts` | `updateDetails` |
| `lib/clearing-paste.ts` | **Pure.** Parses the pasted text into `{ checkNumber, clearedDate?, crNumber? }[]` with per-line errors |
| `app/checks/actions.ts` | `updateDetailsAction`; `clearingAction` unchanged |
| `app/clearing/actions.ts`, `app/clearing/page.tsx` | preview and confirm |
| `app/checks/[id]/page.tsx`, `components/DetailsForm.tsx`, `components/ClearingForm.tsx` | the two forms and the two new fields |
| `components/AppHeader.tsx` | `CLEARING` link |
| `.gitignore` | `snapshots/` |

## Testing

Targeted: the sniffer and parser tests (`CR 1234` → `RECEIPT_REF`; `receiptRef` on the row), the
upsert test (create writes `orNumber` + `receiptType = CR`; update never touches them), the repair
script's selection and transformation as a pure function with a test, `updateDetails` (writes only
changed fields; no row when nothing changed; empty → null; any status), the clearing ladder
(`NONE → CLEARED` legal, `CLEARED → anything` not), `lib/clearing-paste.ts` at every line shape, the
preview's classification (`tests/actions/clearing-bulk.test.ts`), the server actions' role and
validation. `npx tsc --noEmit`; `next build`.

## Not in this design

- **The outstanding-cheques / bank recon report** — sub-project 4, once statements can be imported.
- **Expected dates, planned outflow lines** — sub-project 2. **Settings** — 3.
- **Running the repair.** `--dry-run` first, then `--apply`, against production, by the user.
