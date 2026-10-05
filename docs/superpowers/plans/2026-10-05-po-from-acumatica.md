# PO NUMBER from Acumatica Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The PO NUMBER column shows every real purchase order Acumatica's `AP-Bills and Adjustments` names (in `VendorRef`) for any APV a cheque shows, beside the approval workbook's `CheckBill.poNumber` — on the list, in search, in the PO filter box, in the PO sort, in Excel and on the printed sheet.

**Architecture:** A pure module (`lib/integrations/acumatica/bill-refs.ts`) holds `extractPoNumbers` (only real PO shapes) and a row mapper for the inquiry. A runner (`lib/sync/bill-refs.ts`) reads the inquiry incrementally per tenant with its own watermark on `SyncRun` rows of `mode = 'BILL_REFS'` and mirrors it into a new reference table `AcumaticaBill` (one row per bill with at least one PO, keyed by APV; a bill whose ref stops yielding a PO is deleted). The cron runs it after the BILLS read for a tenant whose payment read RAN; the first read is `scripts/sync.ts <TENANT> --bill-refs`. Display: `listChecks` loads the `AcumaticaBill` rows for the page's displayed APVs in ONE extra query and attaches `poNumbers` computed by the one function `displayPoNumbers(row, index)`; `toTableRow` passes it through, so the list, Excel and print agree by construction. The PO sort loads the same index over the WHOLE matching set (one query), and the PO filter box and the global search share one SQL fragment (`acumaticaPoMatch`). `Check` gains no column.

**Tech Stack:** Next.js 15 App Router, Prisma 6 on Neon, Vitest, TypeScript strict, ExcelJS.

Spec: `docs/superpowers/specs/2026-10-05-po-from-acumatica-design.md`. Deviations and the open points it left are decided below (each labelled **Decision:**) and written back into the spec in Task 6.

## Global Constraints

- Acumatica is read-only (rule 3): only `fetchAll` is used.
- Rule 4: nothing here writes a `Check` column; `status` is untouched. `AcumaticaBill` is reference data, outside the `IMPORT_WRITABLE`/`IMMUTABLE_ON_UPDATE` exhaustiveness test (that test covers `Check` columns only) — a new model needs no classification there.
- Rule 7: no `AuditLog` row per bill. The run writes its own `SyncRun` row only. `app.allow_audit_purge` appears nowhere new.
- Rule 8: no amount is read or written by this feature.
- Measured 2026-10-05: GOLIVE `AP-Bills and Adjustments` columns include `Type`, `ReferenceNbr`, `Vendor`, `Status`, `Date`, `VendorRef`, `LastModifiedOn`, `Branch`; MANUFACTURING has the same names in that inquiry (column list read 2026-10-05: `Type`, `ReferenceNbr`, `Vendor`, `Status`, `Date`, `PostPeriod`, `VendorName`, `Description`, `VendorRef`, …, `LastModifiedOn`, …) — so ONE column map serves both tenants for this inquiry, unlike `AP-PAYMENTS-WITH-BILLS`.
- Measured 2026-10-05: GOLIVE 15,837 documents since 2026-01-01 (9,819 `VendorRef` starting `PO`); MANUFACTURING 217 (~120 `A1PP-PO-`/`STPP-PO-`). `Type` values: `Bill`, `Debit Adj.`, `Prepayment`, `Credit Adj.`.
- PO shapes (spec): `PO-ST-031109` (5,903), `PO-A1-…` (3,659), `PO-IND…` (106), `PO-HF-…` (83), `PO-ST…` without the second dash, occasional 5- or 7-digit numbers, two POs in one ref (`PO-A1-… / PO-A1-…`, `PO-ST-… PO-ST-…`), a trailing dot, lower case; MANUFACTURING `A1PP-PO-…` / `STPP-PO-…`. Not POs: `SI#1659`, `26X06-0267A`, `PO-ST-`, `PONDE 1234`, `for next po`, `PO-ST-12`.
- The PO pattern, exactly: `(?<![A-Z0-9])(?:PO-[A-Z0-9]{2,4}-?\d{5,7}|[A-Z0-9]{2,5}-PO-\d{5,7})(?![A-Z0-9])`, flags `gi`; matches upper-cased, de-duplicated, in order of appearance.
- OData filters: only `datetime'YYYY-MM-DDTHH:MM:SS'` literals (no zone); no `or` of `eq` (500 in Go-Live). This plan filters on ONE column per request and never combines conditions.
- Watermark = max `LastModifiedOn` seen over EVERY row read − 120 minutes (`SYNC_OVERLAP_MINUTES`); null (previous stands) when nothing was read or ANY write failed; fetch failure → `errors 1`, watermark null, rethrow.
- `SyncRun` columns for `BILL_REFS`: `imported` = bill rows actually written (inserted or changed), `updated` = rows deleted, `staged` = bills with a non-empty `VendorRef` that yields no PO, `errors` = failed write batches (or 1 for a failed fetch).
- A first `BILL_REFS` read (no watermark) is a terminal job, never the cron: the cron records a refusal.
- New migration: `prisma/migrations/20261005000100_acumatica_bill/migration.sql`. **The CONTROLLER, not the implementer, runs `node scripts/migrate.mjs test`** before any test that touches the database; production gets `node scripts/migrate.mjs prod --confirm` BEFORE the deploy (the list page reads the table).
- Tests: `node node_modules/vitest/vitest.mjs run <files>` from Bash; only the files named (one agent at a time against the test DB). Type check `node node_modules/typescript/bin/tsc --noEmit` must print nothing. Prisma client: `node node_modules/prisma/build/index.js generate` (no database involved).
- Never run project scripts or the dev server: the repo `.env` is PRODUCTION. Stage files by path. Work only in the `po-acu` worktree.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions

- **Decision: only `Type = 'Bill'` rows are stored.** The BILLS read links only `CHK → Bill`, so a Bill is the only document type whose APV a cheque is shown paying; a Debit Adj.'s Vendor Ref is not the cheque's PO.
- **Decision: the 2026 scope is enforced in the mapper (`Date` ≥ 2026-01-01), not in the incremental OData filter.** The first read filters `Date ge 2026-01-01`, an incremental read filters `LastModifiedOn ge <watermark>` only — combining two conditions in one filter is unmeasured on these tenants, and dropping a pre-2026 row client-side costs nothing.
- **Decision: one column map and tenant-free filter functions.** Measured: both tenants use the same column names in this inquiry.
- **Decision: `AcumaticaBill` is keyed by APV alone (as the spec says); an upsert overwrites `tenant`, a delete is tenant-guarded** (`WHERE tenant = <this run's>`). APV prefixes differ per tenant (`AP-ST…` vs `A1PP-AP-…`), and a MANUFACTURING read must never delete a GOLIVE row.
- **Decision: writes are set-based SQL in batches of 500** — one `INSERT … SELECT FROM jsonb_to_recordset … ON CONFLICT DO UPDATE … WHERE (…) IS DISTINCT FROM (…)` and one `DELETE … = ANY(…)` per batch; no interactive transaction (each batch is one atomic statement, so Prisma's 5 s transaction default and `TX_OPTIONS` do not apply). The `IS DISTINCT FROM` guard makes a re-read of unchanged bills write nothing, so `imported` counts real changes.
- **Decision: `vendorRef` is stored trimmed** (otherwise verbatim — case and punctuation kept for diagnosis).
- **Decision: mode names live in a new leaf module `lib/sync/modes.ts`** (`BILLS_MODE`, `BILL_REFS_MODE`, `NON_PAYMENT_MODES`), and every payment-side reader filters `mode: { notIn: [...NON_PAYMENT_MODES] }` — one list, so a fourth read cannot be forgotten in one of three places. `lib/sync/bills.ts` re-exports `BILLS_MODE` so existing imports keep working.
- **Decision: the cron gates `BILL_REFS` on the tenant's payment read RAN, not on BILLS.** The spec asks for the payment gate; BILLS is irrelevant because `AcumaticaBill` is keyed by APV and resolved at display time — nothing is lost if a cheque is not held yet.
- **Decision: POs reach `toTableRow` by `listChecks` attaching `poNumbers`.** There is no relation to `include`, and `rows.map(toTableRow)` (dashboard, export, print) passes an index as a second argument, so `toTableRow` cannot take the map. `listChecks` runs ONE query (`"apvNumber" = ANY($1::text[])`, a single bind parameter regardless of size) for the page's displayed APVs and computes `poNumbers` with `displayPoNumbers(row, index)`; `toTableRow` copies it.
- **Decision: the PO sort loads the index only when the key is `poNumbers`**, over every matching cheque's displayed APVs, in the same single `ANY` query.
- **Decision: the global search matches an Acumatica PO by substring, case-insensitively** (`ILIKE %q%`), the same as the existing `bills.some.poNumber contains`; it is OR'd in as `id IN (…)` computed by the same SQL fragment the PO filter box uses.
- **Decision: `CheckBill.poNumber` is not normalised** (out of scope); the union de-duplicates exact strings.
- **Decision: portal event bodies are unchanged** (`lib/integrations/portal/client.ts` keeps `CheckBill.poNumber`); the spec scopes this to display.
- **Decision: `--bills` and `--bill-refs` together are refused** by `scripts/sync.ts` — one read per invocation keeps each snapshot matched to its run.
- **Decision: print gets no new test.** No test renders `app/print/page.tsx` (`grep -rln app/print tests` is empty); it maps `listChecks` rows through `toTableRow`, which Task 5 pins, and Excel is pinned through the export route.

## File map

| File | Change |
| --- | --- |
| `lib/integrations/acumatica/bill-refs.ts` | new, pure: feed name, column map, filters, `extractPoNumbers`, `mapBillRef` |
| `prisma/schema.prisma`, `prisma/migrations/20261005000100_acumatica_bill/migration.sql` | `AcumaticaBill` model and table |
| `tests/helpers/db.ts` | `resetDb` truncates `AcumaticaBill` |
| `lib/sync/modes.ts` | new: `BILLS_MODE`, `BILL_REFS_MODE`, `NON_PAYMENT_MODES` |
| `lib/sync/run.ts`, `lib/admin/sync-overview.ts` | payment readers exclude `NON_PAYMENT_MODES` |
| `lib/sync/bills.ts` | `BILLS_MODE` from `modes.ts` (re-exported) |
| `lib/sync/bill-refs.ts` | new: `runBillRefsSync`, `lastBillRefsWatermark`, `runScheduledBillRefsSync` |
| `app/api/cron/sync/route.ts` | `BILL_REFS` per tenant after BILLS, gated on payment RAN |
| `scripts/sync.ts` | `--bill-refs` (snapshot first, `--dry-run`, `--full`) |
| `app/admin/sync/page.tsx` | count captions for `BILL_REFS` rows |
| `lib/queries.ts` | `AcumaticaPoIndex`, `displayPoNumbers(r, index)`, `listChecks` attaches `poNumbers`, PO sort, PO filter, search |
| `CLAUDE.md`, the spec | behaviour, commands, layout, decisions |

---

### Task 1: `extractPoNumbers` and the `AP-Bills and Adjustments` mapper

**Files:**
- Create: `lib/integrations/acumatica/bill-refs.ts`
- Test: `tests/integrations/acumatica-bill-refs.test.ts` (new)

**Interfaces:**
- Consumes: `naiveDate(value: unknown, { dayOnly: boolean }): Date | null` from `lib/integrations/acumatica/map.ts` (already exported).
- Produces: `BILL_REFS_FEED = 'AP-Bills and Adjustments'`; `BILL_REF_COLUMNS = { type: 'Type', ref: 'ReferenceNbr', date: 'Date', vendorRef: 'VendorRef', lastModified: 'LastModifiedOn' } as const`; `billRefsSelect(): string[]`; `billRefsSinceFilter(since: Date): string`; `billRefsInScopeFilter(): string`; `extractPoNumbers(vendorRef: string | null | undefined): string[]`; `type BillRef = { apvNumber: string; vendorRef: string; poNumbers: string[]; lastModifiedOn: Date | null }`; `mapBillRef(raw: unknown): BillRef | null`.

- [ ] **Step 1: Failing test** — create `tests/integrations/acumatica-bill-refs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  BILL_REFS_FEED, BILL_REF_COLUMNS, billRefsSelect, billRefsSinceFilter, billRefsInScopeFilter,
  extractPoNumbers, mapBillRef,
} from '@/lib/integrations/acumatica/bill-refs'

describe('extractPoNumbers — real POs', () => {
  const POSITIVE: [string, string[]][] = [
    ['PO-ST-031109', ['PO-ST-031109']],
    ['PO-A1-012345', ['PO-A1-012345']],
    ['PO-IND123456', ['PO-IND123456']],
    ['PO-HF-004512', ['PO-HF-004512']],
    ['PO-ST123456', ['PO-ST123456']],          // no second dash
    ['PO-ST-03110', ['PO-ST-03110']],          // 5 digits
    ['PO-ST-0311090', ['PO-ST-0311090']],      // 7 digits
    ['A1PP-PO-000123', ['A1PP-PO-000123']],    // MANUFACTURING
    ['STPP-PO-0001234', ['STPP-PO-0001234']],
    ['PO-ST-031109.', ['PO-ST-031109']],       // a trailing dot is not part of the PO
    ['po-st-031109', ['PO-ST-031109']],        // lower case -> upper
    ['stpp-po-000123', ['STPP-PO-000123']],
    ['PO-A1-012345 / PO-A1-012346', ['PO-A1-012345', 'PO-A1-012346']],
    ['PO-ST-031110 PO-ST-031109', ['PO-ST-031110', 'PO-ST-031109']], // order of appearance
    ['PO-ST-031109/PO-ST-031110', ['PO-ST-031109', 'PO-ST-031110']],
    ['PO-ST-031109 / po-st-031109.', ['PO-ST-031109']],              // de-duplicated
    ['DR 4471, PO-ST-031109', ['PO-ST-031109']],
    ['  PO-ST-031109  ', ['PO-ST-031109']],
  ]
  it.each(POSITIVE)('%s', (ref, expected) => {
    expect(extractPoNumbers(ref)).toEqual(expected)
  })
})

describe('extractPoNumbers — anything else is no PO', () => {
  const NEGATIVE: string[] = [
    'SI#1659',
    '26X06-0267A',
    'PO-ST-',           // no digits
    'PONDE 1234',
    'for next po',
    'PO-ST-12',         // too few digits
    'PO-ST-03110912',   // eight digits
    'XPO-ST-031109',    // inside a longer alphanumeric run
    'PO-ST-031109A',
    'PO-0001',
    '',
  ]
  it.each(NEGATIVE)('%s', (ref) => {
    expect(extractPoNumbers(ref)).toEqual([])
  })

  it('reads null and undefined as no PO', () => {
    expect(extractPoNumbers(null)).toEqual([])
    expect(extractPoNumbers(undefined)).toEqual([])
  })
})

describe('the feed', () => {
  it('names one column map for both tenants', () => {
    expect(BILL_REFS_FEED).toBe('AP-Bills and Adjustments')
    expect(BILL_REF_COLUMNS).toEqual({
      type: 'Type', ref: 'ReferenceNbr', date: 'Date', vendorRef: 'VendorRef', lastModified: 'LastModifiedOn',
    })
    expect(billRefsSelect()).toEqual(['Type', 'ReferenceNbr', 'Date', 'VendorRef', 'LastModifiedOn'])
  })

  it('filters on one column with the datetime literal, no zone', () => {
    expect(billRefsSinceFilter(new Date('2026-09-29T06:15:00.000Z')))
      .toBe("LastModifiedOn ge datetime'2026-09-29T06:15:00'")
    expect(billRefsInScopeFilter()).toBe("Date ge datetime'2026-01-01T00:00:00'")
  })
})

describe('mapBillRef', () => {
  const doc = (o: Record<string, unknown> = {}) => ({
    Type: 'Bill', ReferenceNbr: ' ap-st044591 ', Date: '2026-09-29T00:00:00',
    VendorRef: ' PO-ST-031109. ', LastModifiedOn: '2026-09-29T08:15:00', ...o,
  })

  it('maps a 2026 bill: APV trimmed and upper-cased, ref trimmed, POs extracted', () => {
    expect(mapBillRef(doc())).toEqual({
      apvNumber: 'AP-ST044591',
      vendorRef: 'PO-ST-031109.',
      poNumbers: ['PO-ST-031109'],
      lastModifiedOn: new Date('2026-09-29T08:15:00Z'),
    })
  })

  it('keeps a bill whose ref is not a PO, with no POs, so the run can delete a stale row', () => {
    expect(mapBillRef(doc({ VendorRef: 'SI#1659' }))).toMatchObject({ vendorRef: 'SI#1659', poNumbers: [] })
    expect(mapBillRef(doc({ VendorRef: null }))).toMatchObject({ vendorRef: '', poNumbers: [] })
  })

  it('keeps only Bills', () => {
    for (const t of ['Debit Adj.', 'Prepayment', 'Credit Adj.']) expect(mapBillRef(doc({ Type: t })), t).toBeNull()
  })

  it('refuses a bill dated before 2026 or with no date — the sync’s scope', () => {
    expect(mapBillRef(doc({ Date: '2025-12-31T00:00:00' }))).toBeNull()
    expect(mapBillRef(doc({ Date: null }))).toBeNull()
    expect(mapBillRef(doc({ Date: '2026-01-01T00:00:00' }))).not.toBeNull()
  })

  it('refuses a row with no reference, and anything that is not a row', () => {
    expect(mapBillRef(doc({ ReferenceNbr: '   ' }))).toBeNull()
    expect(mapBillRef(null)).toBeNull()
    expect(mapBillRef([])).toBeNull()
  })

  it('keeps a row whose LastModifiedOn cannot be read, with a null date', () => {
    expect(mapBillRef(doc({ LastModifiedOn: 'nonsense' }))?.lastModifiedOn).toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/integrations/acumatica-bill-refs.test.ts` → cannot resolve `@/lib/integrations/acumatica/bill-refs`.

- [ ] **Step 3: Implement** — create `lib/integrations/acumatica/bill-refs.ts`:

```ts
import { naiveDate } from './map'

/**
 * The purchase orders an AP bill names, read from Acumatica.
 *
 * `AP-Bills and Adjustments` carries one row per AP document; `VendorRef` is
 * the field the approval workbook's PO column comes from (lib/import/bills.ts,
 * VENDOR_REF). It is NOT always a PO — `26X06-0267A`, `SI#1659`, free text —
 * and the client chose "only real POs" (2026-10-05), so `extractPoNumbers`
 * keeps the PO shapes measured that day and nothing else.
 *
 * ONE column map for both tenants: measured 2026-10-05, MANUFACTURING names
 * this inquiry's columns exactly as Go-Live does (unlike AP-PAYMENTS-WITH-BILLS,
 * lib/integrations/acumatica/bills.ts).
 *
 * Only `Bill` documents dated 2026 onward (the sync's scope). The incremental
 * filter is on `LastModifiedOn` alone, so the scope is enforced here, not in
 * OData. Pure.
 */

export const BILL_REFS_FEED = 'AP-Bills and Adjustments'

export const BILL_REF_COLUMNS = {
  type: 'Type',
  ref: 'ReferenceNbr',
  date: 'Date',
  vendorRef: 'VendorRef',
  lastModified: 'LastModifiedOn',
} as const

/** The same scope boundary as the payment sync (`SYNC_FROM_DATE` in lib/sync/run.ts). */
const IN_SCOPE_FROM = '2026-01-01T00:00:00'
const SCOPE_START = new Date(`${IN_SCOPE_FROM}Z`)

const literal = (d: Date) => `datetime'${d.toISOString().slice(0, 19)}'`

export function billRefsSelect(): string[] {
  return Object.values(BILL_REF_COLUMNS)
}

export function billRefsSinceFilter(since: Date): string {
  return `${BILL_REF_COLUMNS.lastModified} ge ${literal(since)}`
}

export function billRefsInScopeFilter(): string {
  return `${BILL_REF_COLUMNS.date} ge datetime'${IN_SCOPE_FROM}'`
}

/**
 * `PO-ST-031109`, `PO-A1-012345`, `PO-IND123456`, `PO-ST123456` (first form) and
 * `A1PP-PO-000123`, `STPP-PO-0001234` (second), never inside a longer
 * alphanumeric run. A trailing dot is outside the match by construction.
 */
const PO_PATTERN = /(?<![A-Z0-9])(?:PO-[A-Z0-9]{2,4}-?\d{5,7}|[A-Z0-9]{2,5}-PO-\d{5,7})(?![A-Z0-9])/gi

export function extractPoNumbers(vendorRef: string | null | undefined): string[] {
  if (!vendorRef) return []
  const out: string[] = []
  for (const m of vendorRef.matchAll(PO_PATTERN)) {
    const po = m[0].toUpperCase()
    if (!out.includes(po)) out.push(po)
  }
  return out
}

export type BillRef = {
  /** `ReferenceNbr`, trimmed and upper-cased — the APV. */
  apvNumber: string
  /** `VendorRef`, trimmed; '' when absent. Kept for diagnosis. */
  vendorRef: string
  /** `extractPoNumbers(vendorRef)`; empty when the ref names no PO. */
  poNumbers: string[]
  lastModifiedOn: Date | null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function mapBillRef(raw: unknown): BillRef | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (text(r[BILL_REF_COLUMNS.type]) !== 'Bill') return null
  const apvNumber = text(r[BILL_REF_COLUMNS.ref]).toUpperCase()
  if (!apvNumber) return null
  const date = naiveDate(r[BILL_REF_COLUMNS.date], { dayOnly: true })
  if (date === null || date < SCOPE_START) return null
  const vendorRef = text(r[BILL_REF_COLUMNS.vendorRef])
  return {
    apvNumber,
    vendorRef,
    poNumbers: extractPoNumbers(vendorRef),
    lastModifiedOn: naiveDate(r[BILL_REF_COLUMNS.lastModified], { dayOnly: false }),
  }
}
```

- [ ] **Step 4: Run, expect PASS** — the same command; then `node node_modules/typescript/bin/tsc --noEmit` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add lib/integrations/acumatica/bill-refs.ts tests/integrations/acumatica-bill-refs.test.ts
git commit -m "feat(acumatica): extract real PO numbers from AP-Bills and Adjustments VendorRef" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The `AcumaticaBill` table, and the payment side looking past `BILL_REFS`

**Files:**
- Modify: `prisma/schema.prisma` (new model after `StagedBill`)
- Create: `prisma/migrations/20261005000100_acumatica_bill/migration.sql`
- Modify: `tests/helpers/db.ts` (`resetDb`)
- Create: `lib/sync/modes.ts`
- Modify: `lib/sync/bills.ts` (`BILLS_MODE` import + re-export), `lib/sync/run.ts` (`assertNoRunInProgress`, `lastSyncWatermark`), `lib/admin/sync-overview.ts` (both `findFirst`)
- Test: `tests/sync/modes.test.ts` (new), `tests/schema.test.ts` (+1), `tests/sync/run.test.ts` (+2), `tests/admin/sync-overview.test.ts` (+1), `tests/sync/bills.test.ts` (+2)

**Interfaces:**
- Produces: Prisma model `AcumaticaBill { apvNumber String @id; tenant String; vendorRef String; poNumbers String[]; lastModifiedOn DateTime?; updatedAt DateTime @updatedAt }` (client accessor `db.acumaticaBill`); `BILLS_MODE = 'BILLS'`, `BILL_REFS_MODE = 'BILL_REFS'`, `NON_PAYMENT_MODES: readonly ['BILLS', 'BILL_REFS']` from `lib/sync/modes.ts`; `lib/sync/bills.ts` still exports `BILLS_MODE`.

- [ ] **Step 1: Failing tests.**

`tests/sync/modes.test.ts` (new):

```ts
import { describe, it, expect } from 'vitest'
import { BILLS_MODE, BILL_REFS_MODE, NON_PAYMENT_MODES } from '@/lib/sync/modes'
import { BILLS_MODE as BILLS_MODE_FROM_BILLS } from '@/lib/sync/bills'

describe('sync modes', () => {
  it('lists every read that is not the payment feed', () => {
    expect(BILLS_MODE).toBe('BILLS')
    expect(BILL_REFS_MODE).toBe('BILL_REFS')
    expect([...NON_PAYMENT_MODES]).toEqual(['BILLS', 'BILL_REFS'])
    expect(BILLS_MODE_FROM_BILLS).toBe(BILLS_MODE)
  })
})
```

`tests/schema.test.ts` — append a `describe` at the end of the file (it uses the file's own `prisma` client and cleans up after itself):

```ts
describe('AcumaticaBill', () => {
  const APV = `TEST-SCHEMA-AP-${Date.now()}`
  afterAll(async () => {
    await prisma.acumaticaBill.deleteMany({ where: { apvNumber: APV } })
  })

  it('is keyed by the APV alone: a second row for the same voucher is refused', async () => {
    await prisma.acumaticaBill.create({
      data: { apvNumber: APV, tenant: 'GOLIVE', vendorRef: 'PO-ST-031109.', poNumbers: ['PO-ST-031109'] },
    })
    await expect(prisma.acumaticaBill.create({
      data: { apvNumber: APV, tenant: 'MANUFACTURING', vendorRef: 'A1PP-PO-000123', poNumbers: ['A1PP-PO-000123'] },
    })).rejects.toThrow()
    const row = await prisma.acumaticaBill.findUniqueOrThrow({ where: { apvNumber: APV } })
    expect(row.poNumbers).toEqual(['PO-ST-031109'])
    expect(row.lastModifiedOn).toBeNull()
    expect(row.updatedAt).toBeInstanceOf(Date)
  })
})
```

`tests/sync/run.test.ts` — add after the existing `it('ignores a newer BILLS row, whose watermark is on a different feed', …)` (same `describe`):

```ts
  it('ignores a newer BILL_REFS row, whose watermark is on a different feed', async () => {
    await seedBothTenantsST()
    await sync([feedRow({ LastModifiedOn: '2026-09-04T10:00:00' })]).result
    await testDb.syncRun.create({
      data: {
        mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() + 60_000),
        finishedAt: new Date(NOW.getTime() + 61_000), watermark: new Date('2026-09-30T00:00:00Z'),
      },
    })
    expect(await lastSyncWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-04T08:00:00Z'))
  })
```

and after `it('is not blocked by an unfinished BILLS run', …)` (same `describe`, which has `minutesBefore` in scope):

```ts
  it('is not blocked by an unfinished BILL_REFS run', async () => {
    await seedBothTenantsST()
    await testDb.syncRun.create({
      data: { mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: minutesBefore(5), finishedAt: null, trigger: 'SCHEDULED' },
    })
    const result = await sync([feedRow()]).result
    expect(result.imported).toBe(1)
  })
```

`tests/admin/sync-overview.test.ts` — after the BILLS case:

```ts
  it('does not report a newer BILL_REFS run as the tenant’s last attempt — that panel is the payment feed', async () => {
    await run({ startedAt: '2026-09-04T08:00:00Z', imported: 24 })
    await testDb.syncRun.create({
      data: { mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: new Date('2026-09-04T10:00:00Z'), finishedAt: null, imported: 7 },
    })
    const t = forTenant(await getSyncOverview(testDb), 'GOLIVE')
    expect(t.lastAttempt?.imported).toBe(24)
    expect(t.lastSuccess?.imported).toBe(24)
    expect(t.inFlight).toBe(false)
  })
```

`tests/sync/bills.test.ts` — in `describe('lastBillsWatermark', …)`:

```ts
  it('ignores a newer BILL_REFS watermark', async () => {
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'), watermark: new Date('2026-09-29T08:00:00Z') },
    })
    await testDb.syncRun.create({
      data: { mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: new Date('2026-09-30T10:00:00Z'), finishedAt: new Date('2026-09-30T10:00:01Z'), watermark: new Date('2026-09-30T08:00:00Z') },
    })
    expect(await lastBillsWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-29T08:00:00Z'))
  })
```

and in `describe('runBillsSync — one run at a time', …)`:

```ts
  it('is not blocked by an unfinished BILL_REFS run', async () => {
    await unfinished('BILL_REFS', 5)
    const result = await bills([]).result
    expect(result.errors).toBe(0)
  })
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/sync/modes.test.ts tests/sync/run.test.ts tests/admin/sync-overview.test.ts tests/sync/bills.test.ts` → `modes.test.ts` cannot resolve `@/lib/sync/modes`; the run/overview BILL_REFS cases fail (`not: 'BILLS'` lets a BILL_REFS row through); the two `bills.test.ts` cases already pass (they pin existing behaviour) — that is expected. Do not run `tests/schema.test.ts` yet (the table does not exist).

- [ ] **Step 3: Implement the modes.** Create `lib/sync/modes.ts`:

```ts
/**
 * `SyncRun.mode` values written by reads that are NOT the payment feed.
 *
 * The payment sync (lib/sync/run.ts) owns FULL and INCREMENTAL; its watermark,
 * its one-run-at-a-time guard and the dashboard's ACUMATICA LAST READ
 * (lib/admin/sync-overview.ts) must look past every mode listed here, because
 * each is a different feed with its own watermark:
 *   BILLS      lib/sync/bills.ts      AP-PAYMENTS-WITH-BILLS -> Check.apvNumbers
 *   BILL_REFS  lib/sync/bill-refs.ts  AP-Bills and Adjustments -> AcumaticaBill
 * A new read adds its mode HERE, once, not in three where clauses. Leaf module.
 */
export const BILLS_MODE = 'BILLS'
export const BILL_REFS_MODE = 'BILL_REFS'
export const NON_PAYMENT_MODES = [BILLS_MODE, BILL_REFS_MODE] as const
```

In `lib/sync/bills.ts` replace `export const BILLS_MODE = 'BILLS'` with:

```ts
import { BILLS_MODE } from '@/lib/sync/modes'
export { BILLS_MODE }
```

(move the `import` up with the other imports; keep the `export { BILLS_MODE }` where the constant was). `lastBillsWatermark` already filters `mode: BILLS_MODE` (equality) — leave it.

In `lib/sync/run.ts` add `import { NON_PAYMENT_MODES } from '@/lib/sync/modes'` and change BOTH occurrences (in `assertNoRunInProgress` and `lastSyncWatermark`) of

```ts
      // BILLS rows are the voucher read's, lib/sync/bills.ts; their watermark is on a different feed.
      mode: { not: 'BILLS' },
```

to

```ts
      // BILLS and BILL_REFS rows are other feeds' reads (lib/sync/modes.ts), with their own watermarks.
      mode: { notIn: [...NON_PAYMENT_MODES] },
```

(the `lastSyncWatermark` one is inline: `where: { tenant, mode: { notIn: [...NON_PAYMENT_MODES] }, watermark: { not: null } }`).

In `lib/admin/sync-overview.ts` add the same import and change both `findFirst` wheres from `mode: { not: 'BILLS' }` to `mode: { notIn: [...NON_PAYMENT_MODES] }`; update the comment above them to: `// The dashboard's ACUMATICA LAST READ is the payment feed; BILLS and BILL_REFS rows are other reads (lib/sync/modes.ts).`

- [ ] **Step 4: The table.** In `prisma/schema.prisma`, after the closing `}` of `model StagedBill`, add:

```prisma
// One Acumatica AP bill whose Vendor Ref names at least one real purchase
// order, read from `AP-Bills and Adjustments` by lib/sync/bill-refs.ts.
//
// REFERENCE DATA, NOT A RECORD. The table mirrors Acumatica: a bill whose
// Vendor Ref stops yielding a PO has its row DELETED, and no audit row is
// written per bill — the run's own SyncRun row (mode BILL_REFS) is the trace.
//
// Keyed by the APV, not by a cheque, and with no relation to `Check`: a bill
// read before its cheque carries the APV is not lost, because the link is
// resolved when the PO NUMBER column is displayed (`displayPoNumbers` in
// lib/queries.ts, over the cheque's displayed APVs). `Check` gains no column.
model AcumaticaBill {
  // `ReferenceNbr`, trimmed and upper-cased — the APV.
  apvNumber      String    @id
  // GOLIVE or MANUFACTURING: the tenant whose read last wrote the row.
  tenant         String
  // `VendorRef`, trimmed, otherwise verbatim — for diagnosis.
  vendorRef      String
  // extractPoNumbers(vendorRef): never empty (a bill with none has no row).
  poNumbers      String[]
  lastModifiedOn DateTime?
  updatedAt      DateTime  @updatedAt
}
```

Create `prisma/migrations/20261005000100_acumatica_bill/migration.sql`:

```sql
-- The purchase orders Acumatica's AP bills name, keyed by APV.
-- See docs/superpowers/specs/2026-10-05-po-from-acumatica-design.md.
--
-- Reference data mirrored from AP-Bills and Adjustments by lib/sync/bill-refs.ts:
-- one row per Bill whose VendorRef yields at least one real PO; deleted when it
-- no longer does. No foreign key to "Check": the APV is resolved against a
-- cheque's displayed vouchers when the PO NUMBER column is drawn.
CREATE TABLE "AcumaticaBill" (
    "apvNumber" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "vendorRef" TEXT NOT NULL,
    "poNumbers" TEXT[],
    "lastModifiedOn" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcumaticaBill_pkey" PRIMARY KEY ("apvNumber")
);
```

Do NOT run `prisma migrate dev`. Regenerate the client: `node node_modules/prisma/build/index.js generate`.

In `tests/helpers/db.ts`, inside `resetDb`'s transaction, directly after `await tx.stagedBill.deleteMany()`, add:

```ts
    // Not a child of anything: Acumatica's bill → PO reference table
    // (lib/sync/bill-refs.ts). Truncated so one file's bills cannot put a PO
    // on another file's cheques.
    await tx.acumaticaBill.deleteMany()
```

- [ ] **Step 5: STOP — the CONTROLLER applies the migration to the TEST database** with `node scripts/migrate.mjs test`. The implementer does not run it. Every database test (they all call `resetDb`) fails on a missing table until this is done.

- [ ] **Step 6: Run, expect PASS** — `node node_modules/vitest/vitest.mjs run tests/sync/modes.test.ts tests/schema.test.ts tests/sync/run.test.ts tests/admin/sync-overview.test.ts tests/sync/bills.test.ts`; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261005000100_acumatica_bill/migration.sql tests/helpers/db.ts lib/sync/modes.ts lib/sync/bills.ts lib/sync/run.ts lib/admin/sync-overview.ts tests/sync/modes.test.ts tests/schema.test.ts tests/sync/run.test.ts tests/admin/sync-overview.test.ts tests/sync/bills.test.ts
git commit -m "feat(schema): AcumaticaBill reference table; payment-side readers look past BILL_REFS runs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The `BILL_REFS` read

**Files:**
- Create: `lib/sync/bill-refs.ts`
- Test: `tests/sync/bill-refs.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 exports; `BILL_REFS_MODE` (Task 2); `SYNC_OVERLAP_MINUTES`, `SyncInProgressError`, `type SyncTrigger` from `lib/sync/run.ts`; `naiveDate`; `loadSettings` from `lib/settings/read.ts` (`values['sync.inProgressMinutes']`).
- Produces: `BILL_REFS_MODE` (re-export); `lastBillRefsWatermark(db: Db, tenant: AcumaticaTenant): Promise<Date | null>`; `type BillRefsSyncArgs = { client: AcumaticaClient; tenant: AcumaticaTenant; since: Date | null; now: Date; trigger: SyncTrigger }`; `runBillRefsSync(db: Db, args: BillRefsSyncArgs): Promise<BillRefsRunResult>` where `BillRefsRunResult = { syncRunId: string; tenant: AcumaticaTenant; fetched: number; ignored: number; withPo: number; upserted: number; deleted: number; noPo: number; errors: number; watermark: Date | null }`. `Db = PrismaClient | Prisma.TransactionClient`.

- [ ] **Step 1: Failing test** — create `tests/sync/bill-refs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { runBillRefsSync, lastBillRefsWatermark, BILL_REFS_MODE } from '@/lib/sync/bill-refs'
import { SyncInProgressError, SYNC_OVERLAP_MINUTES } from '@/lib/sync/run'
import {
  BILL_REFS_FEED, billRefsSinceFilter, billRefsInScopeFilter,
} from '@/lib/integrations/acumatica/bill-refs'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import type {
  AcumaticaClient, AcumaticaRow, FetchAllOptions, PageOptions,
} from '@/lib/integrations/acumatica/client'

const NOW = new Date('2026-10-05T18:00:00+08:00')

beforeEach(resetDb)

// Reference data, not a record (rule 7 untouched): no audit row, and nothing
// here may tell a supplier anything.
afterEach(async () => {
  expect(await testDb.auditLog.count()).toBe(0)
  expect(await testDb.portalEvent.count()).toBe(0)
})

type FeedCall = { feed: string; opts: FetchAllOptions | undefined }

function fakeFeed(rows: readonly AcumaticaRow[], failWith?: Error) {
  const calls: FeedCall[] = []
  const client: AcumaticaClient = {
    async fetchAll(feed: string, opts?: FetchAllOptions): Promise<AcumaticaRow[]> {
      calls.push({ feed, opts })
      if (failWith) throw failWith
      if (feed !== BILL_REFS_FEED) throw new Error(`unexpected feed ${feed}`)
      return [...rows]
    },
    async fetchPage(_feed: string, _opts?: PageOptions): Promise<AcumaticaRow[]> {
      throw new Error('runBillRefsSync must page through fetchAll, not fetchPage')
    },
  }
  return { client, calls }
}

/** One row of AP-Bills and Adjustments. */
const docRow = (o: Record<string, unknown> = {}): AcumaticaRow => ({
  Type: 'Bill',
  ReferenceNbr: 'AP-ST044591',
  Date: '2026-09-29T00:00:00',
  VendorRef: 'PO-ST-031109',
  LastModifiedOn: '2026-09-29T08:15:00',
  ...o,
})

const read = (
  rows: readonly AcumaticaRow[],
  opts: { since?: Date | null; failWith?: Error; tenant?: AcumaticaTenant; db?: typeof testDb } = {},
) => {
  const { client, calls } = fakeFeed(rows, opts.failWith)
  return {
    calls,
    result: runBillRefsSync(opts.db ?? testDb, {
      client, tenant: opts.tenant ?? 'GOLIVE', since: opts.since ?? null, now: NOW, trigger: 'MANUAL',
    }),
  }
}

const stored = () => testDb.acumaticaBill.findMany({ orderBy: { apvNumber: 'asc' } })

describe('runBillRefsSync — the table', () => {
  it('stores one row per Bill whose VendorRef names a PO, keyed by the upper-cased APV', async () => {
    const result = await read([
      docRow({ ReferenceNbr: ' ap-st044591 ', VendorRef: 'PO-A1-012345 / po-a1-012346.' }),
      docRow({ ReferenceNbr: 'AP-ST044592', VendorRef: 'PO-ST-031109', LastModifiedOn: '2026-09-29T09:00:00' }),
    ]).result
    expect((await stored()).map((b) => ({ ...b, updatedAt: undefined }))).toEqual([
      {
        apvNumber: 'AP-ST044591', tenant: 'GOLIVE', vendorRef: 'PO-A1-012345 / po-a1-012346.',
        poNumbers: ['PO-A1-012345', 'PO-A1-012346'], lastModifiedOn: new Date('2026-09-29T08:15:00Z'),
        updatedAt: undefined,
      },
      {
        apvNumber: 'AP-ST044592', tenant: 'GOLIVE', vendorRef: 'PO-ST-031109',
        poNumbers: ['PO-ST-031109'], lastModifiedOn: new Date('2026-09-29T09:00:00Z'),
        updatedAt: undefined,
      },
    ])
    expect(result).toMatchObject({ fetched: 2, ignored: 0, withPo: 2, upserted: 2, deleted: 0, noPo: 0, errors: 0 })
  })

  it('one column map serves MANUFACTURING', async () => {
    await read([docRow({ ReferenceNbr: 'A1PP-AP-000014', VendorRef: 'A1PP-PO-000123' })], { tenant: 'MANUFACTURING' }).result
    expect(await stored()).toMatchObject([{ apvNumber: 'A1PP-AP-000014', tenant: 'MANUFACTURING', poNumbers: ['A1PP-PO-000123'] }])
  })

  it('writes nothing for a VendorRef that is not a PO and counts it; an empty VendorRef is not counted', async () => {
    const result = await read([
      docRow({ ReferenceNbr: 'AP-1', VendorRef: 'SI#1659' }),
      docRow({ ReferenceNbr: 'AP-2', VendorRef: '26X06-0267A' }),
      docRow({ ReferenceNbr: 'AP-3', VendorRef: null }),
    ]).result
    expect(await stored()).toEqual([])
    expect(result).toMatchObject({ withPo: 0, upserted: 0, noPo: 2, deleted: 0 })
  })

  it('deletes a row whose VendorRef no longer names a PO — this tenant’s rows only', async () => {
    await testDb.acumaticaBill.createMany({
      data: [
        { apvNumber: 'AP-ST044591', tenant: 'GOLIVE', vendorRef: 'PO-ST-031109', poNumbers: ['PO-ST-031109'] },
        { apvNumber: 'AP-ST044592', tenant: 'MANUFACTURING', vendorRef: 'PO-ST-031110', poNumbers: ['PO-ST-031110'] },
      ],
    })
    const result = await read([
      docRow({ ReferenceNbr: 'AP-ST044591', VendorRef: 'SI#1659' }),
      docRow({ ReferenceNbr: 'AP-ST044592', VendorRef: 'SI#1660' }),
    ]).result
    expect((await stored()).map((b) => b.apvNumber)).toEqual(['AP-ST044592'])
    expect(result.deleted).toBe(1)
  })

  it('rewrites a row whose PO changed, and a second identical read writes nothing', async () => {
    await read([docRow({ VendorRef: 'PO-ST-031109' })]).result
    const changed = await read([docRow({ VendorRef: 'PO-ST-031150', LastModifiedOn: '2026-09-30T08:00:00' })]).result
    expect(changed.upserted).toBe(1)
    expect((await stored())[0].poNumbers).toEqual(['PO-ST-031150'])

    const before = (await stored())[0].updatedAt
    const again = await read([docRow({ VendorRef: 'PO-ST-031150', LastModifiedOn: '2026-09-30T08:00:00' })]).result
    expect(again.upserted).toBe(0)
    expect((await stored())[0].updatedAt).toEqual(before)
  })

  it('the latest row of an APV in one read wins', async () => {
    const result = await read([
      docRow({ VendorRef: 'PO-ST-000001', LastModifiedOn: '2026-09-29T08:00:00' }),
      docRow({ VendorRef: 'PO-ST-000002', LastModifiedOn: '2026-09-29T09:00:00' }),
    ]).result
    expect((await stored()).map((b) => b.poNumbers)).toEqual([['PO-ST-000002']])
    expect(result.upserted).toBe(1)
  })

  it('ignores other types, pre-2026 bills and rows with no reference — but their date still advances the watermark', async () => {
    const result = await read([
      docRow({ Type: 'Debit Adj.', LastModifiedOn: '2026-09-30T12:00:00' }),
      docRow({ ReferenceNbr: 'AP-OLD', Date: '2025-12-31T00:00:00' }),
      docRow({ ReferenceNbr: '  ' }),
    ]).result
    expect(await stored()).toEqual([])
    expect(result).toMatchObject({ fetched: 3, ignored: 3, upserted: 0 })
    expect(result.watermark).toEqual(
      new Date(new Date('2026-09-30T12:00:00Z').getTime() - SYNC_OVERLAP_MINUTES * 60_000),
    )
  })
})

describe('runBillRefsSync — the run record', () => {
  it('records mode BILL_REFS, the counts, watermark = max − 120 min, finishedAt, no message', async () => {
    await testDb.acumaticaBill.create({
      data: { apvNumber: 'AP-GONE', tenant: 'GOLIVE', vendorRef: 'PO-ST-000009', poNumbers: ['PO-ST-000009'] },
    })
    const result = await read([
      docRow({ ReferenceNbr: 'AP-1', LastModifiedOn: '2026-09-29T08:15:00' }),
      docRow({ ReferenceNbr: 'AP-GONE', VendorRef: 'SI#1', LastModifiedOn: '2026-09-29T09:00:00' }),
      docRow({ ReferenceNbr: 'AP-3', VendorRef: 'free text', LastModifiedOn: '2026-09-29T07:00:00' }),
    ]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.mode).toBe(BILL_REFS_MODE)
    expect(run.mode).toBe('BILL_REFS')
    expect(run.tenant).toBe('GOLIVE')
    expect(run.trigger).toBe('MANUAL')
    expect(run.startedAt).toEqual(NOW)
    expect(run.finishedAt).not.toBeNull()
    expect(run.imported).toBe(1)
    expect(run.updated).toBe(1)
    expect(run.staged).toBe(2)
    expect(run.errors).toBe(0)
    expect(run.message).toBeNull()
    expect(run.watermark).toEqual(new Date('2026-09-29T07:00:00Z'))
  })

  it('incremental: filters on LastModifiedOn from the watermark; a first read on Date from 2026', async () => {
    const since = new Date('2026-09-28T00:00:00Z')
    const a = read([], { since })
    await a.result
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0].feed).toBe(BILL_REFS_FEED)
    expect(a.calls[0].opts?.filter).toBe(billRefsSinceFilter(since))
    expect(a.calls[0].opts?.orderby).toBe('LastModifiedOn asc')
    expect(a.calls[0].opts?.select).toEqual(['Type', 'ReferenceNbr', 'Date', 'VendorRef', 'LastModifiedOn'])

    const b = read([])
    await b.result
    expect(b.calls[0].opts?.filter).toBe(billRefsInScopeFilter())
    expect((await b.result).watermark).toBeNull()
  })

  it('a fetch failure leaves the run finished with errors 1, watermark null, and rethrows', async () => {
    const boom = new Error('inquiry down')
    await expect(read([], { failWith: boom }).result).rejects.toBe(boom)
    const run = await testDb.syncRun.findFirstOrThrow({ where: { mode: 'BILL_REFS' } })
    expect(run.finishedAt).not.toBeNull()
    expect(run.errors).toBe(1)
    expect(run.watermark).toBeNull()
    expect(run.message).toContain('inquiry down')
  })

  it('a failed write is an error, the other writes still land, and the watermark is held', async () => {
    await testDb.acumaticaBill.create({
      data: { apvNumber: 'AP-STALE', tenant: 'GOLIVE', vendorRef: 'PO-ST-000009', poNumbers: ['PO-ST-000009'] },
    })
    let calls = 0
    // The first raw write (the upsert batch) throws; the delete batch is real.
    const flaky = new Proxy(testDb, {
      get(target, prop, receiver) {
        if (prop === '$executeRaw') {
          return (...a: unknown[]) => {
            calls++
            if (calls === 1) return Promise.reject(new Error('write refused for the first batch'))
            return (target.$executeRaw as (...x: unknown[]) => unknown).apply(target, a)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const result = await read([
      docRow({ ReferenceNbr: 'AP-ST044591' }),
      docRow({ ReferenceNbr: 'AP-STALE', VendorRef: 'SI#1' }),
    ], { db: flaky }).result
    expect(result.errors).toBe(1)
    expect(result.upserted).toBe(0)
    expect(result.deleted).toBe(1)
    expect(await stored()).toEqual([])
    expect(result.watermark).toBeNull()
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.watermark).toBeNull()
    expect(run.message).toContain('write refused for the first batch')
    expect(run.message).toContain('AP-ST044591')
  })
})

describe('runBillRefsSync — one run at a time', () => {
  const unfinished = (mode: string, minutesAgo: number) =>
    testDb.syncRun.create({
      data: { mode, tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - minutesAgo * 60_000), finishedAt: null },
    })

  it('refuses while a BILL_REFS run younger than the setting is unfinished', async () => {
    await unfinished('BILL_REFS', 5)
    await expect(read([docRow()]).result).rejects.toBeInstanceOf(SyncInProgressError)
    expect(await testDb.syncRun.count()).toBe(1)
  })

  it('is not blocked by an unfinished payment or BILLS run', async () => {
    await unfinished('INCREMENTAL', 5)
    await unfinished('BILLS', 5)
    const result = await read([]).result
    expect(result.errors).toBe(0)
  })
})

describe('lastBillRefsWatermark', () => {
  it('returns the newest BILL_REFS watermark and ignores payment and BILLS runs', async () => {
    const at = (mode: string, day: string) =>
      testDb.syncRun.create({
        data: {
          mode, tenant: 'GOLIVE',
          startedAt: new Date(`${day}T10:00:00Z`), finishedAt: new Date(`${day}T10:00:01Z`),
          watermark: new Date(`${day}T08:00:00Z`),
        },
      })
    await at('BILL_REFS', '2026-09-29')
    await at('BILL_REFS', '2026-09-30')
    await at('BILLS', '2026-10-01')
    await at('INCREMENTAL', '2026-10-02')
    expect(await lastBillRefsWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-30T08:00:00Z'))
    expect(await lastBillRefsWatermark(testDb, 'MANUFACTURING')).toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/sync/bill-refs.test.ts` → cannot resolve `@/lib/sync/bill-refs`.

- [ ] **Step 3: Implement** — create `lib/sync/bill-refs.ts`:

```ts
import { Prisma, type PrismaClient } from '@prisma/client'
import type { AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import {
  BILL_REFS_FEED,
  BILL_REF_COLUMNS,
  billRefsInScopeFilter,
  billRefsSelect,
  billRefsSinceFilter,
  mapBillRef,
  type BillRef,
} from '@/lib/integrations/acumatica/bill-refs'
import { naiveDate } from '@/lib/integrations/acumatica/map'
import { loadSettings } from '@/lib/settings/read'
import { BILL_REFS_MODE } from '@/lib/sync/modes'
import { SYNC_OVERLAP_MINUTES, SyncInProgressError, type SyncTrigger } from '@/lib/sync/run'

/**
 * The PO read: which purchase orders each AP bill names.
 *
 * Reads Acumatica's `AP-Bills and Adjustments` incrementally per tenant, with
 * its own watermark on `SyncRun` rows of `mode = 'BILL_REFS'` (every other read
 * ignores them, lib/sync/modes.ts), and MIRRORS it into `AcumaticaBill`: a Bill
 * whose VendorRef yields at least one real PO (`extractPoNumbers`) is upserted
 * by APV; one that yields none has its row deleted (this tenant's only).
 *
 * Reference data, not a record: no AuditLog row per bill (rule 7 untouched);
 * the run's own SyncRun row is the trace. Never touches `Check` (rule 4) and
 * never writes a PortalEvent. Acumatica is read through `fetchAll` only (rule 3).
 *
 * Writes are set-based, one statement per batch of 500, so no interactive
 * transaction is opened. A failed batch is an error and HOLDS the watermark,
 * so the next run reads those bills again; re-writing an unchanged bill is a
 * no-op (the upsert's IS DISTINCT FROM guard).
 *
 * A first read (no watermark) is a terminal job, never the cron.
 */

type Db = PrismaClient | Prisma.TransactionClient

export { BILL_REFS_MODE }

const WRITE_BATCH = 500
const MAX_REPORTED_PROBLEMS = 5
const MAX_PROBLEM_LENGTH = 300

export type BillRefsSyncArgs = {
  client: AcumaticaClient
  tenant: AcumaticaTenant
  /** The previous BILL_REFS watermark (`lastBillRefsWatermark`), or null for a first read. */
  since: Date | null
  now: Date
  trigger: SyncTrigger
}

export type BillRefsRunResult = {
  syncRunId: string
  tenant: AcumaticaTenant
  /** Rows the feed returned. */
  fetched: number
  /** Rows that are not a 2026 Bill with a reference. Not errors. */
  ignored: number
  /** Distinct bills read whose VendorRef names at least one PO. */
  withPo: number
  /** Bill rows actually written (inserted, or changed). */
  upserted: number
  /** Rows deleted because the bill's VendorRef no longer names a PO. */
  deleted: number
  /** Distinct bills with a non-empty VendorRef that names no PO. */
  noPo: number
  errors: number
  watermark: Date | null
}

/** The watermark the last BILL_REFS run for this tenant left; no other read is consulted. */
export async function lastBillRefsWatermark(db: Db, tenant: AcumaticaTenant): Promise<Date | null> {
  const run = await db.syncRun.findFirst({
    where: { tenant, mode: BILL_REFS_MODE, watermark: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { watermark: true },
  })
  return run?.watermark ?? null
}

export async function runBillRefsSync(db: Db, args: BillRefsSyncArgs): Promise<BillRefsRunResult> {
  const { client, tenant, since, now, trigger } = args
  const inProgressMinutes = (await loadSettings(db)).values['sync.inProgressMinutes']

  // Only another BILL_REFS run blocks this one; the other reads are other feeds.
  const open = await db.syncRun.findFirst({
    where: {
      tenant,
      mode: BILL_REFS_MODE,
      finishedAt: null,
      startedAt: { gt: new Date(now.getTime() - inProgressMinutes * 60_000) },
    },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  })
  if (open) throw new SyncInProgressError(tenant, open.startedAt, inProgressMinutes)

  const run = await db.syncRun.create({ data: { mode: BILL_REFS_MODE, tenant, startedAt: now, trigger } })

  let fetched = 0
  let ignored = 0
  let withPo = 0
  let upserted = 0
  let deleted = 0
  let noPo = 0
  let errors = 0
  const problems: string[] = []

  const finish = async (watermark: Date | null): Promise<void> => {
    await db.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        imported: upserted,
        updated: deleted,
        staged: noPo,
        errors,
        watermark,
        message: problems.length > 0 ? summarise(problems) : null,
      },
    })
  }

  let rows: Awaited<ReturnType<AcumaticaClient['fetchAll']>>
  try {
    rows = await client.fetchAll(BILL_REFS_FEED, {
      select: billRefsSelect(),
      filter: since ? billRefsSinceFilter(since) : billRefsInScopeFilter(),
      // Ordered so `$skip` paging is stable, and so the last row of an APV is its latest.
      orderby: `${BILL_REF_COLUMNS.lastModified} asc`,
      pageSize: 2000,
    })
  } catch (error) {
    // Nothing was read, so the watermark must not move.
    errors = 1
    problems.push(describe(error))
    await finish(null)
    throw error
  }

  fetched = rows.length

  // Over EVERY row, ignored ones included: they were read, and holding the
  // watermark behind them would re-read them for ever.
  let maxSeen: Date | null = null
  const byApv = new Map<string, BillRef>()
  for (const raw of rows) {
    const seen = naiveDate(raw[BILL_REF_COLUMNS.lastModified], { dayOnly: false })
    if (seen && (maxSeen === null || seen > maxSeen)) maxSeen = seen
    const ref = mapBillRef(raw)
    if (ref === null) {
      ignored++
      continue
    }
    // Rows arrive oldest first, so a later row of the same APV replaces an earlier one.
    byApv.set(ref.apvNumber, ref)
  }

  const keep: BillRef[] = []
  const drop: string[] = []
  for (const ref of byApv.values()) {
    if (ref.poNumbers.length > 0) {
      keep.push(ref)
    } else {
      drop.push(ref.apvNumber)
      if (ref.vendorRef !== '') noPo++
    }
  }
  withPo = keep.length

  for (let i = 0; i < keep.length; i += WRITE_BATCH) {
    const batch = keep.slice(i, i + WRITE_BATCH)
    try {
      upserted += await upsertBatch(db, tenant, batch)
    } catch (error) {
      errors++
      problems.push(`${batch[0].apvNumber}…${batch[batch.length - 1].apvNumber}: ${describe(error)}`)
    }
  }

  for (let i = 0; i < drop.length; i += WRITE_BATCH) {
    const batch = drop.slice(i, i + WRITE_BATCH)
    try {
      // This tenant's rows only: a MANUFACTURING read must never delete a GOLIVE bill.
      deleted += await db.$executeRaw(Prisma.sql`
        DELETE FROM "AcumaticaBill"
         WHERE "tenant" = ${tenant} AND "apvNumber" = ANY(${batch}::text[])`)
    } catch (error) {
      errors++
      problems.push(`${batch[0]}…${batch[batch.length - 1]}: ${describe(error)}`)
    }
  }

  // HELD when any batch failed: the previous watermark stays, so the failed
  // bills are re-read next run (an incremental read only looks forward).
  const watermark =
    errors > 0 || maxSeen === null
      ? null
      : new Date(maxSeen.getTime() - SYNC_OVERLAP_MINUTES * 60_000)

  await finish(watermark)

  return { syncRunId: run.id, tenant, fetched, ignored, withPo, upserted, deleted, noPo, errors, watermark }
}

/**
 * One statement for up to WRITE_BATCH bills. Rows travel as one JSON parameter
 * (`poNumbers` is an array per row, which `unnest` of parallel arrays cannot
 * carry). `lastModifiedOn` arrives as an ISO string ending in Z; cast to a
 * zone-less timestamp the Z is ignored, which is how Prisma stores UTC. The
 * WHERE on DO UPDATE skips a bill whose stored values already match, so the
 * returned count is the rows actually written. `updatedAt` is set the way
 * Prisma's @updatedAt would, in UTC (as lib/sync/bills.ts does).
 */
async function upsertBatch(db: Db, tenant: AcumaticaTenant, batch: readonly BillRef[]): Promise<number> {
  const payload = JSON.stringify(batch.map((b) => ({
    apvNumber: b.apvNumber,
    tenant,
    vendorRef: b.vendorRef,
    poNumbers: b.poNumbers,
    lastModifiedOn: b.lastModifiedOn?.toISOString() ?? null,
  })))
  return db.$executeRaw(Prisma.sql`
    INSERT INTO "AcumaticaBill" ("apvNumber", "tenant", "vendorRef", "poNumbers", "lastModifiedOn", "updatedAt")
    SELECT x."apvNumber", x."tenant", x."vendorRef",
           ARRAY(SELECT e FROM jsonb_array_elements_text(x."poNumbers") WITH ORDINALITY AS t(e, n) ORDER BY n),
           x."lastModifiedOn", (now() AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS x("apvNumber" text, "tenant" text, "vendorRef" text, "poNumbers" jsonb, "lastModifiedOn" timestamp(3))
    ON CONFLICT ("apvNumber") DO UPDATE
       SET "tenant" = EXCLUDED."tenant",
           "vendorRef" = EXCLUDED."vendorRef",
           "poNumbers" = EXCLUDED."poNumbers",
           "lastModifiedOn" = EXCLUDED."lastModifiedOn",
           "updatedAt" = EXCLUDED."updatedAt"
     WHERE ("AcumaticaBill"."tenant", "AcumaticaBill"."vendorRef", "AcumaticaBill"."poNumbers", "AcumaticaBill"."lastModifiedOn")
           IS DISTINCT FROM (EXCLUDED."tenant", EXCLUDED."vendorRef", EXCLUDED."poNumbers", EXCLUDED."lastModifiedOn")`)
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > MAX_PROBLEM_LENGTH ? `${text.slice(0, MAX_PROBLEM_LENGTH)}…` : text
}

function summarise(problems: readonly string[]): string {
  return [...new Set(problems)].slice(0, MAX_REPORTED_PROBLEMS).join(' | ')
}
```

- [ ] **Step 4: Run, expect PASS** — `node node_modules/vitest/vitest.mjs run tests/sync/bill-refs.test.ts`; tsc clean. If the `jsonb_to_recordset` statement errors, read the Postgres message, fix the SQL (not the test), and keep: one statement per batch, the `IS DISTINCT FROM` guard, tenant-guarded delete.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/bill-refs.ts tests/sync/bill-refs.test.ts
git commit -m "feat(sync): mirror AP-Bills and Adjustments POs into AcumaticaBill, own watermark" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Scheduled, from a terminal, and on `/admin/sync`

**Files:**
- Modify: `lib/sync/bill-refs.ts` (add the scheduled wrapper)
- Modify: `app/api/cron/sync/route.ts`
- Modify: `scripts/sync.ts`
- Modify: `app/admin/sync/page.tsx`
- Test: `tests/sync/bill-refs.test.ts` (+4), `tests/sync/cron-route.test.ts`

**Interfaces:**
- Produces: `NO_BILL_REFS_WATERMARK_MESSAGE: string`; `type ScheduledBillRefsOutcome = { tenant; outcome: 'RAN'; syncRunId: string; fetched: number; ignored: number; upserted: number; deleted: number; noPo: number; errors: number } | { tenant; outcome: 'REFUSED_NO_WATERMARK'; syncRunId: string } | { tenant; outcome: 'IN_PROGRESS'; message: string } | { tenant; outcome: 'FAILED'; message: string } | { tenant; outcome: 'SKIPPED_PAYMENT_NOT_RUN' }` (`tenant: AcumaticaTenant`); `runScheduledBillRefsSync(db: Db, args: { tenant: AcumaticaTenant; now: Date; client: () => AcumaticaClient }): Promise<ScheduledBillRefsOutcome>` — never throws. The cron JSON body gains `billRefs: ScheduledBillRefsOutcome[]`.

- [ ] **Step 1: Failing tests.**

`tests/sync/bill-refs.test.ts` — extend the import to `import { runBillRefsSync, lastBillRefsWatermark, runScheduledBillRefsSync, BILL_REFS_MODE, NO_BILL_REFS_WATERMARK_MESSAGE } from '@/lib/sync/bill-refs'` and append:

```ts
describe('runScheduledBillRefsSync', () => {
  const refsWatermark = (tenant: 'GOLIVE' | 'MANUFACTURING') =>
    testDb.syncRun.create({
      data: {
        mode: 'BILL_REFS', tenant, trigger: 'MANUAL',
        startedAt: new Date('2026-09-29T10:00:00Z'), finishedAt: new Date('2026-09-29T10:00:01Z'),
        watermark: new Date('2026-09-29T08:00:00Z'),
      },
    })

  it('refuses without a BILL_REFS watermark and records a finished BILL_REFS row saying so', async () => {
    // Neither a payment nor a BILLS watermark is a BILL_REFS watermark.
    await testDb.syncRun.create({ data: { mode: 'INCREMENTAL', tenant: 'GOLIVE', startedAt: NOW, finishedAt: NOW, watermark: NOW } })
    await testDb.syncRun.create({ data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: NOW, finishedAt: NOW, watermark: NOW } })
    let built = 0
    const outcome = await runScheduledBillRefsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => { built++; return fakeFeed([]).client },
    })
    expect(built).toBe(0)
    const run = await testDb.syncRun.findFirstOrThrow({ where: { mode: 'BILL_REFS' } })
    expect(outcome).toEqual({ tenant: 'GOLIVE', outcome: 'REFUSED_NO_WATERMARK', syncRunId: run.id })
    expect(run.trigger).toBe('SCHEDULED')
    expect(run.finishedAt).not.toBeNull()
    expect(run.errors).toBe(1)
    expect(run.watermark).toBeNull()
    expect(run.message).toBe(NO_BILL_REFS_WATERMARK_MESSAGE)
  })

  it('a client factory that throws is FAILED, never a throw', async () => {
    await refsWatermark('GOLIVE')
    const outcome = await runScheduledBillRefsSync(testDb, {
      tenant: 'GOLIVE', now: NOW, client: () => { throw new Error('x'.repeat(400)) },
    })
    expect(outcome.outcome).toBe('FAILED')
    if (outcome.outcome !== 'FAILED') throw new Error('unreachable')
    expect(outcome.message.length).toBe(300)
  })

  it('with a watermark, RAN with the counts, as SCHEDULED, from that watermark', async () => {
    await refsWatermark('GOLIVE')
    const feed = fakeFeed([docRow(), docRow({ ReferenceNbr: 'AP-2', VendorRef: 'SI#1' })])
    const outcome = await runScheduledBillRefsSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => feed.client })
    expect(outcome).toMatchObject({
      tenant: 'GOLIVE', outcome: 'RAN', fetched: 2, ignored: 0, upserted: 1, deleted: 0, noPo: 1, errors: 0,
    })
    expect(feed.calls[0].opts?.filter).toBe(billRefsSinceFilter(new Date('2026-09-29T08:00:00Z')))
    if (outcome.outcome !== 'RAN') throw new Error('unreachable')
    expect((await testDb.syncRun.findUniqueOrThrow({ where: { id: outcome.syncRunId } })).trigger).toBe('SCHEDULED')
  })

  it('a BILL_REFS run already in progress is IN_PROGRESS, not FAILED', async () => {
    await refsWatermark('GOLIVE')
    await testDb.syncRun.create({
      data: { mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() - 60_000), finishedAt: null },
    })
    const outcome = await runScheduledBillRefsSync(testDb, { tenant: 'GOLIVE', now: NOW, client: () => fakeFeed([]).client })
    expect(outcome.outcome).toBe('IN_PROGRESS')
  })
})
```

`tests/sync/cron-route.test.ts` — exact edits:
1. `state` gains `failBillRefsFor: null as string | null,`; `beforeEach` gains `state.failBillRefsFor = null`.
2. The mocked `fetchAll` gains, before `return []`:
   ```ts
        if (feed === 'AP-Bills and Adjustments' && state.failBillRefsFor === tenant) {
          throw new Error(`${tenant} bill refs feed down`)
        }
   ```
3. `watermarked` also seeds a `BILL_REFS` watermark (doc comment becomes "A payment, a BILLS and a BILL_REFS watermark for the tenant."):
   ```ts
  await testDb.syncRun.create({
    data: {
      mode: 'BILL_REFS', tenant, trigger: 'MANUAL',
      startedAt: new Date('2026-09-10T10:00:00Z'), finishedAt: new Date('2026-09-10T10:00:05Z'),
      watermark: new Date('2026-09-10T08:00:00Z'),
    },
  })
   ```
4. In `'reads both tenants, in order, as SCHEDULED'`: `state.requested` becomes `['GOLIVE', 'MANUFACTURING', 'GOLIVE', 'MANUFACTURING', 'GOLIVE', 'MANUFACTURING']`; the comment "A payment read and a voucher read per tenant." becomes "A payment read, a voucher read and a PO read per tenant."; the expected sorted list becomes `['GOLIVE:BILLS', 'GOLIVE:BILL_REFS', 'GOLIVE:INCREMENTAL', 'MANUFACTURING:BILLS', 'MANUFACTURING:BILL_REFS', 'MANUFACTURING:INCREMENTAL']`.
5. In `'still reads the second tenant when the first fails, and answers 500'`: `state.requested` becomes `['GOLIVE', 'MANUFACTURING', 'MANUFACTURING', 'MANUFACTURING']` and the comment says GOLIVE's voucher and PO reads are both skipped.
6. Append:
   ```ts
describe('GET /api/cron/sync — the PO read (BILL_REFS)', () => {
  it('reports one BILL_REFS outcome per tenant, in SYNC_TENANTS order', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.billRefs.map((b: { tenant: string; outcome: string }) => [b.tenant, b.outcome]))
      .toEqual([['GOLIVE', 'RAN'], ['MANUFACTURING', 'RAN']])
  })

  it('a BILL_REFS FAILED turns the response 500 while the payment and voucher reads still RAN', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failBillRefsFor = 'GOLIVE'
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['RAN', 'RAN'])
    expect(body.bills.map((b: { outcome: string }) => b.outcome)).toEqual(['RAN', 'RAN'])
    expect(body.billRefs.map((b: { outcome: string }) => b.outcome)).toEqual(['FAILED', 'RAN'])
  })

  it('skips BILL_REFS for a tenant whose payment read did not run, with no BILL_REFS SyncRun row', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failFor = 'GOLIVE'
    const res = await get(`Bearer ${SECRET}`)
    const body = await res.json()
    expect(body.billRefs.map((b: { tenant: string; outcome: string }) => [b.tenant, b.outcome]))
      .toEqual([['GOLIVE', 'SKIPPED_PAYMENT_NOT_RUN'], ['MANUFACTURING', 'RAN']])
    expect(await testDb.syncRun.count({ where: { mode: 'BILL_REFS', tenant: 'GOLIVE', trigger: 'SCHEDULED' } })).toBe(0)
  })

  it('BILL_REFS REFUSED_NO_WATERMARK is recorded and does not turn the response 500', async () => {
    await paymentWatermarked('GOLIVE')
    await paymentWatermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.billRefs.map((b: { outcome: string }) => b.outcome))
      .toEqual(['REFUSED_NO_WATERMARK', 'REFUSED_NO_WATERMARK'])
    expect(await testDb.syncRun.count({ where: { mode: 'BILL_REFS', trigger: 'SCHEDULED', errors: 1 } })).toBe(2)
  })
})
   ```
   Keep every other existing assertion exact.

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/sync/bill-refs.test.ts tests/sync/cron-route.test.ts`.

- [ ] **Step 3: Implement.**

Append to `lib/sync/bill-refs.ts`:

```ts
/**
 * What a scheduled PO read says when it will not run. A first BILL_REFS read
 * reads the whole year's bills and is a terminal job.
 */
export const NO_BILL_REFS_WATERMARK_MESSAGE =
  'No BILL_REFS watermark for this tenant. The first PO read must be started by an admin — ' +
  'scripts/sync.ts <TENANT> --bill-refs in a terminal — and is never run on a schedule.'

// See lib/sync/scheduled.ts: an OData failure can be a whole HTML page.
const MAX_OUTCOME_MESSAGE = 300

export type ScheduledBillRefsOutcome =
  | {
      tenant: AcumaticaTenant
      outcome: 'RAN'
      syncRunId: string
      fetched: number
      ignored: number
      upserted: number
      deleted: number
      noPo: number
      errors: number
    }
  | { tenant: AcumaticaTenant; outcome: 'REFUSED_NO_WATERMARK'; syncRunId: string }
  | { tenant: AcumaticaTenant; outcome: 'IN_PROGRESS'; message: string }
  | { tenant: AcumaticaTenant; outcome: 'FAILED'; message: string }
  /** The cron did not run the PO read because this tenant's payment read did not RUN. Not a failure. */
  | { tenant: AcumaticaTenant; outcome: 'SKIPPED_PAYMENT_NOT_RUN' }

/**
 * One tenant's scheduled PO read, never throwing — `runScheduledBillsSync`
 * line for line. `client` is a factory so a missing environment variable is
 * this tenant's FAILED, not an exception before the other tenant has run.
 */
export async function runScheduledBillRefsSync(
  db: Db,
  args: { tenant: AcumaticaTenant; now: Date; client: () => AcumaticaClient },
): Promise<ScheduledBillRefsOutcome> {
  const { tenant, now } = args
  try {
    const since = await lastBillRefsWatermark(db, tenant)
    if (since === null) {
      const run = await db.syncRun.create({
        data: {
          mode: BILL_REFS_MODE, tenant, trigger: 'SCHEDULED',
          startedAt: now, finishedAt: new Date(),
          errors: 1, message: NO_BILL_REFS_WATERMARK_MESSAGE,
        },
      })
      return { tenant, outcome: 'REFUSED_NO_WATERMARK', syncRunId: run.id }
    }

    const result = await runBillRefsSync(db, {
      client: args.client(), tenant, since, now, trigger: 'SCHEDULED',
    })
    return {
      tenant, outcome: 'RAN', syncRunId: result.syncRunId,
      fetched: result.fetched, ignored: result.ignored, upserted: result.upserted,
      deleted: result.deleted, noPo: result.noPo, errors: result.errors,
    }
  } catch (error) {
    if (error instanceof SyncInProgressError) {
      return { tenant, outcome: 'IN_PROGRESS', message: error.message.slice(0, MAX_OUTCOME_MESSAGE) }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { tenant, outcome: 'FAILED', message: message.slice(0, MAX_OUTCOME_MESSAGE) }
  }
}
```

`app/api/cron/sync/route.ts`: add `import { runScheduledBillRefsSync, type ScheduledBillRefsOutcome } from '@/lib/sync/bill-refs'`. After the BILLS loop and before `runAutoSign`, insert:

```ts
  // The POs each AP bill names (lib/sync/bill-refs.ts), into AcumaticaBill —
  // reference data keyed by APV, resolved against cheques when the PO NUMBER
  // column is drawn. Gated on the tenant's payment read like BILLS (a read
  // that could not reach the tenant's payments is no moment to read its
  // bills), but NOT on BILLS: nothing here depends on which cheques are held.
  const billRefs: ScheduledBillRefsOutcome[] = []
  for (const tenant of SYNC_TENANTS) {
    const payment = outcomes.find((o) => o.tenant === tenant)
    if (payment?.outcome !== 'RAN') {
      billRefs.push({ tenant, outcome: 'SKIPPED_PAYMENT_NOT_RUN' })
      continue
    }
    billRefs.push(
      await runScheduledBillRefsSync(prisma, { tenant, now, client: () => createClientForTenant(tenant) }),
    )
  }
```

Add `billRefs.some((b) => b.outcome === 'FAILED') ||` to `failed`, and `billRefs` to the JSON body after `bills`: `json({ ranAt: now.toISOString(), outcomes, bills, billRefs, autoSign, portal }, …)`. Add to the header comment, after the voucher-read paragraph:

```
 * Then THE PO READ (lib/sync/bill-refs.ts), both tenants in the same order:
 * Acumatica's AP-Bills and Adjustments, mirrored into AcumaticaBill (bill →
 * real POs, keyed by APV). Its own watermark (BILL_REFS rows); none → a
 * recorded refusal, because a first read is `scripts/sync.ts <TENANT>
 * --bill-refs` from a terminal. FAILED turns the response 500; a refusal or
 * SKIPPED_PAYMENT_NOT_RUN does not. Incremental runs are small (a day's
 * bills), well inside the 60-second ceiling the auto-sign budget already
 * accounts for.
```

`scripts/sync.ts`:
- Imports: `import { runBillRefsSync, lastBillRefsWatermark } from '../lib/sync/bill-refs'` and `import { BILL_REFS_FEED, BILL_REF_COLUMNS, billRefsSelect, billRefsInScopeFilter, billRefsSinceFilter, mapBillRef, type BillRef } from '../lib/integrations/acumatica/bill-refs'`.
- Flags: `const BILL_REFS = args.includes('--bill-refs')`.
- In `main`, before `if (BILLS) return bills(tenant)`:
  ```ts
  if (BILLS && BILL_REFS) throw new Error('One read per run: --bills or --bill-refs, not both.')
  if (BILL_REFS) return billRefs(tenant)
  ```
- Header usage, after the `--bills` block:
  ```
   * THE PO READ (`--bill-refs`). Acumatica's AP-Bills and Adjustments, mirrored
   * into AcumaticaBill (lib/sync/bill-refs.ts): each 2026 Bill whose VendorRef
   * names a real PO, keyed by APV; a bill whose ref no longer does is deleted.
   * Reference data — no Check column, no audit row per bill. The cron runs it
   * incrementally once a tenant has a BILL_REFS watermark; the FIRST read, and
   * any `--full` re-read, is this script's job. Before writing it snapshots the
   * whole AcumaticaBill table to snapshots/bill-refs-<tenant>-<timestamp>.json.
   *
   *   npx.cmd tsx scripts/sync.ts GOLIVE --bill-refs --dry-run   # read the feed, write nothing
   *   npx.cmd tsx scripts/sync.ts GOLIVE --bill-refs             # snapshot, then mirror
   *   npx.cmd tsx scripts/sync.ts GOLIVE --bill-refs --full      # ignore the BILL_REFS watermark
  ```
- New function after `bills`:

```ts
/** The PO read: `--bill-refs`. Reference data; snapshot first. */
async function billRefs(t: AcumaticaTenant) {
  const watermark = FORCE_FULL ? null : await lastBillRefsWatermark(db, t)

  console.log(`\nTENANT      ${t}`)
  console.log(`FEED        ${BILL_REFS_FEED}`)
  console.log(`MODE        ${watermark ? `BILL_REFS since ${watermark.toISOString()}` : 'BILL_REFS, every 2026 bill (no watermark)'}`)

  if (DRY) {
    // The same filter runBillRefsSync uses, so the count is the job's size.
    const rows = await clientFor(t).fetchAll(BILL_REFS_FEED, {
      select: billRefsSelect(),
      filter: watermark ? billRefsSinceFilter(watermark) : billRefsInScopeFilter(),
      orderby: `${BILL_REF_COLUMNS.lastModified} asc`,
      pageSize: 2000,
    })
    const inScope = rows.map((r) => mapBillRef(r)).filter((r): r is BillRef => r !== null)
    const withPo = inScope.filter((b) => b.poNumbers.length > 0).length
    console.log(
      `\nDRY RUN — the feed returns ${rows.length.toLocaleString()} rows: ${inScope.length.toLocaleString()} ` +
      `2026 bills, ${withPo.toLocaleString()} naming a PO. Nothing was written.\n`,
    )
    return
  }

  // CLAUDE.md: snapshot before any bulk write to production. The whole table:
  // a run can rewrite or delete any row of this tenant's.
  const now = new Date()
  const before = await db.acumaticaBill.findMany({ orderBy: { apvNumber: 'asc' } })
  await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
  const snap = join(
    process.cwd(), 'snapshots', `bill-refs-${t}-${now.toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), tenant: t, rows: before }, null, 2))
  console.log(`SNAPSHOT    ${snap} (${before.length.toLocaleString()} bills)`)

  const started = Date.now()
  const res = await runBillRefsSync(db, { client: clientFor(t), tenant: t, since: watermark, now, trigger: 'MANUAL' })

  console.log(`\nRESULT  (${((Date.now() - started) / 60000).toFixed(1)} min)`)
  console.log(`  fetched                       ${res.fetched.toLocaleString()}`)
  console.log(`  ignored (not a 2026 Bill)     ${res.ignored.toLocaleString()}`)
  console.log(`  bills naming a PO             ${res.withPo.toLocaleString()}`)
  console.log(`  rows written                  ${res.upserted.toLocaleString()}`)
  console.log(`  rows deleted (PO gone)        ${res.deleted.toLocaleString()}`)
  console.log(`  ref but no PO                 ${res.noPo.toLocaleString()}`)
  console.log(`  errors                        ${res.errors.toLocaleString()}`)
  console.log(`  next watermark                ${res.watermark ? res.watermark.toISOString() : '(unchanged)'}\n`)
  if (res.errors > 0) {
    console.log(
      `  WATERMARK HELD: ${res.errors} write batch(es) failed (named in the run message on /admin/sync).\n` +
      `  Re-run this command until errors is 0. Until a BILL_REFS watermark exists the scheduled run\n` +
      `  records a refusal for ${t} instead of reading POs.\n`,
    )
  }
}
```

`app/admin/sync/page.tsx`: add `import { BILL_REFS_MODE } from '@/lib/sync/modes'`. Above `SyncPage`, add:

```tsx
/**
 * A non-payment read reuses the three count columns for different things.
 * `short` is the caption under the mode, in column order; `titles` the
 * per-cell hover text.
 */
const COUNT_CAPTIONS: Partial<Record<string, { short: string; titles: readonly [string, string, string] }>> = {
  [BILLS_MODE]: {
    short: 'vouchers added · cheques · not held here',
    titles: ['vouchers added', 'cheques changed', 'payments not held here'],
  },
  [BILL_REFS_MODE]: {
    short: 'bills written · deleted · ref but no PO',
    titles: ['bills with a PO written', 'bills deleted (VendorRef no longer names a PO)', 'bills with a VendorRef that names no PO'],
  },
}
```

In the runs table change `{recent.map((r) => (` … `))}` to a block body that starts `{recent.map((r) => { const cap = COUNT_CAPTIONS[r.mode]; return (` and ends `) })}`; replace the BILLS-only caption block with

```tsx
                    {cap && (
                      <span className="block whitespace-nowrap text-[11px] text-slate-400">{cap.short}</span>
                    )}
```

and the three count cells' `title={r.mode === BILLS_MODE ? '…' : undefined}` with `title={cap?.titles[0]}`, `title={cap?.titles[1]}`, `title={cap?.titles[2]}`. Update the JSX comment above the mode cell to "A BILLS or BILL_REFS row reuses the three count columns for different things; the caption names them in column order."

- [ ] **Step 4: Run, expect PASS** — `node node_modules/vitest/vitest.mjs run tests/sync/bill-refs.test.ts tests/sync/cron-route.test.ts`; tsc clean (it covers `scripts/sync.ts` and the page).

- [ ] **Step 5: Commit**

```bash
git add lib/sync/bill-refs.ts app/api/cron/sync/route.ts scripts/sync.ts app/admin/sync/page.tsx tests/sync/bill-refs.test.ts tests/sync/cron-route.test.ts
git commit -m "feat(cron): PO read for both tenants after the voucher read; scripts/sync.ts --bill-refs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: PO NUMBER from Acumatica — list, search, filter, sort, Excel, print

**Files:**
- Modify: `lib/queries.ts` (`buildWhere`, `arrayContainsIds`, `whereFor`, `appSortValue`, `appSortedIds`, `listChecks`, `displayPoNumbers`, `toTableRow`; new `AcumaticaPoIndex`, `NO_ACUMATICA_POS`, `loadAcumaticaPoIndex`, `acumaticaPoMatch`, `idsWithAcumaticaPo`, `withPoNumbers`)
- Test: `tests/queries.test.ts` (+5), `tests/export/route.test.ts` (+1)

**Interfaces:**
- Consumes: the `AcumaticaBill` table (Task 2).
- Produces: `type AcumaticaPoIndex = ReadonlyMap<string, readonly string[]>` (APV → POs); `NO_ACUMATICA_POS: AcumaticaPoIndex`; `loadAcumaticaPoIndex(db: Db, apvs: Iterable<string>): Promise<AcumaticaPoIndex>`; `displayPoNumbers(r: { apvNumbers: string[]; bills: { apvNumber: string; poNumber: string | null }[] }, acumatica: AcumaticaPoIndex): string[]`; `appSortValue(key: AppSortKey, r: SortProbe, acumatica: AcumaticaPoIndex): SortValue`; `listChecks` rows (`CheckRow`) gain `poNumbers: string[]`; `CheckTableRow.poNumbers` unchanged in type.

- [ ] **Step 1: Failing tests.**

`tests/queries.test.ts` — append:

```ts
// Spec 2026-10-05: the PO NUMBER column also shows the POs Acumatica's
// AP-Bills and Adjustments names for any APV the cheque shows.
describe('PO NUMBER from Acumatica (AcumaticaBill)', () => {
  const acuBill = (apvNumber: string, poNumbers: string[]) =>
    testDb.acumaticaBill.create({ data: { apvNumber, tenant: 'GOLIVE', vendorRef: poNumbers.join(' / '), poNumbers } })
  const nums = (rows: { checkNumber: string }[]) => rows.map((r) => r.checkNumber).sort()

  it('shows the POs of every displayed APV — its own vouchers and its bills’ — with the bills’ POs, once each, sorted', async () => {
    const c = await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST000001'] })
    await testDb.checkBill.create({ data: { checkId: c.id, apvNumber: 'AP-ST000002', poNumber: 'PO-ST-000009', amount: '1.00' } })
    await acuBill('AP-ST000001', ['PO-ST-031110', 'PO-ST-031109'])
    await acuBill('AP-ST000002', ['PO-ST-000009'])  // the bill's own PO: shown once
    await acuBill('AP-ST999999', ['PO-ST-777777'])  // an APV this cheque does not show
    const [row] = await listChecks(testDb, {})
    expect(toTableRow(row).poNumbers).toEqual(['PO-ST-000009', 'PO-ST-031109', 'PO-ST-031110'])
  })

  it('a cheque none of whose APVs has an AcumaticaBill shows its bills’ POs only, or none', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST000001'] })
    await acuBill('AP-ST000002', ['PO-ST-031109'])
    const [row] = await listChecks(testDb, {})
    expect(toTableRow(row).poNumbers).toEqual([])
  })

  it('the global search finds a cheque by part of an Acumatica PO, any case, and the count agrees', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST000001'] })
    const viaBill = await makeCheck({ checkNumber: '6000000002' })
    await testDb.checkBill.create({ data: { checkId: viaBill.id, apvNumber: 'AP-ST000002', amount: '1.00' } })
    await makeCheck({ checkNumber: '6000000003', apvNumbers: ['AP-ST000003'] })
    await acuBill('AP-ST000001', ['PO-ST-031109'])
    await acuBill('AP-ST000002', ['PO-ST-031150'])
    await acuBill('AP-ST000003', ['PO-A1-012345'])
    expect(nums(await listChecks(testDb, { q: 'po-st-0311' }))).toEqual(['6000000001', '6000000002'])
    expect(await countChecks(testDb, { q: 'po-st-0311' })).toBe(2)
    // Still narrows within the other filters.
    expect(nums(await listChecks(testDb, { q: 'po-st-0311', checkNumberContains: '0002' }))).toEqual(['6000000002'])
  })

  it('the PO filter box matches an Acumatica PO as well as a bill’s, and reads % as text', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST000001'] })
    const viaBill = await makeCheck({ checkNumber: '6000000002' })
    await testDb.checkBill.create({ data: { checkId: viaBill.id, apvNumber: 'AP-ST000002', amount: '1.00' } })
    const billPo = await makeCheck({ checkNumber: '6000000004' })
    await testDb.checkBill.create({ data: { checkId: billPo.id, apvNumber: 'AP-ST000004', poNumber: 'PO-ST-031199', amount: '1.00' } })
    await makeCheck({ checkNumber: '6000000003', apvNumbers: ['AP-ST000003'] })
    await acuBill('AP-ST000001', ['PO-ST-031109'])
    await acuBill('AP-ST000002', ['PO-ST-031150'])
    await acuBill('AP-ST000003', ['PO-A1-012345'])
    expect(nums(await listChecks(testDb, { poContains: 'st-0311' }))).toEqual(['6000000001', '6000000002', '6000000004'])
    expect(await countChecks(testDb, { poContains: 'a1-0123' })).toBe(1)
    expect(await countChecks(testDb, { poContains: '%' })).toBe(0)
  })

  it('sorts PO NUMBER by the first value shown, Acumatica’s included, over every matching cheque before the limit', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-1'] })
    await makeCheck({ checkNumber: '6000000002', apvNumbers: ['AP-2'] })
    const c = await makeCheck({ checkNumber: '6000000003' })
    await makeCheck({ checkNumber: '6000000004' }) // no PO anywhere: last both ways
    await acuBill('AP-1', ['PO-ST-000005'])
    await acuBill('AP-2', ['PO-ST-000009'])
    await testDb.checkBill.create({ data: { checkId: c.id, apvNumber: 'AP-3', poNumber: 'PO-ST-000001', amount: '1.00' } })
    const sorted = async (dir: 'asc' | 'desc', limit = 200) =>
      (await listChecks(testDb, {}, limit, { key: 'poNumbers', dir })).map((r) => r.checkNumber)
    expect(await sorted('asc')).toEqual(['6000000003', '6000000001', '6000000002', '6000000004'])
    expect(await sorted('desc')).toEqual(['6000000002', '6000000001', '6000000003', '6000000004'])
    expect(await sorted('asc', 2)).toEqual(['6000000003', '6000000001'])
    // The page's rows carry Acumatica's POs too, not only the order.
    expect((await listChecks(testDb, {}, 1, { key: 'poNumbers', dir: 'desc' })).map((r) => toTableRow(r).poNumbers))
      .toEqual([['PO-ST-000009']])
  })
})
```

`tests/export/route.test.ts` — change the helper import to `import { resetDb, testDb } from '../helpers/db'` and add to `describe('GET /api/export — sort, filters, columns', …)`:

```ts
  it('writes Acumatica’s PO into the PO NUMBER column', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST044591'] })
    await testDb.acumaticaBill.create({
      data: { apvNumber: 'AP-ST044591', tenant: 'GOLIVE', vendorRef: 'PO-ST-031109.', poNumbers: ['PO-ST-031109'] },
    })
    const ws = (await sheetsFrom(await get('http://localhost/api/export?scope=all'))).getWorksheet(REGISTER_SHEET)!
    expect(ws.getRow(HEADER_ROW).getCell(3).value).toBe('PO NUMBER')
    expect(ws.getRow(FIRST_DATA_ROW).getCell(3).value).toBe('PO-ST-031109')
  })
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/queries.test.ts tests/export/route.test.ts` → the five new cases and the export case fail (no Acumatica PO anywhere); every existing case still passes.

- [ ] **Step 3: Implement in `lib/queries.ts`.**

(a) Below `likePattern`, add the index and the shared SQL fragment:

```ts
/**
 * APV → the POs Acumatica's AP-Bills and Adjustments names for it
 * (`AcumaticaBill`, lib/sync/bill-refs.ts). There is no relation from `Check`
 * — the table is keyed by APV — so it is loaded per request, for exactly the
 * APVs on screen (or, for the PO sort, every matching cheque's).
 */
export type AcumaticaPoIndex = ReadonlyMap<string, readonly string[]>
export const NO_ACUMATICA_POS: AcumaticaPoIndex = new Map()

/** One query however many APVs: the list travels as a single array parameter. */
export async function loadAcumaticaPoIndex(db: Db, apvs: Iterable<string>): Promise<AcumaticaPoIndex> {
  const list = [...new Set(apvs)]
  if (list.length === 0) return NO_ACUMATICA_POS
  const rows = await db.$queryRaw<{ apvNumber: string; poNumbers: string[] }[]>`
    SELECT "apvNumber", "poNumbers" FROM "AcumaticaBill" WHERE "apvNumber" = ANY(${list}::text[])`
  return new Map(rows.map((r) => [r.apvNumber, r.poNumbers]))
}

/**
 * The SQL twin of `displayPoNumbers`' Acumatica half, for a cheque aliased
 * `c`: one of the APVs it SHOWS (its own `apvNumbers`, or a bill's
 * `apvNumber` — `displayApvNumbers`) has an AcumaticaBill with a PO matching
 * `pattern` (ILIKE … ESCAPE '\', from `likePattern`). Used by the PO filter
 * box and the global search, so both match exactly what the column shows.
 */
function acumaticaPoMatch(pattern: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "AcumaticaBill" ab
     WHERE (ab."apvNumber" = ANY(c."apvNumbers")
            OR ab."apvNumber" IN (SELECT b2."apvNumber" FROM "CheckBill" b2 WHERE b2."checkId" = c."id"))
       AND EXISTS (SELECT 1 FROM unnest(ab."poNumbers") AS po(x) WHERE po.x ILIKE ${pattern} ESCAPE '\\')
  )`
}

/** The global search's Acumatica-PO arm: substring, any case — as the bills' PO arm is. */
async function idsWithAcumaticaPo(db: Db, text: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c."id" FROM "Check" c WHERE ${acumaticaPoMatch(likePattern(text))}`
  return rows.map((r) => r.id)
}
```

(b) `arrayContainsIds`, PO branch becomes:

```ts
  if (f.poContains) {
    const p = likePattern(f.poContains)
    conditions.push(Prisma.sql`(
      EXISTS (SELECT 1 FROM "CheckBill" b WHERE b."checkId" = c."id" AND b."poNumber" ILIKE ${p} ESCAPE '\\')
      OR ${acumaticaPoMatch(p)}
    )`)
  }
```

and its doc comment's last paragraph becomes: "PO reads both sources the PO NUMBER column shows: the bills' `poNumber` and Acumatica's (`acumaticaPoMatch`). `Check` has no PO column."

(c) `buildWhere` takes the extra search arms. Signature `function buildWhere(filters: CheckFilters, extraSearch: readonly Prisma.CheckWhereInput[] = []): Prisma.CheckWhereInput`; in the `where.OR = [ … ]` array add `...extraSearch,` after the `apvNumbers: { has: … }` entry, with the comment `// Acumatica's POs (AcumaticaBill): ids computed by whereFor, which needs the database.`

(d) `whereFor` becomes:

```ts
/** `buildWhere`, plus the database-backed steps: the search's Acumatica-PO arm and the APV/PO column filters. Every query that can carry a search or column filters goes through this. */
async function whereFor(db: Db, filters: CheckFilters): Promise<Prisma.CheckWhereInput> {
  if (filters.refused) return buildWhere(filters)
  const q = filters.q?.trim()
  const extraSearch: Prisma.CheckWhereInput[] = q ? [{ id: { in: await idsWithAcumaticaPo(db, q) } }] : []
  const where = buildWhere(filters, extraSearch)
  const ids = await arrayContainsIds(db, filters)
  return ids === null ? where : { AND: [where, { id: { in: ids } }] }
}
```

(e) The sort: `appSortValue(key: AppSortKey, r: SortProbe, acumatica: AcumaticaPoIndex): SortValue`, with `case 'poNumbers': return displayPoNumbers(r, acumatica)[0] ?? null`. In `appSortedIds`, after `const probes = …`:

```ts
  // PO NUMBER sorts by the first PO SHOWN, Acumatica's included, so the index
  // is loaded over every matching cheque's displayed APVs — one query.
  const acumatica = key === 'poNumbers'
    ? await loadAcumaticaPoIndex(db, probes.flatMap((p) => displayApvNumbers(p)))
    : NO_ACUMATICA_POS
```

and the mapping calls `appSortValue(key, p, acumatica)`.

(f) `listChecks` attaches `poNumbers`:

```ts
/** What `displayPoNumbers` reads from a row. */
type PoSource = { apvNumbers: string[]; bills: { apvNumber: string; poNumber: string | null }[] }

/**
 * Each row with its PO NUMBER cell computed: ONE query for the AcumaticaBill
 * rows of every APV on the page. `toTableRow` copies it, so the list, Excel
 * and print show the same value from the same function.
 */
async function withPoNumbers<R extends PoSource>(db: Db, rows: R[]): Promise<(R & { poNumbers: string[] })[]> {
  const acumatica = await loadAcumaticaPoIndex(db, rows.flatMap((r) => displayApvNumbers(r)))
  return rows.map((r) => ({ ...r, poNumbers: displayPoNumbers(r, acumatica) }))
}

export async function listChecks(db: Db, filters: CheckFilters, limit = 200, sort: SortSpec = DEFAULT_SORT) {
  const where = await whereFor(db, filters)
  const { key, dir } = sort
  if (!isAppSorted(key)) {
    return withPoNumbers(
      db,
      await db.check.findMany({ where, include: CHECK_ROW_INCLUDE, orderBy: dbOrderBy(key, dir), take: limit }),
    )
  }
  const ids = await appSortedIds(db, where, key, dir, limit)
  const rows = await db.check.findMany({ where: { id: { in: ids } }, include: CHECK_ROW_INCLUDE })
  const position = new Map(ids.map((id, i) => [id, i]))
  return withPoNumbers(db, rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)))
}
```

(keep `listChecks`'s existing doc comment above it).

(g) `displayPoNumbers` becomes (doc comment replaced):

```ts
/**
 * What the PO NUMBER cell shows: the approval workbook's Vendor Ref on each
 * bill (`CheckBill.poNumber`) and every real PO Acumatica's AP-Bills and
 * Adjustments names for an APV the cheque SHOWS (`displayApvNumbers`;
 * `AcumaticaBill`, spec 2026-10-05), de-duplicated and sorted. The ONE
 * definition: the list, Excel and print read it through `listChecks`, the
 * PO sort reads its first value, and the PO filter box and the search match
 * the same two sources (`acumaticaPoMatch`). `Check` has no PO column.
 */
export function displayPoNumbers(r: PoSource, acumatica: AcumaticaPoIndex): string[] {
  const fromBills = r.bills.map((b) => b.poNumber).filter((p): p is string => p !== null)
  const fromAcumatica = displayApvNumbers(r).flatMap((apv) => acumatica.get(apv) ?? [])
  return [...new Set([...fromBills, ...fromAcumatica])].sort()
}
```

Move `type PoSource` above `displayPoNumbers` if `withPoNumbers` is placed after it — the type must be declared once; put it directly above `withPoNumbers` or `displayPoNumbers`, whichever comes first in the file.

(h) `toTableRow`: `poNumbers: r.poNumbers,` with the comment `// Computed by listChecks through displayPoNumbers (one AcumaticaBill query per page).`

No change to `components/CheckTable.tsx`, `lib/export/workbook.ts`, `app/print/page.tsx` or `lib/column-filters.ts`: all three surfaces map `listChecks` rows through `toTableRow`, and `f.po` already reaches `poContains`. Confirm with `grep -rn "displayPoNumbers\|appSortValue" lib app components scripts` that no other caller needs the new argument.

- [ ] **Step 4: Run, expect PASS** — `node node_modules/vitest/vitest.mjs run tests/queries.test.ts tests/export/route.test.ts tests/table-columns.test.ts tests/export/workbook.test.ts tests/list-sort.test.ts`; tsc clean (it also checks `app/page.tsx`, `app/print/page.tsx` and `app/api/export/route.ts` against the new `CheckRow`).

- [ ] **Step 5: Commit**

```bash
git add lib/queries.ts tests/queries.test.ts tests/export/route.test.ts
git commit -m "feat(list): PO NUMBER shows Acumatica's POs in the list, search, filter, sort, Excel and print" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, spec, hand-off

**Files:** `CLAUDE.md`, `docs/superpowers/specs/2026-10-05-po-from-acumatica-design.md`

- [ ] **Step 1: CLAUDE.md.**
  - In the BILLS paragraph of "THIS SYSTEM IS THE RECORD", replace the sentence beginning "A cheque's PO is `CheckBill.poNumber` only (`Check` has no PO column — the register's POs reached `StagedCheck` only; Acumatica publishes none), and the list, Excel and print show a PO NUMBER column" up to "`check-monitoring.columns.v2`)." with: "A cheque's PO NUMBER is `CheckBill.poNumber` ∪ the real POs Acumatica's `AP-Bills and Adjustments` names in `VendorRef` for any APV the cheque shows (spec `2026-10-05-po-from-acumatica-design.md`, client 2026-10-05 "only real POs"): `lib/sync/bill-refs.ts` mirrors it into `AcumaticaBill` (keyed by APV, reference data — no `Check` column, no audit row per bill, deleted when the ref stops naming a PO), `SyncRun.mode = 'BILL_REFS'`, its own watermark, run by the cron after BILLS for a tenant whose payment read RAN; the first read is `npx tsx scripts/sync.ts <TENANT> --bill-refs` (snapshot `snapshots/bill-refs-<tenant>-<timestamp>.json` first). `extractPoNumbers` (`lib/integrations/acumatica/bill-refs.ts`) keeps only the measured PO shapes; ONE column map serves both tenants for this inquiry. `displayPoNumbers` in `lib/queries.ts` is the one definition — list, Excel, print, PO sort, PO filter and search all read it or its SQL twin `acumaticaPoMatch`. The list, Excel and print show a PO NUMBER column (Excel AMOUNT moved to column 8; the column-choice storage key is now `check-monitoring.columns.v2`)."
  - Commands block, after the `--bills` lines:
    ```
    npx tsx scripts/sync.ts GOLIVE --bill-refs --dry-run  # read AP-Bills and Adjustments, write nothing (MANUFACTURING likewise)
    npx tsx scripts/sync.ts GOLIVE --bill-refs            # snapshot AcumaticaBill, then mirror bill -> PO; add --full to re-read
    ```
  - Layout table, after the `lib/integrations/acumatica/bills.ts` row, these three rows verbatim:

    ```
    | `lib/sync/bill-refs.ts` | The BILL_REFS read: `AP-Bills and Adjustments` → `AcumaticaBill` (APV → real POs); own watermark, `runScheduledBillRefsSync` for the cron. |
    | `lib/integrations/acumatica/bill-refs.ts` | `extractPoNumbers` (real PO shapes only), the inquiry's one column map (both tenants), `mapBillRef`. Pure. |
    | `lib/sync/modes.ts` | `SyncRun` modes that are not the payment feed (`BILLS`, `BILL_REFS`); every payment-side reader excludes `NON_PAYMENT_MODES`. |
    ```
  - State: after the line about production migrations, add: "Migration `20261005000100_acumatica_bill` (the `AcumaticaBill` table) must reach production BEFORE the deploy that carries it: the list, export and print query the table on every request."
- [ ] **Step 2: Spec corrections.** In `docs/superpowers/specs/2026-10-05-po-from-acumatica-design.md`:
  - "The read": replace "LastModifiedOn (GOLIVE) / the MANUFACTURING name — measure it before coding" with "LastModifiedOn — measured 2026-10-05: MANUFACTURING uses the same column names in this inquiry, so one column map serves both tenants"; state that only `Type = 'Bill'` rows are stored, the 2026 scope is enforced on `Date` in the mapper (one OData condition per request), `vendorRef` is stored trimmed, the delete is tenant-guarded, `imported` counts rows actually written (unchanged bills are skipped), writes are set-based batches of 500, and the cron gates BILL_REFS on the payment read only (not on BILLS).
  - "Display": state the search matches an Acumatica PO by substring, case-insensitively (as the bills' PO arm), via the same SQL fragment as the PO filter box; `listChecks` attaches `poNumbers` with one `AcumaticaBill` query per page and the PO sort one query over every matching cheque.
  - Add under "Out of scope": portal event bodies keep `CheckBill.poNumber` only.
- [ ] **Step 3: tsc** — `node node_modules/typescript/bin/tsc --noEmit` prints nothing. The CONTROLLER runs the full suite (`node node_modules/vitest/vitest.mjs run`, ~30–60 min, background) once the shared test database is free, and records the count in CLAUDE.md's State paragraph in the existing style.
- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-05-po-from-acumatica-design.md
git commit -m "docs: PO NUMBER from Acumatica (AcumaticaBill, BILL_REFS read); spec decisions written back" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand-off to the user (do not run).** In this order:
  1. **Production migration BEFORE the deploy** — `node scripts/migrate.mjs prod --confirm` (applies `20261005000100_acumatica_bill`). Deploying first makes every list, export and print page fail on a missing table.
  2. Deploy (`npx.cmd vercel --prod`).
  3. First PO read per tenant from a terminal, dry run first; re-run each until `errors` is 0 (a failed batch holds the watermark, and until a BILL_REFS watermark exists the cron records "no watermark" for that tenant each run and reads nothing):

```bash
npx.cmd tsx scripts/sync.ts GOLIVE --bill-refs --dry-run
npx.cmd tsx scripts/sync.ts GOLIVE --bill-refs
npx.cmd tsx scripts/sync.ts MANUFACTURING --bill-refs --dry-run
npx.cmd tsx scripts/sync.ts MANUFACTURING --bill-refs
```

  Expected order of magnitude (measured 2026-10-05): GOLIVE ~15,837 documents, most Bills, ~9,800 naming a PO; MANUFACTURING ~217, ~120 naming a PO. Then confirm on `/admin/sync` one BILL_REFS row per tenant with errors 0, and that the next scheduled run shows BILL_REFS `RAN` for both.
