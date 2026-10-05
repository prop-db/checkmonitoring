# PO NUMBER from Acumatica

Client, 2026-10-05: "P.O number is not existing" — the PO NUMBER column (part B of
`2026-10-01-signing-schedule-apv-and-table-design.md`) is blank on every cheque not on an approval
workbook, because `CheckBill.poNumber` was its only source and `AP-PAYMENTS-WITH-BILLS` publishes no
Vendor Ref. Design agreed in conversation the same day.

## Source, measured 2026-10-05 (read-only, column names and shapes only)

- `AP-Bills and Adjustments` (both tenants) carries one row per AP document: `Type` (Bill,
  Debit Adj., Prepayment, Credit Adj.), `ReferenceNbr` (the APV, e.g. `AP-ST044591`), `VendorRef`,
  `LastModifiedOn`, `Branch`, … `VendorRef` is the field the approval workbook's PO column comes
  from (`lib/import/bills.ts`, `VENDOR_REF`).
- Since 2026-01-01: GOLIVE 15,837 documents, 9,819 VendorRefs starting `PO`; MANUFACTURING 217
  documents, ~120 PO-shaped refs of the form `A1PP-PO-…` / `STPP-PO-…`. Every sampled bill since
  1 Sep carries a VendorRef; it is NOT always a PO: `26X06-0267A`, `SI#1659`, free text.
- Shapes of PO refs: `PO-ST-031109` (5,903), `PO-A1-…` (3,659), `PO-IND…` (106), `PO-HF-…` (83),
  `PO-ST…` without the second dash, occasional 5- or 7-digit numbers, two POs in one ref
  (`PO-A1-… / PO-A1-…`, `PO-ST-… PO-ST-…`), a trailing dot, lower case.

## Rule: only real POs (client choice)

`extractPoNumbers(vendorRef): string[]` — pure. Every token in the ref matching, case-insensitive,

- `PO-[A-Z0-9]{2,4}-?\d{5,7}` (PO-ST-031109, PO-A1-012345, PO-IND123456, PO-ST123456), or
- `[A-Z0-9]{2,5}-PO-\d{5,7}` (A1PP-PO-000123, STPP-PO-0001234)

bounded so it is not part of a longer alphanumeric run, upper-cased, de-duplicated, in order of
appearance. Anything else yields `[]`: `SI#1659`, `26X06-0267A`, `PO-ST-` (no digits), `PONDE 1234`,
"for next po", `… PO-ST-12` (too few digits). A trailing dot is not part of the PO.

## Storage

A new model, one row per Acumatica AP document that has at least one PO:

```
model AcumaticaBill {
  apvNumber      String   @id          // ReferenceNbr, upper-cased, trimmed
  tenant         String
  vendorRef      String                 // verbatim, for audit/diagnosis
  poNumbers      String[]               // extractPoNumbers(vendorRef), non-empty
  lastModifiedOn DateTime?
  updatedAt      DateTime @updatedAt
}
```

Keyed by APV, not by cheque, so a bill read before its cheque carries the APV is not lost — the
link is resolved when displayed. A bill whose VendorRef later stops yielding a PO has its row
deleted (the table mirrors Acumatica; it is a cache of reference data, not a record — no audit row
per bill). Rule 7 is untouched: no AuditLog writes per bill; the run writes its own `SyncRun` row.
`Check` gains no column.

## The read

`lib/sync/bill-refs.ts`, `runBillRefsSync(db, { client, tenant, since, now, trigger })`, mode
`'BILL_REFS'` on `SyncRun` (existing columns: `imported` = rows upserted, `updated` = rows deleted,
`staged` = documents with a VendorRef but no PO, `errors`). Same shape as the BILLS read:

- `fetchAll('AP-Bills and Adjustments', { select: [Type, ReferenceNbr, VendorRef, LastModifiedOn — measured 2026-10-05: MANUFACTURING uses the same column names in this inquiry, so one column map serves both tenants], filter: since ? LastModifiedOn ge
  datetime'…' : date column ge 2026-01-01, orderby: date asc, pageSize: 2000 })`. Acumatica stays
  read-only (rule 3).
- Only `Type = 'Bill'` rows are stored; the 2026 scope is enforced on `Date` in the mapper (one OData
  condition per request); `vendorRef` is stored trimmed; the delete is tenant-guarded; `imported`
  counts rows actually written (unchanged bills are skipped); writes are set-based batches of 500;
  the cron gates BILL_REFS on the payment read only (not on BILLS).
- Upsert/delete per row in batches; watermark = max − 120 min; held (null) when any write failed;
  fetch failure → errors 1, null, rethrow; in-progress guard on its own mode.
- Payment-side readers already exclude `BILLS`; they must exclude `BILL_REFS` too
  (`lastSyncWatermark`, `assertNoRunInProgress`, `getSyncOverview`), and `lastBillsWatermark` must
  read only `BILLS`.
- Cron: after the BILLS read, for a tenant whose payment read RAN; no watermark → recorded refusal;
  never FULL. First read from a terminal: `scripts/sync.ts <TENANT> --bill-refs [--full|--dry-run]`
  (snapshot of the `AcumaticaBill` table first, per CLAUDE.md "snapshot before any bulk write").
- Budget: the cron's 60 s ceiling; incremental runs are small (BILLS measured 613 rows / 5.7 s for a
  week). Note it on `/admin/sync` like BILLS rows.

## Display

`CheckTableRow.poNumbers` = `CheckBill.poNumber` (approval workbook) ∪ the `poNumbers` of every
`AcumaticaBill` whose `apvNumber` is in the cheque's displayed APVs (`displayApvNumbers`),
de-duplicated and sorted. One function computes it (`displayPoNumbers`) and every consumer uses it:
the list, Excel, print, the in-app PO sort, the PO filter box (raw SQL step: add an
`EXISTS (… "AcumaticaBill" ab WHERE ab."apvNumber" = ANY(c."apvNumbers") AND EXISTS(unnest(ab."poNumbers") ILIKE …))`
alongside the CheckBill condition) and the global search (PO: same condition, exact/contains as
the plan decides and states): the search matches an Acumatica PO by substring, case-insensitively
(as the bills' PO arm), via the same SQL fragment as the PO filter box. `listChecks` attaches
`poNumbers` with one `AcumaticaBill` query per page; the PO sort runs one query over every matching cheque.

## Out of scope

- Writing POs onto `Check` or `CheckBill`; changing what the approval workbook import does.
- POs for documents before 2026 (the sync's scope).
- A VENDOR REF column (client chose "only real POs").
- Portal event bodies keep `CheckBill.poNumber` only.
