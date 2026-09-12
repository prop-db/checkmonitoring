# Outstanding Cheques Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/recon` and `/api/export/recon`: for an as-of date, every cash account's outstanding cheques — released and not cleared by that date — as a count and a total, and the list behind each; the OC column of Finance's Cash Balance sheet.

**Architecture:** A pure rule module decides whether one cheque is outstanding as of a day; a pure summary module groups rows by cash account with centavo-exact totals; one query lists the RELEASED population under the filters; the page and the route apply the rule to the same rows. No migration, no writes.

**Tech Stack:** Next 15 App Router · Prisma 6 · ExcelJS · Vitest · TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-12-outstanding-cheques-design.md`. Read it before Task 1.

## Global Constraints

- **`tsc --noEmit` must pass before any task is called done.** On this machine use `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/vitest/vitest.mjs run <files>`, and `node node_modules/next/dist/bin/next build` — the `npx.cmd` shim breaks on the space in the repo path. **Every command runs in the foreground; never background a test or a build.**
- **Run ONLY the test files named in the task. Never the full suite.** One test process at a time.
- **Rule 8:** amounts are decimal strings; totals are struck in centavos with `toCentavos`/`fromCentavos` from `lib/export/report.ts`; the only JS number for money is the ExcelJS cell write.
- **Days are Manila calendar days** (`manilaDay` from `lib/forecast/buckets.ts`), compared as `YYYY-MM-DD` strings.
- **Any Finance user.** The page calls `requireUser()` first; the route `getSessionUser()` first and answers 401 with no database touch.
- **The export cap is the setting** `caps.exportRows` via `loadSettings` (see `app/api/export/forecast/route.ts`).
- **Nothing here writes.** No `writeAudit`, no `update`.
- **British spelling in prose. Never commit or print `.env`, credentials or any `.xlsx`. No raw control characters.**
- **Commit messages end with:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/recon/outstanding.ts` | **Create.** Pure: `issuedOn`, `isOutstandingAsOf`, `clearedOn`. |
| `lib/recon/summary.ts` | **Create.** Pure: `summariseByAccount`, `daysBetween`, `NO_ACCOUNT`. |
| `lib/recon-view.ts` | **Create.** Pure: paths, `parseAsOf`, `reconHref`, `describeReconFilters`, `reconFilename`. |
| `lib/recon/query.ts` | **Create.** `listOutstandingCandidates`, `countExcludedIncomplete`. |
| `lib/export/recon-workbook.ts` | **Create.** SUMMARY + DETAIL. |
| `app/api/export/recon/route.ts` | **Create.** |
| `components/ReconTable.tsx`, `components/OutstandingList.tsx` | **Create.** Server components. |
| `app/recon/page.tsx` | **Create.** |
| `components/AppHeader.tsx`, `CLAUDE.md` | **Modify.** RECON link; item 10's closing sentence. |
| Tests | `tests/recon/outstanding.test.ts`, `tests/recon/summary.test.ts`, `tests/recon-view.test.ts`, `tests/recon/query.test.ts`, `tests/export/recon-workbook.test.ts`, `tests/export/recon-route.test.ts`. |

---

### Task 1: The rule, the summary, the view — all pure

**Files:**
- Create: `lib/recon/outstanding.ts`, `lib/recon/summary.ts`, `lib/recon-view.ts`
- Test: `tests/recon/outstanding.test.ts`, `tests/recon/summary.test.ts`, `tests/recon-view.test.ts`

**Interfaces:**
```ts
// lib/recon/outstanding.ts
export type OutstandingInput = { status: CheckStatus; releasedAt: Date | null; checkDate: Date | null; clearingStatus: ClearingStatus; clearedDate: Date | null; amount: string | null }
export type IssueBasis = 'RELEASED AT' | 'CHEQUE DATE'
export function issuedOn(input: Pick<OutstandingInput, 'releasedAt' | 'checkDate'>): { day: string; basis: IssueBasis } | null
export function clearedOn(input: Pick<OutstandingInput, 'clearingStatus' | 'clearedDate'>): string | 'UNKNOWN' | null   // null = not cleared
export function isOutstandingAsOf(input: OutstandingInput, asOfDay: string): boolean

// lib/recon/summary.ts
export const NO_ACCOUNT = '(NO ACCOUNT)'
export type OutstandingRow = { id: string; checkNumber: string; payee: string | null; accountId: string | null; account: string | null; bank: string | null; company: string; currency: string; amount: string; checkDate: Date | null; releasedAt: Date | null; clearingStatus: ClearingStatus; clearedDate: Date | null; status: CheckStatus }
export type OutstandingLine = OutstandingRow & { issuedDay: string | null; basis: IssueBasis | null; days: number | null }
export type AccountTotal = { currency: string; count: number; total: string }
export type AccountLine = { accountId: string | null; account: string; bank: string | null; company: string; count: number; totals: AccountTotal[] }
export type ReconSummary = { accounts: AccountLine[]; totals: AccountTotal[]; lines: OutstandingLine[] }
export function daysBetween(fromDay: string, toDay: string): number
export function summariseByAccount(rows: readonly OutstandingRow[], asOfDay: string): ReconSummary

// lib/recon-view.ts
export const RECON_PATH = '/recon'
export const RECON_EXPORT_PATH = '/api/export/recon'
export type ReconParams = { asOf?: string; bank?: string; company?: string; account?: string }
export function parseAsOf(value: string | undefined, now: Date): string        // a valid YYYY-MM-DD, else manilaDay(now)
export function reconHref(params: ReconParams, path?: string): string
export function describeReconFilters(f: { bank?: string | null; company?: string | null; account?: string | null }): string
export function reconFilename(asOfDay: string): string                       // outstanding-cheques-<day>.xlsx
```

- [ ] **Step 1: Write the failing tests**

Create `tests/recon/outstanding.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { issuedOn, clearedOn, isOutstandingAsOf, type OutstandingInput } from '@/lib/recon/outstanding'

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
const base: OutstandingInput = {
  status: 'RELEASED', releasedAt: null, checkDate: d('2026-08-20'),
  clearingStatus: 'NONE', clearedDate: null, amount: '100.00',
}

describe('issuedOn', () => {
  it('uses the release day when one was recorded', () => {
    // 2026-09-10 23:30 Manila is 15:30Z — the Manila day is the 10th.
    expect(issuedOn({ releasedAt: new Date('2026-09-10T15:30:00Z'), checkDate: d('2026-08-20') }))
      .toEqual({ day: '2026-09-10', basis: 'RELEASED AT' })
  })
  it('falls back to the cheque date, and says so', () => {
    expect(issuedOn({ releasedAt: null, checkDate: d('2026-08-20') })).toEqual({ day: '2026-08-20', basis: 'CHEQUE DATE' })
  })
  it('is null with neither date', () => {
    expect(issuedOn({ releasedAt: null, checkDate: null })).toBeNull()
  })
})

describe('clearedOn', () => {
  it('is null unless CLEARED', () => {
    expect(clearedOn({ clearingStatus: 'NONE', clearedDate: null })).toBeNull()
    expect(clearedOn({ clearingStatus: 'DEPOSITED', clearedDate: d('2026-09-01') })).toBeNull()
  })
  it('is the cleared day, or UNKNOWN when CLEARED carries no date', () => {
    expect(clearedOn({ clearingStatus: 'CLEARED', clearedDate: d('2026-09-01') })).toBe('2026-09-01')
    expect(clearedOn({ clearingStatus: 'CLEARED', clearedDate: null })).toBe('UNKNOWN')
  })
})

describe('isOutstandingAsOf', () => {
  it('counts a released, uncleared cheque issued on or before the day', () => {
    expect(isOutstandingAsOf(base, '2026-09-12')).toBe(true)
    expect(isOutstandingAsOf(base, '2026-08-20')).toBe(true)   // issued that very day
    expect(isOutstandingAsOf(base, '2026-08-19')).toBe(false)  // not yet issued
  })
  it('never counts a cheque that is not RELEASED', () => {
    for (const status of ['SIGNED', 'READY_FOR_RELEASE', 'CANCELLED', 'VOIDED'] as const) {
      expect(isOutstandingAsOf({ ...base, status }, '2026-09-12'), status).toBe(false)
    }
  })
  it('stops counting on the cleared day, and counts up to the day before', () => {
    const cleared = { ...base, clearingStatus: 'CLEARED' as const, clearedDate: d('2026-09-05') }
    expect(isOutstandingAsOf(cleared, '2026-09-04')).toBe(true)
    expect(isOutstandingAsOf(cleared, '2026-09-05')).toBe(false)
    expect(isOutstandingAsOf(cleared, '2026-09-12')).toBe(false)
  })
  it('treats CLEARED with no date as cleared on every day', () => {
    expect(isOutstandingAsOf({ ...base, clearingStatus: 'CLEARED' }, '2026-08-20')).toBe(false)
  })
  it('keeps DEPOSITED and ENCASHED outstanding — the bank has not paid', () => {
    expect(isOutstandingAsOf({ ...base, clearingStatus: 'DEPOSITED' }, '2026-09-12')).toBe(true)
    expect(isOutstandingAsOf({ ...base, clearingStatus: 'ENCASHED' }, '2026-09-12')).toBe(true)
  })
  it('counts a released cheque with no date at all on any day', () => {
    expect(isOutstandingAsOf({ ...base, checkDate: null }, '2000-01-01')).toBe(true)
  })
  it('never counts a cheque with no recorded amount', () => {
    expect(isOutstandingAsOf({ ...base, amount: null }, '2026-09-12')).toBe(false)
  })
})
```

Create `tests/recon/summary.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { summariseByAccount, daysBetween, NO_ACCOUNT, type OutstandingRow } from '@/lib/recon/summary'

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
function row(o: Partial<OutstandingRow> & { id: string }): OutstandingRow {
  return {
    checkNumber: o.id, payee: 'HENKEL PHILIPPINES INC.', accountId: 'acc-bpi', account: 'BPI STK', bank: 'BPI',
    company: 'STK', currency: 'PHP', amount: '100.00', checkDate: d('2026-08-20'), releasedAt: null,
    clearingStatus: 'NONE', clearedDate: null, status: 'RELEASED', ...o,
  }
}

describe('daysBetween', () => {
  it('counts whole days, negative when the first day is later', () => {
    expect(daysBetween('2026-08-20', '2026-09-12')).toBe(23)
    expect(daysBetween('2026-09-12', '2026-09-12')).toBe(0)
    expect(daysBetween('2026-09-13', '2026-09-12')).toBe(-1)
  })
})

describe('summariseByAccount', () => {
  it('keeps only the rows outstanding as of the day, and adds in centavos per currency', () => {
    const s = summariseByAccount([
      row({ id: 'a', amount: '0.10' }), row({ id: 'b', amount: '0.20' }),
      row({ id: 'c', amount: '5.00', currency: 'USD' }),
      row({ id: 'd', clearingStatus: 'CLEARED', clearedDate: d('2026-09-01') }),
      row({ id: 'e', status: 'SIGNED' }),
    ], '2026-09-12')
    expect(s.lines.map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(s.accounts).toHaveLength(1)
    expect(s.accounts[0]).toMatchObject({ accountId: 'acc-bpi', account: 'BPI STK', bank: 'BPI', company: 'STK', count: 3 })
    expect(s.accounts[0].totals).toEqual([
      { currency: 'PHP', count: 2, total: '0.30' }, { currency: 'USD', count: 1, total: '5.00' },
    ])
    expect(s.totals).toEqual([{ currency: 'PHP', count: 2, total: '0.30' }, { currency: 'USD', count: 1, total: '5.00' }])
  })

  it('orders accounts by bank then code, with no-account rows last under (NO ACCOUNT)', () => {
    const s = summariseByAccount([
      row({ id: 'a', accountId: 'acc-mbtc', account: 'MBTC STK', bank: 'MBTC' }),
      row({ id: 'b', accountId: 'acc-bpi2', account: 'BPI A1', bank: 'BPI', company: 'A1+' }),
      row({ id: 'c', accountId: null, account: null, bank: 'BDO' }),
      row({ id: 'd' }),
    ], '2026-09-12')
    expect(s.accounts.map((a) => a.account)).toEqual(['BPI A1', 'BPI STK', 'MBTC STK', NO_ACCOUNT])
    expect(s.accounts[3]).toMatchObject({ accountId: null, bank: 'BDO', count: 1 })
  })

  it('carries the issue day, its basis and the days outstanding on each line', () => {
    const s = summariseByAccount([
      row({ id: 'a' }),
      row({ id: 'b', releasedAt: new Date('2026-09-10T15:30:00Z') }),
      row({ id: 'c', checkDate: null }),
    ], '2026-09-12')
    expect(s.lines.find((l) => l.id === 'a')).toMatchObject({ issuedDay: '2026-08-20', basis: 'CHEQUE DATE', days: 23 })
    expect(s.lines.find((l) => l.id === 'b')).toMatchObject({ issuedDay: '2026-09-10', basis: 'RELEASED AT', days: 2 })
    expect(s.lines.find((l) => l.id === 'c')).toMatchObject({ issuedDay: null, basis: null, days: null })
  })

  it('is empty, not broken, with nothing outstanding', () => {
    const s = summariseByAccount([], '2026-09-12')
    expect(s).toEqual({ accounts: [], totals: [], lines: [] })
  })
})
```

Create `tests/recon-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RECON_PATH, RECON_EXPORT_PATH, parseAsOf, reconHref, describeReconFilters, reconFilename } from '@/lib/recon-view'

const NOW = new Date('2026-09-12T01:00:00Z') // 09:00 Manila on the 12th

describe('parseAsOf', () => {
  it('accepts a day and defaults to today in Manila', () => {
    expect(parseAsOf('2026-08-31', NOW)).toBe('2026-08-31')
    expect(parseAsOf(undefined, NOW)).toBe('2026-09-12')
    expect(parseAsOf('', NOW)).toBe('2026-09-12')
    expect(parseAsOf('31/08/2026', NOW)).toBe('2026-09-12')
    expect(parseAsOf('2026-02-30', NOW)).toBe('2026-09-12')
  })
  it('names the day after midnight Manila, not UTC', () => {
    expect(parseAsOf(undefined, new Date('2026-09-11T17:30:00Z'))).toBe('2026-09-12')
  })
})

describe('reconHref', () => {
  it('carries the parameters, drops empties, and can point at the export', () => {
    expect(reconHref({})).toBe(RECON_PATH)
    expect(reconHref({ asOf: '2026-08-31', bank: 'BPI', company: '', account: 'acc1' })).toBe('/recon?asOf=2026-08-31&bank=BPI&account=acc1')
    expect(reconHref({ asOf: '2026-08-31' }, RECON_EXPORT_PATH)).toBe('/api/export/recon?asOf=2026-08-31')
  })
})

describe('describeReconFilters and reconFilename', () => {
  it('names the filters in force', () => {
    expect(describeReconFilters({ bank: 'BPI', company: 'STK', account: 'BPI STK' })).toBe('BANK: BPI  ·  COMPANY: STK  ·  ACCOUNT: BPI STK')
    expect(describeReconFilters({})).toBe('No filters applied')
  })
  it('dates the file by the as-of day', () => {
    expect(reconFilename('2026-08-31')).toBe('outstanding-cheques-2026-08-31.xlsx')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node node_modules/vitest/vitest.mjs run tests/recon/outstanding.test.ts tests/recon/summary.test.ts tests/recon-view.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: The rule**

Create `lib/recon/outstanding.ts`:

```ts
import type { CheckStatus, ClearingStatus } from '@/lib/domain/check-status'
import { manilaDay } from '@/lib/forecast/buckets'

/**
 * OUTSTANDING AS OF A DAY — the OC column of Finance's Cash Balance sheet.
 *
 * A cheque is outstanding as of a Manila calendar day when it had been issued
 * by that day and the bank had not paid it by that day. Pure: dates in,
 * verdict out; the page and the extract both call this over the same rows.
 *
 * ISSUED. `releasedAt` when the app recorded the release. The 9,594 cheques
 * released before it did (measured 2026-09-11) carry none, so the cheque's
 * own date stands in — the day from which it could be presented — and every
 * line says which basis it used. Neither date at all: issued "always".
 *
 * CLEARED. Only `CLEARED` clears; DEPOSITED and ENCASHED mean the bank has not
 * paid. A `clearedDate` after the day means it was still outstanding on the
 * day. `CLEARED` with no date is cleared on EVERY day: nobody recorded when,
 * and counting it outstanding would overstate the figure for ever.
 *
 * AMOUNT. No recorded amount, no figure — the standing rule since 2026-09-06.
 */
export type OutstandingInput = {
  status: CheckStatus
  releasedAt: Date | null
  checkDate: Date | null
  clearingStatus: ClearingStatus
  clearedDate: Date | null
  amount: string | null
}

export type IssueBasis = 'RELEASED AT' | 'CHEQUE DATE'

export function issuedOn(
  input: Pick<OutstandingInput, 'releasedAt' | 'checkDate'>,
): { day: string; basis: IssueBasis } | null {
  if (input.releasedAt) return { day: manilaDay(input.releasedAt), basis: 'RELEASED AT' }
  if (input.checkDate) return { day: manilaDay(input.checkDate), basis: 'CHEQUE DATE' }
  return null
}

/** The cleared day; `'UNKNOWN'` for CLEARED with no date; null when not cleared. */
export function clearedOn(input: Pick<OutstandingInput, 'clearingStatus' | 'clearedDate'>): string | 'UNKNOWN' | null {
  if (input.clearingStatus !== 'CLEARED') return null
  return input.clearedDate ? manilaDay(input.clearedDate) : 'UNKNOWN'
}

export function isOutstandingAsOf(input: OutstandingInput, asOfDay: string): boolean {
  if (input.status !== 'RELEASED') return false
  if (input.amount === null) return false
  const issued = issuedOn(input)
  if (issued && issued.day > asOfDay) return false
  const cleared = clearedOn(input)
  if (cleared === 'UNKNOWN') return false
  if (cleared !== null && cleared <= asOfDay) return false
  return true
}
```
(`CheckStatus` and `ClearingStatus` are exported from `lib/domain/check-status.ts`; `manilaDay` from `lib/forecast/buckets.ts`. ISO day strings compare correctly with `<`/`>`.)

- [ ] **Step 4: The summary**

Create `lib/recon/summary.ts`:

```ts
import type { CheckStatus, ClearingStatus } from '@/lib/domain/check-status'
import { toCentavos, fromCentavos } from '@/lib/export/report'
import { issuedOn, isOutstandingAsOf, type IssueBasis } from './outstanding'

/**
 * The account table and the list behind it, struck over one set of rows so
 * the two cannot disagree. Centavo arithmetic, per currency, never across —
 * the same discipline as `lib/forecast/matrix.ts`.
 */
export const NO_ACCOUNT = '(NO ACCOUNT)'

export type OutstandingRow = {
  id: string
  checkNumber: string
  payee: string | null
  accountId: string | null
  account: string | null
  bank: string | null
  company: string
  currency: string
  /** A decimal STRING — rule 8. */
  amount: string
  checkDate: Date | null
  releasedAt: Date | null
  clearingStatus: ClearingStatus
  clearedDate: Date | null
  status: CheckStatus
}

export type OutstandingLine = OutstandingRow & { issuedDay: string | null; basis: IssueBasis | null; days: number | null }
export type AccountTotal = { currency: string; count: number; total: string }
export type AccountLine = { accountId: string | null; account: string; bank: string | null; company: string; count: number; totals: AccountTotal[] }
export type ReconSummary = { accounts: AccountLine[]; totals: AccountTotal[]; lines: OutstandingLine[] }

const DAY_MS = 24 * 60 * 60 * 1000
const instant = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** Whole days from one `YYYY-MM-DD` to another; negative when the first is later. */
export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((instant(toDay) - instant(fromDay)) / DAY_MS)
}

type Acc = Map<string, { count: number; cents: bigint }>
const add = (acc: Acc, currency: string, amount: string) => {
  const prior = acc.get(currency) ?? { count: 0, cents: 0n }
  acc.set(currency, { count: prior.count + 1, cents: prior.cents + toCentavos(amount) })
}
const seal = (acc: Acc): AccountTotal[] =>
  [...acc.entries()].sort(([x], [y]) => x.localeCompare(y))
    .map(([currency, { count, cents }]) => ({ currency, count, total: fromCentavos(cents) }))

export function summariseByAccount(rows: readonly OutstandingRow[], asOfDay: string): ReconSummary {
  const lines: OutstandingLine[] = rows
    .filter((r) => isOutstandingAsOf(r, asOfDay))
    .map((r) => {
      const issued = issuedOn(r)
      return {
        ...r,
        issuedDay: issued?.day ?? null,
        basis: issued?.basis ?? null,
        days: issued ? daysBetween(issued.day, asOfDay) : null,
      }
    })

  // Grouped by account id; the rows with none share one group. The key is
  // the id, not the code, so two accounts could never fold on a shared label.
  const groups = new Map<string, { line: Omit<AccountLine, 'count' | 'totals'>; acc: Acc; count: number }>()
  const grand: Acc = new Map()
  for (const l of lines) {
    const key = l.accountId ?? NO_ACCOUNT
    const g = groups.get(key) ?? {
      line: { accountId: l.accountId, account: l.account ?? NO_ACCOUNT, bank: l.bank, company: l.company },
      acc: new Map(), count: 0,
    }
    add(g.acc, l.currency, l.amount)
    add(grand, l.currency, l.amount)
    g.count += 1
    groups.set(key, g)
  }

  // Bank, then account code — the Cash Balance sheet's own order. No-account
  // rows last, whatever their bank.
  const accounts = [...groups.values()]
    .map((g) => ({ ...g.line, count: g.count, totals: seal(g.acc) }))
    .sort((a, b) => {
      if (a.accountId === null) return 1
      if (b.accountId === null) return -1
      return (a.bank ?? '').localeCompare(b.bank ?? '') || a.account.localeCompare(b.account)
    })

  return { accounts, totals: seal(grand), lines }
}
```

- [ ] **Step 5: The view**

Create `lib/recon-view.ts`:

```ts
import { manilaDay } from './forecast/buckets'
import { isIsoDay } from './domain/details'
import { slugify } from './export/report'

/** The recon screen's arithmetic — parameters, hrefs, the filter line and the filename. Pure. */
export const RECON_PATH = '/recon'
export const RECON_EXPORT_PATH = '/api/export/recon'

export type ReconParams = { asOf?: string; bank?: string; company?: string; account?: string }

/** A valid `YYYY-MM-DD`, else today's Manila day. Never yesterday's UTC day. */
export function parseAsOf(value: string | undefined, now: Date): string {
  const s = (value ?? '').trim()
  return isIsoDay(s) ? s : manilaDay(now)
}

export function reconHref(params: ReconParams, path: string = RECON_PATH): string {
  const qs = new URLSearchParams()
  for (const key of ['asOf', 'bank', 'company', 'account'] as const) {
    const v = params[key]?.trim()
    if (v) qs.set(key, v)
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export function describeReconFilters(
  f: { bank?: string | null; company?: string | null; account?: string | null },
): string {
  const parts: string[] = []
  if (f.bank) parts.push(`BANK: ${f.bank}`)
  if (f.company) parts.push(`COMPANY: ${f.company}`)
  if (f.account) parts.push(`ACCOUNT: ${f.account}`)
  return parts.length ? parts.join('  ·  ') : 'No filters applied'
}

export function reconFilename(asOfDay: string): string {
  return `${slugify('outstanding cheques')}-${asOfDay}.xlsx`
}
```
(`isIsoDay` is exported from `lib/domain/details.ts`. Check `slugify('outstanding cheques')` yields `outstanding-cheques` — read `slugify`; if it does not, write the literal.)

- [ ] **Step 6: Run the three files and tsc**

Run: `node node_modules/vitest/vitest.mjs run tests/recon/outstanding.test.ts tests/recon/summary.test.ts tests/recon-view.test.ts`
Expected: PASS (22). `node node_modules/typescript/bin/tsc --noEmit` — clean.

- [ ] **Step 7: Commit**

```bash
git add lib/recon lib/recon-view.ts tests/recon tests/recon-view.test.ts
git commit -m "feat(recon): outstanding as of a day - the rule, the account summary, the view

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The read

**Files:**
- Create: `lib/recon/query.ts`
- Test: `tests/recon/query.test.ts`

**Interfaces:**
```ts
export type ReconFilters = { bankCode?: string; companyId?: string; cashAccountId?: string }
export async function listOutstandingCandidates(db, filters?: ReconFilters): Promise<OutstandingRow[]>  // RELEASED, isCheque, amount recorded; the as-of test is the caller's
export async function countExcludedIncomplete(db, filters?: ReconFilters): Promise<number>
```

- [ ] **Step 1: Write the failing test**

Create `tests/recon/query.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listOutstandingCandidates, countExcludedIncomplete } from '@/lib/recon/query'

beforeEach(resetDb)

describe('listOutstandingCandidates — the population', () => {
  it('holds RELEASED real cheques with an amount, whatever their clearing, and nothing else', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: '1' })
    const cleared = await makeCheck({ status: 'RELEASED', checkNumber: '2' })
    await testDb.check.update({ where: { id: cleared.id }, data: { clearingStatus: 'CLEARED', clearedDate: new Date('2026-09-01') } })
    await makeCheck({ status: 'SIGNED', checkNumber: '3' })
    await makeCheck({ status: 'VOIDED', checkNumber: '4' })
    await makeCheck({ status: 'RELEASED', checkNumber: '5', amount: null })
    await makeCheck({ status: 'RELEASED', checkNumber: '6', isCheque: false })
    const rows = await listOutstandingCandidates(testDb)
    expect(rows.map((r) => r.checkNumber).sort()).toEqual(['1', '2'])
    const two = rows.find((r) => r.checkNumber === '2')!
    expect(two.clearingStatus).toBe('CLEARED')
    expect(two.clearedDate).toEqual(new Date('2026-09-01'))
  })

  it('carries the account, bank, company and a decimal-string amount', async () => {
    const c = await makeCheck({ status: 'RELEASED', amount: '1234.50' })
    const account = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! }, include: { bank: true, company: true } })
    const [row] = await listOutstandingCandidates(testDb)
    expect(row).toMatchObject({
      id: c.id, accountId: account.id, account: account.code, bank: account.bank.code,
      company: account.company.code, currency: 'PHP', amount: '1234.50', status: 'RELEASED',
    })
    expect(typeof row.amount).toBe('string')
  })

  it('narrows by bank, company and account', async () => {
    const a = await makeCheck({ status: 'RELEASED', checkNumber: '1' })
    const b = await makeCheck({ status: 'RELEASED', checkNumber: '2' })
    const accA = await testDb.cashAccount.findUniqueOrThrow({ where: { id: a.cashAccountId! }, include: { bank: true } })
    expect((await listOutstandingCandidates(testDb, { bankCode: accA.bank.code })).map((r) => r.checkNumber)).toEqual(['1'])
    expect((await listOutstandingCandidates(testDb, { companyId: b.companyId })).map((r) => r.checkNumber)).toEqual(['2'])
    expect((await listOutstandingCandidates(testDb, { cashAccountId: accA.id })).map((r) => r.checkNumber)).toEqual(['1'])
  })

  it('keeps a released cheque with no cash account, with the bank from its checkbook if any', async () => {
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '9' })
    await testDb.check.update({ where: { id: c.id }, data: { cashAccountId: null } })
    const [row] = await listOutstandingCandidates(testDb)
    expect(row).toMatchObject({ checkNumber: '9', accountId: null, account: null, bank: null })
  })
})

describe('countExcludedIncomplete', () => {
  it('counts released cheques with no amount under the same filters', async () => {
    await makeCheck({ status: 'RELEASED', amount: null })
    await makeCheck({ status: 'SIGNED', amount: null })
    await makeCheck({ status: 'RELEASED' })
    expect(await countExcludedIncomplete(testDb)).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node node_modules/vitest/vitest.mjs run tests/recon/query.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: The query**

Create `lib/recon/query.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client'
import type { OutstandingRow } from './summary'

type Db = PrismaClient | Prisma.TransactionClient

export type ReconFilters = { bankCode?: string; companyId?: string; cashAccountId?: string }

/**
 * THE POPULATION the as-of rule is applied to: every released real cheque
 * with a recorded amount, whatever its clearing — the rule in
 * `lib/recon/outstanding.ts` decides per day, and it runs in the pure layer
 * so the page and the extract are struck over the same rows.
 *
 * The bank filter reads the cash account's bank, and for a cheque with no
 * cash account the checkbook's; the account filter is the cash account.
 */
function populationWhere(filters: ReconFilters): Prisma.CheckWhereInput {
  const where: Prisma.CheckWhereInput = { status: 'RELEASED', isCheque: true }
  if (filters.companyId) where.companyId = filters.companyId
  if (filters.cashAccountId) where.cashAccountId = filters.cashAccountId
  if (filters.bankCode) {
    where.OR = [
      { cashAccount: { bank: { code: filters.bankCode } } },
      { cashAccountId: null, checkBook: { bank: { code: filters.bankCode } } },
    ]
  }
  return where
}

export async function listOutstandingCandidates(db: Db, filters: ReconFilters = {}): Promise<OutstandingRow[]> {
  const checks = await db.check.findMany({
    where: { ...populationWhere(filters), isIncomplete: false, amount: { not: null } },
    orderBy: [{ cashAccount: { code: 'asc' } }, { checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: {
      id: true, checkNumber: true, payeeName: true, currency: true, amount: true, checkDate: true,
      releasedAt: true, clearingStatus: true, clearedDate: true, status: true,
      company: { select: { code: true } },
      cashAccount: { select: { id: true, code: true, bank: { select: { code: true } } } },
      checkBook: { select: { bank: { select: { code: true } } } },
      vendor: { select: { canonicalName: true } },
    },
  })
  return checks.flatMap((c) => {
    if (c.amount === null) return []
    return [{
      id: c.id,
      checkNumber: c.checkNumber,
      payee: c.payeeName ?? c.vendor?.canonicalName ?? null,
      accountId: c.cashAccount?.id ?? null,
      account: c.cashAccount?.code ?? null,
      bank: c.cashAccount?.bank.code ?? c.checkBook?.bank.code ?? null,
      company: c.company.code,
      currency: c.currency,
      amount: c.amount.toFixed(2),
      checkDate: c.checkDate,
      releasedAt: c.releasedAt,
      clearingStatus: c.clearingStatus,
      clearedDate: c.clearedDate,
      status: c.status,
    }]
  })
}

/** This report's own exclusion, under the same population and filters. */
export async function countExcludedIncomplete(db: Db, filters: ReconFilters = {}): Promise<number> {
  return db.check.count({ where: { ...populationWhere(filters), isIncomplete: true } })
}
```
(If `orderBy: { cashAccount: { code } }` is refused for a nullable relation by this Prisma version, order by `cashAccountId` then `checkDate` and note it — the summary sorts accounts itself.)

- [ ] **Step 4: Run and tsc**

Run: `node node_modules/vitest/vitest.mjs run tests/recon/query.test.ts`
Expected: PASS (5). `node node_modules/typescript/bin/tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/recon/query.ts tests/recon/query.test.ts
git commit -m "feat(recon): the released population, with its account, bank and company

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The workbook and the route

**Files:**
- Create: `lib/export/recon-workbook.ts`, `app/api/export/recon/route.ts`
- Test: `tests/export/recon-workbook.test.ts`, `tests/export/recon-route.test.ts`

**Interfaces:**
```ts
export const RECON_SUMMARY_SHEET = 'SUMMARY'
export const RECON_DETAIL_SHEET = 'DETAIL'
export const RECON_DETAIL_HEADERS = ['CHECK NUMBER', 'PAYEE', 'ACCOUNT', 'BANK', 'COMPANY', 'CHEQUE DATE', 'ISSUED', 'ISSUE BASIS', 'DAYS OUTSTANDING', 'CLEARING', 'CURRENCY', 'AMOUNT'] as const
export type ReconMeta = { asOfDay: string; generatedAt: Date; generatedBy: string; filterDescription: string; totalRows: number; incompleteCount: number }
export async function buildReconWorkbook(input: { summary: ReconSummary; detail: readonly OutstandingLine[]; meta: ReconMeta }): Promise<ArrayBuffer>
```
SUMMARY layout: A1 `OUTSTANDING CHEQUES AS OF <asOfDay> — CHECK RELEASE MONITORING`; A2 the filters; A3 the generated line and the scope (`DETAIL holds the FIRST n OF m cheques` when capped, else `m cheques`); A4 the premise sentence and the exclusion count; row 6 header `ACCOUNT · BANK · COMPANY · CURRENCY · OUTSTANDING · AMOUNT`; one line per account per currency; then `TOTAL` lines per currency, bold.

- [ ] **Step 1: Write the failing tests**

Create `tests/export/recon-workbook.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { summariseByAccount, type OutstandingRow } from '@/lib/recon/summary'
import { buildReconWorkbook, RECON_SUMMARY_SHEET, RECON_DETAIL_SHEET, RECON_DETAIL_HEADERS } from '@/lib/export/recon-workbook'

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
function row(o: Partial<OutstandingRow> & { id: string }): OutstandingRow {
  return {
    checkNumber: o.id, payee: 'HENKEL PHILIPPINES INC.', accountId: 'acc-bpi', account: 'BPI STK', bank: 'BPI',
    company: 'STK', currency: 'PHP', amount: '100.00', checkDate: d('2026-08-20'), releasedAt: null,
    clearingStatus: 'NONE', clearedDate: null, status: 'RELEASED', ...o,
  }
}

async function build(rows: OutstandingRow[], totalRows?: number) {
  const summary = summariseByAccount(rows, '2026-09-12')
  const buffer = await buildReconWorkbook({
    summary, detail: summary.lines,
    meta: {
      asOfDay: '2026-09-12', generatedAt: new Date('2026-09-12T02:00:00Z'), generatedBy: 'Paolo Parcon',
      filterDescription: 'No filters applied', totalRows: totalRows ?? summary.lines.length, incompleteCount: 25,
    },
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb
}

describe('buildReconWorkbook', () => {
  it('writes SUMMARY then DETAIL, titled by the as-of day, stating the exclusion', async () => {
    const wb = await build([row({ id: 'a' })])
    expect(wb.worksheets.map((w) => w.name)).toEqual([RECON_SUMMARY_SHEET, RECON_DETAIL_SHEET])
    const ws = wb.getWorksheet(RECON_SUMMARY_SHEET)!
    expect(String(ws.getCell('A1').value)).toContain('OUTSTANDING CHEQUES AS OF 2026-09-12')
    expect(String(ws.getCell('A2').value)).toContain('No filters applied')
    expect(String(ws.getCell('A4').value)).toContain('25')
  })

  it('writes one account line per currency with numeric amounts, then totals', async () => {
    const wb = await build([
      row({ id: 'a', amount: '100.00' }), row({ id: 'b', amount: '5.00', currency: 'USD' }),
      row({ id: 'c', accountId: 'acc-m', account: 'MBTC STK', bank: 'MBTC', amount: '7.00' }),
    ])
    const ws = wb.getWorksheet(RECON_SUMMARY_SHEET)!
    const lines: unknown[][] = []
    ws.eachRow((r) => lines.push(r.values as unknown[]))
    // ACCOUNT, BANK, COMPANY, CURRENCY, OUTSTANDING, AMOUNT
    const bpiPhp = lines.find((l) => l[1] === 'BPI STK' && l[4] === 'PHP')!
    expect(bpiPhp[5]).toBe(1)
    expect(bpiPhp[6]).toBe(100)
    const bpiUsd = lines.find((l) => l[1] === 'BPI STK' && l[4] === 'USD')!
    expect(bpiUsd[6]).toBe(5)
    const total = lines.find((l) => l[1] === 'TOTAL' && l[4] === 'PHP')!
    expect(total[5]).toBe(2)
    expect(total[6]).toBe(107)
  })

  it('lists one detail row per outstanding cheque under the fixed header', async () => {
    const wb = await build([row({ id: 'a' }), row({ id: 'b', releasedAt: new Date('2026-09-10T15:30:00Z') })])
    const ws = wb.getWorksheet(RECON_DETAIL_SHEET)!
    expect((ws.getRow(1).values as string[]).slice(1)).toEqual([...RECON_DETAIL_HEADERS])
    const a = ws.getRow(2).values as unknown[]
    expect(a[1]).toBe('a')
    expect(a[8]).toBe('CHEQUE DATE')
    expect(a[9]).toBe(23)
    expect(a[10]).toBe('NONE')
    expect(a[12]).toBe(100)
    const b = ws.getRow(3).values as unknown[]
    expect(b[8]).toBe('RELEASED AT')
    expect(b[9]).toBe(2)
  })

  it('says so in the title block when the cap bit', async () => {
    const wb = await build([row({ id: 'a' })], 20_000)
    expect(String(wb.getWorksheet(RECON_SUMMARY_SHEET)!.getCell('A3').value)).toContain('FIRST 1 OF 20,000')
  })
})
```

Create `tests/export/recon-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { RECON_DETAIL_SHEET } from '@/lib/export/recon-workbook'

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => state.user }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: new Proxy(testDb, { get(t, p, r) { state.dbTouches += 1; return Reflect.get(t, p, r) } }) }
})

const SIGNED_IN = { id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER' }
async function get(url: string) {
  const { GET } = await import('@/app/api/export/recon/route')
  return GET(new Request(url))
}

beforeEach(async () => {
  await resetDb()
  state.user = SIGNED_IN
  state.dbTouches = 0
})

describe('GET /api/export/recon', () => {
  it('refuses an unauthenticated request with 401 and touches nothing', async () => {
    state.user = null
    const res = await get('http://localhost/api/export/recon')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('serves a file named by the as-of day, never cached', async () => {
    await makeCheck({ status: 'RELEASED' })
    const res = await get('http://localhost/api/export/recon?asOf=2026-08-31')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('outstanding-cheques-2026-08-31.xlsx')
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('applies the as-of day — the file is the view', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: '1', checkDate: new Date('2026-08-20') })
    await makeCheck({ status: 'RELEASED', checkNumber: '2', checkDate: new Date('2026-09-05') })
    const res = await get('http://localhost/api/export/recon?asOf=2026-08-31')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const ws = wb.getWorksheet(RECON_DETAIL_SHEET)!
    expect(ws.rowCount).toBe(2)
    expect(ws.getRow(2).getCell(1).value).toBe('1')
  })
})
```

- [ ] **Step 2: Run the workbook test to verify failure**

Run: `node node_modules/vitest/vitest.mjs run tests/export/recon-workbook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: The workbook**

Create `lib/export/recon-workbook.ts`, modelled on `lib/export/forecast-workbook.ts` (same imports: `ExcelJS`, `currencyNumberFormat`, `fitColumnWidth` from `./report`; `BAND_FILL`, `COUNT_FORMAT`, `DATE_FORMAT`, `DATE_WIDTH_SAMPLE`, `styleHeaderCell` from `./sheet-style`):

```ts
import ExcelJS from 'exceljs'
import { currencyNumberFormat, fitColumnWidth } from './report'
import { BAND_FILL, COUNT_FORMAT, DATE_FORMAT, DATE_WIDTH_SAMPLE, styleHeaderCell } from './sheet-style'
import type { ReconSummary, OutstandingLine } from '@/lib/recon/summary'

/**
 * Outstanding cheques as a workbook: SUMMARY is the account table the Cash
 * Balance sheet's OC column is typed from; DETAIL is every cheque behind it.
 * The file is the view — the as-of day and the filters are in the title
 * block. Amounts are Excel numbers in the cells, the one sanctioned use of a
 * JS number for money; the adding was done in centavos in `summary.ts`.
 */
export const RECON_SUMMARY_SHEET = 'SUMMARY'
export const RECON_DETAIL_SHEET = 'DETAIL'
export const RECON_DETAIL_HEADERS = [
  'CHECK NUMBER', 'PAYEE', 'ACCOUNT', 'BANK', 'COMPANY', 'CHEQUE DATE', 'ISSUED', 'ISSUE BASIS',
  'DAYS OUTSTANDING', 'CLEARING', 'CURRENCY', 'AMOUNT',
] as const
const SUMMARY_HEADERS = ['ACCOUNT', 'BANK', 'COMPANY', 'CURRENCY', 'OUTSTANDING', 'AMOUNT'] as const

export type ReconMeta = {
  asOfDay: string
  generatedAt: Date
  generatedBy: string
  filterDescription: string
  totalRows: number
  incompleteCount: number
}

const TITLE_INK = 'FF0F172A'
const MUTED_INK = 'FF475569'
const count = (n: number) => n.toLocaleString('en-PH')
const dayCell = (day: string | null) => (day ? new Date(`${day}T00:00:00Z`) : null)

function generatedLine(meta: ReconMeta): string {
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })
  return `Generated ${stamp} by ${meta.generatedBy}`
}

export async function buildReconWorkbook(
  { summary, detail, meta }: { summary: ReconSummary; detail: readonly OutstandingLine[]; meta: ReconMeta },
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt

  const ws = wb.addWorksheet(RECON_SUMMARY_SHEET)
  ws.getCell('A1').value = `OUTSTANDING CHEQUES AS OF ${meta.asOfDay} — CHECK RELEASE MONITORING`
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE_INK } }
  ws.getRow(1).height = 24
  ws.getCell('A2').value = meta.filterDescription
  ws.getCell('A2').font = { bold: true, size: 12, color: { argb: TITLE_INK } }
  ws.getCell('A3').value = detail.length < meta.totalRows
    ? `${generatedLine(meta)}  ·  DETAIL holds the FIRST ${count(detail.length)} OF ${count(meta.totalRows)} cheques`
    : `${generatedLine(meta)}  ·  ${count(meta.totalRows)} cheque${meta.totalRows === 1 ? '' : 's'}`
  ws.getCell('A3').font = { size: 10, color: { argb: MUTED_INK } }
  ws.getCell('A4').value =
    `Outstanding means released and not cleared by the bank as of the day. Where no release date was ` +
    `recorded, the cheque date stands in. Excludes ${count(meta.incompleteCount)} released ` +
    `cheque${meta.incompleteCount === 1 ? '' : 's'} with no recorded amount.`
  ws.getCell('A4').font = { size: 10, color: { argb: MUTED_INK } }

  const header = ws.getRow(6)
  SUMMARY_HEADERS.forEach((label, i) => styleHeaderCell(header.getCell(i + 1), label, i >= 4 ? 'right' : 'left'))

  let r = 7
  let band = false
  const writeLine = (account: string, bank: string | null, company: string, t: { currency: string; count: number; total: string }, bold: boolean) => {
    const row = ws.getRow(r)
    row.getCell(1).value = account
    row.getCell(2).value = bank
    row.getCell(3).value = company
    row.getCell(4).value = t.currency
    row.getCell(5).value = t.count
    row.getCell(5).numFmt = COUNT_FORMAT
    row.getCell(6).value = Number(t.total)
    row.getCell(6).numFmt = currencyNumberFormat(t.currency)
    if (bold) row.font = { bold: true }
    if (band && !bold) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
    r += 1
  }
  for (const a of summary.accounts) {
    for (const t of a.totals) writeLine(a.account, a.bank, a.company, t, false)
    band = !band
  }
  for (const t of summary.totals) writeLine('TOTAL', null, '', t, true)
  ws.getColumn(1).width = 22
  ws.getColumn(2).width = 10
  ws.getColumn(3).width = 12
  ws.getColumn(4).width = 10
  ws.getColumn(5).width = 14
  ws.getColumn(6).width = 20

  const dws = wb.addWorksheet(RECON_DETAIL_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  const dh = dws.getRow(1)
  RECON_DETAIL_HEADERS.forEach((label, i) => {
    styleHeaderCell(dh.getCell(i + 1), label, label === 'AMOUNT' || label === 'DAYS OUTSTANDING' ? 'right' : 'left')
  })
  dh.height = 20
  const samples: string[][] = RECON_DETAIL_HEADERS.map(() => [])
  detail.forEach((l, i) => {
    const row = dws.getRow(i + 2)
    const values: (string | number | Date | null)[] = [
      l.checkNumber, l.payee, l.account, l.bank, l.company, l.checkDate, dayCell(l.issuedDay), l.basis,
      l.days, l.clearingStatus, l.currency, Number(l.amount),
    ]
    values.forEach((v, col) => {
      const cell = row.getCell(col + 1)
      cell.value = v
      if (v instanceof Date) cell.numFmt = DATE_FORMAT
      samples[col].push(v === null ? '' : v instanceof Date ? DATE_WIDTH_SAMPLE : String(v))
    })
    row.getCell(12).numFmt = currencyNumberFormat(l.currency)
    row.getCell(9).numFmt = COUNT_FORMAT
    if (i % 2 === 1) row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
  })
  RECON_DETAIL_HEADERS.forEach((label, i) => { dws.getColumn(i + 1).width = fitColumnWidth(label, samples[i]) })
  dws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + detail.length, column: RECON_DETAIL_HEADERS.length } }

  return wb.xlsx.writeBuffer()
}
```

- [ ] **Step 4: The route**

Create `app/api/export/recon/route.ts`, modelled on `app/api/export/forecast/route.ts`:

```ts
import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { listBankCodes } from '@/lib/forecast/query'
import { listOutstandingCandidates, countExcludedIncomplete } from '@/lib/recon/query'
import { summariseByAccount } from '@/lib/recon/summary'
import { parseAsOf, describeReconFilters, reconFilename } from '@/lib/recon-view'
import { buildReconWorkbook } from '@/lib/export/recon-workbook'
import { loadSettings } from '@/lib/settings/read'

/**
 * EXPORT THE OUTSTANDING CHEQUES. The file is the view: the as-of day and the
 * filters are in the title block. Authenticates on its first line — 401, not a
 * redirect — as every export route does; never on the public list.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
  }

  const params = new URL(request.url).searchParams
  const now = new Date()
  const asOfDay = parseAsOf(params.get('asOf') ?? undefined, now)
  const [options, banks, settings] = await Promise.all([getFilterOptions(prisma), listBankCodes(prisma), loadSettings(prisma)])
  const bankParam = params.get('bank')?.trim() || undefined
  const bank = bankParam && banks.includes(bankParam) ? bankParam : undefined
  const company = options.companies.find((c) => c.id === (params.get('company')?.trim() || undefined))
  const account = options.cashAccounts.find((a) => a.id === (params.get('account')?.trim() || undefined))
  const filters = { bankCode: bank, companyId: company?.id, cashAccountId: account?.id }

  const [rows, incompleteCount] = await Promise.all([
    listOutstandingCandidates(prisma, filters),
    countExcludedIncomplete(prisma, filters),
  ])
  const summary = summariseByAccount(rows, asOfDay)

  const workbook = await buildReconWorkbook({
    summary,
    detail: summary.lines.slice(0, settings.values['caps.exportRows']),
    meta: {
      asOfDay, generatedAt: now, generatedBy: user.name,
      filterDescription: describeReconFilters({ bank, company: company?.code, account: account?.code }),
      totalRows: summary.lines.length, incompleteCount,
    },
  })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${reconFilename(asOfDay)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
```
(`getFilterOptions` returns `companies: { id, code, name }[]` and `cashAccounts: { id, code, bankCode }[]` — see `lib/queries.ts:377-391`.)

- [ ] **Step 5: Run both test files and tsc**

Run: `node node_modules/vitest/vitest.mjs run tests/export/recon-workbook.test.ts` then `node node_modules/vitest/vitest.mjs run tests/export/recon-route.test.ts`.
Expected: PASS (4 + 3). `node node_modules/typescript/bin/tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add lib/export/recon-workbook.ts app/api/export/recon tests/export/recon-workbook.test.ts tests/export/recon-route.test.ts
git commit -m "feat(recon): the extract - SUMMARY per account, DETAIL per cheque, as of a day

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The page

**Files:**
- Create: `app/recon/page.tsx`, `components/ReconTable.tsx`, `components/OutstandingList.tsx`
- Modify: `components/AppHeader.tsx`, `CLAUDE.md`
- Test: none new; `tsc` and `next build`

- [ ] **Step 1: The components**

Create `components/ReconTable.tsx` (server component):

```tsx
import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import type { ReconSummary, AccountTotal } from '@/lib/recon/summary'
import { reconHref, type ReconParams } from '@/lib/recon-view'

function Totals({ totals }: { totals: AccountTotal[] }) {
  if (totals.length === 0) return <span className="text-slate-300">—</span>
  return (
    <div className="space-y-0.5">
      {totals.map((t) => (
        <div key={t.currency} className="tabular-nums">
          <span className="text-slate-500">{t.count.toLocaleString('en-PH')} · </span>{formatMoney(t.total, t.currency)}
        </div>
      ))}
    </div>
  )
}

/** One row per cash account, in the Cash Balance sheet's order; each links to its list. */
export function ReconTable({ summary, params }: { summary: ReconSummary; params: ReconParams }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">ACCOUNT</th><th className="px-4 py-3">BANK</th><th className="px-4 py-3">COMPANY</th>
            <th className="px-4 py-3 text-right">OUTSTANDING · AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          {summary.accounts.map((a) => (
            <tr key={a.accountId ?? a.account} className="border-b border-slate-100 odd:bg-white even:bg-ground">
              <td className="px-4 py-3 font-medium">
                {a.accountId
                  ? <Link href={reconHref({ ...params, account: a.accountId })} className="underline underline-offset-2">{a.account}</Link>
                  : a.account}
              </td>
              <td className="px-4 py-3">{a.bank ?? '—'}</td>
              <td className="px-4 py-3">{a.company}</td>
              <td className="px-4 py-3 text-right"><Totals totals={a.totals} /></td>
            </tr>
          ))}
          <tr className="border-t border-hairline bg-navy-bg font-semibold">
            <td className="px-4 py-3" colSpan={3}>TOTAL</td>
            <td className="px-4 py-3 text-right"><Totals totals={summary.totals} /></td>
          </tr>
        </tbody>
      </table>
    </section>
  )
}
```

Create `components/OutstandingList.tsx` (server component):

```tsx
import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import type { OutstandingLine } from '@/lib/recon/summary'

const fmtDay = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const fmtIso = (day: string | null) => (day ? fmtDay(new Date(`${day}T00:00:00Z`)) : '—')

/** The cheques behind one account's figure. */
export function OutstandingList({ lines }: { lines: readonly OutstandingLine[] }) {
  return (
    <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">CHECK NUMBER</th><th className="px-4 py-3">PAYEE</th><th className="px-4 py-3">CHEQUE DATE</th>
            <th className="px-4 py-3">ISSUED</th><th className="px-4 py-3 text-right">DAYS</th><th className="px-4 py-3">CLEARING</th>
            <th className="px-4 py-3 text-right">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-b border-slate-100 odd:bg-white even:bg-ground">
              <td className="px-4 py-3 tabular-nums"><Link href={`/checks/${l.id}`} className="underline underline-offset-2">{l.checkNumber}</Link></td>
              <td className="px-4 py-3">{l.payee ?? '—'}</td>
              <td className="px-4 py-3">{fmtDay(l.checkDate)}</td>
              <td className="px-4 py-3">
                {fmtIso(l.issuedDay)}
                {l.basis === 'CHEQUE DATE' && <span className="ml-2 text-xs text-slate-500">from register</span>}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{l.days ?? '—'}</td>
              <td className="px-4 py-3">{l.clearingStatus}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMoney(l.amount, l.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
```

- [ ] **Step 2: The page**

Create `app/recon/page.tsx`:

```tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { listBankCodes } from '@/lib/forecast/query'
import { listOutstandingCandidates, countExcludedIncomplete } from '@/lib/recon/query'
import { summariseByAccount } from '@/lib/recon/summary'
import { RECON_PATH, RECON_EXPORT_PATH, parseAsOf, reconHref, describeReconFilters } from '@/lib/recon-view'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { ReconTable } from '@/components/ReconTable'
import { OutstandingList } from '@/components/OutstandingList'

/**
 * OUTSTANDING CHEQUES — the cheque side of the bank reconciliation.
 *
 * For a day, every cash account's released-and-not-cleared cheques: the OC
 * column of Finance's Cash Balance sheet, computed from what this system
 * records (built 2026-09-12). Everything shown is decided in `lib/recon/`;
 * the page reads parameters, runs one query, and renders. The export runs
 * the same query with the same day and filters, so the file and the screen
 * agree.
 */
export default async function ReconPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; bank?: string; company?: string; account?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const now = new Date()
  const asOfDay = parseAsOf(params.asOf, now)

  const [options, banks] = await Promise.all([getFilterOptions(prisma), listBankCodes(prisma)])
  const bank = banks.includes(params.bank?.trim() ?? '') ? params.bank!.trim() : undefined
  const company = options.companies.find((c) => c.id === params.company?.trim())
  const account = options.cashAccounts.find((a) => a.id === params.account?.trim())
  const filters = { bankCode: bank, companyId: company?.id, cashAccountId: account?.id }

  const [rows, incompleteCount] = await Promise.all([
    listOutstandingCandidates(prisma, filters),
    countExcludedIncomplete(prisma, filters),
  ])
  const summary = summariseByAccount(rows, asOfDay)

  const current = { asOf: asOfDay, bank, company: company?.id, account: account?.id }
  const anyFilter = Boolean(bank || company || account || params.asOf)
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <AppHeader user={user} title="OUTSTANDING CHEQUES" back={{ href: '/', label: '← DASHBOARD' }} showReconLink={false} />

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        Outstanding means released and not yet cleared by the bank as of the date. Where no release date
        was recorded, the cheque date stands in. Record clearing on the cheque or on{' '}
        <Link href="/clearing" className="underline underline-offset-2">CLEARING</Link> to move a cheque off this list.
      </p>

      <form className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline" method="get">
        <label htmlFor="recon-asOf" className="text-[11px] font-semibold tracking-widest text-slate-400">AS OF</label>
        <input id="recon-asOf" name="asOf" type="date" defaultValue={asOfDay} className={field} />
        <label className="sr-only" htmlFor="recon-bank">BANK</label>
        <select id="recon-bank" name="bank" defaultValue={bank ?? ''} className={field}>
          <option value="">ANY BANK</option>
          {banks.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <label className="sr-only" htmlFor="recon-company">COMPANY</label>
        <select id="recon-company" name="company" defaultValue={company?.id ?? ''} className={field}>
          <option value="">ANY COMPANY</option>
          {options.companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
        </select>
        {account && <input type="hidden" name="account" value={account.id} />}
        <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">APPLY</button>
        {anyFilter && <Link href={RECON_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            {summary.lines.length.toLocaleString('en-PH')} CHEQUE{summary.lines.length === 1 ? '' : 'S'} OUTSTANDING AS OF {asOfDay}
            {' · '}{describeReconFilters({ bank, company: company?.code, account: account?.code })}
          </p>
          {incompleteCount > 0 && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              EXCLUDES {incompleteCount.toLocaleString('en-PH')} RELEASED CHEQUE{incompleteCount === 1 ? '' : 'S'} WITH NO RECORDED AMOUNT.{' '}
              <Link href="/?incomplete=1" className="underline underline-offset-2">Show them</Link>.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-500">The file holds this view, as of this day.</span>
          <a href={reconHref(current, RECON_EXPORT_PATH)} className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">EXPORT EXCEL</a>
        </div>
      </div>

      {summary.lines.length === 0 ? (
        <EmptyState title="NOTHING OUTSTANDING" tone={anyFilter ? 'plain' : 'good'}>
          {anyFilter ? 'No released cheque under these filters was uncleared on that day.' : 'Every released cheque has cleared.'}
        </EmptyState>
      ) : (
        <>
          <ReconTable summary={summary} params={current} />
          {account && (
            <>
              <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">{account.code} — THE CHEQUES</h2>
              <OutstandingList lines={summary.lines} />
            </>
          )}
        </>
      )}
    </main>
  )
}
```

`components/AppHeader.tsx`: prop `showReconLink = true` (`/** False on the recon page, which IS the recon screen. */`) and after CLEARING:
```tsx
        {showReconLink && (
          <Link href="/recon" className="underline underline-offset-2">RECON</Link>
        )}
```

- [ ] **Step 3: CLAUDE.md**

In "What is missing" item 10, replace the closing two sentences (`The other three reports Finance named — bank reconciliation, hedging, foreign outlook — are not buildable here; the voucher-index spec's closing section records why and where their sources actually live.`) with: `Of the other three reports Finance named, **the bank reconciliation's cheque side is built** (2026-09-12): `/recon` gives every cash account's outstanding cheques — released and not cleared — as of a day, the OC column of the Cash Balance sheet, with its extract; deposits in transit and the balances stay with the bank statement, whose import waits for a sample export. Hedging and the foreign outlook are not buildable here; the voucher-index spec's closing section records why.`

In the Layout table add a row: `| \`lib/recon/\` | Outstanding cheques: \`outstanding.ts\` (the as-of rule, pure), \`summary.ts\` (per account, centavo-exact, pure), \`query.ts\` (the released population). \`/recon\` and \`/api/export/recon\` sit on it. |`

- [ ] **Step 4: tsc, build, commit**

Run: `node node_modules/typescript/bin/tsc --noEmit` — clean. `node node_modules/next/dist/bin/next build` — `/recon` and `/api/export/recon` listed.

```bash
git add app/recon components/ReconTable.tsx components/OutstandingList.tsx components/AppHeader.tsx CLAUDE.md
git commit -m "feat: /recon - outstanding cheques per cash account as of a day

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** A the rule with all four clauses and both bases (Task 1); B the read, the exclusion count, the summary with `(NO ACCOUNT)` last (Tasks 1–2); C the page with AS OF / BANK / COMPANY, the premise, the account table linking to the list, the count line, the exclusion, the RECON link, EXPORT (Task 4); D the extract with SUMMARY and DETAIL, the cap from settings, the filename (Task 3). Testing list — every file appears except `tests/recon-view.test.ts` sits at `tests/` root as the spec names it.

**Deviations, stated.** (1) `listCashAccounts` is not created: the page and route read accounts from `getFilterOptions`, which already lists them with bank codes, and the summary orders accounts itself. (2) `clearedOn` is a third exported helper the spec did not name. (3) The list under an account uses the page's own `summary.lines`, already narrowed by the account filter, rather than a second query.

**Type consistency.** `OutstandingRow` (Task 1 `summary.ts`) is what `query.ts` (Task 2) returns and `recon-workbook.ts` (Task 3) reads; `OutstandingLine`/`ReconSummary` flow to the components (Task 4); `ReconParams`/`reconHref` are shared by the page and `ReconTable`.
