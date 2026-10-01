# Signing schedule, APV/PO from Acumatica, and a sortable, filterable list

Client request 2026-10-01, design agreed in conversation the same day. Three parts, built and
shipped in this order: **A. signing**, **B. APV and PO**, **C. the table**. Each part is
independently releasable; nothing in B or C depends on A.

## Why

- Pending cheques show `—` under APV NUMBER. Since the register was retired (2026-09-10) a cheque
  arrives only from the sync, and `AP-Checks and Payments` publishes no bill reference.
- Finance wants the PO reference beside the APV wherever cheques are listed or summarised.
- Finance's signing routine is weekly, not "N days after creation": Monday's cheques are signed
  Tuesday; the rest are signed by a person when they are signed.
- The list cannot be sorted, filters exist only for company/bank/eligibility/released date, and
  the column choice is show/hide only.

---

## A. Signing

### A1. Automatic: Monday cheques only

Replaces the 2026-09-25 rule (`autoSign.afterDays`, "3 Manila calendar days after `createdAt`").

- A cheque is **due** when all hold: `status = SIGNATURE_PENDING`, `acumaticaPaymentId` set,
  `isCheque`, `acumaticaStatus !== 'Voided'`, its `createdAt` falls on the **Manila Monday
  immediately before the run's Manila Tuesday**, and it carries **no `signature_reverted` audit row** (A3: a person's revert must not be undone by the
  clock next week).
- The rule runs **only on a Manila Tuesday**. `isDueForAutoSign(facts, now, enabled)` stays pure:
  `now` must be a Manila Tuesday, and `createdAt` must fall on the Manila day before it. A Tuesday
  run that failed is retried by hand the same day from `/admin/sync`; it does not reach back to
  earlier Mondays. Older pending cheques are signed with SIGN ALL (A2).
- "Prepared on Monday" is read as "first read by the sync on a Manila Monday" — `createdAt`.
  Acumatica publishes no creation time, and `PaymentDate` is post-dated on some cheques.
  Consequence, accepted: a cheque prepared Monday after the 18:00 read is first read at Tuesday's
  12:00 read, carries a Tuesday `createdAt`, and waits for the button.
- Writes as today: `status = SIGNED`, `signedById` null, one `auto_signed` audit row each, one
  `auto_sign_run` row per run (with `checkId` null), no portal event. Rule 4 is untouched — the
  sync never writes status; auto-sign remains its own step in `lib/domain/actions.ts`.

### A1a. A second daily run at 12:00 Manila

- `vercel.json` gains `{ path: /api/cron/sync, schedule: "0 4 * * *" }` (12:00 Manila) beside
  `"0 10 * * *"` (18:00). Both call the same route: **sync both tenants, then auto-sign**. Auto-sign
  does nothing on any day but Tuesday, so the 18:00 run on a Tuesday finds nothing new to sign
  except cheques it has just read with a Tuesday `createdAt`, which are not due — correct.
- The overlap guard (`SYNC_IN_PROGRESS_MINUTES`) and the 50-second budget apply to both runs.
- The staleness warning (`STALE_AFTER_HOURS`, 30) is unchanged; two reads a day only make it
  rarer.

### A1b. The setting

`autoSign.afterDays` (int) is replaced by **`autoSign.mondayEnabled`** (an int setting, 1 = ON, 0 = OFF, default 1 — the registry has only `int` and `list` kinds),
labelled "AUTO-SIGN MONDAY'S ACUMATICA CHEQUES ON TUESDAY". The registry's exhaustiveness and the
settings form follow. A stored `autoSign.afterDays` row is ignored, not migrated: the old number has
no meaning under the new rule. `/admin/sync`'s LAST AUTO-SIGN line now reads "N Monday cheque(s) signed", "not a Tuesday — nothing due", or "switched off in settings".

### A2. SIGN ALL

- A button on the LIST screen's **SIGNATURE PENDING** view only, beside EXPORT/PRINT. Modelled on
  RELEASE ALL (`listTodaysReleaseIds`, `ReleaseAllConfirm`):
  - The set is every SIGNATURE_PENDING cheque the view counts under its company, bank and
    eligibility narrowing (and the column filters of part C, once they exist), incomplete ones
    excluded as everywhere. Computed **on the server at submit time** from the same URL, not from
    ids the browser sends.
  - Confirmation states the count and total before anything is written: "SIGN 37 CHEQUES,
    ₱1,234,567.89?".
  - A filter value that is present but unrecognised **refuses** the action rather than widening
    it to everything — the RELEASE ALL rule.
  - Non-cheques (DEBIT ADV, CASH) are skipped and counted in the result, as `markSigned` already
    refuses them.
  - Each cheque goes through `markSigned` — one `signed` audit row each, `signedById` the user.
    Chunked by `MAX_BULK_SELECTION` (the setting in force), each chunk its own transaction with
    `TX_OPTIONS`.
- Any active Finance user may use it (as SIGN on ticked rows today).

### A3. Revert to SIGNATURE PENDING

- New transition in the ladder: `SIGNED → SIGNATURE_PENDING`. Nothing else gains it. A
  READY_FOR_RELEASE cheque must first go back to SIGNED through the existing `revertAvailability`.
- `revertSignature(db, { checkId, userId, reason?, now })` in `lib/domain/actions.ts`: refuses
  anything not SIGNED; clears `signedAt`/`signedById`; writes one `signature_reverted` audit row
  recording the previous signer (user or `auto_signed`) and the optional reason. No portal event —
  signing never produced one.
- Any active Finance user. Offered on the cheque page (SIGNED only) and as a bulk action on ticked
  SIGNED rows (`bulk-actions.ts`, same selection cap).
- A reverted cheque is never auto-signed again (A1). It can be signed by hand or by SIGN ALL.

### A tests

- `domain/auto-sign`: Monday 00:00 and 23:59:59 Manila are due on Tuesday; Sunday 23:59:59 and
  Tuesday 00:00 are not; nothing is due on any non-Tuesday `now`; disabled → nothing; reverted →
  not due; non-cheque / voided / register-only → not due.
- `sync/auto-sign` and `sync/cron-route`: the Tuesday run signs Monday's, the noon run syncs then
  signs, a Wednesday run signs nothing.
- `actions`: `revertSignature` refuses each non-SIGNED status, writes one row, clears the signer;
  ladder test gains the one edge.
- `actions/bulk-actions`: SIGN ALL signs exactly the narrowed set, refuses an unrecognised filter,
  skips non-cheques, recomputes server-side.
- `settings/registry`: the new boolean key, the old key gone.

---

## B. APV and PO

### B1. APV from `AP-PAYMENTS-WITH-BILLS`, in every sync

- After each tenant's payment sync, the run reads `AP-PAYMENTS-WITH-BILLS` incrementally by its
  own watermark on `LastModifiedOn` (Go-Live) / `APAdjust_lastModifiedDateTime` (MANUFACTURING),
  with the same 120-minute overlap. Bill column `AdjdRefNbr` / `ReferenceNbr_2` (`BILL_COLUMN`).
  Filters are single `gt` on the date column — no `or` of `eq`s (a 500 in Go-Live).
- Each voucher is resolved with the existing `judgeLink` (exactly one live CHK cheque; voided and
  ADR applications ignored; a number held twice is ambiguous). On `LINK`, the voucher is **unioned**
  into `Check.apvNumbers` — never removed, never replacing — and one `voucher_linked_from_acumatica`
  audit row is written per cheque changed. Status is **never** touched (rule 4). The readying step of
  `scripts/link-vouchers-from-acumatica.ts` is not part of the sync.
- Unresolved vouchers (`NO_LIVE_CHEQUE_HERE`, `AMBIGUOUS`) are counted on the sync run record and
  shown on `/admin/sync`. They are not staged: they are a lookup that may resolve on the next run.
- First run with no watermark reads the inquiry in full as a **terminal job**
  (`scripts/sync.ts --bills`), never from the cron — the same rule as the payment sync's first read.
  That run fills every cheque generated since 9 September.
- The bills read records its own `SyncRun` row per tenant with `mode = 'BILLS'` (the existing
  `mode` string), so its `watermark` never mixes with the payment sync's; the payment sync's
  "last watermark" lookup must filter on its own mode. Adds the unresolved counts as nullable
  integer columns; migration required.
- Acumatica stays read-only (rule 3): only `fetchPage` is used.

### B2. PO

- `AP-PAYMENTS-WITH-BILLS` publishes no PO / Vendor Ref in either tenant (checked 2026-10-01,
  column names only). The PO shown is what this system already holds: `CheckBill.poNumber` (the
  approval workbook's Vendor Ref) ∪ `Check.poNumbers` (the register).
- **Open, for the client's Acumatica admin:** add the bill's Vendor Ref to
  `AP-PAYMENTS-WITH-BILLS` (or publish an AP bills inquiry carrying it). When it exists, B1 unions
  it into `Check.poNumbers` in the same step. Nothing else in this design waits on it.

### B3. Where APV and PO appear

- A **PO NUMBER** column after APV NUMBER in the list, export and printed sheet (a new
  `ColumnKey`, `poNumbers`; the storage key version is bumped, see C3).
- TODAY'S RELEASE panel on the TOTALS screen: APV and PO beside each cheque.
- Search already matches APV and PO; unchanged.

### B tests

- `sync/run`: bills step unions, never removes, never writes status, advances its own watermark
  only on success, counts unresolved; a tenant failure leaves the other's watermark alone.
- `integrations/acumatica`: the per-tenant column names; read-only assertion still holds.
- `table-columns`, `export/report`: the PO column.

---

## C. The list: sort, per-column filters, customise

### C1. Sort

- Clicking a header sorts ascending, again descending, again back to the default. URL params
  `sort=<columnKey>&dir=asc|desc`. Sortable: every column but ACTION. APV and PO sort by their
  first value.
- Server-side, in `listChecks`'s `orderBy`, across every matching cheque — the list shows at most
  200, so sorting in the browser would sort the wrong set. **Nulls last in both directions** (the
  `checkDate` lesson), `checkNumber asc` as the final tiebreak.
- Default with no `sort`: `checkDate desc nulls last`, as today. An unknown `sort` or `dir` falls
  back to the default (sort cannot widen anything, so it need not refuse).
- Export and print read the same params and produce the same order.

### C2. Filter row

A second header row, one control per visible column:

| Column | Control | Param |
| --- | --- | --- |
| CHECK NUMBER, APV, PO, SUPPLIER | text, contains, case-insensitive | `f.checkNumber`, `f.apv`, `f.po`, `f.payee` |
| COMPANY | dropdown | `company` (existing) |
| BANK | dropdown | `cashAccount` (existing) |
| STATUS | dropdown, only on ALL CHEQUES (a card already fixes status) | `f.status` |
| CHECK DATE, AVAILABLE DATE, PICKUP SCHEDULE | from–to, Manila days | `f.<col>From`, `f.<col>To` |
| DATE RELEASED | from–to | `releasedFrom`, `releasedTo` (existing, same rules) |
| AMOUNT | min–max | `f.amountMin`, `f.amountMax` |

- The existing company / bank / eligibility controls move into this row, **keeping their param
  names**, so `dashboardScreen`, `TOTALS_KEYS`, `totalsHref` and the TOTALS screen's own filter bar
  are unaffected. ELIGIBILITY has no column; its dropdown stays at the left of the filter row.
  Every new `f.*` param is a LIST parameter: `dashboardScreen` already fails closed on any key
  outside `TOTALS_KEYS`.
- Applied debounced (as `FilterAutoSubmit` does now). An empty box contributes nothing. A value
  that cannot be parsed (an amount `12x`, a date that is not a day) **refuses** with a message
  beside the box and shows no rows, rather than being dropped — a silently ignored filter reads as
  an applied one. Amounts parse as decimal strings (rule 8), never a JS number.
- All of it is built in `buildWhere`, so `getSummary`, the exclusion count, export, print, SIGN ALL
  and RELEASE ALL see exactly the rows the table shows.

### C3. Customise

- The COLUMNS panel keeps show/hide and gains ◀ ▶ to move a column. Order and visibility are one
  preference in `localStorage` under a bumped key (`check-monitoring.columns.v2`, now an ordered
  list); a v1 value is read as the visibility of the default order. Wrapped in try/catch as now;
  CHECK NUMBER, STATUS and ACTION stay always on.
- Export follows the on-screen order: the export link carries `cols=` in the viewer's order.

### C4. Remember my sort

- Choosing a sort writes a cookie `cm_sort` (`<key>:<dir>`, path `/`, one year, `SameSite=Lax`).
  When the URL has no `sort`, the server reads the cookie, so the list opens on it with no flicker.
  An invalid cookie is ignored. RESET clears it.

### C tests

- `queries`: each sort key both directions with nulls last; each filter; an unparseable filter
  refuses; the narrowed summary and exclusion count follow the filters.
- `dashboard-params`: parsing, defaults, the cookie fallback, `f.*` opens the LIST.
- `table-columns`: order round-trip, v1 migration, always-on.
- `export/dashboard-params`, `export/report`: sort, filters, column order.

---

## Out of scope

- Holidays: a Tuesday holiday still auto-signs Monday's cheques.
- Pulling a status from the portal (rule 12) and any supplier-facing change (rule 1).
- Server-side storage of column preferences (per browser, as today).
