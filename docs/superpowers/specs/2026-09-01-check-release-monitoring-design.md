# CHECK RELEASE MONITORING SYSTEM — DESIGN

**Date:** 2026-09-01
**Status:** Approved for planning

---

## 1. PURPOSE

An internal Finance system that monitors a check from the moment Acumatica generates it until it is physically released to the supplier, and that pushes availability to the existing Supplier Portal automatically.

It sits between two systems that already exist and replaces neither:

| System | Role | Owned by |
| --- | --- | --- |
| Acumatica | Source of truth for check/payment data | ERP |
| **Check Release Monitoring** | Internal operational monitoring layer | this project |
| Supplier Portal | Supplier-facing availability + pickup scheduling | existing app |

**Internal use only.** No supplier login, registration, dashboard, profile, or any supplier-facing page exists in this system. Suppliers continue to use the Supplier Portal exclusively.

### 1.1 The problem, stated concretely

Finance currently maintains the same information three times:

1. Acumatica generates the checks.
2. Finance hand-maintains `CHECK MONITORING <date>.xlsx` — 15 sheets, 12,264 rows, sharded by bank × company, moved between sheets by cut-and-paste.
3. Finance exports `APPROVAL FOR RELEASE <date>.xlsx` and uploads it to the Supplier Portal, which matches rows by APV number and marks them available.

This design removes steps 2 and 3. Ticking **READY FOR RELEASE** in this system calls the Supplier Portal API directly.

---

## 2. EVIDENCE BASE

This design was derived from the two real workbooks and the Supplier Portal source, not from assumption.

### 2.1 `APPROVAL FOR RELEASE 9.4.2026.xlsx`

85 AP bills, 34 vendors, all `FINANCE REMARKS = AVAILABLE`. Columns: Date, Post Period, Reference Nbr., Vendor Ref., Vendor Name, Balance Amount, Description, Due Date, Type, Detail Total, Terms Code, Created By, NO. OF DAYS, four aging buckets, GL Account, FINANCE REMARKS, Payment Ref. #, check No., bank. A PIVOT sheet sums amounts by vendor × bank account.

### 2.2 `CHECK MONITORING 9.1.2026.xlsx`

| Group | Sheets | Rows |
| --- | --- | ---: |
| RELEASED | BPI, MBTC, STK P&P, MBTC P&P, BPI A1, BDO | 10,035 |
| AVAILABLE (open) | BPI STK, MBTC, MBTC P&P, BPI P&P, BPI A1, BDO | 1,317 |
| CANCELLED | | 774 |
| CHECK FINDING (stale) | | 88 |
| FT & MC (fund transfers, manager's cheques) | | 50 |
| **Total** | **15** | **12,264** |

Facts established from this file:

- Banks are **BPI, MBTC, BDO**.
- Companies/entities: **STK, A1+, P&P**, with document prefixes `ST`, `A1`, `HF`, `STPP`, `A1PP`, `IND`.
- Checkbooks are real identifiers: `BPI-S-4636`, `BPI-A-5713`, `BPI-S-8879`, `BPI-A-8879`, `MBT-A-4155`, `MBT-A-9048`, `MBT-S-9048`, `MBT-S-1121`, `BDO-A-3838`.
- A **CV number** (`CV-ST019113`, `CV-A1009393`, `A1PP-CV-000009`) is the Acumatica payment document. The AP bill (`AP-ST036198`) is a separate document. The term "APV" in the original brief conflates the two; this design keeps them distinct.
- Payment categories share a column with checkbooks: `LOCAL SUPPLIER`, `PAYROLL`, `UTILITIES`, `TAX`, `FUND TRANSFER`, `BROKERS`, `SALARIES`, `TRANSPO,GAS AND OIL`, `FTP`.
- Lifecycle continues past release: `DEPOSITED`, `ENCASHMENT`, `CLEARED`, with a **CR number** (`CR 6336`, `CR08970`, `CR19030`).
- Additional tracked fields: POINT PERSON, CHECKS POSSESSION, RR NUMBER, STATUS RR, PURCHASING DIRECTOR.

**Column positions are not stable across sheets.** The APV sits in column H on `BPI RELEASED`, column F on `MBTC AVAIL.`, and columns B and D on `MBTC P&P`. Column E holds a payee on one sheet and a description on another. The importer must therefore identify fields by content, not position (section 8).

### 2.3 Supplier Portal (`Desktop\Supplier Portal`)

A live Express + PostgreSQL application (Vercel + Neon, 49 migrations) that already implements the supplier half of this workflow:

- `migrations/011_check_release.sql` — status ladder
- `migrations/021_pickup_confirmation.sql` — `pickup_date`, `pickup_time`, `pickup_rep`, `confirmed_at`, `confirmed_by`
- `migrations/048_check_revert_status.sql` — `REVERTED_FOR_REUPLOADING`
- `src/checks/store.js` — `markAvailable()`, `revertChecks()`, `confirmPickup()`
- `src/checks/import.js` — the workbook upload this design replaces
- `src/import/odata-client.js` — a working Acumatica OData reader

Its ladder:

```
FOR_PROCESSING -> FOR_APPROVAL -> FOR_CHECK_PRINTING -> READY_FOR_SIGNATURE
  -> AVAILABLE_FOR_RELEASE -> RELEASED        (+ REVERTED_FOR_REUPLOADING)
```

Endpoints this design consumes:

```
GET  /api/checks?q=&status=            list + pickup confirmations
GET  /api/checks/untracked?q=          resolve an APV to a portal tradeId (admin)
POST /api/checks/mark-available        { tradeIds[], pickupDate }
POST /api/checks/revert                { tradeReleaseIds[], brokerReleaseIds[] }
POST /api/checks/:id                   { status, orNumber, orDate, remarks }
GET  /api/checks/:id/history
POST /api/broker-checks/mark-available { transactionIds[], pickupDate }
```

`markAvailable()` carries a one-way `notified_at` latch guaranteeing each supplier is notified exactly once. **All portal writes go through the HTTP API so that latch and the portal's audit log are inherited.** Direct database writes are prohibited by this design.

---

## 3. DECISIONS

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Next.js 15 (App Router, TypeScript) + Prisma + PostgreSQL + Tailwind | One codebase for UI and API; real auth, roles, audit tables |
| D2 | Own database, separate from the portal's | No write lock or schema coupling to a production supplier-facing app |
| D3 | Acumatica integrated for real; both OData and REST readers behind one interface | Interface confirmed available; mode chosen by env var |
| D4 | Supplier Portal integrated for real over HTTP | The endpoints already exist |
| D5 | Check has many AP bills | Acumatica can pay several bills with one check |
| D6 | Portal auth via dedicated service account at `encoder` tier | No portal code change needed; actions attributable in the portal audit log |
| D7 | Non-supplier checks tracked internally, never pushed | Payroll/tax/inter-company data must not reach a supplier-facing system |
| D8 | Import all 12,264 historical rows | Powers reports, pickup patterns, and the stale-check queue |
| D9 | Extend the ladder past RELEASED to DEPOSITED/ENCASHED/CLEARED | Already how the team works; without it Excel survives |
| D10 | Local accounts + roles, built on NextAuth | Works day one; Entra SSO can be added later |
| D11 | Batch release restricted to FINANCE_ADMIN | Highest-risk action in the system |
| D12 | Acumatica is read-only from this system | The client interface exposes no mutating method |

---

## 4. ARCHITECTURE

```
              ACUMATICA
                  | OData / REST (read-only)
                  v
        +---------------------------+
        |  SYNC SERVICE (15 min)    |
        +------------+--------------+
                     v
                 POSTGRES  <-->  NEXT.JS UI (Finance only)
                     |                  |
                     |                  | [x] READY FOR RELEASE
                     v                  v
              ELIGIBILITY GATE ---> PORTAL OUTBOX
              supplier|broker|internal    | service-account session
                                          v
                                  SUPPLIER PORTAL
```

### 4.1 Module boundaries

Each module has one purpose, a defined interface, and is testable alone.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `lib/domain/check-status.ts` | State machine + transition guards. Pure, no I/O. | nothing |
| `lib/domain/eligibility.ts` | Classify SUPPLIER / BROKER / INTERNAL. Pure. | nothing |
| `lib/domain/field-sniffer.ts` | Identify a cell's meaning by content pattern. Pure. | nothing |
| `lib/domain/actions.ts` | sign / ready / revert / release / clear. One transaction each. | db, the three above |
| `lib/integrations/acumatica/` | `odata.ts`, `rest.ts` behind `AcumaticaClient`; `field-map.ts` | http |
| `lib/integrations/portal/` | `PortalClient` (session mgmt, resolve, push, poll) + mock | http |
| `lib/sync/` | fetch -> map -> upsert -> `SyncRun` | the two above |
| `lib/import/` | Workbook ingestion + reconciliation report | field-sniffer, db |

The UI never writes a status directly; every mutation goes through `lib/domain/actions.ts`.

---

## 5. STATUS MODEL

Status is modelled on **two axes**, not one ladder. The release ladder records
custody of a physical check; clearing records what the bank did with it
afterwards. Keeping them separate means a check's release facts stay immutable
once it is released, and "released but not yet deposited" is representable
without inventing a combined state.

**Axis 1 — release ladder** (`status`):

```
GENERATED
  -> SIGNATURE_PENDING
    -> SIGNED
      -> READY_FOR_RELEASE   [portal: AVAILABLE_FOR_RELEASE]
        -> SCHEDULED         [portal: confirmed_at set]
          -> RELEASED        [portal: RELEASED]   (terminal)
  -> CANCELLED (terminal, reason required, from any pre-RELEASED state)

REVERT: READY_FOR_RELEASE | SCHEDULED -> SIGNED  (reason required)
```

**Axis 2 — clearing** (`clearingStatus`), permitted only once `status = RELEASED`:

```
NONE -> DEPOSITED | ENCASHED -> CLEARED     (CR number + clearing date)
```

`SCHEDULED` is not mandatory. A supplier may collect a check without having
confirmed a pickup slot in the portal, so `READY_FOR_RELEASE -> RELEASED` is a
legal transition. `SIGNED -> RELEASED` is not: a check must be made available
before it can be released.

### 5.1 Mapping to the portal

| Internal | Portal state | Mechanism |
| --- | --- | --- |
| `GENERATED` | not pushed | — |
| `SIGNATURE_PENDING` | not pushed | — |
| `SIGNED` | not pushed | — |
| `READY_FOR_RELEASE` | `AVAILABLE_FOR_RELEASE` | `POST /api/checks/mark-available` |
| `SCHEDULED` | `AVAILABLE_FOR_RELEASE` + `confirmed_at` | polled from `GET /api/checks` |
| `RELEASED` | `RELEASED` | `POST /api/checks/:id` |
| `DEPOSITED`/`ENCASHED`/`CLEARED` | not pushed | internal only |
| `CANCELLED` | not pushed | internal only |
| revert -> `SIGNED` | `REVERTED_FOR_REUPLOADING` | `POST /api/checks/revert` |

---

## 6. THE READY FOR RELEASE TRIGGER

The primary daily Finance action. One database transaction, then the push.

```
BLOCKING GUARDS  (failure aborts the action)
  GUARD 1  status === SIGNED
  GUARD 2  required fields present: checkNumber, payee, amount, checkDate,
           cashAccount, availablePickupDate
  GUARD 3  status !== RELEASED
   |
   |  any blocking guard fails -> typed error -> exact warning text on screen
   v
ROUTING CONDITION  (never blocks; decides whether a push happens)
  eligibility === SUPPLIER or BROKER  -> outbox event is written
  eligibility === INTERNAL            -> no outbox event, status still changes
   |
   v
BEGIN
  UPDATE check  status = READY_FOR_RELEASE, readyBy, readyAt, availablePickupDate
  INSERT audit  "Ready for Release - pickup <date>"
  INSERT outbox PortalEvent OUT (only when eligibility is SUPPLIER or BROKER)
COMMIT
   |
   v
push -> ok    : portalSyncStatus = SYNCED
        fail  : portalSyncStatus = PENDING, retried by worker, amber badge,
                visible in admin sync log
```

Confirmation prompt: *"Are you sure you want to mark this check as READY FOR RELEASE?"*

Success: *"Check CHK-001245 is now READY FOR RELEASE and has been updated in the Supplier Portal."*

Blocked example: *"This check cannot be released because it has not yet been marked as SIGNED."*

### 6.1 Why an outbox

A portal timeout must never (a) silently lose the notification or (b) roll back a status Finance already confirmed. The outbox decouples the two: the status change commits, the push retries.

### 6.2 REVERT AVAILABILITY

Same machinery in reverse. Requires a reason. Emits a retract event to `POST /api/checks/revert`, returns status to `SIGNED`, records who/when/why. **The check record is never deleted.**

### 6.3 Inbound pickup confirmations

The sync worker polls `GET /api/checks` and applies confirmations. A portal message may only move `READY_FOR_RELEASE -> SCHEDULED`. It can never mark a check `RELEASED` — physical release is a Finance-only confirmation.

---

## 7. ELIGIBILITY GATE

Classified from payee and payment category:

```
SUPPLIER  -> portal domain 'local'   -> /api/checks/mark-available
BROKER    -> portal domain 'broker'  -> /api/broker-checks/mark-available
INTERNAL  -> PAYROLL | TAX | FUND TRANSFER | INTER-COMPANY | MANAGER'S CHEQUE
          -> no portal call is ever made
```

Enforced in `lib/domain/eligibility.ts` **and** asserted again inside `PortalClient` before any request is built. Two independent checks: a payroll register reaching a supplier-facing portal is not a recoverable error.

`FT & MC` rows (50 records, amounts up to PHP 16,000,000, payees are the group's own companies) classify as `INTERNAL`.

Finance Admin may override a classification per check; the override is audited.

---

## 8. IMPORTER

Positional parsing is impossible (section 2.2). Fields are identified by content:

| Pattern | Meaning |
| --- | --- |
| `^(AP\|A1PP-AP\|STPP-AP)-` | APV (AP bill) |
| `^(CV\|A1PP-CV\|STPP-CV)-` | CV number (payment doc) |
| `^PO-` or `^PR-` | PO / purchase request |
| `^(BPI\|MBT\|BDO)-[SA]-\d+` | Checkbook |
| `^\d{6,10}$` | Check number |
| numeric 44000-48000 | Excel date serial |
| `LOCAL SUPPLIER\|PAYROLL\|TAX\|FUND TRANSFER\|UTILITIES\|BROKERS\|SALARIES` | Category |
| `^CR ?\d+` | Clearing reference |

Normalisation: strip `#N/A`, trim whitespace, fold payee casing to a canonical vendor. **The vendor merge list is presented for confirmation before commit** — it is not applied silently.

Anything unclassified goes to a review queue carrying source sheet and row number. Nothing is dropped.

### 8.1 Reconciliation

Importing 12,264 legacy rows will surface contradictions: a check appearing both RELEASED and CANCELLED, duplicate check numbers across sheets, the 9-digit `600027346` where 10 digits are expected, a stray header row inside `BPI A1 AVAIL.` data. The importer produces a **reconciliation report** listing every conflict. It does not pick a winner silently.

### 8.2 Duplicate prevention

Unique key `(companyId, checkNumber)`, plus `acumaticaPaymentId` unique where present. An existing record is **updated**, never duplicated.

---

## 9. DATA MODEL

```
Company        code (STK, A1+, P&P) · name
Bank           code (BPI, MBTC, BDO) · name
CashAccount    code ("BPI STK") · bank · company
CheckBook      code ("BPI-S-4636") · bank · company
Vendor         vendorId · canonicalName · aliases[] · eligibilityDefault

Check          UNIQUE(companyId, checkNumber)
               acumaticaPaymentId (unique, nullable)
               checkNumber · cvNumber · checkDate · amount · currency
               company · cashAccount · checkBook · payee -> Vendor
               category · eligibility · eligibilityOverriddenBy
               portalTradeId · portalDomain · portalSyncStatus
               status
               signedBy/At · readyBy/At · availablePickupDate
               scheduledPickupDate · scheduledPickupTime · pickupRep
               portalConfirmedAt
               releasedBy/At · orNumber · orDate · remarks
               pointPerson · checksPossession
               clearingStatus · crNumber · clearedDate
               cancelledBy/At · cancelReason
               sourceSheet · sourceRow            (provenance for imports)

CheckBill      check -> Check
               apvNumber · poNumber · rrNumber · statusRr
               description · glAccount · dueDate · termsCode · amount
               createdByName

AuditLog       check? · actorType (SYSTEM|USER) · user? · action
               details(json) · remarks · createdAt      [append-only]
PortalEvent    check · direction (OUT|IN) · payload · status · attempts
               lastError · createdAt                     [outbox]
SyncRun        startedAt · finishedAt · mode · imported · updated · errors
Notification   type · message · check? · readAt
User           email · name · passwordHash · role · active · lastLoginAt
Setting        key · value
```

`AuditLog` is append-only: no update or delete method exists in the codebase, and `UPDATE`/`DELETE` are revoked at the database level for the application role. This is what makes "audit records must not be editable" real rather than a UI convention.

---

## 10. ACUMATICA INTEGRATION

Read-only. `AcumaticaClient` exposes no mutating method, so writing back to Acumatica is impossible by construction, not by discipline.

```
ACUMATICA_MODE=odata|rest
ACUMATICA_BASE_URL=...
ACUMATICA_USER / ACUMATICA_PASSWORD
ACUMATICA_GI_NAME=...          (odata mode)
```

Basic auth, `$select`/`$filter` passthrough, `$top`/`$skip` paging with a default page size of 2000 — the AP feed is roughly 37,000 rows and some inquiries ignore `$top`, so paging is mandatory. `fetchImpl` is injectable so tests never hit the network.

Field mapping lives in `field-map.ts`; a column rename is a config edit.

Fields consumed: Company, Vendor ID, Vendor Name, APV/Reference Nbr., CV number, Check Number, Check Date, Amount, Currency, Cash Account, Payment Status.

---

## 11. SYNCHRONISATION

Every 15 minutes by default, plus a **SYNC NOW** button for Finance Admin.

Displays: last successful sync, last attempt, records imported, records updated, error count.

> Last Sync: September 1, 2026 - 10:45 AM
> 24 new checks imported, 3 records updated, 0 errors

The same worker polls the portal for pickup confirmations and drains the outbox.

---

## 12. USERS AND SECURITY

| Role | Permissions |
| --- | --- |
| `FINANCE_USER` | view, search, filter, mark signed, mark ready, set availability date, view pickup schedule, mark released, record clearing, view audit, run reports |
| `FINANCE_ADMIN` | all of the above, plus manage users, settings, integrations, view sync logs, re-sync, batch release, override eligibility, view system audit |

Argon2 password hashing, strong-password policy, 30-minute idle session timeout, httpOnly cookies, role checks enforced server-side on every action, audit logging, encrypted transport, portal credentials in env only.

No public access, no anonymous access, no supplier access of any kind.

---

## 13. UI

Light theme, white background, soft pastel status indicators, rounded cards, clean tables, minimal animation, professional typography, desktop-first and responsive. ALL CAPS for major labels and dashboard headings.

| Route | Contents |
| --- | --- |
| `/login` | Authentication |
| `/` | Summary cards; **READY FOR RELEASE panel pinned top**, then SCHEDULED, PENDING SIGNATURE, RELEASED; monitoring table |
| `/checks/[id]` | Check information, release monitoring, bills, audit trail |
| `/reports` | The five reports plus vendor × bank pivot; Excel + PDF export |
| `/admin/users` · `/admin/settings` · `/admin/sync` · `/admin/audit` | Administration, sync logs, SYNC NOW, unmatched queue, stale-check findings |

Summary cards: TOTAL CHECKS, PENDING SIGNATURE, SIGNED, READY FOR RELEASE, SCHEDULED, RELEASED, TOTAL CHECK VALUE.

Table columns: CHECK NUMBER, APV NUMBER, SUPPLIER NAME, COMPANY, CHECK DATE, AMOUNT, STATUS, AVAILABLE DATE, PICKUP SCHEDULE, READY FOR RELEASE, RELEASED, ACTION.

Search by check number, APV number, CV number, supplier name, supplier ID. Filters: company, bank/cash account, status, eligibility, check date, available date, supplier, Finance user. Date presets: today, this week, this month, custom range.

Reports: Daily Check Release, Ready for Release, Released Check, Unreleased Check, Supplier Pickup, plus the vendor × bank-account pivot already in use.

Notifications, in-system only: new checks imported, supplier confirmed pickup, checks ready for release, unreleased check past its scheduled pickup.

### 13.1 Minimum-click workflow

```
OPEN DASHBOARD -> tick [x] READY FOR RELEASE -> CONFIRM
  -> portal updated automatically -> supplier confirms pickup
  -> schedule appears -> tick RELEASED -> DONE
```

Two clicks per check. No re-encoding of anything Acumatica already knows.

---

## 14. TESTING

Pure domain first, with Vitest:

- every legal and illegal status transition
- the four READY FOR RELEASE guards
- **eligibility: an `INTERNAL` check must never produce a portal call**
- duplicate prevention on `(Company, Check Number)`
- the field sniffer against real rows drawn from both workbooks
- outbox retry and idempotency
- Acumatica field mapping in both modes, with an injected `fetchImpl`

Then Playwright on the path that must never break: sign -> ready -> portal push -> schedule pulled back -> release -> audit trail complete.

---

## 15. RISKS AND OPEN ITEMS

| # | Item | Handling |
| --- | --- | --- |
| R1 | Portal service account does not exist yet | Must be created at `encoder` tier. Everything except the live push works without it; the mock client covers development. |
| R2 | APVs that resolve to no portal `trade` | Surfaced in an UNMATCHED queue rather than failing silently, which is the current behaviour of the Excel upload. |
| R3 | 88 CHECK FINDING rows are 2025 checks still AVAILABLE | Imported into a stale queue for review. Not auto-released, not auto-cancelled. |
| R4 | Legacy data contradictions across 12,264 rows | Reconciliation report; no silent winner. |
| R5 | `APPROVAL FOR RELEASE` has no check-date column | Document date used as a stand-in and flagged as such; real sync supplies the true check date. |
| R6 | Portal session expiry mid-batch | Client re-authenticates once on 401 and retries; a second failure leaves the outbox event PENDING. |
| R7 | Adding a bearer-token API to the portal | Recommended follow-up, documented for the portal team. Not required for this project. |

---

## 16. OUT OF SCOPE

- Any supplier-facing page, login, registration, profile, or dashboard
- Writing financial data back to Acumatica
- Replacing any part of the Supplier Portal
- Modifying the Supplier Portal repository
