# Check Release Monitoring — Plan 2: Ingestion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the client's real check data into the system — both the 12,264 historical rows sitting in a spreadsheet, and a live incremental feed from Acumatica — without inventing, losing, or silently mangling any of it.

**Architecture:** Two independent ingestion paths converging on one upsert. A content-sniffing workbook parser handles the historical spreadsheet, whose columns drift between sheets. An OData reader handles Acumatica's `AP-Checks and Payments` generic inquiry incrementally. Both produce the same normalised row shape, and both go through one `upsertCheck` that enforces duplicate prevention. Nothing in this plan writes a `PortalEvent` or touches the Supplier Portal — that is Plan 3.

**Tech Stack:** Next.js 15, Prisma 6, PostgreSQL (Neon), TypeScript strict, Vitest, `exceljs` for workbook reading, `zod` for boundary validation.

**Source spec:** `docs/superpowers/specs/2026-09-01-check-release-monitoring-design.md`
**Builds on:** `docs/superpowers/plans/2026-09-01-foundation-and-domain-core.md` (Plan 1, complete)

---

## Global Constraints

Everything from Plan 1 still binds. In addition:

- **The database is Neon cloud PostgreSQL.** No local Postgres, no `psql`, no Docker. `.env` holds `DATABASE_URL`, `DATABASE_URL_TEST`, `DIRECT_DATABASE_URL`, `DIRECT_DATABASE_URL_TEST`, `AUTH_SECRET`. **Never print its contents or echo a connection string.**
- **Prisma Migrate reads `directUrl`, not `url`.** Apply to the test database with `DIRECT_DATABASE_URL="$DIRECT_DATABASE_URL_TEST" npx prisma migrate deploy`. Apply every migration to **both** databases.
- **Never edit an applied migration** — Prisma stores a checksum and `migrate deploy` will fail. Always add a new one.
- **Acumatica is read-only.** `AcumaticaClient` exposes no mutating method. This is not a convention to be careful about; it is the reason the type has no such method.
- **Parsers are pure.** `lib/import/field-sniffer.ts` and `lib/integrations/acumatica/map.ts` take data and return data: no database, network, filesystem, `process.env`, `Date.now()` or `new Date()`.
- **Nothing in this plan may write a `PortalEvent` or call the Supplier Portal.** Import and sync change a check's *data*, never its release status. A check imported at `SIGNATURE_PENDING` stays there until a Finance user acts.
- **`AuditLog` is append-only** — enforced by a database trigger. Every import and sync writes `SYSTEM`-actor audit rows through `writeAudit`.
- **An `INTERNAL` check cannot hold portal routing state** — enforced by a CHECK constraint. Any import path that sets `portalDomain` or `portalSyncStatus` must go through `portalRoute()`.
- **Amounts are `Decimal(18,2)` and never a JavaScript `number`.**
- **Currency is NOT PHP-only.** Verified against the live feed: of 1,490 payment rows sampled,
  1,270 are PHP, 138 CNY and 82 USD. **Never sum across currencies.** Every amount carries its
  currency, every total is per-currency, and `formatPhp` is replaced by a currency-aware
  `formatMoney(amount, currency)`. A single peso total spanning three currencies is not a rounding
  problem, it is a meaningless number that looks authoritative.
- **Not every Acumatica payment is a cheque.** The `DG` (Dongguan) and `SH` (Shanghai) branches pay
  in CNY and their `PaymentRef` carries an AP reference (`AP-DG001931`), not a cheque number. They
  are imported so nothing is invisible, but flagged `isCheque = false` and **can never be marked
  SIGNED, READY FOR RELEASE or RELEASED** — there is no physical cheque to hand over.
- Test output must be pristine. `npx tsc --noEmit` clean, `npm run build` warning-free.
- Every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## What we learned from the Supplier Portal, and are reusing

The client's existing Supplier Portal already reads this Acumatica instance. Its integration is the source of the following facts; they are not inferences.

- The payments generic inquiry is named **`AP-Checks and Payments`**, and exposes:
  `Type, ReferenceNbr, Vendor, VendorName, Status, PaymentDate, Description, PaymentRef, PaymentAmount, Balance, Currency, CashAccount, PaymentMethod, Branch, LastModifiedOn`
- **`PaymentRef` is the check number.** `ReferenceNbr` is the CV (check voucher) number. The workbook's "CHECK NUMBER" column is `PaymentRef`; its "VOUCHER NUMBER"/CV column is `ReferenceNbr`.
- **There are two Acumatica tenants** — Go-Live and MANUFACTURING — and they reuse the same branch codes for different companies. `ST` is Starkson Packaging in one and Starkson Paper and Plastic in the other. Company resolution is `(tenant, branch)`; branch alone is ambiguous.
- **A voided cheque is two rows under one reference:** the original (positive, `Status = Voided`) and its reversal (negative, `Status = Closed`).
- The feed carries five document types: `Payment`, `Voided Payment`, `Prepayment`, `Debit Adj.`, `Refund`.
- Incremental sync works off `LastModifiedOn` with a deliberate **120-minute overlap** on re-reads, because a row committed *during* a run can carry a timestamp below the maximum that run observed and would otherwise never be picked up again.

## Decisions taken before this plan

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | Six companies, keyed by `(tenant, branch)`, mirroring the portal | Both systems exchange checks by APV; they must agree on what a company is |
| D2 | Import `Payment` and `Voided Payment`; skip `Prepayment`, `Debit Adj.`, `Refund` | Only the first two are cheques Finance hands to a supplier |
| D3 | A voided cheque gets a terminal `VOIDED` status, distinct from `CANCELLED` | `CANCELLED` is a Finance action with a reason; `VOIDED` is an Acumatica fact |
| D4 | Import never changes release status | Acumatica does not know whether Finance has signed a cheque |

## The shared shape both ingestion paths produce

> **SUPERSEDED (2026-09-03).** This section describes `lib/import/types.ts`, which was never
> created. The shape actually built is **`lib/normalised-row.ts`**, written in Task 8 — read that
> file, not this block. It is the authority; the sketch below is kept only to explain the changes.
>
> What differs, and why:
>
> | This sketch | As built | Why |
> | --- | --- | --- |
> | `checkNumber: string` | `string \| null` | Acumatica's China rows carry an AP reference, not a cheque number, and 66 register rows have none at all. Non-nullable here would have forced an invented value at the boundary. |
> | `isVoided`, `tenant`, `sheet`, `rowNumber` | `voided`, `acumaticaTenant`, `sourceSheet`, `sourceRow` | Named to match the `Check` columns they feed, so the upsert is a copy rather than a translation. |
> | — | `acumaticaPaymentId`, `isCheque`, `acumaticaBranch` | `isCheque` is needed because not every payment is one; the other two are provenance the sketch omitted. |
> | `bills: {apvNumber, poNumber, amount}[]` | `apvNumbers: string[]`, `poNumbers: string[]`, `clearingRef` | The payments generic inquiry is **one row per payment and publishes no bill breakdown**, so no `amount` per bill is available from Acumatica at all. Bill-level detail — amount, due date, terms, GL account — comes from the approval-for-release workbook into `CheckBill` (Task 11), whose grain is one row per bill. A cheque-level reference list and a bill ledger are different things. |
>
> One consequence worth stating plainly: **`acumaticaPaymentId` is identical to `cvNumber` for
> every Acumatica row.** The inquiry has no separate document key, and the Supplier Portal's
> `ap_payment.ref` is unique on exactly `ReferenceNbr`. They are kept as two fields because one is
> provenance and the other a business identifier a workbook row can also carry. Do not collapse them.

```ts
export type IngestSource = 'WORKBOOK' | 'ACUMATICA'

export type NormalisedRow = {
  source: IngestSource
  // Provenance. For WORKBOOK, the sheet and row so a reconciliation report can
  // point a human at the cell. For ACUMATICA, the feed's own identifiers.
  sheet?: string
  rowNumber?: number

  // Identity. `checkNumber` plus a resolved company is the duplicate key.
  checkNumber: string
  cvNumber: string | null
  companyCode: string | null          // null when the branch is unrecognised
  tenant: 'GOLIVE' | 'MANUFACTURING' | null

  // Money and dates
  amount: string | null               // decimal string, never a JS number
  currency: string | null
  checkDate: Date | null

  // Vendor and routing
  payeeName: string | null
  vendorCode: string | null
  cashAccountCode: string | null
  checkBookCode: string | null
  category: string | null

  // Acumatica provenance; null for workbook rows
  acumaticaDocType: string | null     // Payment | Voided Payment
  acumaticaStatus: string | null
  isVoided: boolean
  lastModifiedOn: Date | null

  // Bills. A cheque can pay several.
  bills: { apvNumber: string; poNumber: string | null; amount: string | null }[]
}
```

`companyCode` is deliberately nullable. An unrecognised branch is a data surprise, and a row that cannot be attributed to a company must land somewhere a human will see it rather than defaulting to company one.

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/import/field-sniffer.ts` | Identify what a cell *is* from its content. Pure. |
| `lib/import/normalise.ts` | Canonical vendor names, `#N/A` stripping, Excel date serials. Pure. |
| `lib/import/workbook.ts` | Read a workbook into raw grids (I/O only, no interpretation) |
| `lib/import/parse.ts` | Grid + sniffer → normalised rows + unclassified queue |
| `lib/import/reconcile.ts` | Detect contradictions across rows. Pure. |
| `lib/import/upsert.ts` | The single write path for both ingestion sources |
| `lib/integrations/acumatica/client.ts` | OData reader: Basic auth, paging, injectable fetch |
| `lib/integrations/acumatica/map.ts` | Feed row → normalised row. Pure. |
| `lib/integrations/acumatica/companies.ts` | `(tenant, branch)` → company. Pure. |
| `lib/sync/run.ts` | Incremental sync orchestration, `SyncRun` records |
| `app/admin/sync/page.tsx` | Sync status, history, SYNC NOW |
| `app/admin/import/page.tsx` | Workbook upload, reconciliation report, confirm |
| `scripts/import-workbook.ts` | CLI for the one-time 12,264-row historical load |

---

## Task 1: Company and Tenant Model

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_tenants_and_companies/migration.sql`
- Create: `lib/integrations/acumatica/companies.ts`
- Test: `tests/integrations/companies.test.ts`

**Interfaces:**
- Consumes: Plan 1's schema
- Produces:
  - `type AcumaticaTenant = 'GOLIVE' | 'MANUFACTURING'`
  - `companyForBranch(tenant: AcumaticaTenant, branch: string): string | null` — returns a company **code**, or `null` for an unrecognised branch
  - `UNASSIGNED_COMPANY = 'UNASSIGNED'`
  - Schema: `Company` gains `tenant` and `branch`, with `@@unique([tenant, branch])`

- [ ] **Step 1: Write the failing test**

`tests/integrations/companies.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { companyForBranch } from '@/lib/integrations/acumatica/companies'

describe('branch routing is per tenant', () => {
  it('routes the same branch code to different companies by tenant', () => {
    // This is the whole reason the function takes a tenant. Getting it wrong
    // files Starkson Paper and Plastic's cheques under Starkson Packaging.
    expect(companyForBranch('GOLIVE', 'ST')).toBe('STK')
    expect(companyForBranch('MANUFACTURING', 'ST')).toBe('STPP')
    expect(companyForBranch('GOLIVE', 'A1+')).toBe('A1+')
    expect(companyForBranch('MANUFACTURING', 'A1+')).toBe('A1PP')
  })

  it('routes the companies that exist in both tenants to the same company', () => {
    for (const t of ['GOLIVE', 'MANUFACTURING'] as const) {
      expect(companyForBranch(t, 'HAMFI(HO)')).toBe('HAMFI')
      expect(companyForBranch(t, 'STINDUSTRY')).toBe('IND')
    }
  })

  it('routes the A1+ Paper and Plastic sibling branches', () => {
    for (const b of ['EURASIA', 'HASBRO', 'MATTEL', 'PERULANDIA', 'SITIO', 'WARNER']) {
      expect(companyForBranch('MANUFACTURING', b), b).toBe('A1PP')
    }
  })

  it('returns null for an unrecognised branch rather than guessing', () => {
    // A branch nobody recognises is a data surprise. Silently filing it under
    // company one is how a cheque ends up attributed to the wrong legal entity.
    expect(companyForBranch('GOLIVE', 'ONEMARANAO')).toBeNull()
    expect(companyForBranch('GOLIVE', '')).toBeNull()
    expect(companyForBranch('MANUFACTURING', 'NOPE')).toBeNull()
  })

  it('tolerates the padding Acumatica applies to branch codes', () => {
    expect(companyForBranch('GOLIVE', '  ST  ')).toBe('STK')
    expect(companyForBranch('MANUFACTURING', 'hamfi(ho)')).toBe('HAMFI')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integrations/companies.test.ts`
Expected: FAIL, "Cannot find package '@/lib/integrations/acumatica/companies'".

- [ ] **Step 3: Write `lib/integrations/acumatica/companies.ts`**

```ts
export type AcumaticaTenant = 'GOLIVE' | 'MANUFACTURING'

// Acumatica's two tenants reuse the same branch codes for different companies.
// In Go-Live, "ST" is Starkson Packaging; in MANUFACTURING it is Starkson Paper
// and Plastic. Routing on branch alone files a cheque under the wrong legal
// entity, so the tenant is not optional.
//
// Mirrors the Supplier Portal's routing table so both systems agree on what a
// company is — they exchange cheques by APV number and must not disagree.
const GOLIVE: Readonly<Record<string, string>> = {
  ST: 'STK',
  'A1+': 'A1+',
  'HAMFI(HO)': 'HAMFI',
  STINDUSTRY: 'IND',
}

const MANUFACTURING: Readonly<Record<string, string>> = {
  ST: 'STPP',
  'A1+': 'A1PP',
  // A1+ Paper and Plastic carries the same sibling branches A1+ Multinational
  // does in Go-Live.
  EURASIA: 'A1PP',
  HASBRO: 'A1PP',
  MATTEL: 'A1PP',
  PERULANDIA: 'A1PP',
  SITIO: 'A1PP',
  WARNER: 'A1PP',
  'HAMFI(HO)': 'HAMFI',
  STINDUSTRY: 'IND',
}

export function companyForBranch(tenant: AcumaticaTenant, branch: string): string | null {
  const key = String(branch ?? '').trim().toUpperCase()
  if (!key) return null
  const map = tenant === 'MANUFACTURING' ? MANUFACTURING : GOLIVE
  return map[key] ?? null
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integrations/companies.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the schema**

In `prisma/schema.prisma`, add the enum and extend `Company`:

```prisma
enum AcumaticaTenant {
  GOLIVE
  MANUFACTURING
}

model Company {
  id           String           @id @default(cuid())
  code         String           @unique
  name         String
  tenant       AcumaticaTenant?
  branch       String?
  legalNames   String[]
  cashAccounts CashAccount[]
  checkBooks   CheckBook[]
  checks       Check[]
  createdAt    DateTime         @default(now())

  @@unique([tenant, branch])
}
```

Add `VOIDED` to `CheckStatus`, and the Acumatica provenance fields to `Check`:

```prisma
enum CheckStatus {
  GENERATED
  SIGNATURE_PENDING
  SIGNED
  READY_FOR_RELEASE
  SCHEDULED
  RELEASED
  CANCELLED
  VOIDED
}
```

On `Check`, add:

```prisma
  acumaticaDocType   String?
  acumaticaStatus    String?
  acumaticaBranch    String?
  acumaticaTenant    AcumaticaTenant?
  lastModifiedOn     DateTime?
  voidedAt           DateTime?
```

- [ ] **Step 6: Create and apply the migration**

```bash
npx prisma migrate dev --name tenants_and_companies
DIRECT_DATABASE_URL="$DIRECT_DATABASE_URL_TEST" npx prisma migrate deploy
```

Expected: applied to both databases. Run `npx prisma migrate status` against each and confirm both report up to date.

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc --noEmit`
Expected: all existing tests still pass; `tsc` silent. Adding an enum value and nullable columns breaks nothing.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/integrations/acumatica/companies.ts tests/integrations/companies.test.ts
git commit -m "feat: model Acumatica tenants and route branches to companies

The two tenants reuse the same branch codes for different companies - ST is
Starkson Packaging in Go-Live and Starkson Paper and Plastic in MANUFACTURING -
so a cheque routed on branch alone lands under the wrong legal entity. Mirrors
the Supplier Portal's routing table so both systems agree on what a company is.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Reference Data for Six Companies

**Files:**
- Modify: `prisma/seed.ts`
- Test: `tests/seed-reference.test.ts`

**Interfaces:**
- Consumes: Task 1's schema and `companyForBranch`
- Produces: six companies with tenant/branch, their cash accounts and checkbooks

Plan 1 seeded three companies and conflated Starkson Paper and Plastic with A1+ Paper and Plastic under a single "P&P". That is wrong: they are separate legal entities issuing separate cheques.

- [ ] **Step 1: Write the failing test**

`tests/seed-reference.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { COMPANIES } from '@/prisma/reference-data'

describe('company reference data', () => {
  it('has six companies, not three', () => {
    expect(COMPANIES).toHaveLength(6)
  })

  it('keeps Starkson and A1+ Paper and Plastic separate', () => {
    const codes = COMPANIES.map((c) => c.code)
    expect(codes).toContain('STPP')
    expect(codes).toContain('A1PP')
    // The old model folded both into one "P&P" company.
    expect(codes).not.toContain('P&P')
  })

  it('gives every company a tenant and branch that round-trips through routing', async () => {
    const { companyForBranch } = await import('@/lib/integrations/acumatica/companies')
    for (const c of COMPANIES) {
      expect(companyForBranch(c.tenant, c.branch), c.code).toBe(c.code)
    }
  })

  it('carries the legal names the eligibility classifier needs', () => {
    // classifyEligibility treats a payment to one of our own companies as
    // INTERNAL. It can only do that if the names are here.
    const all = COMPANIES.flatMap((c) => c.legalNames)
    expect(all).toContain('STARKSON PACKAGING INC.')
    expect(all).toContain('A1+ MULTINATIONAL PACKAGING INC.')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/seed-reference.test.ts`
Expected: FAIL, "Cannot find package '@/prisma/reference-data'".

- [ ] **Step 3: Extract reference data into `prisma/reference-data.ts`**

```ts
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'

export type CompanyRef = {
  code: string
  name: string
  tenant: AcumaticaTenant
  branch: string
  legalNames: string[]
}

// Six companies across two Acumatica tenants. Mirrors the Supplier Portal's
// routing table. `legalNames` feeds classifyEligibility's inter-company check —
// a payment to one of our own companies is INTERNAL and must never reach the
// supplier portal.
export const COMPANIES: readonly CompanyRef[] = [
  { code: 'STK',   name: 'Starkson Packaging Inc.',            tenant: 'GOLIVE',        branch: 'ST',
    legalNames: ['STARKSON PACKAGING INC.'] },
  { code: 'A1+',   name: 'A1+ Multinational Packaging Inc.',   tenant: 'GOLIVE',        branch: 'A1+',
    legalNames: ['A1+ MULTINATIONAL PACKAGING INC.'] },
  { code: 'STPP',  name: 'Starkson Paper and Plastic',         tenant: 'MANUFACTURING', branch: 'ST',
    legalNames: ['STARKSON PAPER AND PLASTIC'] },
  { code: 'A1PP',  name: 'A1+ Paper and Plastic',              tenant: 'MANUFACTURING', branch: 'A1+',
    legalNames: ['A1+ PAPER AND PLASTIC'] },
  { code: 'HAMFI', name: 'Happy Alliance Mono Film Inc.',      tenant: 'GOLIVE',        branch: 'HAMFI(HO)',
    legalNames: ['HAPPY ALLIANCE MONO FILM INC', 'HAPPY ALLIANCE MONO FILM INC.'] },
  { code: 'IND',   name: 'Starkson Industries Inc.',           tenant: 'GOLIVE',        branch: 'STINDUSTRY',
    legalNames: ['STARKSON INDUSTRIES', 'STARKSON INDUSTRIES INC'] },
]

// Bank + company. Codes are exactly as they appear in the client's register.
export const CASH_ACCOUNTS: readonly { code: string; bank: string; company: string }[] = [
  { code: 'BPI STK',  bank: 'BPI',  company: 'STK' },
  { code: 'BPI P&P',  bank: 'BPI',  company: 'STPP' },
  { code: 'BPI A1',   bank: 'BPI',  company: 'A1+' },
  { code: 'MBTC A1+', bank: 'MBTC', company: 'A1+' },
  { code: 'MBTC P&P', bank: 'MBTC', company: 'A1PP' },
  { code: 'BDO A1',   bank: 'BDO',  company: 'A1+' },
]

export const CHECK_BOOKS: readonly { code: string; bank: string; company: string }[] = [
  { code: 'BPI-S-4636', bank: 'BPI',  company: 'STK' },
  { code: 'BPI-A-5713', bank: 'BPI',  company: 'A1+' },
  { code: 'BPI-S-8879', bank: 'BPI',  company: 'STPP' },
  { code: 'BPI-A-8879', bank: 'BPI',  company: 'A1PP' },
  { code: 'MBT-A-4155', bank: 'MBTC', company: 'A1+' },
  { code: 'MBT-A-9048', bank: 'MBTC', company: 'A1PP' },
  // NOTE: `MBT-S-9048` appears in the register but is NOT a real checkbook —
  // Finance confirmed (2026-09-03) it is a mis-keying of MBT-A-9048. It is
  // deliberately absent here and normalised on import; see canonicalCheckBook.
  { code: 'MBT-S-1121', bank: 'MBTC', company: 'STK' },
  { code: 'BDO-A-3838', bank: 'BDO',  company: 'A1+' },
]
```

> **Verify the cash-account and checkbook company assignments against the client before relying on them.** They are inferred from the register's document prefixes and the account naming (`BPI P&P`, `MBT-A-9048`). The bank and the code are certain; which of the two Paper and Plastic entities owns each is not. Flag any you cannot confirm rather than guessing silently.

- [ ] **Step 4: Rewrite `prisma/seed.ts` to consume it**

Replace the inline `COMPANIES`, `CASH_ACCOUNTS` and `CHECK_BOOKS` arrays with imports from `prisma/reference-data.ts`, and include `tenant` and `branch` in the company upsert. Keep every existing guard: the non-fixture-data refusal, the credential warning, and `classifyEligibility` computing eligibility rather than it being hardcoded.

The fixtures reference `'P&P'`, which no longer exists. Repoint each to the correct company: fixtures on `MBTC P&P` belong to `A1PP`, those on `BPI P&P` to `STPP`.

- [ ] **Step 5: Run the tests and re-seed**

```bash
npx vitest run tests/seed-reference.test.ts
npm run db:seed
```

Expected: tests pass; the seed refuses if non-fixture data is present, otherwise upserts six companies. Confirm with a direct query that six companies exist and that no check is left pointing at a missing company.

- [ ] **Step 6: Commit**

```bash
git add prisma/reference-data.ts prisma/seed.ts tests/seed-reference.test.ts
git commit -m "feat: seed six companies across two tenants

Plan 1 conflated Starkson Paper and Plastic with A1+ Paper and Plastic under a
single P&P company and omitted HAMFI and Starkson Industries entirely. They are
separate legal entities issuing separate cheques.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2b: Currency and Non-Cheque Payments

Added after connecting to the live Acumatica feed, which contradicted two assumptions the spec and the register had both left implicit. This task must land before any import runs, because both facts change what a correct import looks like.

**Files:**
- Modify: `prisma/schema.prisma` (+ migration), `prisma/reference-data.ts`, `lib/integrations/acumatica/companies.ts`, `lib/money.ts`, `lib/queries.ts`, `components/SummaryCards.tsx`, `lib/domain/check-status.ts`
- Test: `tests/money.test.ts`, `tests/integrations/companies.test.ts`, `tests/domain/check-status.test.ts`, `tests/queries.test.ts`

**Interfaces produced:**
- `formatMoney(amount: string | Prisma.Decimal, currency: string): string` — replaces `formatPhp`
- `getSummary(db)` returns `totalsByCurrency: { currency: string; total: string; count: number }[]` instead of a single `totalValue`
- `companyForBranch` additionally routes `DG` → `DG` and `SH` → `SH`
- `Check.isCheque: Boolean @default(true)`
- `assertReleasable(check)` — throws unless `isCheque`

- [ ] **Step 1: Two more companies, and route their branches**

Dongguan Office (`DG`) and Shanghai Office (`SH`), both in the Go-Live tenant. Add to `COMPANIES` and to the `GOLIVE` routing map. Their cash account is `RMB-C-2213`.

Extend `tests/integrations/companies.test.ts`:

```ts
it('routes the China offices', () => {
  expect(companyForBranch('GOLIVE', 'DG')).toBe('DG')
  expect(companyForBranch('GOLIVE', 'SH')).toBe('SH')
})
```

- [ ] **Step 2: `isCheque` on the Check model**

```prisma
  // Not every Acumatica payment is a cheque. The China offices pay by transfer,
  // and their PaymentRef carries an AP reference rather than a cheque number.
  // Such a payment is tracked but has no physical document to sign or hand over.
  isCheque Boolean @default(true)
```

Migration via `migrate diff` + `migrate deploy` to both databases (`migrate dev` does not run in this shell).

- [ ] **Step 3: A non-cheque payment cannot enter the release ladder**

In `lib/domain/check-status.ts`, add to the READY FOR RELEASE guards — and to `markSigned` and `markReleased` in `lib/domain/actions.ts` — a check that refuses a non-cheque payment:

```ts
export function assertReleasable(input: { isCheque: boolean }): void {
  if (!input.isCheque) {
    throw new DomainError(
      'NOT_A_CHEQUE',
      'This payment is not a cheque, so it cannot be signed or released. It is tracked here for visibility only.',
    )
  }
}
```

Test that a non-cheque payment is refused at each of sign, ready and release, and that the audit trail records nothing for the refused attempt.

- [ ] **Step 4: `formatMoney` replaces `formatPhp`**

Keep the half-up rounding and the string-based carry exactly as they are — only the symbol becomes a parameter:

```ts
const SYMBOLS: Readonly<Record<string, string>> = { PHP: '₱', CNY: '¥', USD: '$' }

// An unknown currency renders its ISO code rather than guessing a symbol: a
// wrong symbol on a financial figure is worse than an unfamiliar one.
export function formatMoney(value: string | number | Prisma.Decimal, currency: string): string {
  const symbol = SYMBOLS[currency?.toUpperCase()] ?? `${currency} `
  // ... existing rounding and grouping, with `symbol` in place of the hardcoded ₱
}
```

Tests: every existing `formatPhp` case still passes through `formatMoney(x, 'PHP')`; `formatMoney('892140', 'CNY')` renders `¥892,140.00`; an unknown code renders `XYZ 1,000.00` rather than a peso sign.

- [ ] **Step 5: Per-currency totals**

`getSummary` groups by currency. The dashboard card lists one line per currency with its count. **There must be no code path that adds two different currencies together** — a test asserting a mixed-currency dataset produces multiple totals, not one, is the point of this step.

- [ ] **Step 6: Run everything, walk the dashboard, commit**

The seeded data is all PHP, so add a temporary CNY check to the **test** database to exercise the breakdown, and remove it. Do not add non-PHP fixtures to the seed.

---

## Task 3: The Field Sniffer

**Files:**
- Create: `lib/import/field-sniffer.ts`
- Test: `tests/import/field-sniffer.test.ts`

**Interfaces:**
- Consumes: nothing (pure)
- Produces:
  - `type FieldKind = 'APV' | 'CV' | 'PO' | 'CHECKBOOK' | 'CHECK_NUMBER' | 'DATE_SERIAL' | 'CATEGORY' | 'CLEARING_REF' | 'AMOUNT' | 'STATUS_WORD' | 'CASH_ACCOUNT' | 'UNKNOWN'`
  - `sniff(value: unknown): FieldKind`

The client's monitoring workbook has fifteen sheets whose columns do not line up. The APV sits in column H on one sheet, F on another, and both B and D on a third. Column E holds a payee on one sheet and a description on the next. Positional parsing is therefore impossible; every cell must be identified by what it contains.

- [ ] **Step 1: Write the failing test**

`tests/import/field-sniffer.test.ts`. Every value below is taken verbatim from the client's register.

```ts
import { describe, it, expect } from 'vitest'
import { sniff } from '@/lib/import/field-sniffer'

describe('sniff', () => {
  it('identifies APV numbers across all document prefixes', () => {
    for (const v of ['AP-ST036198', 'AP-A1032460', 'AP-HF001969', 'STPP-AP-000019', 'A1PP-AP-000007', 'AP-IND000580']) {
      expect(sniff(v), v).toBe('APV')
    }
  })

  it('identifies CV numbers', () => {
    for (const v of ['CV-ST011550', 'CV-A1009393', 'CV-HF000087', 'A1PP-CV-000009', 'STPP-CV-000012']) {
      expect(sniff(v), v).toBe('CV')
    }
  })

  it('identifies PO and PR numbers', () => {
    for (const v of ['PO-ST-027363', 'PO-A1-024234', 'A1PP-PO-000012', 'PR-D02-001314']) {
      expect(sniff(v), v).toBe('PO')
    }
  })

  it('identifies checkbooks', () => {
    for (const v of ['BPI-S-4636', 'BPI-A-5713', 'MBT-A-4155', 'MBT-S-1121', 'BDO-A-3838', 'BPI-S-8879']) {
      expect(sniff(v), v).toBe('CHECKBOOK')
    }
  })

  it('identifies check numbers at their two real lengths', () => {
    // BDO cheques are 6 digits, BPI and MBTC are 10. Those are the only two
    // lengths in the register.
    for (const v of ['6000329924', '1791379619', '174602', '326350']) {
      expect(sniff(v), v).toBe('CHECK_NUMBER')
    }
  })

  it('does not mistake a round-number amount for a cheque number', () => {
    // The register carries 4200000 and 20000000 as amounts. A \d{6,10} rule
    // matched them, and appearing earlier in the row they became the cheque
    // number. 600089528 is a truncated BPI number and belongs in review.
    for (const v of ['4200000', '20000000', '600089528', '60003162116']) {
      expect(sniff(v), v).not.toBe('CHECK_NUMBER')
    }
    expect(sniff(4200000)).not.toBe('CHECK_NUMBER')
    expect(sniff(20000000)).not.toBe('CHECK_NUMBER')
  })

  it('identifies Excel date serials in the plausible range', () => {
    // 44000 is 2020, 48000 is 2031. Outside that, a bare number is a check
    // number or an amount, not a date.
    for (const v of [46164, 45882.606282141198, 46259]) {
      expect(sniff(v), String(v)).toBe('DATE_SERIAL')
    }
  })

  it('identifies payment categories', () => {
    for (const v of ['LOCAL SUPPLIER', 'PAYROLL', 'UTILITIES', 'TAX', 'FUND TRANSFER', 'BROKERS', 'SALARIES']) {
      expect(sniff(v), v).toBe('CATEGORY')
    }
  })

  it('identifies clearing references', () => {
    for (const v of ['CR 6336', 'CR08970', 'CR19030']) {
      expect(sniff(v), v).toBe('CLEARING_REF')
    }
  })

  it('does not mistake a checkbook for a check number', () => {
    // BPI-S-4636 contains digits but is not a cheque.
    expect(sniff('BPI-S-4636')).not.toBe('CHECK_NUMBER')
  })

  it('does not mistake a check number for a date serial', () => {
    expect(sniff('174602')).toBe('CHECK_NUMBER')
    expect(sniff(174602)).toBe('CHECK_NUMBER')
  })

  it('identifies text-formatted amounts', () => {
    // Running the parser over the real register produced vendors named
    // "17187.5" and "3746.25": decimal text fell through to UNKNOWN and won the
    // payee slot. A decimal point is required, so cheque numbers are unaffected.
    for (const v of ['17187.5', '1718.75', '3746.25', '197715.42', '1,234.56']) {
      expect(sniff(v), v).toBe('AMOUNT')
    }
  })

  it('does not mistake a whole-number cheque number for an amount', () => {
    expect(sniff('6000329924')).toBe('CHECK_NUMBER')
    expect(sniff('174602')).toBe('CHECK_NUMBER')
  })

  it('identifies the cash-account labels the register uses', () => {
    for (const v of ['BPI STK', 'BPI P&P', 'MBTC A1+', 'MBTC P&P']) {
      expect(sniff(v), v).toBe('CASH_ACCOUNT')
    }
  })

  it('does not mistake a bank that is a genuine payee for an account label', () => {
    // The group pays BDO Unibank as a vendor; eight cheques in the register go
    // to it. Matching on a bank-name prefix would have swallowed them.
    expect(sniff('BDO Unibank, Inc')).toBe('UNKNOWN')
    expect(sniff('BDO Unibank, Inc Credit Card')).toBe('UNKNOWN')
  })

  it('identifies status words the register scatters across columns', () => {
    // "CANCELLED" became a vendor name before this rule existed.
    for (const v of ['PAID', 'YES', 'CANCELLED', 'DEPOSITED', 'CLEARED', 'RELEASED']) {
      expect(sniff(v), v).toBe('STATUS_WORD')
    }
  })

  it('returns UNKNOWN rather than guessing', () => {
    for (const v of ['', '   ', '#N/A', null, undefined, 'Some free text description']) {
      expect(sniff(v as unknown), String(v)).toBe('UNKNOWN')
    }
  })

  it('is not confused by the surrounding whitespace the register carries', () => {
    expect(sniff('  AP-ST036198  ')).toBe('APV')
    expect(sniff(' BPI-S-4636 ')).toBe('CHECKBOOK')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/import/field-sniffer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `lib/import/field-sniffer.ts`**

```ts
export type FieldKind =
  | 'APV' | 'CV' | 'PO' | 'CHECKBOOK' | 'CHECK_NUMBER'
  | 'DATE_SERIAL' | 'CATEGORY' | 'CLEARING_REF' | 'AMOUNT' | 'STATUS_WORD'
  | 'CASH_ACCOUNT' | 'UNKNOWN'

// The client's monitoring workbook has fifteen sheets whose columns do not line
// up: the APV is column H on one sheet, F on another, B and D on a third, and
// column E holds a payee on one sheet and a description on the next. Positional
// parsing cannot work, so every cell is identified by what it contains.
//
// Order matters. CHECKBOOK is tested before CHECK_NUMBER because "BPI-S-4636"
// contains digits, and DATE_SERIAL is bounded because an unbounded numeric rule
// would swallow six-digit BDO cheque numbers.

// The entity code after AP-/CV- is not always two letters. The register carries
// AP-ST (2 letters), AP-A1 (letter+digit), and AP-IND (3 letters), so a
// [A-Z]{2} class silently rejects every A1+ and Starkson Industries document —
// they would fall through to UNKNOWN and land in the review queue rather than
// on the cheque.
const APV = /^(AP-[A-Z0-9]{2,3}\d+|(?:STPP|A1PP)-AP-\d+)$/
const CV = /^(CV-[A-Z0-9]{2,3}\d+|(?:STPP|A1PP)-CV-\d+)$/
const PO = /^(P[OR]-[A-Z0-9]{1,4}-?\d+|(?:STPP|A1PP)-PO-\d+)$/
const CHECKBOOK = /^(BPI|MBT|BDO)-[SA]-\d+$/
// Cheque numbers in this register are exactly 6 digits (BDO) or 10 (BPI, MBTC).
// A looser \d{6,10} also matched round-number amounts — 4200000, 20000000 —
// which then won the `??=` race by appearing earlier in the row and became the
// cheque number. Verified against the real register: constraining to 6 or 10
// leaves 337 six-digit and 11,828 ten-digit cheques and sends 44 ambiguous rows
// to review, which is where a 9- or 11-digit value belongs.
const CHECK_NUMBER = /^\d{6}$|^\d{10}$/
const CLEARING_REF = /^CR\s?\d+$/
// A text-formatted amount. Without this such a cell falls through to UNKNOWN
// and competes to be the payee — the real register produced vendors named
// "17187.5" and "3746.25" before this rule existed. Requires a decimal point,
// so it cannot swallow a whole-number cheque number.
const AMOUNT = /^-?\d{1,3}(,\d{3})*\.\d+$|^-?\d+\.\d+$/

const CATEGORIES = new Set([
  'LOCAL SUPPLIER', 'PAYROLL', 'UTILITIES', 'TAX', 'FUND TRANSFER',
  'BROKERS', 'SALARIES', 'FTP', 'TRANSPO,GAS AND OIL',
])

// Excel serials: 44000 is 2020-06, 48000 is 2031-05. A bare number outside that
// band is a cheque number or an amount, never a date in this data.
// The register's 'bank' column holds these account labels. They contain
// letters and are short, so without this rule they beat real company names to
// the payee slot - 1,264 rows in the real register. Matched as an exact set
// rather than a bank-name prefix, because 'BDO Unibank, Inc' is a genuine payee
// the group pays as a vendor.
const CASH_ACCOUNT_LABELS = new Set([
  'BPI STK', 'BPI P&P', 'BPI A1', 'MBTC A1+', 'MBTC P&P', 'BDO A1',
])

const STATUS_WORDS = new Set([
  'PAID', 'YES', 'CANCELLED', 'DEPOSITED', 'ENCASHMENT', 'CLEARED', 'RELEASED', 'AVAILABLE',
])

const SERIAL_MIN = 44000
const SERIAL_MAX = 48000

export function sniff(value: unknown): FieldKind {
  if (value === null || value === undefined) return 'UNKNOWN'

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'UNKNOWN'
    if (value >= SERIAL_MIN && value <= SERIAL_MAX) return 'DATE_SERIAL'
    // Same 6-or-10 rule as the string form. A 7- or 8-digit integer in this
    // register is an amount, not a cheque number.
    const digits = String(value).length
    if (Number.isInteger(value) && (digits === 6 || digits === 10)) return 'CHECK_NUMBER'
    return 'UNKNOWN'
  }

  if (typeof value !== 'string') return 'UNKNOWN'

  const s = value.trim().toUpperCase().replace(/\s+/g, ' ')
  if (s === '' || s === '#N/A') return 'UNKNOWN'

  if (CHECKBOOK.test(s)) return 'CHECKBOOK'
  if (APV.test(s)) return 'APV'
  if (CV.test(s)) return 'CV'
  if (PO.test(s)) return 'PO'
  if (CLEARING_REF.test(s)) return 'CLEARING_REF'
  if (CATEGORIES.has(s)) return 'CATEGORY'
  if (CHECK_NUMBER.test(s)) return 'CHECK_NUMBER'
  if (AMOUNT.test(s.replace(/,/g, ''))) return 'AMOUNT'
  // Status words the register puts in various columns. They are not payees, and
  // without this "CANCELLED" became a vendor name.
  if (STATUS_WORDS.has(s)) return 'STATUS_WORD'
  if (CASH_ACCOUNT_LABELS.has(s)) return 'CASH_ACCOUNT'

  return 'UNKNOWN'
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/import/field-sniffer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/import/field-sniffer.ts tests/import/field-sniffer.test.ts
git commit -m "feat: identify workbook fields by content rather than column

The register's fifteen sheets do not agree on column order - the APV is in H on
one sheet and B and D on another - so positional parsing cannot work.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Normalisation

**Files:**
- Create: `lib/import/normalise.ts`
- Test: `tests/import/normalise.test.ts`

**Interfaces:**
- Consumes: nothing (pure)
- Produces:
  - `canonicalVendor(name: string): string`
  - `excelSerialToDate(serial: number): Date`
  - `cleanCell(value: unknown): string | null` — trims, strips `#N/A`, returns `null` for empty

- [ ] **Step 1: Write the failing test**

`tests/import/normalise.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { canonicalVendor, canonicalCheckBook, excelSerialToDate, cleanCell } from '@/lib/import/normalise'

describe('cleanCell', () => {
  it('strips the noise the register carries', () => {
    expect(cleanCell('  HENKEL PHILIPPINES INC.  ')).toBe('HENKEL PHILIPPINES INC.')
    expect(cleanCell('#N/A')).toBeNull()
    expect(cleanCell('')).toBeNull()
    expect(cleanCell('   ')).toBeNull()
    expect(cleanCell(null)).toBeNull()
    expect(cleanCell(undefined)).toBeNull()
  })

  it('collapses internal whitespace', () => {
    expect(cleanCell('BIZARRE   MARKETING')).toBe('BIZARRE MARKETING')
  })
})

describe('canonicalVendor', () => {
  it('folds the casing variants the register actually contains', () => {
    // Both spellings appear in the client's data for the same company.
    expect(canonicalVendor('STARKSON PACKAGING INC.'))
      .toBe(canonicalVendor('Starkson Packaging Inc.'))
  })

  it('folds trailing punctuation and INC spelling', () => {
    expect(canonicalVendor('A1+ MULTINATIONAL PACKAGING INC'))
      .toBe(canonicalVendor('A1+ MULTINATIONAL PACKAGING INC.'))
    expect(canonicalVendor('Kooler Industries Incorporated'))
      .toBe(canonicalVendor('Kooler Industries Inc.'))
  })

  it('preserves characters that distinguish companies', () => {
    // The + in A1+ is part of the name, not punctuation.
    expect(canonicalVendor('A1+ PAPER AND PLASTIC')).toContain('A1+')
    expect(canonicalVendor('ABC Trading')).not.toBe(canonicalVendor('ABD Trading'))
  })
})

describe('canonicalCheckBook', () => {
  it('corrects the mis-keyed checkbook code Finance confirmed', () => {
    // MBT-S-9048 appears in the register but is not a real checkbook.
    expect(canonicalCheckBook('MBT-S-9048')).toBe('MBT-A-9048')
    expect(canonicalCheckBook('  mbt-s-9048  ')).toBe('MBT-A-9048')
  })

  it('leaves genuine checkbook codes alone', () => {
    for (const c of ['BPI-S-4636', 'BPI-A-5713', 'BPI-S-8879', 'BPI-A-8879', 'MBT-A-4155', 'MBT-A-9048', 'MBT-S-1121', 'BDO-A-3838']) {
      expect(canonicalCheckBook(c), c).toBe(c)
    }
  })

  it('returns null for a blank or missing code', () => {
    expect(canonicalCheckBook(null)).toBeNull()
    expect(canonicalCheckBook('#N/A')).toBeNull()
  })
})

describe('excelSerialToDate', () => {
  // Anchor the conversion to serials whose dates are independently known, not
  // to values eyeballed from the register. An earlier version of this test
  // asserted three dates that were each nine days out; the implementation was
  // correct and the expectations were invented.
  it('matches known Excel reference points', () => {
    expect(excelSerialToDate(44927).toISOString().slice(0, 10)).toBe('2023-01-01')
    expect(excelSerialToDate(45658).toISOString().slice(0, 10)).toBe('2025-01-01')
  })

  it('converts the serials the register actually carries', () => {
    expect(excelSerialToDate(46164).toISOString().slice(0, 10)).toBe('2026-05-22')
    expect(excelSerialToDate(46014).toISOString().slice(0, 10)).toBe('2025-12-23')
    expect(excelSerialToDate(46259).toISOString().slice(0, 10)).toBe('2026-08-25')
  })

  it('truncates the time component the register sometimes carries', () => {
    // 45882.606282141198 is a date with a time. Only the date matters here.
    expect(excelSerialToDate(45882.606282141198).toISOString().slice(0, 10)).toBe('2025-08-13')
  })

  it('is stable across a day boundary within one serial', () => {
    // .999 must not roll into the next day: the fraction is discarded, not rounded.
    expect(excelSerialToDate(46164.999).toISOString().slice(0, 10))
      .toBe(excelSerialToDate(46164).toISOString().slice(0, 10))
  })
})
```

- [ ] **Step 2: Run to verify it fails, then implement**

`lib/import/normalise.ts`:

```ts
export function cleanCell(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim().replace(/\s+/g, ' ')
  if (s === '' || s.toUpperCase() === '#N/A') return null
  return s
}

// The register spells the same company several ways: with and without a
// trailing period, INC vs INCORPORATED, inconsistent casing and spacing. Fold
// them to one key so a vendor is not created twice. The `+` in "A1+" is part of
// the name and must survive.
export function canonicalVendor(name: string): string {
  return String(name ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,']/g, '')
    .replace(/\bINCORPORATED\b/g, 'INC')
    .replace(/\bCORPORATION\b/g, 'CORP')
    .trim()
}

// Known mis-keyings in the register, confirmed by Finance. The letter in a
// checkbook code encodes the company — S for a Starkson entity, A for an A1+
// one — so a wrong letter files a cheque's checkbook under a sibling company.
// Left uncorrected, `MBT-S-9048` would also create a seventh checkbook that
// does not exist.
const CHECKBOOK_ALIASES: Readonly<Record<string, string>> = {
  'MBT-S-9048': 'MBT-A-9048',   // confirmed 2026-09-03: mis-keyed A as S
}

export function canonicalCheckBook(code: string | null | undefined): string | null {
  const c = cleanCell(code)?.toUpperCase() ?? null
  if (!c) return null
  return CHECKBOOK_ALIASES[c] ?? c
}

// Excel's 1900 date system, with the well-known leap-year bug: serial 60 is a
// day that never existed, so everything from 61 onward is offset by one. The
// 1899-12-30 epoch below already accounts for it, and is therefore correct only
// for serials above 60 — which every date in this register is, the range being
// roughly 44000 to 48000. Verified against two independent reference points:
// serial 44927 is 2023-01-01 and serial 45658 is 2025-01-01.
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86_400_000

export function excelSerialToDate(serial: number): Date {
  const wholeDays = Math.floor(serial)
  return new Date(EXCEL_EPOCH_UTC + wholeDays * MS_PER_DAY)
}
```

- [ ] **Step 3: Run to verify it passes, then commit**

```bash
npx vitest run tests/import/normalise.test.ts
git add lib/import/normalise.ts tests/import/normalise.test.ts
git commit -m "feat: normalise register cells, vendor names and Excel date serials

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Workbook Parsing

**Files:**
- Create: `lib/import/workbook.ts`, `lib/import/parse.ts`
- Test: `tests/import/parse.test.ts`
- Modify: `package.json` (add `exceljs`)

**Interfaces:**
- Consumes: `field-sniffer`, `normalise`
- Produces:
  - `type RawRow = { sheet: string; row: number; cells: unknown[] }`
  - `readWorkbook(buffer: Buffer): Promise<RawRow[]>` — I/O only, no interpretation
  - `type ParsedRow = { sheet: string; row: number; checkNumber: string; cvNumber: string | null; apvNumbers: string[]; poNumbers: string[]; checkBook: string | null; cashAccountLabel: string | null; category: string | null; clearingRef: string | null; checkDate: Date | null; amount: string | null; payee: string | null; unclassified: string[] }`
    — `checkNumber` is non-nullable: a row without one goes to the review queue and never reaches `parsed`.
  - `parseRows(rows: RawRow[]): { parsed: ParsedRow[]; review: ReviewItem[] }`

- [ ] **Step 1: Install exceljs**

```bash
npm install exceljs
```

- [ ] **Step 2: Write the failing test**

`tests/import/parse.test.ts` builds `RawRow`s in memory, so it needs no fixture file and no I/O:

```ts
import { describe, it, expect } from 'vitest'
import { parseRows } from '@/lib/import/parse'

const row = (sheet: string, n: number, cells: unknown[]) => ({ sheet, row: n, cells })

describe('parseRows', () => {
  it('finds each field wherever it sits in the row', () => {
    // A BPI RELEASED row: APV in position 7, CV in 3, checkbook in 6.
    const [r] = parseRows([row('BPI RELEASED', 2, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', 'STARKSON PACKAGING INC.',
      'PO-ST-027363 WEEKLY DIRECT', 'BPI-S-4636', 'AP-ST036198', 46014, 7950, 46024, 'DEPOSITED',
    ])]).parsed
    expect(r.checkNumber).toBe('6000308584')
    expect(r.cvNumber).toBe('CV-ST011550')
    expect(r.apvNumbers).toEqual(['AP-ST036198'])
    expect(r.checkBook).toBe('BPI-S-4636')
    // Serial 46014. Computed, not eyeballed — an earlier version of this file
    // asserted 2026-01-01 here, which is serial 46023 and appears nowhere in
    // the fixture. The parser takes the first date serial in the row.
    expect(r.checkDate?.toISOString().slice(0, 10)).toBe('2025-12-23')
  })

  it('finds the same fields when the columns are in a different order', () => {
    // An MBTC AVAIL. row: CV in position 1, APV in 5, PO in 7.
    const [r] = parseRows([row('MBTC AVAIL.', 2, [
      'YES', 'CV-A1010588', '1791361727', 'Painting of machine due to rust',
      'Rockwell Lumber and Hardware,Inc.', 'AP-A1032102', 'MBT-A-4155', 'PO-A1-024539', 46079,
    ])]).parsed
    expect(r.cvNumber).toBe('CV-A1010588')
    expect(r.checkNumber).toBe('1791361727')
    expect(r.apvNumbers).toEqual(['AP-A1032102'])
    expect(r.poNumbers).toEqual(['PO-A1-024539'])
  })

  it('collects every APV on a multi-bill row', () => {
    const [r] = parseRows([row('BPI RELEASED', 5, [
      '6000308611', 'AP-ST036371', 'AP-ST036372', 'CV-A1009393',
    ])]).parsed
    expect(r.apvNumbers).toEqual(['AP-ST036371', 'AP-ST036372'])
  })

  it('recovers a PO number embedded ahead of its description', () => {
    // 1,508 cells in the register have this shape. Without this the PO is lost
    // and the whole string competes to be the payee.
    const [r] = parseRows([row('BPI RELEASED', 7, [
      '6000308584',
      'PO-ST-027363 WEEKLY DIRECT (DISNEY) D2, D5, D7, D6 RESTDAY HOLIDAY FTP NOV. 30, 2025 (11 PAX)',
      'STARKSON PACKAGING INC.',
    ])]).parsed
    expect(r.poNumbers).toContain('PO-ST-027363')
    expect(r.unclassified.some((u) => u.startsWith('WEEKLY DIRECT'))).toBe(true)
    expect(r.unclassified.some((u) => u.startsWith('PO-ST-027363'))).toBe(false)
    expect(r.payee).toBe('STARKSON PACKAGING INC.')
  })

  it('reads the payee from column E', () => {
    // Column index 4. Measured across all fifteen sheets of the real register:
    // 88-100% of rows carry the company name there.
    const [r] = parseRows([row('BPI RELEASED', 2, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', 'STARKSON PACKAGING INC.',
      'PO-ST-027363 A MUCH LONGER DESCRIPTION OF THE PURCHASE', 'BPI-S-4636',
    ])]).parsed
    expect(r.payee).toBe('STARKSON PACKAGING INC.')
  })

  it('leaves the payee null when column E is empty, rather than guessing', () => {
    // No fallback by design. Guessing from the rest of the row produced four
    // classes of wrong payee across ~10,000 rows of the real register. A blank
    // payee also fails safe: classifyEligibility treats it as INTERNAL, so an
    // unknown payee is never pushed to the supplier portal.
    const [r] = parseRows([row('BPI RELEASED', 3, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', null, 'SOME LONG DESCRIPTION OF THE PURCHASE',
    ])]).parsed
    expect(r.checkNumber).toBe('6000308584')
    expect(r.payee).toBeNull()
  })

  it('does not take a number from column E as the payee', () => {
    const [r] = parseRows([row('BPI RELEASED', 4, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', 7950,
    ])]).parsed
    expect(r.payee).toBeNull()
  })

  it('does not take a cash-account label from column E as the payee', () => {
    const [r] = parseRows([row('BPI RELEASED', 5, [
      'PAID', 'W-RDHOT', '6000308584', 'CV-ST011550', 'BPI STK',
    ])]).parsed
    expect(r.payee).toBeNull()
    expect(r.cashAccountLabel).toBe('BPI STK')
  })
  it('reports a row with no check number for review rather than dropping it', () => {
    const { parsed, review } = parseRows([row('BPI RELEASED', 9, ['PAID', 'DEPOSITED'])])
    expect(parsed).toHaveLength(0)
    expect(review).toHaveLength(1)
    expect(review[0]).toMatchObject({ sheet: 'BPI RELEASED', row: 9, reason: 'NO_CHECK_NUMBER' })
  })

  it('ignores an Invalid Date rather than passing it to the database', () => {
    // ExcelJS produces these for malformed date cells; three exist in the real
    // register. `instanceof Date` accepts them and Prisma throws on write.
    const [r] = parseRows([row('CANCELLED', 517, ['6000329057', new Date('not a date')])]).parsed
    expect(r.checkNumber).toBe('6000329057')
    expect(r.checkDate).toBeNull()
  })

  it('never silently discards a row', () => {
    const rows = [
      row('A', 2, ['6000000001']),
      row('A', 3, ['nothing useful']),
      row('A', 4, ['6000000002']),
    ]
    const { parsed, review } = parseRows(rows)
    expect(parsed.length + review.length).toBe(rows.length)
  })
})
```

- [ ] **Step 3: Run to verify it fails, then implement `lib/import/workbook.ts`**

```ts
import ExcelJS from 'exceljs'

export type RawRow = { sheet: string; row: number; cells: unknown[] }

// I/O only: reads every sheet into rows of raw cell values and interprets
// nothing. Keeping interpretation out of here is what lets parseRows be tested
// without a fixture file.
export async function readWorkbook(buffer: Buffer): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)

  const out: RawRow[] = []
  wb.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return // header
      const cells: unknown[] = []
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value
        // ExcelJS wraps formula results and rich text; unwrap to the value.
        if (v && typeof v === 'object' && 'result' in v) cells.push((v as { result: unknown }).result)
        else if (v && typeof v === 'object' && 'richText' in v) {
          cells.push((v as { richText: { text: string }[] }).richText.map((t) => t.text).join(''))
        } else if (v instanceof Date) cells.push(v)
        else cells.push(v)
      })
      out.push({ sheet: sheet.name, row: rowNumber, cells })
    })
  })
  return out
}
```

- [ ] **Step 4: Implement `lib/import/parse.ts`**

```ts
import { sniff } from './field-sniffer'
import { cleanCell, excelSerialToDate } from './normalise'
import type { RawRow } from './workbook'

export type ParsedRow = {
  sheet: string
  row: number
  // Non-nullable by construction: a row without a cheque number cannot be keyed
  // and goes to the review queue instead, so it never reaches `parsed`. Typing
  // this `string | null` would make every downstream consumer handle a case
  // that cannot occur — and `reconcile` cannot key a Map on a nullable value.
  checkNumber: string
  cvNumber: string | null
  apvNumbers: string[]
  poNumbers: string[]
  checkBook: string | null
  cashAccountLabel: string | null
  category: string | null
  clearingRef: string | null
  checkDate: Date | null
  amount: string | null
  payee: string | null
  unclassified: string[]
}

export type ReviewItem = { sheet: string; row: number; reason: 'NO_CHECK_NUMBER'; cells: unknown[] }

// While a row is being assembled its cheque number may still be absent. The
// draft carries that possibility; `ParsedRow` does not, and the narrowing
// happens at the one point where the row is accepted.
type Draft = Omit<ParsedRow, 'checkNumber'> & { checkNumber: string | null }

// A row with no cheque number cannot be keyed and is sent for review rather
// than dropped. Nothing is ever discarded silently: parsed.length +
// review.length always equals the input length.
export function parseRows(rows: RawRow[]): { parsed: ParsedRow[]; review: ReviewItem[] } {
  const parsed: ParsedRow[] = []
  const review: ReviewItem[] = []

  for (const raw of rows) {
    const r: Draft = {
      sheet: raw.sheet, row: raw.row,
      checkNumber: null, cvNumber: null, apvNumbers: [], poNumbers: [],
      checkBook: null, cashAccountLabel: null, category: null, clearingRef: null,
      checkDate: null, amount: null, payee: null, unclassified: [],
    }

    for (const cell of raw.cells) {
      if (cell instanceof Date) {
        // ExcelJS yields an Invalid Date for a malformed date cell. It passes
        // `instanceof Date`, so without this guard it reaches Prisma, which
        // throws on write — the real register has three such cells, all on the
        // CANCELLED sheet. Treat it as no date rather than an invalid one; the
        // row still imports, it simply has no check date.
        if (!Number.isNaN(cell.getTime())) r.checkDate ??= cell
        continue
      }
      const kind = sniff(cell)
      const text = cleanCell(cell)
      switch (kind) {
        case 'APV': if (text) r.apvNumbers.push(text.toUpperCase()); break
        case 'CV': r.cvNumber ??= text?.toUpperCase() ?? null; break
        case 'PO': if (text) r.poNumbers.push(text.toUpperCase()); break
        case 'CHECKBOOK': r.checkBook ??= text?.toUpperCase() ?? null; break
        case 'CHECK_NUMBER': r.checkNumber ??= text; break
        case 'DATE_SERIAL': r.checkDate ??= excelSerialToDate(Number(cell)); break
        case 'CATEGORY': r.category ??= text?.toUpperCase() ?? null; break
        case 'CLEARING_REF': r.clearingRef ??= text?.toUpperCase() ?? null; break
        case 'AMOUNT': r.amount ??= text?.replace(/,/g, '') ?? null; break
        // A status word is neither a field nor free text; dropping it keeps it
        // out of the payee candidates.
        case 'CASH_ACCOUNT': r.cashAccountLabel ??= text?.toUpperCase() ?? null; break
        case 'STATUS_WORD': break
        default: if (text) r.unclassified.push(text)
      }
    }

    const checkNumber = r.checkNumber
    if (!checkNumber) {
      review.push({ sheet: raw.sheet, row: raw.row, reason: 'NO_CHECK_NUMBER', cells: raw.cells })
      continue
    }

    // 1,508 distinct cells in the register hold a PO number followed by its
    // description in one cell:
    //   "PO-ST-027363 WEEKLY DIRECT (DISNEY) D2, D5, D7 ... (11 PAX)"
    // `sniff` correctly returns UNKNOWN for these — the cell is not *just* a PO —
    // so the parser recovers both halves rather than losing the PO number.
    // Verified count: running `sniff` over the register's 47,356 distinct strings
    // left exactly 1,508 document-shaped cells unclassified, all of this form.
    for (let i = r.unclassified.length - 1; i >= 0; i--) {
      const m = /^(P[OR]-[A-Z0-9]{1,4}-?\d+)\s+(.+)$/.exec(r.unclassified[i])
      if (!m) continue
      r.poNumbers.push(m[1].toUpperCase())
      r.unclassified[i] = m[2].trim()   // the description survives as free text
    }

    // The payee is column E on every sheet. Measured across all fifteen: 88-100%
    // of rows carry a company name there, and the samples are unambiguous
    // (STARKSON PACKAGING INC., Easytrip Services Corporation, RACNET
    // INFORMATION TECHNOLOGY). The columns that drift between sheets are the
    // APV, CV and PO — not this one.
    //
    // The earlier heuristic — shortest lettered unclassified string — was
    // guessing at something knowable, and produced four separate classes of
    // wrong payee against the real register: amounts (8,254 rows), cash-account
    // labels (1,264), and point-person names (~400). Reading the column is both
    // simpler and correct.
    //
    // When column E is empty the payee is null. There is deliberately **no
    // fallback**: guessing from the rest of the row is exactly what produced
    // those four classes of wrong payee, and a missing payee is better than an
    // invented one.
    //
    // It is also the safe direction. `classifyEligibility` treats a blank payee
    // as INTERNAL, so a cheque whose payee we do not know is never pushed to the
    // supplier portal — whereas a guessed payee could be classified SUPPLIER and
    // published. Rows without a payee still import; they simply have none, and
    // the reconciliation report surfaces them.
    const PAYEE_COLUMN = 4
    const atColumn = raw.cells[PAYEE_COLUMN]
    const fromColumn =
      atColumn instanceof Date || sniff(atColumn) !== 'UNKNOWN' ? null : cleanCell(atColumn)

    r.payee = fromColumn && /[A-Za-z]/.test(fromColumn) ? fromColumn : null

    // The one narrowing point: past the guard above, the cheque number is known
    // to exist, so the row satisfies ParsedRow rather than Draft.
    parsed.push({ ...r, checkNumber })
  }

  return { parsed, review }
}
```

- [ ] **Step 5: Run the tests, then commit**

```bash
npx vitest run tests/import/parse.test.ts
git add package.json package-lock.json lib/import/workbook.ts lib/import/parse.ts tests/import/parse.test.ts
git commit -m "feat: parse the register by content, sending unkeyable rows to review

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Reconciliation

**Files:**
- Create: `lib/import/reconcile.ts`
- Test: `tests/import/reconcile.test.ts`

**Interfaces:**
- Consumes: `ParsedRow` from `lib/import/parse.ts`, `canonicalVendor` from `lib/import/normalise.ts`
- Produces:
  - `type ConflictKind = 'DUPLICATE_ACROSS_SHEETS' | 'CONTRADICTORY_STATUS' | 'AMOUNT_MISMATCH' | 'IMPLAUSIBLE_DATE'`
  - `type Conflict = { checkNumber: string; kind: ConflictKind; rows: { sheet: string; row: number }[]; detail: string }`
  - `type VendorMerge = { canonical: string; variants: string[] }`
  - `reconcile(rows: readonly ParsedRow[], opts: { today: Date }): { conflicts: Conflict[]; vendorMerges: VendorMerge[] }`

Importing 12,264 legacy rows surfaces contradictions. **This module reports them and never picks a winner.** Deciding that a cheque appearing on both the RELEASED and CANCELLED sheets is "really" released is a Finance judgement about money that already moved, not something an importer may infer.

`today` is injected rather than read from the clock, so the module stays pure and its tests are deterministic.

- [ ] **Step 1: Write the failing test**

`tests/import/reconcile.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { reconcile } from '@/lib/import/reconcile'
import type { ParsedRow } from '@/lib/import/parse'

const TODAY = new Date('2026-09-03T00:00:00Z')

const mk = (over: Partial<ParsedRow>): ParsedRow => ({
  sheet: 'S', row: 1, checkNumber: '6000000001', cvNumber: null, apvNumbers: [], poNumbers: [],
  checkBook: null, cashAccountLabel: null, category: null, clearingRef: null, checkDate: null, amount: null,
  payee: null, unclassified: [], ...over,
})

describe('duplicates across sheets', () => {
  it('reports one cheque appearing on two sheets, naming both', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 5 }),
      mk({ sheet: 'CANCELLED', row: 9 }),
    ], { today: TODAY })
    const dup = conflicts.find((c) => c.kind === 'DUPLICATE_ACROSS_SHEETS')
    expect(dup).toBeDefined()
    expect(dup!.rows).toEqual([
      { sheet: 'BPI RELEASED', row: 5 }, { sheet: 'CANCELLED', row: 9 },
    ])
  })

  it('does not treat the same cheque twice on one sheet as a cross-sheet duplicate', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 5 }),
      mk({ sheet: 'BPI RELEASED', row: 6 }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'DUPLICATE_ACROSS_SHEETS')).toHaveLength(0)
  })

  it('does not report a cheque that appears once', () => {
    expect(reconcile([mk({})], { today: TODAY }).conflicts).toHaveLength(0)
  })
})

describe('contradictory status', () => {
  it('reports a cheque the register says is both released and cancelled', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 5 }),
      mk({ sheet: 'CANCELLED', row: 9 }),
    ], { today: TODAY })
    const c = conflicts.find((x) => x.kind === 'CONTRADICTORY_STATUS')
    expect(c).toBeDefined()
    expect(c!.detail).toContain('RELEASED')
    expect(c!.detail).toContain('CANCELLED')
  })

  it('does not report two sheets that agree', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 5 }),
      mk({ sheet: 'MBTC RELEASED', row: 9 }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'CONTRADICTORY_STATUS')).toHaveLength(0)
  })
})

describe('amount mismatch', () => {
  it('reports the same cheque carrying two different amounts', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'A', row: 2, amount: '7950.00' }),
      mk({ sheet: 'B', row: 3, amount: '8950.00' }),
    ], { today: TODAY })
    const c = conflicts.find((x) => x.kind === 'AMOUNT_MISMATCH')
    expect(c).toBeDefined()
    expect(c!.detail).toContain('7950.00')
    expect(c!.detail).toContain('8950.00')
  })

  it('treats trailing-zero differences as the same amount', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'A', row: 2, amount: '7950' }),
      mk({ sheet: 'B', row: 3, amount: '7950.00' }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'AMOUNT_MISMATCH')).toHaveLength(0)
  })

  it('ignores a missing amount rather than calling it a mismatch', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'A', row: 2, amount: '7950.00' }),
      mk({ sheet: 'B', row: 3, amount: null }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'AMOUNT_MISMATCH')).toHaveLength(0)
  })
})

describe('implausible dates', () => {
  it('flags a cheque dated more than a year ahead', () => {
    const { conflicts } = reconcile([
      mk({ sheet: 'BPI RELEASED', row: 4, checkDate: new Date('2028-11-18T00:00:00Z') }),
    ], { today: TODAY })
    const c = conflicts.find((x) => x.kind === 'IMPLAUSIBLE_DATE')
    expect(c).toBeDefined()
    expect(c!.detail).toContain('2028-11-18')
  })

  it('does not flag an ordinary post-dated cheque', () => {
    const { conflicts } = reconcile([
      mk({ checkDate: new Date('2026-11-18T00:00:00Z') }),
    ], { today: TODAY })
    expect(conflicts.filter((c) => c.kind === 'IMPLAUSIBLE_DATE')).toHaveLength(0)
  })

  it('does not flag a missing date', () => {
    expect(reconcile([mk({ checkDate: null })], { today: TODAY }).conflicts).toHaveLength(0)
  })
})

describe('vendor merges', () => {
  it('groups spelling variants without choosing between them', () => {
    const { vendorMerges } = reconcile([
      mk({ checkNumber: '1', payee: 'STARKSON PACKAGING INC.' }),
      mk({ checkNumber: '2', payee: 'Starkson Packaging Inc.' }),
      mk({ checkNumber: '3', payee: 'HENKEL PHILIPPINES INC.' }),
    ], { today: TODAY })
    const merged = vendorMerges.find((m) => m.variants.length > 1)
    expect(merged!.variants.slice().sort()).toEqual(['STARKSON PACKAGING INC.', 'Starkson Packaging Inc.'])
    expect(vendorMerges.find((m) => m.variants.includes('HENKEL PHILIPPINES INC.'))!.variants).toHaveLength(1)
  })

  it('lists a repeated payee once', () => {
    const { vendorMerges } = reconcile([
      mk({ checkNumber: '1', payee: 'ACME' }),
      mk({ checkNumber: '2', payee: 'ACME' }),
    ], { today: TODAY })
    expect(vendorMerges).toHaveLength(1)
    expect(vendorMerges[0].variants).toEqual(['ACME'])
  })
})

describe('purity', () => {
  it('never mutates or reorders its input', () => {
    const rows = [mk({ sheet: 'A', row: 1 }), mk({ sheet: 'B', row: 2 })]
    const before = JSON.stringify(rows)
    reconcile(rows, { today: TODAY })
    expect(JSON.stringify(rows)).toBe(before)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/import/reconcile.test.ts`
Expected: FAIL, "Cannot find package '@/lib/import/reconcile'".

- [ ] **Step 3: Write `lib/import/reconcile.ts`**

```ts
import { canonicalVendor } from './normalise'
import type { ParsedRow } from './parse'

export type ConflictKind =
  | 'DUPLICATE_ACROSS_SHEETS'
  | 'CONTRADICTORY_STATUS'
  | 'AMOUNT_MISMATCH'
  | 'IMPLAUSIBLE_DATE'

export type Conflict = {
  checkNumber: string
  kind: ConflictKind
  rows: { sheet: string; row: number }[]
  detail: string
}

export type VendorMerge = { canonical: string; variants: string[] }

// Which sheet a row came from is what the register believed about that cheque.
// Two sheets implying different things about one cheque is a contradiction only
// a human can settle: deciding a cheque on both RELEASED and CANCELLED is
// "really" released is a judgement about money that has already moved.
// CANCELLED is tested first because several sheet names contain both words.
const IMPLIED_STATUS: readonly (readonly [RegExp, string])[] = [
  [/CANCELLED/i, 'CANCELLED'],
  [/RELEASED/i, 'RELEASED'],
  [/AVAIL/i, 'AVAILABLE'],
  [/FINDING/i, 'FINDING'],
  [/FT ?& ?MC/i, 'FT_MC'],
]

function impliedStatus(sheet: string): string | null {
  for (const [re, status] of IMPLIED_STATUS) if (re.test(sheet)) return status
  return null
}

// '7950' and '7950.00' are the same money written two ways. Compared on a
// normalised decimal string, never through a float.
function amountKey(amount: string): string {
  const [wholeRaw, fracRaw = ''] = amount.trim().split('.')
  const sign = wholeRaw.startsWith('-') ? '-' : ''
  const digits = wholeRaw.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '')
  const frac = fracRaw.replace(/0+$/, '')
  const whole = digits === '' ? '0' : digits
  return frac ? sign + whole + '.' + frac : sign + whole
}

// A cheque dated far beyond the import is a data-entry error worth a human
// look, not a rejection. The real register carries a 2028 date against 2026.
const IMPLAUSIBLE_MONTHS_AHEAD = 12

export function reconcile(
  rows: readonly ParsedRow[],
  opts: { today: Date },
): { conflicts: Conflict[]; vendorMerges: VendorMerge[] } {
  const byCheck = new Map<string, ParsedRow[]>()
  for (const r of rows) {
    const list = byCheck.get(r.checkNumber)
    if (list) list.push(r)
    else byCheck.set(r.checkNumber, [r])
  }

  const conflicts: Conflict[] = []
  const horizon = new Date(opts.today.getTime())
  horizon.setUTCMonth(horizon.getUTCMonth() + IMPLAUSIBLE_MONTHS_AHEAD)

  for (const [checkNumber, group] of byCheck) {
    const where = group.map((r) => ({ sheet: r.sheet, row: r.row }))

    const sheets = [...new Set(group.map((r) => r.sheet))]
    if (sheets.length > 1) {
      conflicts.push({
        checkNumber,
        kind: 'DUPLICATE_ACROSS_SHEETS',
        rows: where,
        detail: 'appears on ' + sheets.length + ' sheets: ' + sheets.join(', '),
      })

      const statuses = [...new Set(
        sheets.map(impliedStatus).filter((s): s is string => s !== null),
      )]
      if (statuses.length > 1) {
        conflicts.push({
          checkNumber,
          kind: 'CONTRADICTORY_STATUS',
          rows: where,
          detail: 'the register implies ' + statuses.join(' and ') + ' for the same cheque',
        })
      }
    }

    const present = group.map((r) => r.amount).filter((a): a is string => a !== null)
    const distinct = [...new Set(present.map(amountKey))]
    if (distinct.length > 1) {
      conflicts.push({
        checkNumber,
        kind: 'AMOUNT_MISMATCH',
        rows: where,
        detail: 'carries ' + distinct.length + ' different amounts: ' + [...new Set(present)].join(', '),
      })
    }

    for (const r of group) {
      if (r.checkDate && r.checkDate.getTime() > horizon.getTime()) {
        conflicts.push({
          checkNumber,
          kind: 'IMPLAUSIBLE_DATE',
          rows: [{ sheet: r.sheet, row: r.row }],
          detail: 'dated ' + r.checkDate.toISOString().slice(0, 10) +
            ', more than ' + IMPLAUSIBLE_MONTHS_AHEAD + ' months ahead',
        })
      }
    }
  }

  // Payee spellings that fold to one canonical form. Reported, never applied:
  // the merge list is presented for confirmation before any import runs.
  const byCanonical = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.payee) continue
    const key = canonicalVendor(r.payee)
    const set = byCanonical.get(key)
    if (set) set.add(r.payee)
    else byCanonical.set(key, new Set([r.payee]))
  }
  const vendorMerges: VendorMerge[] = [...byCanonical].map(([canonical, variants]) => ({
    canonical,
    variants: [...variants],
  }))

  return { conflicts, vendorMerges }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/import/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite, then commit**

```bash
npm test && npx tsc --noEmit
```

```bash
git add lib/import/reconcile.ts tests/import/reconcile.test.ts
git commit -m "feat: report register contradictions without picking a winner

A cheque on both the RELEASED and CANCELLED sheets is a Finance judgement about
money that already moved, not something an importer may infer. Reports
cross-sheet duplicates, contradictory implied status, differing amounts for one
cheque, and dates more than a year ahead - the real register carries a 2028 date
against a 2026 import.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6c: Fields the Register Does Not Always Know

**Files:**
- Modify: `prisma/schema.prisma`, `lib/money.ts`, `lib/domain/eligibility.ts`,
  `app/checks/[id]/page.tsx`, `components/CheckTable.tsx`
- Create: a migration making `Check.amount` and `Check.payeeName` nullable
- Test: `tests/money.test.ts`, `tests/domain/eligibility.test.ts`, `tests/schema.test.ts`

`Check.amount` and `Check.payeeName` are currently `NOT NULL`. The real register does not always
know them: **397 of 12,161 rows have no amount** (260 blank, 135 where the amount column literally
holds the word "CANCELLED", 2 shifted rows holding a date) and **153 have no payee**.

The domain layer already models both as nullable and has done since Plan 1 — `ReadyGuardInput`
types them `string | null`, `REQUIRED_FIELDS` lists `AMOUNT` and `PAYEE` among the fields that
must be present before a cheque can be released, and `lib/domain/actions.ts` already writes
`check.amount?.toString() ?? null`. Only the Prisma schema disagrees. This task makes the storage
match the domain rather than the other way round.

**Why not store zero or an empty string.** A cheque recorded at ₱0.00 is indistinguishable from a
real zero-value cheque and silently understates every total it appears in; an empty payee reads as
a cheque payable to nobody. NULL says the one true thing: the register does not record it.

**The consequence is deliberate and desirable.** `assertReleasable` already refuses to release a
cheque with a blank amount or payee, so these 397 and 153 cheques import, are visible, and are
**blocked from release until someone fills the gap in** — which is the correct behaviour for a
cheque whose amount nobody knows. A blank payee also classifies as `INTERNAL`, so such a cheque can
never be pushed to the supplier portal.

- [ ] **Step 1: Write the failing tests**

- `formatMoney(null, 'PHP')` renders an em dash, not `₱0.00` and not a crash
- `formatMoney` still formats `0` as `₱0.00` — a genuine zero is not the same as unknown
- `classifyEligibility({ payeeName: null, ... })` returns `INTERNAL` (the same safe answer it
  already gives for `''` and `'   '`), and `portalRoute` of it is `null`
- a `Check` row can be created with `amount: null` and `payeeName: null`
- `checkReadyForRelease` on such a row reports the existing exact string, naming both missing
  fields: `This check cannot be released because required information is missing: PAYEE, AMOUNT.`
- `listChecks`' per-currency totals ignore rows with a null amount rather than treating them as
  zero, and the dashboard count still includes them

- [ ] **Step 2: Implement**

`formatMoney(value: string | number | Prisma.Decimal | null, currency: string)`. Widen
`classifyEligibility`'s input to `payeeName: string | null`; `norm` already collapses blanks, so
this is a widening of an existing safe path, not a new branch. Check the two render sites.

- [ ] **Step 3: Run, verify, commit**

---

## Task 7: Company Resolution, Staging, and the Upsert Path

**Files:**
- Create: `lib/import/company.ts`, `lib/import/implied-status.ts`, `lib/import/upsert.ts`
- Modify: `prisma/schema.prisma` (add `StagedCheck`)
- Test: `tests/import/company.test.ts`, `tests/import/implied-status.test.ts`,
  `tests/import/upsert.test.ts`

**Interfaces:**
- Consumes: `lib/db.ts`, `lib/audit.ts`, `lib/domain/eligibility.ts`, `lib/domain/actions.ts`
- Produces: `resolveCompany(...)`, `impliedStatus(...)`, `upsertCheck(...)`, `stageRow(...)`

### 7a. Company resolution

Measured against the real register with the actual reference table (every one of the 9 checkbook
codes and 6 cash-account codes in the workbook is already mapped in `prisma/reference-data.ts` —
none is unknown):

| | rows | |
| --- | ---: | --- |
| resolved from checkbook and/or cash account | **9,521** | 78.3% |
| → both signals present, agreeing | 897 | |
| → both present, **conflicting** | **17** | |
| → checkbook only | 8,245 | |
| → cash account only | 362 | |
| **unresolved — neither present** | **2,640** | 21.7% |

```ts
export type CompanyResolution =
  | { ok: true; companyCode: string; from: 'CASH_ACCOUNT' | 'CHECK_BOOK'; conflictedWith: string | null }
  | { ok: false }
```

**The cash account wins a conflict** (Finance ruling, 2026-09-03). It names the bank account the
money actually leaves, and in all 17 cases it agrees with the sheet the cheque sits on while the
checkbook cell holds an implausible value — including two Metrobank book codes recorded on a BPI
sheet. The losing signal is carried in `conflictedWith` and every one of the 17 is listed on the
reconciliation report so Finance can correct the register. It is **reported, never silently
preferred**.

**Do not infer the company from the sheet name.** Measured: the RELEASED sheets are 97–100% one
company, but `CANCELLED` splits 59/41 between Starkson and A1+ and `CHECK FINDING` 63/37 — those
sheets collect cheques from every company. Inferring would put roughly 213 cheques under the wrong
company, and since `@@unique([companyId, checkNumber])` is the dedup key, a wrong company is a
cheque that can silently duplicate later.

### 7b. Staging

`companyId` is required and is half the dedup key, so a row whose company is unknown cannot become
a `Check` without a guess. It is staged instead — kept whole, visible to Finance, and promoted
later when the Acumatica sync (Tasks 8–9) supplies the company by cheque number.

```prisma
enum StagedReason {
  NO_COMPANY        // 2,640 - no checkbook and no cash account in the register
  NO_CHECK_NUMBER   //    66 - cannot be keyed at all
}

model StagedCheck {
  id              String       @id @default(cuid())
  sourceSheet     String
  sourceRow       Int
  reason          StagedReason
  checkNumber     String?
  cvNumber        String?
  apvNumbers      String[]
  poNumbers       String[]
  checkBookCode   String?
  cashAccountCode String?
  category        String?
  clearingRef     String?
  checkDate       DateTime?
  amount          Decimal?     @db.Decimal(18, 2)
  currency        String?
  payeeName       String?
  impliedStatus   CheckStatus
  promotedCheckId String?      // set when Acumatica later supplies the company
  createdAt       DateTime     @default(now())

  @@unique([sourceSheet, sourceRow])   // re-running the import updates, never duplicates
  @@index([checkNumber])               // the Acumatica sync matches on this
  @@index([reason])
}
```

Expected import outcome — every one of the 12,227 rows accounted for, nothing dropped:

```
imported            9,521
staged NO_COMPANY   2,640
staged NO_CHECK_NUMBER 66
--------------------------
total rows         12,227
```

### 7c. Implied status and the contradiction ruling

`impliedStatus(sheetName)` maps a sheet to the status it asserts. Where one cheque appears on two
sheets with different implied statuses, apply the Finance ruling of 2026-09-03 recorded in
`.superpowers/sdd/progress.md`:

| Sheets imply | Count | Resolves to |
| --- | ---: | --- |
| CANCELLED + FINDING | 48 | CANCELLED |
| RELEASED + CANCELLED | 25 | **RELEASED** |
| RELEASED + FINDING | 25 | RELEASED |
| RELEASED + CANCELLED + FINDING | 1 | **CANCELLED** |
| RELEASED + AVAILABLE | 1 | RELEASED |
| AVAILABLE + CANCELLED | 1 | CANCELLED |
| AVAILABLE + FINDING | 1 | AVAILABLE |

Two things a future reader must not "tidy": RELEASED+CANCELLED resolves to RELEASED, but adding
FINDING flips it to CANCELLED — deliberate, affecting exactly one cheque (`6000319079`); and the
heterogeneous cases resolve to the **later state**, not to CANCELLED, because two of them have no
CANCELLED entry on any sheet and marking a released cheque cancelled would invent a status the
register never records.

Each resolution writes a `SYSTEM` audit row naming the clashing sheets, the implied statuses, the
chosen one, and the ruling as its basis. **Applied at scale, traceable one by one.**

### 7d. The upsert

The single write path for both the workbook importer and the Acumatica sync. Duplicate prevention
lives here and nowhere else.

- [ ] **Step 1: Write the failing test**

Cover, at minimum:
- creating a check that does not exist, at the status the sheet implies
- re-importing the same `(company, checkNumber)` **updates** rather than duplicating
- **a re-import never changes `status`** — a check a Finance user has already marked `SIGNED` stays `SIGNED`
- **a re-import never changes `signedById`, `readyById`, `releasedById` or any timestamp Finance set**
- eligibility is computed via `classifyEligibility`, and an INTERNAL check gets `portalDomain = null`, `portalSyncStatus = 'NOT_APPLICABLE'` (the CHECK constraint enforces this; a test proving the constraint rejects the alternative is worth having)
- every create and update writes a `SYSTEM`-actor audit row
- a `Voided Payment` row sets status `VOIDED` and records `voidedAt`
- a row with no resolvable company is staged, not written as a check, and **not** dropped
- re-running the whole import is idempotent: same counts, no duplicate checks, no duplicate staged rows

- [ ] **Step 2: Implement `lib/import/upsert.ts`**

Key rules, which the tests above pin:

```ts
// Import brings in what Acumatica knows: amounts, dates, vendor, cash account.
// It must never touch what Finance knows: whether the cheque has been signed,
// made available, or released. Acumatica has no notion of any of those, so an
// import that wrote `status` would silently undo a Finance user's work.
const IMMUTABLE_ON_UPDATE = [
  'status', 'signedById', 'signedAt', 'readyById', 'readyAt',
  'availablePickupDate', 'scheduledPickupDate', 'scheduledPickupTime', 'pickupRep',
  'portalConfirmedAt', 'releasedById', 'releasedAt', 'orNumber', 'orDate',
  'clearingStatus', 'crNumber', 'clearedDate', 'cancelledById', 'cancelledAt', 'cancelReason',
] as const
```

The one exception: a `Voided Payment` may move a check to `VOIDED` from any non-`RELEASED` status, because Acumatica *does* know a cheque was voided. Route that through `lib/domain/actions.ts`, not through a bare update.

- [ ] **Step 3: Run, verify, commit**

---

## Task 8: The Acumatica Client

**Files:**
- Create: `lib/integrations/acumatica/client.ts`, `lib/integrations/acumatica/map.ts`
- Test: `tests/integrations/acumatica-client.test.ts`, `tests/integrations/acumatica-map.test.ts`

**Interfaces:**
- Produces:
  - `createAcumaticaClient({ baseUrl, user, password, fetchImpl? }): { fetchPage, fetchAll }` — **no mutating method exists**
  - `mapPayment(row: unknown, tenant: AcumaticaTenant): NormalisedRow | null` — returns `null` for a document type we do not import

- [ ] **Step 1: Write the failing tests**

The client's tests inject `fetchImpl` and never touch the network. Cover: Basic auth header present and never logged; `$select`/`$filter`/`$top`/`$skip` correctly encoded; paging stops on the first short page; a non-OK response throws with the status; unparseable JSON throws a message naming the feed and body length.

The mapper's tests use the real field names and cover:
- `Payment` → a normalised row
- `Voided Payment` → a row flagged voided
- `Prepayment`, `Debit Adj.`, `Refund` → `null` (not imported)
- `PaymentRef` becomes the **check number**, `ReferenceNbr` the **CV number** — getting these the wrong way round is the single most likely mapping error
- an unrecognised `Branch` produces a row with no company rather than defaulting to one

- [ ] **Step 2: Implement both, mirroring the Supplier Portal's client**

Paging is not optional: the AP feed runs to roughly 37,000 rows and some inquiries ignore `$top` and stream the whole result, which kills the body read. Default `pageSize` 2000.

- [ ] **Step 3: Run, verify, commit**

---

## Task 9: The Sync Service

**Files:**
- Create: `lib/sync/run.ts`
- Test: `tests/sync/run.test.ts`

**Interfaces:**
- Produces: `runSync(db, { client, tenant, since, now }): Promise<SyncRunResult>`

- [ ] **Step 1: Write the failing test**

Cover:
- a run records a `SyncRun` with `imported`, `updated`, `errors` and `finishedAt`
- the watermark is the maximum `LastModifiedOn` seen, **minus a 120-minute overlap** — a row committed during a run can carry a timestamp below the maximum that run observed and would otherwise never be picked up again
- a row that fails to map increments `errors` and does not abort the run
- a failed run still writes a `SyncRun` with `finishedAt` set, so a hung sync is distinguishable from a failed one
- **no `PortalEvent` is ever written by a sync** — assert `portalEvent.count()` is unchanged

- [ ] **Step 2: Implement, run, verify, commit**

---

## Task 10: Admin Screens

**Files:**
- Create: `app/admin/sync/page.tsx`, `app/admin/import/page.tsx`, `app/admin/actions.ts`
- Create: `scripts/import-workbook.ts`
- Test: `tests/admin/actions.test.ts`

**Interfaces:**
- Produces: `syncNowAction`, `importWorkbookAction`, both **`FINANCE_ADMIN` only**

- [ ] **Step 1: Write the failing test**

Both actions must refuse a `FINANCE_USER` with an `ActionResult`, not a redirect — `run()`'s catch would otherwise swallow the redirect. Follow the pattern established for `revertAction`.

- [ ] **Step 2: Build the sync page**

Shows last successful sync, last attempt, records imported, records updated, error count, and a SYNC NOW button, per spec §20:

> Last Sync: September 1, 2026 — 10:45 AM
> 24 new checks imported, 3 records updated, 0 errors

- [ ] **Step 3: Build the import page**

Upload → parse → **show the reconciliation report and the vendor merge list** → confirm → import. The confirmation step is not optional: the spec requires the merge list be presented before it is applied, not after.

- [ ] **Step 4: Build the CLI for the historical load**

`scripts/import-workbook.ts` for the one-time 12,264-row load, with the same guard shape as the seed: refuse when the target database already holds checks that did not come from this import, unless explicitly overridden.

- [ ] **Step 5: Run the full suite, `tsc`, build, and walk both pages in a browser**

- [ ] **Step 6: Commit**

---

## Plan 2 Completion Criteria

- [ ] `npm test` passes, `npx tsc --noEmit` clean, `npm run build` warning-free
- [ ] Six companies exist, keyed by `(tenant, branch)`
- [ ] The historical workbook imports with a reconciliation report, and **no row is silently dropped** — parsed + review + conflicts accounts for every input row
- [ ] A second import of the same workbook creates no duplicates and changes no Finance-set field
- [ ] An Acumatica sync runs incrementally, records a `SyncRun`, and writes **zero** `PortalEvent` rows
- [ ] A voided cheque in Acumatica reaches `VOIDED` and cannot be marked ready or released
- [ ] Admin screens are `FINANCE_ADMIN` only

## What Plan 2 Deliberately Leaves Out

| Deferred to | Item |
| --- | --- |
| Plan 3 | `PortalClient`, the outbox worker, pickup-confirmation polling, the unmatched-APV queue, batch release, reports and exports, notifications, user administration |

Before Plan 3 begins, `PortalEvent` needs a status enum, a `nextAttemptAt`, and a claim column — it cannot back a concurrent worker as currently shaped.

---

## Task 11: Bill Detail from the Approval-for-Release Workbook

**Files:**
- Create: `lib/import/bills.ts`
- Test: `tests/import/bills.test.ts`

**Interfaces:**
- Produces: `parseBillRows(rows: RawRow[]): { bills: ParsedBill[]; review: BillReviewItem[] }`

**Added 2026-09-03.** `CheckBill` exists in the schema, the check detail page is built to render
bills, and **nothing in Plan 2 populates it**. This task closes that gap. It was missed because the
plan treated "the workbook" as one thing; there are two, and only the register was specified.

### The source is a different workbook with a different grain

`APPROVAL FOR RELEASE 9.4.2026.xlsx` is not a cheque register. Measured:

| | |
| --- | --- |
| sheets | `LIST` (85 data rows) and `PIVOT` (derived — **ignore it**, it is a pivot table over `LIST`) |
| grain | **one row per bill**, not per cheque |
| all 85 rows | `Type = Bill`, `FINANCE REMARKS = AVAILABLE` |
| cheque linkage | `check No.` (col 20), populated on all 85; 85 distinct values, so one bill per cheque *in this snapshot* |

Columns, which map to `CheckBill` almost field for field:

| Workbook column | Field |
| --- | --- |
| `Reference Nbr.` | `apvNumber` (e.g. `AP-A1033419`) |
| `Vendor Ref.` | `poNumber` (e.g. `PO-A1-025543`) |
| `Description` | `description` |
| `GL Account` | `glAccount` |
| `Due Date` | `dueDate` |
| `Terms Code` | `termsCode` |
| `Detail Total` | `amount` |
| `Created By` | `createdByName` |
| `check No.` | links to `Check.checkNumber` |
| `bank` | the **cash-account label** — a company signal the register lacks |

**One bill per cheque here is a property of this snapshot, not of the domain.** The register carries
rows with several APVs on one cheque, and `CheckBill` is correctly modelled one-to-many. Do not add
a unique constraint on `checkId`, and do not let a test that happens to see 85 one-to-one rows
harden into an assumption.

### Rules

- This is a **current snapshot**, not history — it is the approval-for-release working list as of
  4 September 2026. It says nothing about cheques outside it, so it must never be treated as
  authoritative about a cheque's absence.
- Its `bank` column supplies a cash account for 85 cheques. That is a legitimate company signal and
  should feed `resolveCompany` on the same footing as the register's own cash-account column —
  which may promote a small number of Task 7 `NO_COMPANY` staged rows.
- `FINANCE REMARKS = AVAILABLE` on every row corroborates `READY_FOR_RELEASE`, but **this task must
  not set status**. Import never changes release status (decision D4); the remark is evidence for a
  human, not an instruction.
- A bill whose `check No.` matches no imported cheque goes to review. It is not an error — the
  cheque may be staged for want of a company, or simply not in the register — and it must not be
  dropped.
- Re-running must be idempotent. Key on `(checkId, apvNumber)`.

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Implement `lib/import/bills.ts`**
- [ ] **Step 3: Wire into the import flow and the reconciliation report**
- [ ] **Step 4: Run, verify against the real workbook, commit**
