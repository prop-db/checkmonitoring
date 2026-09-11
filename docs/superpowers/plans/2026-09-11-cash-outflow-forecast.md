# Cash Outflow Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/forecast` page and its Excel extract showing every cheque written and not yet handed over, bucketed by the cheque's own date — the day from which it can be presented — and split by bank and by stage.

**Architecture:** Three pure modules carry every decision (`lib/forecast/buckets.ts` for the time buckets, `lib/forecast/matrix.ts` for the two matrices with centavo-exact totals, `lib/forecast-view.ts` for parameters and hrefs). One read (`lib/forecast/query.ts`) returns the population as rows; the matrices and the detail sheet are struck over that one list. An ExcelJS renderer on the shared `sheet-style.ts`, a route guarded like the other exports, and a server-rendered page guarded like `/vouchers`.

**Tech Stack:** Next 15 App Router server components and route handler · Prisma 6 query API · ExcelJS · `Intl.DateTimeFormat` for the Manila calendar day · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-cash-outflow-forecast-design.md`. Read it before Task 1.

## Global Constraints

- **`npx tsc --noEmit` must pass before any task is called done.** Vitest transpiles with esbuild, which erases types.
- **On Windows use `npx.cmd` / `npm.cmd`.**
- **Run ONLY the test files named in the task. Never the full suite.** Every test crosses the network to Neon; all files share one database that `resetDb()` truncates — never two test processes at once.
- **Amounts are decimal strings end to end, never a JS number.** Totals are summed in centavos with `toCentavos` / `fromCentavos` from `lib/export/report.ts`. The ONE place a number is written is an Excel cell, as `workbook.ts` documents.
- **Per currency, never summed across currencies.**
- **The population is live statuses only, `isCheque = true`, `isIncomplete = false`, `amount` not null.** Released, cancelled and voided cheques are out. The exclusion is stated on screen with its count.
- **The axis is the cheque date, framed as "presentable from", never "expected on".** The page's paragraph in the spec is the copy; do not soften or reword it.
- **"Today" is the Manila calendar day** (`Asia/Manila`, UTC+8, no daylight saving), computed once per request. Days are whole calendar days.
- **`middleware.ts` runs on Vercel.** The page calls `requireUser()` first; the route calls `getSessionUser()` first and answers 401, not a redirect. Neither path is public; nothing is added to `lib/public-paths.ts`.
- **No migration, no schema change, no write of any kind.**
- **Never write a raw control character into a source file.**
- **British spelling in prose.** Never commit or print `.env`, credentials or any `.xlsx`.
- **Commit messages end with:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/forecast/buckets.ts` | **Create.** Pure: the bucket list, the Manila day, `daysPresentable`, `bucketFor`. |
| `lib/forecast/query.ts` | **Create.** The one read of the population, with filters. Returns rows; decides nothing. |
| `lib/forecast/matrix.ts` | **Create.** Pure: rows → the two matrices, centavo-exact, per currency. |
| `lib/forecast-view.ts` | **Create.** Pure: parameter parsing, hrefs, the filter description, the filename. |
| `lib/export/forecast-workbook.ts` | **Create.** ExcelJS rendering of `SUMMARY` and `DETAIL`. |
| `app/api/export/forecast/route.ts` | **Create.** Guard, read, build, respond. |
| `components/ForecastMatrix.tsx` | **Create.** Server component drawing one matrix. |
| `app/forecast/page.tsx` | **Create.** Guard, params, read, render. |
| `components/AppHeader.tsx` | **Modify.** `FORECAST` link beside `VOUCHERS`. |
| `CLAUDE.md` | **Modify.** Item 10 becomes built; the Layout table gains `lib/forecast/`. |
| `tests/forecast/buckets.test.ts`, `tests/forecast/matrix.test.ts`, `tests/forecast-view.test.ts` | **Create.** Pure; no database. |
| `tests/forecast/query.test.ts`, `tests/export/forecast-workbook.test.ts`, `tests/export/forecast-route.test.ts` | **Create.** |

---

### Task 1: The buckets

**Files:**
- Create: `lib/forecast/buckets.ts`
- Test: `tests/forecast/buckets.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const BUCKETS: readonly ['OVER 90 DAYS','61–90 DAYS','31–60 DAYS','8–30 DAYS','1–7 DAYS','TODAY','THIS WEEK','NEXT WEEK','LATER','NO DATE']
  export type Bucket = (typeof BUCKETS)[number]
  export const MANILA = 'Asia/Manila'
  export function manilaDay(instant: Date): string            // 'YYYY-MM-DD'
  export function daysPresentable(checkDate: Date, today: Date): number   // positive = dated in the past
  export function bucketFor(checkDate: Date | null, today: Date): Bucket
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/forecast/buckets.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BUCKETS, bucketFor, daysPresentable, manilaDay } from '@/lib/forecast/buckets'

/**
 * Pure. The buckets are the report, so every edge is pinned with a literal.
 *
 * TODAY is Wednesday 16 September 2026, 10:00 Manila. A cheque "N days ago" is
 * dated at UTC midnight N days before the 16th — the way both ingestion paths
 * store a date — and a Manila reader must see it as that calendar day.
 */
const TODAY = new Date('2026-09-16T02:00:00Z')
const daysAgo = (n: number) => new Date(Date.UTC(2026, 8, 16 - n))

describe('manilaDay', () => {
  it('is the Manila calendar day, not the UTC one', () => {
    // 16:30 UTC on the 10th is 00:30 on the 11th in Manila.
    expect(manilaDay(new Date('2026-09-10T16:30:00Z'))).toBe('2026-09-11')
    expect(manilaDay(new Date('2026-09-11T00:00:00Z'))).toBe('2026-09-11')
  })
})

describe('daysPresentable', () => {
  it('counts whole calendar days, past positive, future negative', () => {
    expect(daysPresentable(daysAgo(0), TODAY)).toBe(0)
    expect(daysPresentable(daysAgo(7), TODAY)).toBe(7)
    expect(daysPresentable(daysAgo(-3), TODAY)).toBe(-3)
  })
})

describe('bucketFor — the past', () => {
  it.each([
    [0, 'TODAY'],
    [1, '1–7 DAYS'], [7, '1–7 DAYS'],
    [8, '8–30 DAYS'], [30, '8–30 DAYS'],
    [31, '31–60 DAYS'], [60, '31–60 DAYS'],
    [61, '61–90 DAYS'], [90, '61–90 DAYS'],
    [91, 'OVER 90 DAYS'], [400, 'OVER 90 DAYS'],
  ] as const)('%i days ago → %s', (n, bucket) => {
    expect(bucketFor(daysAgo(n), TODAY)).toBe(bucket)
  })
})

describe('bucketFor — the future', () => {
  // Wednesday: this week's Sunday is 4 days away.
  it('THIS WEEK runs up to and including Sunday', () => {
    expect(bucketFor(daysAgo(-1), TODAY)).toBe('THIS WEEK')
    expect(bucketFor(daysAgo(-4), TODAY)).toBe('THIS WEEK')
  })

  it('NEXT WEEK is the following Monday to Sunday', () => {
    expect(bucketFor(daysAgo(-5), TODAY)).toBe('NEXT WEEK')
    expect(bucketFor(daysAgo(-11), TODAY)).toBe('NEXT WEEK')
  })

  it('LATER is anything after that', () => {
    expect(bucketFor(daysAgo(-12), TODAY)).toBe('LATER')
  })

  it('on a Sunday, tomorrow is already NEXT WEEK', () => {
    const sunday = new Date('2026-09-13T02:00:00Z')
    expect(bucketFor(new Date(Date.UTC(2026, 8, 14)), sunday)).toBe('NEXT WEEK')
  })
})

describe('bucketFor — no date', () => {
  it('is its own bucket, never a time one', () => {
    expect(bucketFor(null, TODAY)).toBe('NO DATE')
  })
})

describe('BUCKETS', () => {
  it('runs oldest first and ends with NO DATE', () => {
    expect(BUCKETS[0]).toBe('OVER 90 DAYS')
    expect(BUCKETS[BUCKETS.length - 1]).toBe('NO DATE')
    expect(BUCKETS).toHaveLength(10)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/forecast/buckets.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/forecast/buckets"`.

- [ ] **Step 3: Write the module**

Create `lib/forecast/buckets.ts`:

```ts
/**
 * THE BUCKETS. How long a cheque has been presentable, or how soon it will be.
 *
 * The axis is the cheque's own date — the day from which it can be presented,
 * which is how Finance's own Cash Balance sheet treats an outstanding cheque.
 * No pickup or release date has ever been recorded in this system (measured
 * 2026-09-11: null on every row), so this is the one date every cheque has,
 * and it is read as PRESENTABLE FROM, never as EXPECTED ON.
 *
 * Pure. No clock: `today` is passed in, computed once per request by the
 * caller, so a page and its export struck in the same request agree about
 * which day it is.
 */

export const BUCKETS = [
  'OVER 90 DAYS', '61–90 DAYS', '31–60 DAYS', '8–30 DAYS', '1–7 DAYS',
  'TODAY', 'THIS WEEK', 'NEXT WEEK', 'LATER', 'NO DATE',
] as const
export type Bucket = (typeof BUCKETS)[number]

/**
 * The Philippines has kept a single offset, UTC+8, with no daylight saving
 * since 1977. Vercel runs in UTC, so a "day" must be named explicitly or a
 * cheque dated the 11th reads as the 10th between midnight and 8 a.m.
 */
export const MANILA = 'Asia/Manila'

const DAY_MS = 24 * 60 * 60 * 1000

// `en-CA` is the locale whose default date format is ISO 8601 — YYYY-MM-DD —
// which is the only reason it is used here.
const manilaFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MANILA, year: 'numeric', month: '2-digit', day: '2-digit',
})

/** The Manila calendar day of an instant, as `YYYY-MM-DD`. */
export function manilaDay(instant: Date): string {
  return manilaFormatter.format(instant)
}

/** A `YYYY-MM-DD` as a UTC-midnight instant, so two days can be subtracted. */
function dayInstant(day: string): number {
  return Date.parse(`${day}T00:00:00Z`)
}

/**
 * Whole calendar days from the cheque's date to today, in Manila. Positive
 * means the cheque is dated in the past — presentable for that many days.
 * Both instants are reduced to their Manila day first, so a cheque stored as
 * UTC midnight and one stored as Manila midnight land on the same day.
 */
export function daysPresentable(checkDate: Date, today: Date): number {
  return Math.round((dayInstant(manilaDay(today)) - dayInstant(manilaDay(checkDate))) / DAY_MS)
}

/** Days until this week's Sunday, from a Manila day. 0 on a Sunday. */
function daysUntilSunday(today: Date): number {
  const dow = new Date(dayInstant(manilaDay(today))).getUTCDay() // 0 = Sunday
  return (7 - dow) % 7
}

export function bucketFor(checkDate: Date | null, today: Date): Bucket {
  if (checkDate === null) return 'NO DATE'
  const d = daysPresentable(checkDate, today)
  // The past: the ageing buckets Finance already uses on AP Local, with the
  // first split at a week. Upper edges inclusive.
  if (d > 90) return 'OVER 90 DAYS'
  if (d >= 61) return '61–90 DAYS'
  if (d >= 31) return '31–60 DAYS'
  if (d >= 8) return '8–30 DAYS'
  if (d >= 1) return '1–7 DAYS'
  if (d === 0) return 'TODAY'
  // The future: to Sunday, the week after, then everything else. On a Sunday
  // "this week" has no days left and tomorrow is already next week.
  const ahead = -d
  const toSunday = daysUntilSunday(today)
  if (ahead <= toSunday) return 'THIS WEEK'
  if (ahead <= toSunday + 7) return 'NEXT WEEK'
  return 'LATER'
}
```

- [ ] **Step 4: Run the test and the type-checker**

```bash
npx.cmd vitest run tests/forecast/buckets.test.ts
```

Expected: PASS, 19 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/forecast/buckets.ts tests/forecast/buckets.test.ts
git commit -m "feat: how long a cheque has been presentable, in Finance's own buckets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The read

**Files:**
- Create: `lib/forecast/query.ts`
- Test: `tests/forecast/query.test.ts`

**Interfaces:**
- Consumes: `LIVE_STATUSES` from `lib/domain/check-status.ts`.
- Produces:
  ```ts
  export type ForecastFilters = { bankCode?: string; companyId?: string; stage?: CheckStatus }
  export type ForecastRow = {
    id: string; checkNumber: string; payee: string | null; bank: string | null; company: string
    stage: CheckStatus; currency: string; amount: string; checkDate: Date | null
  }
  export function listForecastRows(db: Db, filters?: ForecastFilters): Promise<ForecastRow[]>
  export function listBankCodes(db: Db): Promise<string[]>
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/forecast/query.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listForecastRows, listBankCodes } from '@/lib/forecast/query'

beforeEach(resetDb)

/**
 * The population rule is the whole meaning of the report: what is written and
 * not yet handed over. Each exclusion is pinned by a row that would be counted
 * if the rule slipped.
 */
describe('listForecastRows — the population', () => {
  it('holds every live status and nothing closed', async () => {
    await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '1' })
    await makeCheck({ status: 'SIGNED', checkNumber: '2' })
    await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '3' })
    await makeCheck({ status: 'SCHEDULED', checkNumber: '4' })
    await makeCheck({ status: 'RELEASED', checkNumber: '5' })
    await makeCheck({ status: 'CANCELLED', checkNumber: '6' })
    await makeCheck({ status: 'VOIDED', checkNumber: '7' })
    const rows = await listForecastRows(testDb)
    expect(rows.map((r) => r.checkNumber).sort()).toEqual(['1', '2', '3', '4'])
  })

  it('leaves out a cheque with no recorded amount', async () => {
    await makeCheck({ status: 'SIGNED', amount: null })
    expect(await listForecastRows(testDb)).toHaveLength(0)
  })

  it('leaves out a payment that is not a cheque', async () => {
    await makeCheck({ status: 'SIGNED', isCheque: false })
    expect(await listForecastRows(testDb)).toHaveLength(0)
  })

  it('carries the amount as a decimal string and the bank from the cash account', async () => {
    const check = await makeCheck({ status: 'SIGNED', amount: '1234.50' })
    const account = await testDb.cashAccount.findUniqueOrThrow({
      where: { id: check.cashAccountId! }, include: { bank: true },
    })
    const [row] = await listForecastRows(testDb)
    expect(row.amount).toBe('1234.50')
    expect(typeof row.amount).toBe('string')
    expect(row.bank).toBe(account.bank.code)
    expect(row.stage).toBe('SIGNED')
  })

  it('orders oldest cheque date first, undated last', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: 'B', checkDate: new Date('2026-08-01') })
    await makeCheck({ status: 'SIGNED', checkNumber: 'C', checkDate: null })
    await makeCheck({ status: 'SIGNED', checkNumber: 'A', checkDate: new Date('2026-07-01') })
    const rows = await listForecastRows(testDb)
    expect(rows.map((r) => r.checkNumber)).toEqual(['A', 'B', 'C'])
  })
})

describe('listForecastRows — the filters', () => {
  it('narrows by stage', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '1' })
    await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '2' })
    const rows = await listForecastRows(testDb, { stage: 'READY_FOR_RELEASE' })
    expect(rows.map((r) => r.checkNumber)).toEqual(['2'])
  })

  it('narrows by company', async () => {
    const keep = await makeCheck({ status: 'SIGNED', checkNumber: '1' })
    await makeCheck({ status: 'SIGNED', checkNumber: '2' })
    const rows = await listForecastRows(testDb, { companyId: keep.companyId })
    expect(rows.map((r) => r.checkNumber)).toEqual(['1'])
  })

  it('narrows by bank, whichever of checkbook or cash account names it', async () => {
    const keep = await makeCheck({ status: 'SIGNED', checkNumber: '1' })
    await makeCheck({ status: 'SIGNED', checkNumber: '2' })
    const account = await testDb.cashAccount.findUniqueOrThrow({
      where: { id: keep.cashAccountId! }, include: { bank: true },
    })
    const rows = await listForecastRows(testDb, { bankCode: account.bank.code })
    expect(rows.map((r) => r.checkNumber)).toEqual(['1'])
  })

  it('prefers the checkbook bank when a cheque has both', async () => {
    const check = await makeCheck({ status: 'SIGNED' })
    const bank = await testDb.bank.create({ data: { code: 'MBTC-X', name: 'Metrobank' } })
    const book = await testDb.checkBook.create({
      data: { code: 'MBTC-S-0001', bankId: bank.id, companyId: check.companyId },
    })
    await testDb.check.update({ where: { id: check.id }, data: { checkBookId: book.id } })
    const [row] = await listForecastRows(testDb)
    expect(row.bank).toBe('MBTC-X')
    expect(await listForecastRows(testDb, { bankCode: 'MBTC-X' })).toHaveLength(1)
  })
})

describe('listBankCodes', () => {
  it('lists every bank, sorted', async () => {
    await testDb.bank.create({ data: { code: 'MBTC', name: 'Metrobank' } })
    await testDb.bank.create({ data: { code: 'BPI', name: 'BPI' } })
    expect(await listBankCodes(testDb)).toEqual(['BPI', 'MBTC'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/forecast/query.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/forecast/query"`.

- [ ] **Step 3: Write the read**

Create `lib/forecast/query.ts`:

```ts
import type { CheckStatus, Prisma, PrismaClient } from '@prisma/client'
import { LIVE_STATUSES } from '@/lib/domain/check-status'

type Db = PrismaClient | Prisma.TransactionClient

export type ForecastFilters = {
  /** A `Bank.code`. Matched against the checkbook's bank, else the cash account's. */
  bankCode?: string
  companyId?: string
  stage?: CheckStatus
}

/** One cheque of the population. `amount` is a decimal STRING — rule 8. */
export type ForecastRow = {
  id: string
  checkNumber: string
  payee: string | null
  bank: string | null
  company: string
  stage: CheckStatus
  currency: string
  amount: string
  checkDate: Date | null
}

/**
 * THE POPULATION: written, and not yet handed over.
 *
 * Live statuses only — a released cheque has left the counter, and with
 * clearing never recorded (measured 2026-09-11: `clearingStatus = NONE` on all
 * 9,594) its fate is unknowable here; a cancelled or voided one will never
 * leave. Real cheques only: a DEBIT ADV or CASH payment has no paper to
 * present. And only cheques with a recorded amount, consistent with every
 * other output since the ruling of 2026-09-06 — the page states the exclusion
 * and its count.
 *
 * `amount: { not: null }` is stated as well as `isIncomplete: false`, because
 * `isIncomplete` is a stored derivation of the former and a rule about money
 * reads the fact, not the cache of it — the same reason `checkDeletable` does.
 *
 * Returned as rows, not groups: the two matrices and the DETAIL sheet are all
 * struck over this one list in the pure layer, so they cannot disagree.
 */
export async function listForecastRows(db: Db, filters: ForecastFilters = {}): Promise<ForecastRow[]> {
  const where: Prisma.CheckWhereInput = {
    status: filters.stage ? filters.stage : { in: [...LIVE_STATUSES] },
    isCheque: true,
    isIncomplete: false,
    amount: { not: null },
  }
  if (filters.companyId) where.companyId = filters.companyId
  if (filters.bankCode) {
    // The bank a cheque draws on is the checkbook's when it has one — 9,072
    // cheques do — and the cash account's for the 1,342 that carry only that.
    // The filter says the same thing in Prisma's grammar: a checkbook bank
    // that matches, or no checkbook at all and a cash-account bank that does.
    where.OR = [
      { checkBook: { bank: { code: filters.bankCode } } },
      { checkBookId: null, cashAccount: { bank: { code: filters.bankCode } } },
    ]
  }

  const checks = await db.check.findMany({
    where,
    orderBy: [{ checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: {
      id: true, checkNumber: true, payeeName: true, currency: true, amount: true,
      checkDate: true, status: true,
      company: { select: { code: true } },
      checkBook: { select: { bank: { select: { code: true } } } },
      cashAccount: { select: { bank: { select: { code: true } } } },
      vendor: { select: { canonicalName: true } },
    },
  })

  return checks.flatMap((c) => {
    // Guarded above by the where clause; narrowed here for the type, never
    // defaulted — a cheque with no amount is not worth 0.00.
    if (c.amount === null) return []
    return [{
      id: c.id,
      checkNumber: c.checkNumber,
      payee: c.payeeName ?? c.vendor?.canonicalName ?? null,
      bank: c.checkBook?.bank.code ?? c.cashAccount?.bank.code ?? null,
      company: c.company.code,
      stage: c.status,
      currency: c.currency,
      amount: c.amount.toString(),
      checkDate: c.checkDate,
    }]
  })
}

/** Every bank, for the filter's dropdown. Never hard-coded: a new bank appears without a code change. */
export async function listBankCodes(db: Db): Promise<string[]> {
  const banks = await db.bank.findMany({ orderBy: { code: 'asc' }, select: { code: true } })
  return banks.map((b) => b.code)
}
```

- [ ] **Step 4: Run the test file and the type-checker**

```bash
npx.cmd vitest run tests/forecast/query.test.ts
```

Expected: PASS, 10 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/forecast/query.ts tests/forecast/query.test.ts
git commit -m "feat: read the cheques that are written and not yet handed over

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The matrices and the view module — both pure

**Files:**
- Create: `lib/forecast/matrix.ts`, `lib/forecast-view.ts`
- Test: `tests/forecast/matrix.test.ts`, `tests/forecast-view.test.ts`

**Interfaces:**
- Consumes: `Bucket`, `BUCKETS`, `bucketFor`, `daysPresentable` (Task 1); `ForecastRow` (Task 2); `LIVE_STATUSES`; `statusWords`, `toCentavos`, `fromCentavos` from `lib/export/report.ts`.
- Produces, from `lib/forecast/matrix.ts`:
  ```ts
  export const NO_BANK = '(NO BANK)'
  export type Cell = { count: number; totals: { currency: string; total: string }[] }   // totals sorted by currency
  export type MatrixRow = { bucket: Bucket; cells: Record<string, Cell>; total: Cell }
  export type Matrix = { columns: string[]; rows: MatrixRow[]; total: MatrixRow }        // total.bucket is 'NO DATE' placeholder — see code
  export type BucketedRow = ForecastRow & { bucket: Bucket; days: number | null }
  export function buildMatrices(rows: readonly ForecastRow[], today: Date): { byBank: Matrix; byStage: Matrix; bucketed: BucketedRow[] }
  ```
- Produces, from `lib/forecast-view.ts`:
  ```ts
  export const FORECAST_PATH = '/forecast'
  export const FORECAST_EXPORT_PATH = '/api/export/forecast'
  export const STAGE_OPTIONS: readonly { value: CheckStatus; label: string }[]
  export type ForecastParams = { bank?: string; company?: string; stage?: string }
  export function parseStageParam(value: string | undefined): CheckStatus | undefined
  export function forecastHref(params: ForecastParams, path?: string): string
  export function describeForecastFilters(f: { bank?: string | null; company?: string | null; stage?: CheckStatus | null }): string
  export function forecastFilename(generatedAt: Date): string
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/forecast/matrix.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildMatrices, NO_BANK } from '@/lib/forecast/matrix'
import type { ForecastRow } from '@/lib/forecast/query'

const TODAY = new Date('2026-09-16T02:00:00Z')
const daysAgo = (n: number) => new Date(Date.UTC(2026, 8, 16 - n))

function row(o: Partial<ForecastRow> & { id: string }): ForecastRow {
  return {
    checkNumber: o.id, payee: 'HENKEL PHILIPPINES INC.', bank: 'BPI', company: 'STK',
    stage: 'SIGNED', currency: 'PHP', amount: '100.00', checkDate: daysAgo(3),
    ...o,
  }
}

describe('buildMatrices', () => {
  it('adds in centavos, never in floats', () => {
    const { byBank } = buildMatrices([
      row({ id: 'a', amount: '0.10' }), row({ id: 'b', amount: '0.20' }),
    ], TODAY)
    const cell = byBank.rows.find((r) => r.bucket === '1–7 DAYS')!.cells.BPI
    expect(cell.count).toBe(2)
    expect(cell.totals).toEqual([{ currency: 'PHP', total: '0.30' }])
  })

  it('never sums two currencies together', () => {
    const { byBank } = buildMatrices([
      row({ id: 'a', amount: '100.00', currency: 'PHP' }),
      row({ id: 'b', amount: '5.00', currency: 'USD' }),
    ], TODAY)
    const cell = byBank.rows.find((r) => r.bucket === '1–7 DAYS')!.cells.BPI
    expect(cell.count).toBe(2)
    expect(cell.totals).toEqual([{ currency: 'PHP', total: '100.00' }, { currency: 'USD', total: '5.00' }])
  })

  it('has a column per bank present, NO BANK last, and an empty cell where a bank has nothing in a bucket', () => {
    const { byBank } = buildMatrices([
      row({ id: 'a', bank: 'MBTC' }),
      row({ id: 'b', bank: null, checkDate: daysAgo(40) }),
      row({ id: 'c', bank: 'BPI', checkDate: daysAgo(40) }),
    ], TODAY)
    expect(byBank.columns).toEqual(['BPI', 'MBTC', NO_BANK])
    const week = byBank.rows.find((r) => r.bucket === '1–7 DAYS')!
    expect(week.cells.BPI).toEqual({ count: 0, totals: [] })
    expect(week.cells.MBTC.count).toBe(1)
    const month = byBank.rows.find((r) => r.bucket === '31–60 DAYS')!
    expect(month.cells[NO_BANK].count).toBe(1)
    expect(month.total.count).toBe(2)
  })

  it('carries every bucket row, in order, even when empty', () => {
    const { byBank } = buildMatrices([row({ id: 'a' })], TODAY)
    expect(byBank.rows.map((r) => r.bucket)[0]).toBe('OVER 90 DAYS')
    expect(byBank.rows).toHaveLength(10)
  })

  it('totals the column and the grand total', () => {
    const { byBank } = buildMatrices([
      row({ id: 'a', amount: '1.00' }), row({ id: 'b', amount: '2.00', checkDate: daysAgo(100) }),
    ], TODAY)
    expect(byBank.total.cells.BPI).toEqual({ count: 2, totals: [{ currency: 'PHP', total: '3.00' }] })
    expect(byBank.total.total).toEqual({ count: 2, totals: [{ currency: 'PHP', total: '3.00' }] })
  })

  it('splits by stage in ladder order, only the stages present', () => {
    const { byStage } = buildMatrices([
      row({ id: 'a', stage: 'READY_FOR_RELEASE' }), row({ id: 'b', stage: 'SIGNATURE_PENDING' }),
    ], TODAY)
    expect(byStage.columns).toEqual(['SIGNATURE PENDING', 'READY FOR RELEASE'])
  })

  it('returns every row bucketed, with its days, for the detail sheet', () => {
    const { bucketed } = buildMatrices([row({ id: 'a', checkDate: daysAgo(45) }), row({ id: 'b', checkDate: null })], TODAY)
    expect(bucketed.map((r) => [r.bucket, r.days])).toEqual([['31–60 DAYS', 45], ['NO DATE', null]])
  })
})
```

Create `tests/forecast-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  FORECAST_PATH, FORECAST_EXPORT_PATH, STAGE_OPTIONS,
  parseStageParam, forecastHref, describeForecastFilters, forecastFilename,
} from '@/lib/forecast-view'

describe('STAGE_OPTIONS', () => {
  it('offers the live statuses as words, in ladder order', () => {
    expect(STAGE_OPTIONS.map((o) => o.value)).toEqual(['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'])
    expect(STAGE_OPTIONS.find((o) => o.value === 'READY_FOR_RELEASE')!.label).toBe('READY FOR RELEASE')
  })
})

describe('parseStageParam', () => {
  it('accepts a live status in either spelling and answers the enum', () => {
    expect(parseStageParam('READY_FOR_RELEASE')).toBe('READY_FOR_RELEASE')
    expect(parseStageParam('ready for release')).toBe('READY_FOR_RELEASE')
  })

  it('refuses a closed status and nonsense', () => {
    expect(parseStageParam('RELEASED')).toBeUndefined()
    expect(parseStageParam('DELIVERED')).toBeUndefined()
    expect(parseStageParam(undefined)).toBeUndefined()
  })
})

describe('forecastHref', () => {
  it('is the bare path with nothing set', () => {
    expect(forecastHref({})).toBe(FORECAST_PATH)
  })

  it('carries the filters, drops empties, and can point at the export', () => {
    expect(forecastHref({ bank: 'BPI', company: '', stage: 'SIGNED' })).toBe('/forecast?bank=BPI&stage=SIGNED')
    expect(forecastHref({ bank: 'BPI' }, FORECAST_EXPORT_PATH)).toBe('/api/export/forecast?bank=BPI')
  })
})

describe('describeForecastFilters', () => {
  it('names each filter in force', () => {
    expect(describeForecastFilters({ bank: 'BPI', company: 'STK', stage: 'SIGNED' }))
      .toBe('BANK: BPI  ·  COMPANY: STK  ·  STAGE: SIGNED')
  })

  it('says so when there are none', () => {
    expect(describeForecastFilters({})).toBe('No filters applied')
  })
})

describe('forecastFilename', () => {
  it('is dated in local time', () => {
    expect(forecastFilename(new Date(2026, 8, 11, 8, 0))).toBe('cash-outflow-2026-09-11.xlsx')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx.cmd vitest run tests/forecast/matrix.test.ts tests/forecast-view.test.ts
```

Expected: FAIL on both unresolved imports.

- [ ] **Step 3: Write the two modules**

Create `lib/forecast/matrix.ts`:

```ts
import type { CheckStatus } from '@prisma/client'
import { LIVE_STATUSES } from '@/lib/domain/check-status'
import { statusWords, toCentavos, fromCentavos } from '@/lib/export/report'
import { BUCKETS, bucketFor, daysPresentable, type Bucket } from './buckets'
import type { ForecastRow } from './query'

/**
 * THE TWO MATRICES, struck over one list of rows.
 *
 * Pure. Every total is a decimal string summed in centavos and handed back as
 * a decimal string (rule 8); every cell keeps its currencies apart, because a
 * PHP amount added to a USD amount is a number with no meaning. The same
 * discipline as `totalsByCurrency` in lib/export/report.ts.
 */

/** A cheque with neither a checkbook nor a cash account. Shown, never dropped: it is still money. */
export const NO_BANK = '(NO BANK)'

export type Cell = { count: number; totals: { currency: string; total: string }[] }
export type MatrixRow = { bucket: Bucket; cells: Record<string, Cell>; total: Cell }
export type Matrix = {
  columns: string[]
  rows: MatrixRow[]
  /** The column totals. Its `bucket` is meaningless and set to 'NO DATE' only to satisfy the type. */
  total: MatrixRow
}
export type BucketedRow = ForecastRow & { bucket: Bucket; days: number | null }

type Acc = { count: number; cents: Map<string, bigint> }
const acc = (): Acc => ({ count: 0, cents: new Map() })
function add(a: Acc, currency: string, amount: string): void {
  a.count += 1
  a.cents.set(currency, (a.cents.get(currency) ?? 0n) + toCentavos(amount))
}
function seal(a: Acc): Cell {
  return {
    count: a.count,
    totals: [...a.cents.entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([currency, cents]) => ({ currency, total: fromCentavos(cents) })),
  }
}

function matrix(rows: readonly BucketedRow[], columns: string[], columnOf: (r: BucketedRow) => string): Matrix {
  const grid = new Map<Bucket, Map<string, Acc>>()
  const rowTotals = new Map<Bucket, Acc>()
  const colTotals = new Map<string, Acc>()
  const grand = acc()
  for (const b of BUCKETS) {
    grid.set(b, new Map(columns.map((c) => [c, acc()])))
    rowTotals.set(b, acc())
  }
  for (const c of columns) colTotals.set(c, acc())

  for (const r of rows) {
    const col = columnOf(r)
    add(grid.get(r.bucket)!.get(col)!, r.currency, r.amount)
    add(rowTotals.get(r.bucket)!, r.currency, r.amount)
    add(colTotals.get(col)!, r.currency, r.amount)
    add(grand, r.currency, r.amount)
  }

  const cellsOf = (m: Map<string, Acc>) => Object.fromEntries(columns.map((c) => [c, seal(m.get(c)!)]))
  return {
    columns,
    rows: BUCKETS.map((bucket) => ({ bucket, cells: cellsOf(grid.get(bucket)!), total: seal(rowTotals.get(bucket)!) })),
    total: { bucket: 'NO DATE', cells: cellsOf(colTotals), total: seal(grand) },
  }
}

export function buildMatrices(
  rows: readonly ForecastRow[],
  today: Date,
): { byBank: Matrix; byStage: Matrix; bucketed: BucketedRow[] } {
  const bucketed: BucketedRow[] = rows.map((r) => ({
    ...r,
    bucket: bucketFor(r.checkDate, today),
    days: r.checkDate ? daysPresentable(r.checkDate, today) : null,
  }))

  // Banks: whichever appear, sorted, NO BANK last. Never a hard-coded list —
  // a third bank appears on the report the day its first cheque does.
  const banks = [...new Set(bucketed.map((r) => r.bank ?? NO_BANK))]
    .sort((a, b) => (a === NO_BANK ? 1 : b === NO_BANK ? -1 : a.localeCompare(b)))

  // Stages: ladder order, only those present, spelled as words.
  const present = new Set<CheckStatus>(bucketed.map((r) => r.stage))
  const stages = LIVE_STATUSES.filter((s) => present.has(s)).map(statusWords)

  return {
    byBank: matrix(bucketed, banks, (r) => r.bank ?? NO_BANK),
    byStage: matrix(bucketed, stages, (r) => statusWords(r.stage)),
    bucketed,
  }
}
```

Create `lib/forecast-view.ts`:

```ts
import type { CheckStatus } from '@prisma/client'
import { LIVE_STATUSES } from './domain/check-status'
import { statusWords, slugify } from './export/report'

/**
 * The forecast screen's arithmetic — parameters, hrefs, the filter line and
 * the filename. Pure, for the same reason `vouchers-view.ts` and
 * `dashboard-view.ts` are: the page reads these and decides nothing itself.
 */

export const FORECAST_PATH = '/forecast'
export const FORECAST_EXPORT_PATH = '/api/export/forecast'

/** The STAGE select: the live statuses, ladder order, as words. Read from the ladder, not restated. */
export const STAGE_OPTIONS: readonly { value: CheckStatus; label: string }[] =
  LIVE_STATUSES.map((s) => ({ value: s, label: statusWords(s) }))

export type ForecastParams = { bank?: string; company?: string; stage?: string }

/**
 * `?stage=` as the screen reads it: words or underscores, any case, LIVE only.
 * A closed status is refused rather than honoured — the population is what is
 * not yet handed over, and a filter to RELEASED would show an empty table that
 * looks like a broken one.
 */
export function parseStageParam(value: string | undefined): CheckStatus | undefined {
  if (!value) return undefined
  const key = value.trim().toUpperCase().replace(/ /g, '_')
  return (LIVE_STATUSES as readonly string[]).includes(key) ? (key as CheckStatus) : undefined
}

/** The URL a filled-in form means. Empty controls are dropped, as everywhere else. */
export function forecastHref(params: ForecastParams, path: string = FORECAST_PATH): string {
  const qs = new URLSearchParams()
  for (const key of ['bank', 'company', 'stage'] as const) {
    const v = params[key]?.trim()
    if (v) qs.set(key, v)
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

/** The filters in force, in words, for the page and the workbook's title block. */
export function describeForecastFilters(
  f: { bank?: string | null; company?: string | null; stage?: CheckStatus | null },
): string {
  const parts: string[] = []
  if (f.bank) parts.push(`BANK: ${f.bank}`)
  if (f.company) parts.push(`COMPANY: ${f.company}`)
  if (f.stage) parts.push(`STAGE: ${statusWords(f.stage)}`)
  return parts.length ? parts.join('  ·  ') : 'No filters applied'
}

/** `cash-outflow-2026-09-11.xlsx`, dated in LOCAL time like the register export. */
export function forecastFilename(generatedAt: Date): string {
  const y = generatedAt.getFullYear()
  const m = String(generatedAt.getMonth() + 1).padStart(2, '0')
  const d = String(generatedAt.getDate()).padStart(2, '0')
  return `${slugify('cash outflow')}-${y}-${m}-${d}.xlsx`
}
```

- [ ] **Step 4: Run the two test files and the type-checker**

```bash
npx.cmd vitest run tests/forecast/matrix.test.ts tests/forecast-view.test.ts
```

Expected: PASS — 7 and 8.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/forecast/matrix.ts lib/forecast-view.ts tests/forecast/matrix.test.ts tests/forecast-view.test.ts
git commit -m "feat: the forecast's two matrices and its parameters, pure

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The workbook and the route

**Files:**
- Create: `lib/export/forecast-workbook.ts`, `app/api/export/forecast/route.ts`
- Test: `tests/export/forecast-workbook.test.ts`, `tests/export/forecast-route.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `sheet-style.ts` (`HEADER_FILL`, `BAND_FILL`, `DATE_FORMAT`, `COUNT_FORMAT`, `DATE_WIDTH_SAMPLE`, `styleHeaderCell`); `currencyNumberFormat`, `fitColumnWidth`, `EXPORT_ROW_LIMIT`, `statusWords` from `lib/export/report.ts`; `getFilterOptions` from `lib/queries.ts`; `getSessionUser`, `prisma`.
- Produces:
  ```ts
  export const SUMMARY_SHEET = 'SUMMARY'; export const DETAIL_SHEET = 'DETAIL'
  export const DETAIL_HEADERS = ['CHECK NUMBER','PAYEE','BANK','COMPANY','STAGE','CHECK DATE','DAYS PRESENTABLE','BUCKET','CURRENCY','AMOUNT'] as const
  export type ForecastMeta = { generatedAt: Date; generatedBy: string; filterDescription: string; totalRows: number; incompleteCount: number }
  export function buildForecastWorkbook(input: { byBank: Matrix; byStage: Matrix; detail: readonly BucketedRow[]; meta: ForecastMeta }): Promise<ArrayBuffer>
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/export/forecast-workbook.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildMatrices } from '@/lib/forecast/matrix'
import type { ForecastRow } from '@/lib/forecast/query'
import {
  buildForecastWorkbook, SUMMARY_SHEET, DETAIL_SHEET, DETAIL_HEADERS,
} from '@/lib/export/forecast-workbook'

const TODAY = new Date('2026-09-16T02:00:00Z')
const daysAgo = (n: number) => new Date(Date.UTC(2026, 8, 16 - n))

function row(o: Partial<ForecastRow> & { id: string }): ForecastRow {
  return {
    checkNumber: o.id, payee: 'HENKEL PHILIPPINES INC.', bank: 'BPI', company: 'STK',
    stage: 'SIGNED', currency: 'PHP', amount: '100.00', checkDate: daysAgo(3), ...o,
  }
}

async function build(rows: ForecastRow[], totalRows = rows.length) {
  const { byBank, byStage, bucketed } = buildMatrices(rows, TODAY)
  const buffer = await buildForecastWorkbook({
    byBank, byStage, detail: bucketed,
    meta: {
      generatedAt: TODAY, generatedBy: 'Paolo Parcon',
      filterDescription: 'No filters applied', totalRows, incompleteCount: 129,
    },
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb
}

describe('buildForecastWorkbook', () => {
  it('writes SUMMARY then DETAIL', async () => {
    const wb = await build([row({ id: 'a' })])
    expect(wb.worksheets.map((w) => w.name)).toEqual([SUMMARY_SHEET, DETAIL_SHEET])
  })

  it('titles the summary and states the exclusion and the filters', async () => {
    const wb = await build([row({ id: 'a' })])
    const ws = wb.getWorksheet(SUMMARY_SHEET)!
    expect(String(ws.getCell('A1').value)).toContain('CASH OUTFLOW')
    expect(String(ws.getCell('A2').value)).toContain('No filters applied')
    expect(String(ws.getCell('A4').value)).toContain('129')
  })

  it('writes a bucket row per currency with numeric amounts the reader can sum', async () => {
    const wb = await build([
      row({ id: 'a', amount: '100.00' }), row({ id: 'b', amount: '5.00', currency: 'USD' }),
    ])
    const ws = wb.getWorksheet(SUMMARY_SHEET)!
    const lines: string[][] = []
    ws.eachRow((r) => lines.push(r.values as string[]))
    const php = lines.find((l) => l[1] === '1–7 DAYS' && l[2] === 'PHP')!
    const usd = lines.find((l) => l[1] === '1–7 DAYS' && l[2] === 'USD')!
    expect(php).toBeDefined()
    expect(usd).toBeDefined()
    // BUCKET, CURRENCY, BPI CHEQUES, BPI AMOUNT, TOTAL CHEQUES, TOTAL AMOUNT
    expect(php[3]).toBe(1)
    expect(php[4]).toBe(100)
    expect(usd[4]).toBe(5)
  })

  it('lists one detail row per cheque under the fixed header', async () => {
    const wb = await build([row({ id: 'a', checkDate: daysAgo(45) })])
    const ws = wb.getWorksheet(DETAIL_SHEET)!
    expect((ws.getRow(1).values as string[]).slice(1)).toEqual([...DETAIL_HEADERS])
    const r = ws.getRow(2).values as unknown[]
    expect(r[1]).toBe('a')
    expect(r[7]).toBe(45)
    expect(r[8]).toBe('31–60 DAYS')
    expect(r[10]).toBe(100)
  })

  it('says so in the title block when the cap bit', async () => {
    const wb = await build([row({ id: 'a' })], 20_000)
    const ws = wb.getWorksheet(SUMMARY_SHEET)!
    expect(String(ws.getCell('A3').value)).toContain('FIRST 1 OF 20,000')
  })
})
```

Create `tests/export/forecast-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { DETAIL_SHEET } from '@/lib/export/forecast-workbook'

/**
 * The route's guard. `middleware.ts` runs on Vercel but this route is NOT on
 * the public list, and it must not rely on the middleware either way: it
 * authenticates itself on its first line. The counting Proxy asserts an
 * unauthenticated request never touches the database.
 */
const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))

vi.mock('@/lib/auth', () => ({ getSessionUser: async () => state.user }))

vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return {
    prisma: new Proxy(testDb, {
      get(target, prop, receiver) {
        state.dbTouches += 1
        return Reflect.get(target, prop, receiver)
      },
    }),
  }
})

const SIGNED_IN = { id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER' }

async function get(url: string) {
  const { GET } = await import('@/app/api/export/forecast/route')
  return GET(new Request(url))
}

beforeEach(async () => {
  await resetDb()
  state.user = SIGNED_IN
  state.dbTouches = 0
})

describe('GET /api/export/forecast — the guard', () => {
  it('refuses an unauthenticated request with 401 and touches nothing', async () => {
    state.user = null
    const res = await get('http://localhost/api/export/forecast')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })
})

describe('GET /api/export/forecast — the file', () => {
  it('serves a dated filename, never cached', async () => {
    await makeCheck({ status: 'SIGNED' })
    const res = await get('http://localhost/api/export/forecast')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="cash-outflow-\d{4}-\d{2}-\d{2}\.xlsx"/)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('honours the stage filter — the file is the view', async () => {
    await makeCheck({ status: 'SIGNED', checkNumber: '1' })
    await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '2' })
    const res = await get('http://localhost/api/export/forecast?stage=READY_FOR_RELEASE')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const ws = wb.getWorksheet(DETAIL_SHEET)!
    expect(ws.rowCount).toBe(2)
    expect(ws.getRow(2).getCell(1).value).toBe('2')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx.cmd vitest run tests/export/forecast-workbook.test.ts tests/export/forecast-route.test.ts
```

Expected: FAIL on both unresolved imports.

- [ ] **Step 3: The workbook**

Create `lib/export/forecast-workbook.ts`:

```ts
import ExcelJS from 'exceljs'
import { currencyNumberFormat, fitColumnWidth, statusWords } from './report'
import { BAND_FILL, COUNT_FORMAT, DATE_FORMAT, DATE_WIDTH_SAMPLE, styleHeaderCell } from './sheet-style'
import type { Matrix, BucketedRow } from '@/lib/forecast/matrix'

/**
 * The cash outflow forecast, as a workbook. Two sheets: SUMMARY holds the two
 * matrices under a title block; DETAIL holds one row per cheque.
 *
 * Unlike the voucher index, THE FILE IS THE VIEW: the filters in force are
 * written into the title block, because a filtered forecast that did not say
 * so would be read as the whole.
 *
 * Amounts are written as Excel NUMBERS in the cells — the one sanctioned use
 * of a JS number for money, as `workbook.ts` documents: a presentational value
 * the reader can sum and sort, never added to anything here and never read
 * back. The adding was done in centavos in `matrix.ts`.
 */

export const SUMMARY_SHEET = 'SUMMARY'
export const DETAIL_SHEET = 'DETAIL'

export const DETAIL_HEADERS = [
  'CHECK NUMBER', 'PAYEE', 'BANK', 'COMPANY', 'STAGE', 'CHECK DATE',
  'DAYS PRESENTABLE', 'BUCKET', 'CURRENCY', 'AMOUNT',
] as const

export type ForecastMeta = {
  generatedAt: Date
  generatedBy: string
  filterDescription: string
  /** Every cheque in the population before the DETAIL cap. */
  totalRows: number
  incompleteCount: number
}

export type ForecastWorkbookInput = {
  byBank: Matrix
  byStage: Matrix
  detail: readonly BucketedRow[]
  meta: ForecastMeta
}

const TITLE_INK = 'FF0F172A'
const MUTED_INK = 'FF475569'
const count = (n: number) => n.toLocaleString('en-PH')

function generatedLine(meta: ForecastMeta): string {
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Manila',
  })
  return `Generated ${stamp} by ${meta.generatedBy}`
}

/** One matrix, written from `top` down. Returns the next free row. */
function writeMatrix(ws: ExcelJS.Worksheet, top: number, title: string, m: Matrix): number {
  ws.getCell(top, 1).value = title
  ws.getCell(top, 1).font = { bold: true, size: 12, color: { argb: TITLE_INK } }

  const header = ws.getRow(top + 1)
  const labels = ['BUCKET', 'CURRENCY', ...m.columns.flatMap((c) => [`${c} CHEQUES`, `${c} AMOUNT`]), 'TOTAL CHEQUES', 'TOTAL AMOUNT']
  labels.forEach((label, i) => styleHeaderCell(header.getCell(i + 1), label, i >= 2 ? 'right' : 'left'))

  let r = top + 2
  const writeLine = (bucket: string, currency: string, cells: Matrix['rows'][number]['cells'], total: Matrix['rows'][number]['total'], band: boolean) => {
    const row = ws.getRow(r)
    row.getCell(1).value = bucket
    row.getCell(2).value = currency
    let col = 3
    for (const c of m.columns) {
      const cell = cells[c]
      const t = cell.totals.find((x) => x.currency === currency)
      row.getCell(col).value = t ? cell.count : null
      row.getCell(col).numFmt = COUNT_FORMAT
      row.getCell(col + 1).value = t ? Number(t.total) : null
      row.getCell(col + 1).numFmt = currencyNumberFormat(currency)
      col += 2
    }
    const tt = total.totals.find((x) => x.currency === currency)
    row.getCell(col).value = tt ? total.count : null
    row.getCell(col).numFmt = COUNT_FORMAT
    row.getCell(col + 1).value = tt ? Number(tt.total) : null
    row.getCell(col + 1).numFmt = currencyNumberFormat(currency)
    if (band) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
    r += 1
  }

  let band = false
  for (const line of m.rows) {
    // One line per currency present in the bucket; a bucket with nothing in it
    // is still written, with a dash, so the reader sees the whole ladder.
    const currencies = line.total.totals.map((t) => t.currency)
    if (currencies.length === 0) {
      ws.getRow(r).getCell(1).value = line.bucket
      ws.getRow(r).getCell(2).value = '—'
      r += 1
    } else {
      for (const currency of currencies) writeLine(line.bucket, currency, line.cells, line.total, band)
    }
    band = !band
  }
  for (const currency of m.total.total.totals.map((t) => t.currency)) {
    writeLine('TOTAL', currency, m.total.cells, m.total.total, false)
    ws.getRow(r - 1).font = { bold: true }
  }
  return r + 1
}

export async function buildForecastWorkbook(
  { byBank, byStage, detail, meta }: ForecastWorkbookInput,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  const summary = wb.addWorksheet(SUMMARY_SHEET)
  summary.getCell('A1').value = 'CASH OUTFLOW BY CHEQUE DATE — CHECK RELEASE MONITORING'
  summary.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE_INK } }
  summary.getRow(1).height = 24
  summary.getCell('A2').value = meta.filterDescription
  summary.getCell('A2').font = { bold: true, size: 12, color: { argb: TITLE_INK } }
  const scope = detail.length < meta.totalRows
    ? `${generatedLine(meta)}  ·  DETAIL holds the FIRST ${count(detail.length)} OF ${count(meta.totalRows)} cheques`
    : `${generatedLine(meta)}  ·  ${count(meta.totalRows)} cheque${meta.totalRows === 1 ? '' : 's'}`
  summary.getCell('A3').value = scope
  summary.getCell('A3').font = { size: 10, color: { argb: MUTED_INK } }
  summary.getCell('A4').value =
    `Dates are the cheque's own date — the day from which it can be presented. Excludes ` +
    `${count(meta.incompleteCount)} cheque${meta.incompleteCount === 1 ? '' : 's'} with no recorded amount.`
  summary.getCell('A4').font = { size: 10, color: { argb: MUTED_INK } }

  let next = writeMatrix(summary, 6, 'BY BANK', byBank)
  writeMatrix(summary, next, 'BY STAGE', byStage)
  summary.getColumn(1).width = 16
  summary.getColumn(2).width = 10
  for (let c = 3; c <= summary.columnCount; c++) summary.getColumn(c).width = 18

  // ── DETAIL ───────────────────────────────────────────────────────────────
  const ws = wb.addWorksheet(DETAIL_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  const header = ws.getRow(1)
  DETAIL_HEADERS.forEach((label, i) => {
    styleHeaderCell(header.getCell(i + 1), label, label === 'AMOUNT' || label === 'DAYS PRESENTABLE' ? 'right' : 'left')
  })
  header.height = 20
  const samples: string[][] = DETAIL_HEADERS.map(() => [])

  detail.forEach((r, i) => {
    const row = ws.getRow(i + 2)
    const values: (string | number | Date | null)[] = [
      r.checkNumber, r.payee, r.bank, r.company, statusWords(r.stage), r.checkDate,
      r.days, r.bucket, r.currency, Number(r.amount),
    ]
    values.forEach((v, col) => {
      const cell = row.getCell(col + 1)
      cell.value = v
      if (v instanceof Date) cell.numFmt = DATE_FORMAT
      samples[col].push(v === null ? '' : v instanceof Date ? DATE_WIDTH_SAMPLE : String(v))
    })
    row.getCell(10).numFmt = currencyNumberFormat(r.currency)
    row.getCell(7).numFmt = COUNT_FORMAT
    if (i % 2 === 1) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
  })
  DETAIL_HEADERS.forEach((label, i) => { ws.getColumn(i + 1).width = fitColumnWidth(label, samples[i]) })
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + detail.length, column: DETAIL_HEADERS.length } }

  return wb.xlsx.writeBuffer()
}
```

- [ ] **Step 4: The route**

Create `app/api/export/forecast/route.ts`:

```ts
import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { listForecastRows } from '@/lib/forecast/query'
import { buildMatrices } from '@/lib/forecast/matrix'
import { parseStageParam, describeForecastFilters, forecastFilename } from '@/lib/forecast-view'
import { buildForecastWorkbook } from '@/lib/export/forecast-workbook'
import { EXPORT_ROW_LIMIT } from '@/lib/export/report'

/**
 * EXPORT THE FORECAST. The file is the view: the same filters as the page,
 * written into the title block.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` runs on Vercel and not locally, and this route is on neither
 * side's public list — it authenticates itself on its first line regardless,
 * because a route that leans on middleware is protected in one environment and
 * not the other. 401, not a redirect: a download that redirects arrives as a
 * login page saved under an .xlsx name.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const params = new URL(request.url).searchParams
  const options = await getFilterOptions(prisma)
  const bank = params.get('bank')?.trim() || undefined
  const companyParam = params.get('company')?.trim() || undefined
  // Validated against the companies that exist, as the dashboard does; an
  // unknown id is ignored rather than passed to the query.
  const company = options.companies.find((c) => c.id === companyParam)
  const stage = parseStageParam(params.get('stage') ?? undefined)

  const now = new Date()
  const [rows, incompleteCount] = await Promise.all([
    listForecastRows(prisma, { bankCode: bank, companyId: company?.id, stage }),
    prisma.check.count({ where: { isIncomplete: true } }),
  ])
  const { byBank, byStage, bucketed } = buildMatrices(rows, now)

  const workbook = await buildForecastWorkbook({
    byBank, byStage,
    // Capped after bucketing, so the matrices are struck over every cheque
    // and only the DETAIL listing is cut — and the title block says so.
    detail: bucketed.slice(0, EXPORT_ROW_LIMIT),
    meta: {
      generatedAt: now,
      generatedBy: user.name,
      filterDescription: describeForecastFilters({ bank, company: company?.code, stage }),
      totalRows: bucketed.length,
      incompleteCount,
    },
  })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${forecastFilename(now)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
```

- [ ] **Step 5: Run the two test files and the type-checker**

```bash
npx.cmd vitest run tests/export/forecast-workbook.test.ts tests/export/forecast-route.test.ts
```

Expected: PASS — 5 and 3.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/export/forecast-workbook.ts app/api/export/forecast/route.ts tests/export/forecast-workbook.test.ts tests/export/forecast-route.test.ts
git commit -m "feat: the forecast as a workbook, and the route that serves it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The page, the header link, and CLAUDE.md

**Files:**
- Create: `components/ForecastMatrix.tsx`, `app/forecast/page.tsx`
- Modify: `components/AppHeader.tsx`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above; `formatMoney` from `lib/money.ts`; `getFilterOptions` from `lib/queries.ts`; `AppHeader`, `EmptyState`, `Panel`.
- Produces: `ForecastMatrix({ title, matrix }: { title: string; matrix: Matrix })`; `AppHeader` gains `showForecastLink?: boolean` (default `true`).

No new unit test — no page in this repository has one. Verification is `tsc` and `next build` listing `/forecast` and `/api/export/forecast`.

- [ ] **Step 1: The matrix component**

Create `components/ForecastMatrix.tsx`:

```tsx
import { formatMoney } from '@/lib/money'
import type { Matrix, Cell } from '@/lib/forecast/matrix'

/**
 * One matrix: buckets down, columns across, count and amount per currency in
 * each cell. A server component — nothing here is interactive.
 *
 * A cell with nothing in it is a dash, never a zero: "no cheques" and "cheques
 * worth nothing" are different facts, the same rule `formatMoney` applies to a
 * null amount.
 */
function CellView({ cell }: { cell: Cell }) {
  if (cell.count === 0) return <span className="text-slate-300">—</span>
  return (
    <div className="space-y-0.5">
      {cell.totals.map((t) => (
        <div key={t.currency} className="tabular-nums">
          <span className="text-slate-500">{cell.count.toLocaleString('en-PH')} · </span>
          {formatMoney(t.total, t.currency)}
        </div>
      ))}
    </div>
  )
}

export function ForecastMatrix({ title, matrix }: { title: string; matrix: Matrix }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <h2 className="px-6 pb-4 pt-6 text-[11px] font-semibold tracking-widest text-slate-400">{title}</h2>
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">PRESENTABLE</th>
            {matrix.columns.map((c) => <th key={c} className="px-4 py-3 text-right">{c}</th>)}
            <th className="px-4 py-3 text-right">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((r) => (
            <tr key={r.bucket} className="border-b border-slate-100 odd:bg-white even:bg-ground">
              <td className="whitespace-nowrap px-4 py-3 font-medium">{r.bucket}</td>
              {matrix.columns.map((c) => (
                <td key={c} className="px-4 py-3 text-right"><CellView cell={r.cells[c]} /></td>
              ))}
              <td className="px-4 py-3 text-right font-medium"><CellView cell={r.total} /></td>
            </tr>
          ))}
          <tr className="border-t border-hairline bg-navy-bg font-semibold">
            <td className="px-4 py-3">TOTAL</td>
            {matrix.columns.map((c) => (
              <td key={c} className="px-4 py-3 text-right"><CellView cell={matrix.total.cells[c]} /></td>
            ))}
            <td className="px-4 py-3 text-right"><CellView cell={matrix.total.total} /></td>
          </tr>
        </tbody>
      </table>
    </section>
  )
}
```

- [ ] **Step 2: The page**

Create `app/forecast/page.tsx`:

```tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { ForecastMatrix } from '@/components/ForecastMatrix'
import { listForecastRows, listBankCodes } from '@/lib/forecast/query'
import { buildMatrices } from '@/lib/forecast/matrix'
import {
  FORECAST_PATH, FORECAST_EXPORT_PATH, STAGE_OPTIONS,
  parseStageParam, forecastHref, describeForecastFilters,
} from '@/lib/forecast-view'

/**
 * CASH OUTFLOW BY CHEQUE DATE — what is written and not yet handed over.
 *
 * The cheque-side of the daily cash position Finance asked for on
 * 2026-09-10. The axis is the cheque's own date, read as PRESENTABLE FROM:
 * no pickup or release date has ever been recorded (measured 2026-09-11), and
 * a cheque's date is the day from which it can be presented — which is how
 * Finance's own Cash Balance sheet treats an outstanding cheque. A cheque dated
 * in the past is not a missed forecast; it is exposure, and the buckets say
 * how long it has been exposure.
 *
 * Everything shown is decided in `lib/forecast/` and `lib/forecast-view.ts`;
 * the page reads parameters, runs one query, and renders. The export runs the
 * same query with the same filters, so the file and the screen agree.
 */
export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<{ bank?: string; company?: string; stage?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const [options, banks] = await Promise.all([getFilterOptions(prisma), listBankCodes(prisma)])
  const bank = banks.includes(params.bank?.trim() ?? '') ? params.bank!.trim() : undefined
  const company = options.companies.find((c) => c.id === params.company?.trim())
  const stage = parseStageParam(params.stage)

  // Once per request, so the two matrices and the paragraph above them agree
  // about which day it is.
  const now = new Date()
  const [rows, incompleteCount] = await Promise.all([
    listForecastRows(prisma, { bankCode: bank, companyId: company?.id, stage }),
    prisma.check.count({ where: { isIncomplete: true } }),
  ])
  const { byBank, byStage } = buildMatrices(rows, now)

  const anyFilter = Boolean(bank || company || stage)
  const current = { bank, company: company?.id, stage }
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <AppHeader user={user} title="CASH OUTFLOW" back={{ href: '/', label: '← DASHBOARD' }} showForecastLink={false} />

      {/* The premise, stated once and always. Not a tooltip: a reader who takes
          "presentable from" for "expected on" will carry a wrong number into a
          meeting, and the sentence that prevents it has to be on the page. */}
      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        Dates are the cheque&apos;s own date — the day from which it can be presented. A cheque dated in
        the past can leave on any day; the buckets say how long it has been presentable. No pickup or
        release dates have been recorded yet; as Finance releases through this system, the RELEASED
        view will begin to show actual outflow by day.
      </p>

      <form className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline" method="get">
        <label className="sr-only" htmlFor="forecast-bank">BANK</label>
        <select id="forecast-bank" name="bank" defaultValue={bank ?? ''} className={field}>
          <option value="">ANY BANK</option>
          {banks.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <label className="sr-only" htmlFor="forecast-company">COMPANY</label>
        <select id="forecast-company" name="company" defaultValue={company?.id ?? ''} className={field}>
          <option value="">ANY COMPANY</option>
          {options.companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
        </select>

        <label className="sr-only" htmlFor="forecast-stage">STAGE</label>
        <select id="forecast-stage" name="stage" defaultValue={stage ?? ''} className={field}>
          <option value="">ANY STAGE</option>
          {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">
          APPLY
        </button>
        {anyFilter && (
          <Link href={FORECAST_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>
        )}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            {rows.length.toLocaleString('en-PH')} CHEQUE{rows.length === 1 ? '' : 'S'} WRITTEN AND NOT YET HANDED OVER
            {' · '}{describeForecastFilters({ bank, company: company?.code, stage })}
          </p>
          {/* The disclosure, as on the dashboard and /vouchers: the exclusion is
              a ruling (2026-09-06), and stating its count is the price of it. */}
          {incompleteCount > 0 && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              EXCLUDES {incompleteCount.toLocaleString('en-PH')} CHEQUE{incompleteCount === 1 ? '' : 'S'} WITH NO
              RECORDED AMOUNT — not in these figures and not in the file.{' '}
              <Link href="/?incomplete=1" className="underline underline-offset-2">Show them</Link>.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-500">The file holds this view, with these filters.</span>
          <a
            href={forecastHref(current, FORECAST_EXPORT_PATH)}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
          >
            EXPORT EXCEL
          </a>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={anyFilter ? 'NO CHEQUES MATCH' : 'NOTHING IS WAITING TO BE HANDED OVER'} tone={anyFilter ? 'plain' : 'good'}>
          {anyFilter
            ? 'No live cheque carries that bank, company and stage together.'
            : 'Every cheque this system knows has been released, cancelled or voided.'}
        </EmptyState>
      ) : (
        <>
          <ForecastMatrix title="BY BANK" matrix={byBank} />
          <ForecastMatrix title="BY STAGE" matrix={byStage} />
        </>
      )}
    </main>
  )
}
```

- [ ] **Step 3: The header link**

In `components/AppHeader.tsx`, add `showForecastLink = true` to the destructured props and `showForecastLink?: boolean` to the type (with the comment `/** False on the forecast page, which IS the forecast. */`), and insert directly after the `VOUCHERS` link block:

```tsx
        {showForecastLink && (
          <Link href="/forecast" className="underline underline-offset-2">FORECAST</Link>
        )}
```

- [ ] **Step 4: CLAUDE.md**

In `CLAUDE.md`'s "Layout" table, add a row after the `lib/sync/run.ts` row:

```markdown
| `lib/forecast/` | Cash outflow by cheque date: `buckets.ts` (the ageing buckets, pure), `query.ts` (the population — live, real, with an amount), `matrix.ts` (bucket × bank and bucket × stage, centavo-exact, pure). `/forecast` and `/api/export/forecast` sit on it. |
```

In "What is missing", replace item 10 (beginning `10. **The cash-outflow forecast is the next seam, and it is buildable now**`) with:

```markdown
10. **The cash-outflow forecast is BUILT** (2026-09-11) — `/forecast`, on the cheque date read as
   PRESENTABLE FROM, because no pickup or release date has ever been recorded (measured: null on
   every row) and a cheque's date is the day from which it can be presented. Live cheques by bank
   and by stage in Finance's own ageing buckets; the file is the view. What it cannot yet show is
   actual outflow by day: that begins the day releases go through the app and `releasedAt` fills.
   The other three reports Finance named — bank reconciliation, hedging, foreign outlook — are not
   buildable here; the voucher-index spec's closing section records why and where their sources
   actually live.
```

- [ ] **Step 5: Type-check and build**

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

```bash
npx.cmd next build
```

Expected: build succeeds; `/forecast` and `/api/export/forecast` are listed as dynamic routes.

- [ ] **Step 6: Commit**

```bash
git add components/ForecastMatrix.tsx app/forecast/page.tsx components/AppHeader.tsx CLAUDE.md
git commit -m "feat: cash outflow by cheque date, on screen, with the file as the view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Not in this plan

- **A forecast on pickup or release dates.** None exist yet.
- **The float** (released, not cleared). Clearing is never recorded.
- **A page test.** No page in this repository has one; the three pure modules carry the decisions.
