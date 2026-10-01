# APV and PO on Every Cheque (Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every cheque the sync brings in carries the AP vouchers (APV) it pays, read from Acumatica's `AP-PAYMENTS-WITH-BILLS` at every scheduled run; and a PO NUMBER column sits beside APV in the list, the Excel export and the printed sheet.

**Architecture:** A pure mapper (`lib/integrations/acumatica/bills.ts`) turns an inquiry row into `{ paymentRef, voucher, lastModifiedOn }`. A runner (`lib/sync/bills.ts`) reads the inquiry incrementally per tenant with its own watermark — `SyncRun` rows with `mode = 'BILLS'` — and unions vouchers into `Check.apvNumbers`, matching on the payment's own reference (`Check.acumaticaPaymentId`), never on a cheque number. The cron route runs it after the payment syncs. PO is display-only: `CheckBill.poNumber` ∪ `Check.poNumbers`.

**Tech Stack:** Next.js 15 App Router, Prisma 6 on Neon, Vitest, TypeScript strict, ExcelJS.

Spec: `docs/superpowers/specs/2026-10-01-signing-schedule-apv-and-table-design.md`, part B. **This plan deviates from the spec in three places, all to be written back into the spec in Task 1:**
1. **Match by payment reference, not `judgeLink`.** The inquiry carries the payment's own reference (Go-Live `AdjgRefNbr`, MANUFACTURING `ReferenceNbr`), which is exactly `Check.acumaticaPaymentId` (unique). That is an exact join, so no cheque-number ambiguity and no "exactly one live cheque per voucher" judgement is needed: a voucher split across two cheques legitimately appears on both. `judgeLink` stays for the release-list script it was written for.
2. **No migration.** BILLS runs reuse `SyncRun`'s existing columns: `imported` = vouchers added, `updated` = cheques changed, `staged` = inquiry payments this system does not hold, `errors`.
3. **TODAY'S RELEASE is not touched.** It shows a count and totals, no per-cheque rows; there is nowhere to put a reference.

## Global Constraints

- Acumatica is read-only (rule 3): only `fetchAll`/`fetchPage` are used.
- Rule 4: an import never changes a cheque's status. The BILLS step writes only `apvNumbers` and audit rows.
- The BILLS step only ADDS vouchers. It never removes one and never replaces the array.
- Every changed cheque gets exactly one audit row (`voucher_linked_from_acumatica`), in the same transaction as the write.
- OData literal: `datetime'YYYY-MM-DDTHH:MM:SS'`, no zone (anything else is a 500). No `or` of `eq` filters (500 in Go-Live).
- Watermark = max `lastModifiedOn` seen − 120 minutes (`SYNC_OVERLAP_MINUTES`); null when nothing was read, so the previous one stands.
- A first BILLS read (no watermark) is a terminal job, never the cron: the cron records a refusal, as the payment sync does.
- Measured 2026-10-01, read-only: Go-Live 20,059 rows since 2026-01-01 (8.3 s), 613 since 24 Sep (5.7 s); MANUFACTURING 180 / 3. `AdjgDocType` values: CHK, VCK, PPM, ADR, REF. Bill-type values: `Bill`, `Debit Adj.`, `PPM`. Only `CHK` → `Bill` rows are links.
- Tests: `node node_modules/vitest/vitest.mjs run <files>` from Bash; only the files named. Type check `node node_modules/typescript/bin/tsc --noEmit` must print nothing.
- Never run scripts or the dev server: the repo `.env` is PRODUCTION. Stage files by path.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Change |
| --- | --- |
| `lib/integrations/acumatica/map.ts` | export `naiveDate` |
| `lib/integrations/acumatica/bills.ts` | new, pure: feed name, per-tenant columns, filters, `mapBillApplication` |
| `lib/sync/run.ts` | payment sync ignores `BILLS` rows (watermark, in-progress) |
| `lib/admin/sync-overview.ts` | payment read freshness ignores `BILLS` rows |
| `lib/sync/bills.ts` | new: `runBillsSync`, `lastBillsWatermark`, `runScheduledBillsSync` |
| `app/api/cron/sync/route.ts` | run BILLS for both tenants after the payment syncs |
| `scripts/sync.ts` | `--bills` for the first read |
| `app/admin/sync/page.tsx` | BILLS rows labelled |
| `lib/table-columns.ts`, `lib/queries.ts`, `components/CheckTable.tsx` | PO NUMBER column, PO search |
| `lib/export/workbook.ts`, `app/print/page.tsx` | APV + PO in the file and on paper |
| spec, `CLAUDE.md` | deviations, behaviour |

---

### Task 1: The pure mapper, and the spec written back

**Files:**
- Modify: `lib/integrations/acumatica/map.ts:108` (export `naiveDate`)
- Create: `lib/integrations/acumatica/bills.ts`
- Modify: `docs/superpowers/specs/2026-10-01-signing-schedule-apv-and-table-design.md` (part B)
- Test: `tests/integrations/acumatica-bills.test.ts` (new)

**Interfaces:**
- Produces: `BILLS_FEED = 'AP-PAYMENTS-WITH-BILLS'`; `BILL_FEED_COLUMNS: Record<AcumaticaTenant, { date: string; paymentRef: string; paymentType: string; billRef: string; billType: string }>`; `billsSinceFilter(tenant, since: Date): string`; `billsInScopeFilter(tenant): string`; `billFeedSelect(tenant): string[]`; `type BillApplication = { paymentRef: string; voucher: string; lastModifiedOn: Date | null }`; `mapBillApplication(raw: unknown, tenant): BillApplication | null`.

- [ ] **Step 1: Failing test** — create `tests/integrations/acumatica-bills.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  BILL_FEED_COLUMNS, billsSinceFilter, billsInScopeFilter, mapBillApplication,
} from '@/lib/integrations/acumatica/bills'

const golive = (o: Record<string, unknown> = {}) => ({
  AdjgDocType: 'CHK', AdjgRefNbr: 'CV-ST012345', AdjdDocType: 'Bill', AdjdRefNbr: 'ap-st042652 ',
  LastModifiedOn: '2026-09-29T08:15:00', ...o,
})
const mfg = (o: Record<string, unknown> = {}) => ({
  AdjgDocType: 'CHK', ReferenceNbr: 'CV-MF000123', DocumentType: 'Bill', ReferenceNbr_2: 'A1PP-AP-000014',
  APAdjust_lastModifiedDateTime: '2026-09-29T08:15:00', ...o,
})

describe('BILL_FEED_COLUMNS', () => {
  it('names each tenant’s own columns', () => {
    expect(BILL_FEED_COLUMNS.GOLIVE).toEqual({ date: 'LastModifiedOn', paymentRef: 'AdjgRefNbr', paymentType: 'AdjgDocType', billRef: 'AdjdRefNbr', billType: 'AdjdDocType' })
    expect(BILL_FEED_COLUMNS.MANUFACTURING).toEqual({ date: 'APAdjust_lastModifiedDateTime', paymentRef: 'ReferenceNbr', paymentType: 'AdjgDocType', billRef: 'ReferenceNbr_2', billType: 'DocumentType' })
  })
})

describe('filters', () => {
  it('uses the datetime literal on the tenant’s own date column, no zone', () => {
    const since = new Date('2026-09-29T06:15:00.000Z')
    expect(billsSinceFilter('GOLIVE', since)).toBe("LastModifiedOn ge datetime'2026-09-29T06:15:00'")
    expect(billsSinceFilter('MANUFACTURING', since)).toBe("APAdjust_lastModifiedDateTime ge datetime'2026-09-29T06:15:00'")
    expect(billsInScopeFilter('GOLIVE')).toBe("LastModifiedOn ge datetime'2026-01-01T00:00:00'")
  })
})

describe('mapBillApplication', () => {
  it('maps a cheque paying a bill, trimmed and upper-cased voucher', () => {
    expect(mapBillApplication(golive(), 'GOLIVE')).toEqual({
      paymentRef: 'CV-ST012345', voucher: 'AP-ST042652', lastModifiedOn: new Date('2026-09-29T08:15:00Z'),
    })
    expect(mapBillApplication(mfg(), 'MANUFACTURING')).toEqual({
      paymentRef: 'CV-MF000123', voucher: 'A1PP-AP-000014', lastModifiedOn: new Date('2026-09-29T08:15:00Z'),
    })
  })

  it('keeps only CHK paying a Bill', () => {
    for (const t of ['VCK', 'PPM', 'ADR', 'REF']) expect(mapBillApplication(golive({ AdjgDocType: t }), 'GOLIVE'), t).toBeNull()
    for (const t of ['Debit Adj.', 'PPM']) expect(mapBillApplication(golive({ AdjdDocType: t }), 'GOLIVE'), t).toBeNull()
  })

  it('refuses a row with no payment or no voucher', () => {
    expect(mapBillApplication(golive({ AdjgRefNbr: '  ' }), 'GOLIVE')).toBeNull()
    expect(mapBillApplication(golive({ AdjdRefNbr: null }), 'GOLIVE')).toBeNull()
    expect(mapBillApplication(null, 'GOLIVE')).toBeNull()
  })

  it('keeps a row whose date cannot be read, with a null date', () => {
    expect(mapBillApplication(golive({ LastModifiedOn: 'nonsense' }), 'GOLIVE')?.lastModifiedOn).toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/integrations/acumatica-bills.test.ts` → module not found.

- [ ] **Step 3: Implement** — in `lib/integrations/acumatica/map.ts` change `function naiveDate(` to `export function naiveDate(`. Create `lib/integrations/acumatica/bills.ts`:

```ts
import type { AcumaticaTenant } from './companies'
import { naiveDate } from './map'

/**
 * Which AP vouchers a cheque pays, read from Acumatica.
 *
 * `AP-Checks and Payments` — the feed every cheque comes from — publishes no
 * bill reference, so since the register was retired (2026-09-10) no cheque
 * generated here carried an APV. `AP-PAYMENTS-WITH-BILLS` joins a payment to
 * the documents it settles, one row per application.
 *
 * THE JOIN IS THE PAYMENT'S OWN REFERENCE (the CV number), which is
 * `Check.acumaticaPaymentId`. Exact, unique, and blind to cheque numbers, which
 * repeat across companies. A voucher paid by two cheques appears on both.
 *
 * Only `CHK` applied to a `Bill`. Measured 2026-10-01: the payment side also
 * carries VCK (the reversal of a voided cheque), PPM, ADR, REF; the bill side
 * `Debit Adj.` and `PPM`. None of those is "the voucher this cheque pays".
 *
 * The two tenants name the columns differently; filtering MANUFACTURING on a
 * Go-Live name is a 500. Pure.
 */

export const BILLS_FEED = 'AP-PAYMENTS-WITH-BILLS'

export const BILL_FEED_COLUMNS = {
  GOLIVE: { date: 'LastModifiedOn', paymentRef: 'AdjgRefNbr', paymentType: 'AdjgDocType', billRef: 'AdjdRefNbr', billType: 'AdjdDocType' },
  MANUFACTURING: { date: 'APAdjust_lastModifiedDateTime', paymentRef: 'ReferenceNbr', paymentType: 'AdjgDocType', billRef: 'ReferenceNbr_2', billType: 'DocumentType' },
} as const satisfies Record<AcumaticaTenant, Record<string, string>>

/** The same scope boundary as the payment sync (`SYNC_FROM_DATE` in lib/sync/run.ts). */
const IN_SCOPE_FROM = '2026-01-01T00:00:00'

const literal = (d: Date) => `datetime'${d.toISOString().slice(0, 19)}'`

export function billsSinceFilter(tenant: AcumaticaTenant, since: Date): string {
  return `${BILL_FEED_COLUMNS[tenant].date} ge ${literal(since)}`
}

export function billsInScopeFilter(tenant: AcumaticaTenant): string {
  return `${BILL_FEED_COLUMNS[tenant].date} ge datetime'${IN_SCOPE_FROM}'`
}

export function billFeedSelect(tenant: AcumaticaTenant): string[] {
  return Object.values(BILL_FEED_COLUMNS[tenant])
}

export type BillApplication = { paymentRef: string; voucher: string; lastModifiedOn: Date | null }

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function mapBillApplication(raw: unknown, tenant: AcumaticaTenant): BillApplication | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const c = BILL_FEED_COLUMNS[tenant]
  if (text(r[c.paymentType]) !== 'CHK' || text(r[c.billType]) !== 'Bill') return null
  const paymentRef = text(r[c.paymentRef])
  const voucher = text(r[c.billRef]).toUpperCase()
  if (!paymentRef || !voucher) return null
  return { paymentRef, voucher, lastModifiedOn: naiveDate(r[c.date], { dayOnly: false }) }
}
```

- [ ] **Step 4: Run, expect PASS; tsc clean.**

- [ ] **Step 5: Write the deviations into the spec.** In part B of the spec: replace B1's `judgeLink` bullet with the payment-reference join (deviation 1 above, verbatim reasoning); replace the "new SyncRun kind or column… migration required" bullet with deviation 2; in B3 delete the TODAY'S RELEASE bullet and add "TODAY'S RELEASE shows totals only, so it carries no references"; add the measured volumes and type values from Global Constraints to B1.

- [ ] **Step 6: Commit** — `git add lib/integrations/acumatica/map.ts lib/integrations/acumatica/bills.ts tests/integrations/acumatica-bills.test.ts docs/superpowers/specs/2026-10-01-signing-schedule-apv-and-table-design.md` — message `feat(acumatica): map AP-PAYMENTS-WITH-BILLS rows to cheque-voucher links`.

---

### Task 2: The BILLS run, and keeping it out of the payment sync's way

**Files:**
- Modify: `lib/sync/run.ts` (`assertNoRunInProgress`, `lastSyncWatermark`)
- Modify: `lib/admin/sync-overview.ts:85-86`
- Create: `lib/sync/bills.ts`
- Test: `tests/sync/bills.test.ts` (new), `tests/sync/run.test.ts` (+2), `tests/admin/sync-overview.test.ts` (+1; find the file with `grep -rln getSyncOverview tests`)

**Interfaces:**
- Consumes: Task 1 exports; `SYNC_OVERLAP_MINUTES`, `SyncTrigger` from `lib/sync/run.ts`; `writeAudit`.
- Produces: `BILLS_MODE = 'BILLS'`; `VOUCHER_LINKED_ACTION = 'voucher_linked_from_acumatica'`; `lastBillsWatermark(db, tenant): Promise<Date | null>`; `runBillsSync(db, { client, tenant, since: Date | null, now: Date, trigger: SyncTrigger }): Promise<BillsRunResult>` where `BillsRunResult = { syncRunId: string; tenant; fetched: number; ignored: number; vouchersAdded: number; chequesChanged: number; notHeld: number; errors: number; watermark: Date | null }`.

Rules for `runBillsSync`:
1. Refuse to start while a `BILLS` run for the tenant is unfinished and younger than `sync.inProgressMinutes` (read with `loadSettings`) — throw `SyncInProgressError` (exported from run.ts).
2. Create `SyncRun { mode: 'BILLS', tenant, startedAt: now, trigger }` before reading.
3. `fetchAll(BILLS_FEED, { select: billFeedSelect(tenant), filter: since ? billsSinceFilter(tenant, since) : billsInScopeFilter(tenant), orderby: \`${BILL_FEED_COLUMNS[tenant].date} asc\`, pageSize: 2000 })`. On a fetch error: finish with `errors = 1`, the message, watermark null; rethrow.
4. Map every row; `ignored` counts nulls. `maxSeen` over EVERY row's date column (read `naiveDate(raw[date])` for ignored rows too, so a run of VCK rows still advances the watermark).
5. Group by `paymentRef` → set of vouchers. One query: `check.findMany({ where: { acumaticaPaymentId: { in: refs } }, select: { id, acumaticaPaymentId } })` (chunk `in` lists at 1,000). A ref with no cheque → `notHeld++` (per ref).
6. Per held cheque, in its own transaction with `TX_OPTIONS` (`{ timeout: 30_000, maxWait: 15_000 }`): re-read `apvNumbers`; `missing = vouchers − current`; if empty, nothing; else `update({ apvNumbers: [...current, ...missing.sort()] })` and one audit row `{ checkId, actorType: 'SYSTEM', action: VOUCHER_LINKED_ACTION, details: { vouchers: missing, source: BILLS_FEED, tenant, paymentRef }, remarks: 'Acumatica (AP-PAYMENTS-WITH-BILLS) shows this cheque paying <list>.' }`. Count `vouchersAdded += missing.length`, `chequesChanged++`. A throw for one cheque: `errors++`, message kept, carry on.
7. Finish: `finishedAt: new Date()`, `imported = vouchersAdded`, `updated = chequesChanged`, `staged = notHeld`, `errors`, `watermark = maxSeen ? maxSeen − SYNC_OVERLAP_MINUTES : null`, `message` = first five distinct problems or null.

- [ ] **Step 1: Failing tests** — `tests/sync/bills.test.ts`, with a fake client like `tests/sync/run.test.ts:91` (read it) that records the filter it was given and returns given rows for `BILLS_FEED`. Cases (write each as an `it` with real DB rows via `makeCheck` + `testDb.check.update({ data: { acumaticaPaymentId } })`):
  - links two vouchers to the cheque whose `acumaticaPaymentId` matches; `apvNumbers` gains them sorted; one `voucher_linked_from_acumatica` row with `details.vouchers` both;
  - keeps vouchers already present (from the register) and never removes one: a cheque with `apvNumbers: ['AP-OLD']` and an incoming `AP-NEW` ends `['AP-OLD', 'AP-NEW']`; a second identical run writes nothing and no audit row;
  - never writes `status` (pending cheque stays pending) and creates no `PortalEvent`;
  - VCK / Debit Adj. rows are `ignored` and link nothing, but their date still advances the watermark;
  - a payment ref this system does not hold counts `notHeld` and writes nothing;
  - the run row: `mode 'BILLS'`, `imported/updated/staged/errors` as above, `watermark = max − 120 min`, `finishedAt` set;
  - incremental: with `since`, the filter passed is `billsSinceFilter(tenant, since)`; without, `billsInScopeFilter`;
  - a fetch failure leaves the run finished with `errors 1`, watermark null, and rethrows;
  - an unfinished BILLS run younger than the setting refuses with `SyncInProgressError`; an unfinished PAYMENT run does not block BILLS;
  - `lastBillsWatermark` returns the newest BILLS watermark and ignores payment runs.

  `tests/sync/run.test.ts` (+2): `lastSyncWatermark` ignores a newer `BILLS` row; an unfinished `BILLS` row does not make `runSync` refuse. Sync overview test (+1): a newer `BILLS` row is not reported as the tenant's last attempt.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** In `lib/sync/run.ts`: export `SyncInProgressError` (already exported — confirm); add `mode: { not: 'BILLS' }` to the `where` of `assertNoRunInProgress` and `lastSyncWatermark`, with a one-line comment each ("BILLS rows are the voucher read's, lib/sync/bills.ts; their watermark is on a different feed"). In `lib/admin/sync-overview.ts` add `mode: { not: 'BILLS' }` to both `findFirst` wheres (comment: the dashboard's ACUMATICA LAST READ is the payment feed). Then write `lib/sync/bills.ts` to the rules above, header comment stating: what it reads, the payment-reference join, add-only, never status (rule 4), never a portal event, first read is a terminal job.

- [ ] **Step 4: Run** `tests/sync/bills.test.ts tests/sync/run.test.ts` and the overview test → PASS; tsc clean.

- [ ] **Step 5: Commit** — `feat(sync): read AP-PAYMENTS-WITH-BILLS and union each cheque's vouchers, add-only`.

---

### Task 3: Scheduled, and from a terminal

**Files:**
- Modify: `lib/sync/bills.ts` (add `runScheduledBillsSync`)
- Modify: `app/api/cron/sync/route.ts`
- Modify: `scripts/sync.ts`
- Modify: `app/admin/sync/page.tsx`
- Test: `tests/sync/bills.test.ts` (+3), `tests/sync/cron-route.test.ts`

**Interfaces:**
- Produces: `NO_BILLS_WATERMARK_MESSAGE`; `runScheduledBillsSync(db, { tenant, now, client: () => AcumaticaClient }): Promise<ScheduledBillsOutcome>` — never throws; outcomes `RAN` (with the result counts) | `REFUSED_NO_WATERMARK` (records a finished BILLS row with `errors 1` and the message, like `runScheduledSync`) | `IN_PROGRESS` | `FAILED` (message capped at 300).

- [ ] **Step 1: Failing tests.** `tests/sync/bills.test.ts`: no watermark → `REFUSED_NO_WATERMARK` and a BILLS row with the message; a client factory that throws → `FAILED`, never a throw; with a watermark → `RAN` with counts. `tests/sync/cron-route.test.ts`: read the file; where it seeds payment watermarks for both tenants, also seed a BILLS watermark row (`mode: 'BILLS'`); add: the response JSON carries `bills` with one outcome per tenant in `SYNC_TENANTS` order; a BILLS `FAILED` turns the response 500; BILLS `REFUSED_NO_WATERMARK` does not. Keep every existing assertion exact — if one counts `SyncRun` rows, update its expected count rather than loosening it.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** `runScheduledBillsSync` mirrors `runScheduledSync` (lib/sync/scheduled.ts) line for line with `lastBillsWatermark` and `runBillsSync`. In the route, after the payment loop and before auto-sign:

```ts
  // The vouchers each cheque pays (lib/sync/bills.ts), after the payments so a
  // cheque first read this run is already here to be linked. Never status.
  const bills = []
  for (const tenant of SYNC_TENANTS) {
    bills.push(await runScheduledBillsSync(prisma, { tenant, now, client: () => createClientForTenant(tenant) }))
  }
```

add `bills.some((b) => b.outcome === 'FAILED')` to `failed`, and `bills` to the JSON body. Add a paragraph to the route's header comment.

`scripts/sync.ts`: a `--bills` flag. With it, the script uses `lastBillsWatermark` (or null with `--full`) and calls `runBillsSync` with `trigger: 'MANUAL'`, then prints `fetched, ignored, vouchersAdded, chequesChanged, notHeld, errors, watermark`. **Before the write (CLAUDE.md: snapshot before any bulk write to production)** it writes `snapshots/bills-<tenant>-<ISO timestamp with : and . replaced by ->.json` holding `{ takenAt, tenant, rows: [{ id, checkNumber, apvNumbers }] }` for every cheque with `acumaticaPaymentId` not null, and prints the path — the pattern in `scripts/link-vouchers-from-acumatica.ts`. `--dry-run --bills` reads the feed with the same filter, prints the row count, and writes nothing (no snapshot). Update the usage text at the top of the file.

`app/admin/sync/page.tsx`: in the runs table, for `r.mode === 'BILLS'` render the count cells with a title attribute / small caption "vouchers added · cheques · not held here" (read the table markup first; keep it one line).

- [ ] **Step 4: Run** `tests/sync/bills.test.ts tests/sync/cron-route.test.ts` → PASS; tsc clean.

- [ ] **Step 5: Commit** — `feat(cron): voucher read for both tenants at every run; scripts/sync.ts --bills`.

---

### Task 4: PO NUMBER beside APV — list, search, export, print

**Files:**
- Modify: `lib/table-columns.ts` (key, label, storage key)
- Modify: `lib/queries.ts` (`CheckTableRow.poNumbers`, `toTableRow`, search)
- Modify: `components/CheckTable.tsx`
- Modify: `lib/export/workbook.ts`
- Modify: `app/print/page.tsx`
- Test: `tests/table-columns.test.ts`, `tests/queries.test.ts`, the workbook test (`grep -rln REGISTER_HEADERS tests`), the print test if one exists

**Interfaces:**
- Produces: `ColumnKey` gains `'poNumbers'` (after `'apvNumbers'`), label `'PO NUMBER'`; `COLUMN_STORAGE_KEY = 'check-monitoring.columns.v2'`; `CheckTableRow.poNumbers: string[]`; `REGISTER_HEADERS` gains `'PO NUMBER'` after `'APV NUMBER'`.

- [ ] **Step 1: Failing tests.**
  - `tests/table-columns.test.ts`: `COLUMN_KEYS` has `poNumbers` right after `apvNumbers`; `COLUMN_LABELS.poNumbers === 'PO NUMBER'`; storage key is `.v2` (a v1 value is not read — say why in the test name: "a new column must appear for viewers who chose columns before it existed").
  - `tests/queries.test.ts`: `toTableRow` gives `poNumbers` = union of `Check.poNumbers` and the bills' non-null `poNumber`, deduplicated, sorted (create a cheque with `poNumbers: ['PO-2']` and a `CheckBill` with `poNumber: 'PO-1'` — read how other tests in the file create bills); searching `po-2` (lower case) finds it (exact match on the array, upper-cased); searching `PO-` does NOT (array elements are not substring-searchable — pin that, like the APV comment says).
  - workbook test: header row has `PO NUMBER` at column 3; a row's PO cell is the joined list; AMOUNT is now column 8 and still numeric.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `lib/table-columns.ts`: add `'poNumbers'` after `'apvNumbers'` in `COLUMN_KEYS`; label; bump the storage key to `v2` with a comment: "v2 (2026-10-01): PO NUMBER added. A v1 choice was a list of the columns that existed then, and read under v2 it would hide the new one for everybody who had ever ticked a box."
  - `lib/queries.ts`: `poNumbers: string[]` on `CheckTableRow`; in `toTableRow`: `poNumbers: [...new Set([...r.poNumbers, ...r.bills.map((b) => b.poNumber).filter((p): p is string => p !== null)])].sort()` with a comment mirroring the APV one; confirm `CheckRow` includes `poNumbers` (Prisma scalar — it does with `include`). In the search `OR`, beside the `apvNumbers: { has: … }` clause, add `{ poNumbers: { has: q.toUpperCase() } }` with a one-line comment pointing at the APV comment.
  - `components/CheckTable.tsx`: header `{shows('poNumbers') && <th …>{COLUMN_LABELS.poNumbers}</th>}` after APV, and the cell `{r.poNumbers.length ? r.poNumbers.join(', ') : '—'}` with the same classes as APV.
  - `lib/export/workbook.ts`: header after APV; `AMOUNT_COLUMN = 8`; write PO into cell 3 and shift cells 3–10 to 4–11. Grep the file and its tests for any other hard-coded column index and update it.
  - `app/print/page.tsx`: add `APV NUMBER` and `PO NUMBER` header cells after CHECK NUMBER and the two cells in each row (joined lists, `—` when empty). The print rows come from `listChecks` + the same row shape — if the page maps rows itself, map APV with the same union as `toTableRow` (prefer calling `toTableRow`).
- [ ] **Step 4: Run** the touched test files → PASS; tsc clean.
- [ ] **Step 5: Commit** — `feat(list): PO NUMBER beside APV in the list, search, Excel and print`.

---

### Task 5: Docs, full suite, first read handed to the user

**Files:** `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md.**
  - In "THIS SYSTEM IS THE RECORD", replace the sentence "**Until the sync reads that inquiry, every cheque generated since 9 September carries no voucher here.**" with: "**Since 2026-10-0X the scheduled run reads it** (`lib/sync/bills.ts`, `SyncRun.mode = 'BILLS'`): every `CHK` → `Bill` application is unioned into the paying cheque's `apvNumbers`, matched on the payment's own reference (`acumaticaPaymentId`), add-only, never status. The first read is `npx tsx scripts/sync.ts <TENANT> --bills` from a terminal."
  - Commands: add `npx tsx scripts/sync.ts GOLIVE --bills --dry-run` and `npx tsx scripts/sync.ts GOLIVE --bills` (and MANUFACTURING).
  - Data facts, the `apvNumbers` paragraph: "An empty incoming array — every Acumatica row, since the payments inquiry publishes no bill references —" add "; the vouchers arrive by the separate BILLS read instead".
  - Layout table: add `lib/sync/bills.ts` and `lib/integrations/acumatica/bills.ts`.
- [ ] **Step 2: Full suite** (Bash, `run_in_background: true`, only when the shared test database is free — ask the controller): `node node_modules/vitest/vitest.mjs run`. Expected 0 failures; record the count in the State paragraph in the existing style.
- [ ] **Step 3: Commit** — `docs: APV from Acumatica, PO column; suite count`.
- [ ] **Step 4: Hand-off to the user (do not run):** after deploying, run once from a terminal, dry run first:

```bash
npx.cmd tsx scripts/sync.ts GOLIVE --bills --dry-run
npx.cmd tsx scripts/sync.ts GOLIVE --bills
npx.cmd tsx scripts/sync.ts MANUFACTURING --bills
```

Until those run, the cron records "no watermark" for BILLS each run and links nothing.
