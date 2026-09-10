# Voucher Index Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate `CHECK BY VOUCHER.xlsx` — one row per AP voucher saying which cheque pays it and where that cheque sits — so the Finance Executive Report's `AP Local` sheet can replace three `VLOOKUP`s that broke when the register was retired.

**Architecture:** Four files in `lib/export/` plus one route, following the split the register export already uses: a **pure** resolver that turns candidate rows into one row per voucher and can be tested with literals, a query that only reads, an ExcelJS renderer, and a route handler that authenticates on its own first line. Nothing writes.

**Tech Stack:** Next 15 App Router route handler · Prisma 6 raw SQL (`unnest` over `Check.apvNumbers`, served by the existing GIN index) · ExcelJS · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-voucher-index-export-design.md`. Read it before Task 1 — it carries the measurements every decision below rests on.

## Global Constraints

- **`npx tsc --noEmit` must pass before any task is called done.** Vitest transpiles with esbuild, which erases types; this project has repeatedly had a green suite over unsound types.
- **On Windows use `npx.cmd` / `npm.cmd`.** PowerShell's execution policy blocks `npx.ps1`.
- **One agent at a time against the test database.** All test files share one Neon database and `resetDb()` truncates it.
- **Amounts are decimal strings end to end, never a JS number.** Not directly at issue here — this export deliberately carries no amount column — but do not add one.
- **`middleware.ts` does not run.** Every request-time control lives in the request path. The route authenticates itself.
- **Never commit or print the `.xlsx` workbooks, `.env`, or any credential.** `*.xlsx` is gitignored; keep it that way.
- **This feature never writes to the database.** No migration, no `Check` column, no audit row.
- Sheet name `INDEX` and filename `CHECK BY VOUCHER.xlsx` are **fixed** — they are half of an external reference stored inside the Executive Report.
- The 129 `isIncomplete` cheques are **excluded**, consistent with the ruling of 2026-09-06.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/export/voucher-index.ts` | **Create.** Pure. Constants, types, and `resolveVoucherRows` — every rule about which cheque wins and when a cell goes blank. No database, no ExcelJS, no clock. |
| `lib/export/voucher-query.ts` | **Create.** Two reads: cheque candidates and staged candidates. Resolves nothing. |
| `lib/export/sheet-style.ts` | **Create.** The palette and header styling both generated workbooks share, lifted out of `workbook.ts` so the two cannot drift apart. |
| `lib/export/workbook.ts` | **Modify.** Its private style constants move to `sheet-style.ts`; nothing it renders changes. |
| `lib/export/voucher-workbook.ts` | **Create.** ExcelJS rendering, beside `workbook.ts`. |
| `app/api/export/vouchers/route.ts` | **Create.** Auth, assemble, respond with the fixed filename. |
| `components/QuickActions.tsx` | **Modify.** One more anchor. |
| `tests/export/voucher-index.test.ts` | **Create.** The resolver, with literals. Fast — no database. |
| `tests/export/voucher-query.test.ts` | **Create.** The reads, against the test database. |
| `tests/export/voucher-workbook.test.ts` | **Create.** Generate to a buffer, read cells back. |
| `tests/export/voucher-route.test.ts` | **Create.** The guard, and the filename. |

---

### Task 1: The pure resolver

This is the whole feature's judgement in one file. Everything else is plumbing.

**Files:**
- Create: `lib/export/voucher-index.ts`
- Test: `tests/export/voucher-index.test.ts`

**Interfaces:**
- Consumes: `statusWords` from `lib/export/report.ts`; `CheckStatus` from `@prisma/client`.
- Produces:
  - `VOUCHER_INDEX_SHEET = 'INDEX'`, `VOUCHER_INDEX_FILENAME = 'CHECK BY VOUCHER.xlsx'`, `VOUCHER_INDEX_ROW_LIMIT = 15_000`, `VOUCHER_INDEX_HREF = '/api/export/vouchers'`
  - `VOUCHER_HEADERS`, `VOUCHER_HEADER_ROW = 6`, `VOUCHER_FIRST_DATA_ROW = 7`
  - `CONTESTED`, `ALL_CANCELLED`, `NOT_KEYED`
  - `type CheckCandidate`, `type StagedCandidate`, `type VoucherIndexInput`, `type VoucherRow`
  - `resolveVoucherRows(input: VoucherIndexInput): VoucherRow[]`
  - `describeVoucherScope(exported: number, total: number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/export/voucher-index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  resolveVoucherRows, describeVoucherScope, VOUCHER_HEADERS,
  CONTESTED, ALL_CANCELLED, NOT_KEYED,
  type CheckCandidate, type StagedCandidate,
} from '@/lib/export/voucher-index'

/**
 * The resolver decides which cheque answers a voucher. Every case here was
 * measured against production on 2026-09-10 over the Executive Report's
 * `AP Local` sheet — see the spec. No database: candidates in, rows out.
 */
function candidate(overrides: Partial<CheckCandidate> & { voucher: string }): CheckCandidate {
  return {
    checkNumber: '6000353106',
    status: 'SIGNED',
    bank: 'BPI',
    company: 'STK',
    checkDate: new Date('2026-08-13'),
    payee: 'HENKEL PHILIPPINES INC.',
    releasedAt: null,
    ...overrides,
  }
}

function stagedCandidate(overrides: Partial<StagedCandidate> & { voucher: string }): StagedCandidate {
  return {
    sourceSheet: 'BPI STK',
    sourceRow: 412,
    statedCheckRef: null,
    checkNumber: '6000353110',
    acumaticaRef: null,
    ...overrides,
  }
}

describe('resolveVoucherRows — one row per voucher', () => {
  it('answers a voucher naming a single live cheque', () => {
    const [row] = resolveVoucherRows({
      checks: [candidate({ voucher: 'AP-ST042652' })],
      staged: [],
    })
    expect(row.voucher).toBe('AP-ST042652')
    expect(row.checkNumber).toBe('6000353106')
    expect(row.status).toBe('SIGNED')
    expect(row.bank).toBe('BPI')
    expect(row.supersedes).toBeNull()
    expect(row.remarks).toBeNull()
  })

  it('names the live cheque and lists its dead predecessors — 46 measured re-issues', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-A1033692', checkNumber: '6000300001', status: 'VOIDED' }),
        candidate({ voucher: 'AP-A1033692', checkNumber: '6000300002', status: 'READY_FOR_RELEASE' }),
      ],
      staged: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].checkNumber).toBe('6000300002')
    expect(rows[0].status).toBe('READY FOR RELEASE')
    expect(rows[0].supersedes).toBe('6000300001 (VOIDED)')
  })

  it('refuses to pick when two LIVE cheques name the voucher — 6 measured', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-ST036567', checkNumber: '6000300003', status: 'SIGNED' }),
        candidate({ voucher: 'AP-ST036567', checkNumber: '6000300004', status: 'READY_FOR_RELEASE' }),
      ],
      staged: [],
    })
    expect(rows[0].checkNumber).toBeNull()
    expect(rows[0].status).toBe(CONTESTED)
    expect(rows[0].remarks).toContain('6000300003')
    expect(rows[0].remarks).toContain('6000300004')
  })

  it('still answers when the only cheque was cancelled — 35 measured', () => {
    const rows = resolveVoucherRows({
      checks: [candidate({ voucher: 'AP-HF000123', status: 'CANCELLED' })],
      staged: [],
    })
    expect(rows[0].checkNumber).toBe('6000353106')
    expect(rows[0].status).toBe('CANCELLED')
  })

  it('blanks the number when EVERY cheque naming the voucher is dead — 2 measured', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-ST042976', checkNumber: '6000300005', status: 'VOIDED' }),
        candidate({ voucher: 'AP-ST042976', checkNumber: '6000300006', status: 'CANCELLED' }),
      ],
      staged: [],
    })
    expect(rows[0].checkNumber).toBeNull()
    expect(rows[0].status).toBe(ALL_CANCELLED)
    expect(rows[0].remarks).toContain('6000300005')
  })

  it('reports a staged voucher without giving a cheque number — 51 measured', () => {
    const rows = resolveVoucherRows({
      checks: [],
      staged: [stagedCandidate({ voucher: 'AP-A1-02663' })],
    })
    expect(rows[0].checkNumber).toBeNull()
    expect(rows[0].status).toBe(NOT_KEYED)
    expect(rows[0].remarks).toContain('/admin/staged')
    expect(rows[0].remarks).toContain('BPI STK row 412')
  })

  it('prefers the cheque over a staged row naming the same voucher', () => {
    const rows = resolveVoucherRows({
      checks: [candidate({ voucher: 'AP-ST042652' })],
      staged: [stagedCandidate({ voucher: 'AP-ST042652' })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].checkNumber).toBe('6000353106')
  })

  it('sorts by voucher, so two runs produce the same file', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-ST000002' }),
        candidate({ voucher: 'AP-A1000001' }),
      ],
      staged: [],
    })
    expect(rows.map((r) => r.voucher)).toEqual(['AP-A1000001', 'AP-ST000002'])
  })
})

describe('the sheet is shaped for VLOOKUP', () => {
  it('puts VOUCHER in the first column', () => {
    expect(VOUCHER_HEADERS[0]).toBe('VOUCHER')
  })

  it('carries no amount column', () => {
    expect(VOUCHER_HEADERS.some((h) => h.includes('AMOUNT'))).toBe(false)
  })
})

describe('describeVoucherScope', () => {
  it('says so when the cap bites', () => {
    expect(describeVoucherScope(15_000, 20_100)).toBe('FIRST 15,000 OF 20,100 VOUCHERS')
  })

  it('states the count when it does not', () => {
    expect(describeVoucherScope(10_985, 10_985)).toBe('10,985 VOUCHERS')
  })

  it('does not leave an empty file silent', () => {
    expect(describeVoucherScope(0, 0)).toBe('NO VOUCHERS')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/export/voucher-index.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/export/voucher-index"`.

- [ ] **Step 3: Write the resolver**

Create `lib/export/voucher-index.ts`:

```ts
import type { CheckStatus } from '@prisma/client'
import { statusWords } from './report'

/**
 * THE VOUCHER INDEX — one row per AP voucher, saying which cheque pays it.
 *
 * It exists because the Finance Executive Report's `AP Local` sheet found a
 * payable's cheque with three VLOOKUPs into the released sheets of
 * `CHECK MONITORING <date>.xlsx`, and that register was retired on 2026-09-10.
 * A VLOOKUP into a stale external does not fail; it returns its last cached
 * value indefinitely. See docs/superpowers/specs/2026-09-10-voucher-index-export-design.md.
 *
 * PURE. No database, no ExcelJS, no clock — the decisions worth pinning by test
 * are decisions, and a test that has to open a spreadsheet to check them is a
 * test nobody runs. Same split as `report.ts` and `workbook.ts`.
 */

/**
 * FIXED, both of them. They are half of an external reference stored inside the
 * Executive Report: `='…\[CHECK BY VOUCHER.xlsx]INDEX'!$A$2`. A dated filename
 * would break the link on every regeneration, which is the failure being fixed.
 *
 * The price of a fixed name is that a stale copy looks identical to a fresh one,
 * which is why the generation timestamp goes in a fixed cell — see
 * `voucher-workbook.ts` and `TIMESTAMP_CELL`.
 */
export const VOUCHER_INDEX_SHEET = 'INDEX'
export const VOUCHER_INDEX_FILENAME = 'CHECK BY VOUCHER.xlsx'

/** Where the dashboard's anchor points. Stated once so the link and the route agree. */
export const VOUCHER_INDEX_HREF = '/api/export/vouchers'

/**
 * The most rows one index will contain.
 *
 * A CAP, not streaming, for the same reason `EXPORT_ROW_LIMIT` is one: the
 * workbook is assembled whole in memory inside a serverless function, and the
 * column widths are fitted to the full row set before the first byte is written.
 *
 * 15,000 rather than the register export's 10,000 because this row is narrower —
 * ten short columns, no amounts, no second sheet — and today's population is
 * ~10,985 vouchers. That is ~37% headroom. RE-MEASURE it the way the original
 * was measured before raising it further; do not reason from the ratio.
 *
 * The cap is never silent: `describeVoucherScope` writes it into the title block.
 */
export const VOUCHER_INDEX_ROW_LIMIT = 15_000

/**
 * `VOUCHER` is FIRST and must stay first. VLOOKUP searches the first column of
 * the range it is given and cannot be told to search any other.
 *
 * There is deliberately NO AMOUNT COLUMN. A cheque can settle several bills, so
 * its amount is not the `Detail Total` sitting beside it on `AP Local`, and the
 * two would eventually be subtracted from one another. `StagedBill` omits an
 * amount for the mirror image of this reason. Client decision, 2026-09-10.
 */
export const VOUCHER_HEADERS = [
  'VOUCHER', 'CHECK NUMBER', 'BANK', 'COMPANY', 'STATUS',
  'CHECK DATE', 'PAYEE', 'RELEASED', 'SUPERSEDES', 'REMARKS',
] as const

/** Four lines of title block, one blank row, header on 6, first voucher on 7. */
export const VOUCHER_HEADER_ROW = 6
export const VOUCHER_FIRST_DATA_ROW = VOUCHER_HEADER_ROW + 1

/**
 * Three statuses that are not a `CheckStatus`, because they are facts about the
 * ROW rather than about a cheque. Spelled in the same voice as `statusWords`
 * output so the column reads consistently.
 */
export const CONTESTED = 'CONTESTED'
export const ALL_CANCELLED = 'ALL CANCELLED'
export const NOT_KEYED = 'NOT KEYED'

/** A cheque is dead when it can never be released. */
const DEAD_STATUSES: readonly CheckStatus[] = ['CANCELLED', 'VOIDED']
function isDead(status: CheckStatus): boolean {
  return DEAD_STATUSES.includes(status)
}

/** One (voucher, cheque) pair as the database hands it over. */
export type CheckCandidate = {
  voucher: string
  checkNumber: string
  status: CheckStatus
  bank: string | null
  company: string
  checkDate: Date | null
  payee: string | null
  releasedAt: Date | null
}

/** One (voucher, staged row) pair. A staged row has no company, so no bank. */
export type StagedCandidate = {
  voucher: string
  sourceSheet: string | null
  sourceRow: number | null
  statedCheckRef: string | null
  checkNumber: string | null
  acumaticaRef: string | null
}

export type VoucherIndexInput = {
  checks: readonly CheckCandidate[]
  staged: readonly StagedCandidate[]
}

/** One line of the sheet. `checkNumber` is null exactly when we will not guess. */
export type VoucherRow = {
  voucher: string
  checkNumber: string | null
  bank: string | null
  company: string | null
  status: string
  checkDate: Date | null
  payee: string | null
  releasedAt: Date | null
  supersedes: string | null
  remarks: string | null
}

function describeCheque(c: CheckCandidate): string {
  return `${c.checkNumber} (${statusWords(c.status)})`
}

function fromCheque(
  voucher: string,
  c: CheckCandidate,
  superseded: readonly CheckCandidate[],
): VoucherRow {
  return {
    voucher,
    checkNumber: c.checkNumber,
    bank: c.bank,
    company: c.company,
    status: statusWords(c.status),
    checkDate: c.checkDate,
    payee: c.payee,
    releasedAt: c.releasedAt,
    supersedes: superseded.length ? superseded.map(describeCheque).join('; ') : null,
    remarks: null,
  }
}

function withoutCheque(voucher: string, status: string, remarks: string): VoucherRow {
  return {
    voucher,
    checkNumber: null,
    bank: null,
    company: null,
    status,
    checkDate: null,
    payee: null,
    releasedAt: null,
    supersedes: null,
    remarks,
  }
}

/**
 * One voucher's cheques, collapsed to one row.
 *
 * A re-issue — one live cheque and some voided predecessors — is NOT an
 * ambiguity. It has an obvious right answer, and refusing to give it would
 * throw away 46 measured answers to guard against 6.
 *
 * Two LIVE cheques is a genuine conflict and is refused outright, the same way
 * `bills.ts` refuses `AMBIGUOUS_CHECK`. The lookup then returns nothing, which
 * is correct: a bill hung on the wrong cheque is a supplier told the wrong thing.
 */
function resolveOne(voucher: string, candidates: readonly CheckCandidate[]): VoucherRow {
  const live = candidates.filter((c) => !isDead(c.status))
  const dead = candidates.filter((c) => isDead(c.status))

  if (live.length === 1) return fromCheque(voucher, live[0], dead)
  if (live.length > 1) {
    return withoutCheque(
      voucher,
      CONTESTED,
      `More than one live cheque names this voucher: ${live.map(describeCheque).join('; ')}. ` +
        'Settle it in Check Release Monitoring; no cheque number is given here because ' +
        'attaching a bill to the wrong cheque tells a supplier the wrong thing.',
    )
  }
  // Nothing live. One dead cheque is still an answer — "the cheque for this was
  // voided" is what somebody chasing an open payable needs to know.
  if (dead.length === 1) return fromCheque(voucher, dead[0], [])
  return withoutCheque(
    voucher,
    ALL_CANCELLED,
    `Every cheque naming this voucher was cancelled or voided: ${dead.map(describeCheque).join('; ')}.`,
  )
}

/**
 * A voucher known only to `StagedCheck`.
 *
 * The staged row DOES carry a cheque number, and it stays out of `CHECK NUMBER`
 * deliberately: the row was staged because nothing said which company's cheque
 * it is, and therefore which bank's. A number with no bank feeding the
 * workbook's `bank` column is precisely the guess staging exists to prevent. It
 * goes in `REMARKS`, where a human reads it, never in the column a formula does.
 */
function stagedRow(voucher: string, rows: readonly StagedCandidate[]): VoucherRow {
  const where = rows
    .map((s) => {
      const at = s.sourceSheet && s.sourceRow !== null
        ? `${s.sourceSheet} row ${s.sourceRow}`
        : s.acumaticaRef ?? 'an Acumatica row'
      const stated = s.checkNumber ?? s.statedCheckRef
      return stated ? `${at} states ${stated}` : at
    })
    .join('; ')
  return withoutCheque(
    voucher,
    NOT_KEYED,
    'A staged row names this voucher but never resolved to a company, so no cheque ' +
      `number can be given here — see /admin/staged. ${where}.`,
  )
}

export function resolveVoucherRows({ checks, staged }: VoucherIndexInput): VoucherRow[] {
  const byVoucher = new Map<string, CheckCandidate[]>()
  for (const c of checks) {
    const found = byVoucher.get(c.voucher)
    if (found) found.push(c)
    else byVoucher.set(c.voucher, [c])
  }

  const rows: VoucherRow[] = []
  for (const [voucher, candidates] of byVoucher) rows.push(resolveOne(voucher, candidates))

  // A voucher with a real cheque never falls back to its staged row: the cheque
  // is the better answer, and two rows for one voucher would silently break the
  // lookup, which returns whichever it meets first.
  const stagedOnly = new Map<string, StagedCandidate[]>()
  for (const s of staged) {
    if (byVoucher.has(s.voucher)) continue
    const found = stagedOnly.get(s.voucher)
    if (found) found.push(s)
    else stagedOnly.set(s.voucher, [s])
  }
  for (const [voucher, group] of stagedOnly) rows.push(stagedRow(voucher, group))

  // Sorted so two runs of the same data produce the same file. VLOOKUP's exact
  // match does not need order; a reviewer diffing two exports does.
  return rows.sort((a, b) => (a.voucher < b.voucher ? -1 : a.voucher > b.voucher ? 1 : 0))
}

const count = (n: number) => n.toLocaleString('en-PH')

/**
 * Line 2 of the scope, for the title block.
 *
 * "NO VOUCHERS" is spelled out for the same reason `describeScope` spells out
 * "NO CHEQUES MATCH": an empty table and a broken export look identical.
 */
export function describeVoucherScope(exported: number, total: number): string {
  if (exported === 0) return 'NO VOUCHERS'
  if (exported < total) return `FIRST ${count(exported)} OF ${count(total)} VOUCHERS`
  return `${count(exported)} VOUCHER${exported === 1 ? '' : 'S'}`
}
```

- [ ] **Step 4: Run the test and the type-checker**

```bash
npx.cmd vitest run tests/export/voucher-index.test.ts
```

Expected: PASS, 13 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/export/voucher-index.ts tests/export/voucher-index.test.ts
git commit -m "feat: resolve one cheque per AP voucher, or refuse to guess

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The query

**Files:**
- Create: `lib/export/voucher-query.ts`
- Test: `tests/export/voucher-query.test.ts`

**Interfaces:**
- Consumes: `CheckCandidate`, `StagedCandidate`, `VoucherIndexInput` from Task 1.
- Produces: `listVoucherCandidates(db: Db): Promise<VoucherIndexInput>` where `Db = PrismaClient | Prisma.TransactionClient`.

- [ ] **Step 1: Write the failing test**

Create `tests/export/voucher-query.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { listVoucherCandidates } from '@/lib/export/voucher-query'

beforeEach(async () => {
  await resetDb()
})

describe('listVoucherCandidates', () => {
  it('returns one candidate per (voucher, cheque) pair', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652', 'AP-ST042653'], checkNumber: '6000353106' })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks.map((c) => c.voucher).sort()).toEqual(['AP-ST042652', 'AP-ST042653'])
    expect(checks[0].checkNumber).toBe('6000353106')
  })

  it('ignores a cheque carrying no voucher', async () => {
    await makeCheck({ apvNumbers: [] })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks).toHaveLength(0)
  })

  /**
   * Client ruling, 2026-09-06. Measured cost: 17 vouchers out of ~10,985 — the
   * other 58 that sit on an incomplete cheque are also carried by a complete
   * one, so they still get a row.
   */
  it('excludes a cheque with no recorded amount', async () => {
    await makeCheck({ apvNumbers: ['AP-ST099999'], amount: null })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks).toHaveLength(0)
  })

  it('reads the bank from the cash account', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks[0].bank).not.toBeNull()
  })

  it('prefers the checkbook bank over the cash account bank', async () => {
    const check = await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const bank = await testDb.bank.create({ data: { code: 'MBTC-X', name: 'Metrobank' } })
    const book = await testDb.checkBook.create({
      data: { code: 'MBTC-S-0001', bankId: bank.id, companyId: check.companyId },
    })
    await testDb.check.update({ where: { id: check.id }, data: { checkBookId: book.id } })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks[0].bank).toBe('MBTC-X')
  })

  it('returns staged rows that name a voucher', async () => {
    await testDb.stagedCheck.create({
      data: {
        source: 'WORKBOOK', sourceSheet: 'BPI STK', sourceRow: 412,
        reason: 'NO_COMPANY', checkNumber: '6000353110',
        apvNumbers: ['AP-A1-02663'], impliedStatus: 'SIGNED',
      },
    })
    const { staged } = await listVoucherCandidates(testDb)
    expect(staged).toHaveLength(1)
    expect(staged[0].voucher).toBe('AP-A1-02663')
    expect(staged[0].sourceSheet).toBe('BPI STK')
    expect(staged[0].sourceRow).toBe(412)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/export/voucher-query.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/export/voucher-query"`.

- [ ] **Step 3: Write the query**

Create `lib/export/voucher-query.ts`:

```ts
import type { CheckStatus, Prisma, PrismaClient } from '@prisma/client'
import type { CheckCandidate, StagedCandidate, VoucherIndexInput } from './voucher-index'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * The two reads behind the voucher index. READ ONLY, and it resolves nothing —
 * every decision about which cheque answers a voucher lives in
 * `voucher-index.ts`, where it can be tested without a database.
 *
 * Raw SQL rather than Prisma's query API because the grain is one row per
 * ELEMENT of `Check.apvNumbers`, and `unnest` is the only way to say that.
 */

/** `status` arrives as text from the cast; widened back on the way out. */
type RawCheckCandidate = Omit<CheckCandidate, 'status'> & { status: string }

export async function listVoucherCandidates(db: Db): Promise<VoucherIndexInput> {
  const [checks, staged] = await Promise.all([
    /**
     * `isIncomplete = false` — the 129 cheques with no recorded amount are out,
     * consistent with the dashboard, the export and the printed sheet (client
     * ruling 2026-09-06). This sheet carries no amount, so the usual argument
     * for the exclusion does not apply here; one rule across every output does,
     * and the measured cost is 17 vouchers.
     *
     * The bank falls back from the checkbook to the cash account because 9,072
     * cheques carry a checkbook and only 1,342 carry a cash account. Null when
     * neither is known — an empty cell, never a guessed bank.
     */
    db.$queryRaw<RawCheckCandidate[]>`
      select v.voucher                                  as "voucher",
             c."checkNumber"                            as "checkNumber",
             c.status::text                             as "status",
             b.code                                     as "bank",
             co.code                                    as "company",
             c."checkDate"                              as "checkDate",
             coalesce(c."payeeName", ve."canonicalName") as "payee",
             c."releasedAt"                             as "releasedAt"
        from "Check" c
        cross join lateral unnest(c."apvNumbers") as v(voucher)
        join "Company" co on co.id = c."companyId"
        left join "CheckBook" cb on cb.id = c."checkBookId"
        left join "CashAccount" ca on ca.id = c."cashAccountId"
        left join "Bank" b on b.id = coalesce(cb."bankId", ca."bankId")
        left join "Vendor" ve on ve.id = c."vendorId"
       where c."isIncomplete" = false`,
    /**
     * `distinct` because one voucher can appear on several staged rows of the
     * same import, and the resolver groups them anyway.
     */
    db.$queryRaw<StagedCandidate[]>`
      select distinct
             v.voucher          as "voucher",
             s."sourceSheet"    as "sourceSheet",
             s."sourceRow"      as "sourceRow",
             s."statedCheckRef" as "statedCheckRef",
             s."checkNumber"    as "checkNumber",
             s."acumaticaRef"   as "acumaticaRef"
        from "StagedCheck" s
        cross join lateral unnest(s."apvNumbers") as v(voucher)`,
  ])

  return {
    checks: checks.map((c) => ({ ...c, status: c.status as CheckStatus })),
    staged,
  }
}
```

- [ ] **Step 4: Run the test and the type-checker**

```bash
npx.cmd vitest run tests/export/voucher-query.test.ts
```

Expected: PASS, 6 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/export/voucher-query.ts tests/export/voucher-query.test.ts
git commit -m "feat: read voucher-to-cheque candidates, excluding cheques with no amount

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The workbook

Two commits: first lift the sheet palette out of `workbook.ts` so both workbooks share one
definition, then build the new renderer on it.

**Files:**
- Create: `lib/export/sheet-style.ts`
- Modify: `lib/export/workbook.ts` (delete its private style constants, import them instead)
- Create: `lib/export/voucher-workbook.ts`
- Test: `tests/export/voucher-workbook.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces; `fitColumnWidth` from `lib/export/report.ts`.
- Produces:
  - from `lib/export/sheet-style.ts`: `HEADER_FILL`, `BAND_FILL`, `GRID`, `DATE_FORMAT`, `COUNT_FORMAT`, `DATE_WIDTH_SAMPLE`, `styleHeaderCell(cell: ExcelJS.Cell, label: string, align?: 'left' | 'right'): void`
  - `TIMESTAMP_CELL = 'A2'`
  - `type VoucherIndexMeta = { generatedAt: Date; generatedBy: string; totalRows: number }`
  - `buildVoucherIndexWorkbook(input: { rows: readonly VoucherRow[]; meta: VoucherIndexMeta }): Promise<ArrayBuffer>`

- [ ] **Step 1: Lift the sheet palette into one module**

Create `lib/export/sheet-style.ts`:

```ts
import type ExcelJS from 'exceljs'

/**
 * The look every generated sheet shares.
 *
 * Extracted from `workbook.ts` when the voucher index arrived, because two
 * files each holding their own copy of `FF1E293B` is two files that drift: the
 * register export and the voucher index are handed to the same reader, often in
 * the same week, and a header that is nearly the same navy reads as a mistake.
 *
 * Only what is genuinely shared lives here. Neither sheet's title block does —
 * the register's row 2 is a scope line and the index's is a machine-readable
 * timestamp, and a styler with an option for that would serve neither well.
 */

/** slate-800 / white — the dashboard's own header. */
export const HEADER_FILL = 'FF1E293B'
/** slate-100, for row banding. */
export const BAND_FILL = 'FFF1F5F9'
/** slate-200, for cell borders. */
export const GRID = 'FFE2E8F0'

export const DATE_FORMAT = 'dd mmm yyyy'
export const COUNT_FORMAT = '#,##0'

/** Every date renders as `01 Sep 2026`; this is what a date column must fit. */
export const DATE_WIDTH_SAMPLE = '01 Sep 2026'

/**
 * One header cell: the fill, the white bold text, and the border that keeps the
 * band from bleeding into it.
 */
export function styleHeaderCell(
  cell: ExcelJS.Cell,
  label: string,
  align: 'left' | 'right' = 'left',
): void {
  cell.value = label
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
  cell.alignment = { horizontal: align, vertical: 'middle' }
  cell.border = {
    top: { style: 'thin', color: { argb: HEADER_FILL } },
    bottom: { style: 'thin', color: { argb: HEADER_FILL } },
    left: { style: 'thin', color: { argb: HEADER_FILL } },
    right: { style: 'thin', color: { argb: HEADER_FILL } },
  }
}
```

Then in `lib/export/workbook.ts`, delete these six private constants:

```ts
// slate-800 / white, the dashboard's own header, and slate-100 for the banding.
const HEADER_FILL = 'FF1E293B'
const BAND_FILL = 'FFF1F5F9'
const GRID = 'FFE2E8F0'
const DATE_FORMAT = 'dd mmm yyyy'
const COUNT_FORMAT = '#,##0'
```

```ts
/** The width a date column needs — every date renders as `01 Sep 2026`. */
const DATE_WIDTH_SAMPLE = '01 Sep 2026'
```

and import them instead, adding to the existing import block at the top of the file:

```ts
import {
  HEADER_FILL, BAND_FILL, GRID, DATE_FORMAT, COUNT_FORMAT, DATE_WIDTH_SAMPLE, styleHeaderCell,
} from './sheet-style'
```

Then replace the per-cell header styling inside `buildRegisterSheet` — the block that sets
`cell.value`, `cell.font`, `cell.fill`, `cell.alignment` and `cell.border` — with a call:

```ts
  const header = ws.getRow(HEADER_ROW)
  REGISTER_HEADERS.forEach((label, i) => {
    styleHeaderCell(header.getCell(i + 1), label, i + 1 === AMOUNT_COLUMN ? 'right' : 'left')
  })
  header.height = 20
```

Leave every other use of those constants exactly as it is — this step changes where the values are
defined, not what any sheet looks like.

- [ ] **Step 2: Prove the register export is unchanged**

```bash
npx.cmd vitest run tests/export/workbook.test.ts
```

Expected: PASS, with the same test count as before the edit. This is a pure refactor; a single
changed assertion means a value moved when it should not have.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

```bash
git add lib/export/sheet-style.ts lib/export/workbook.ts
git commit -m "refactor: one definition of the generated sheets' palette

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Write the failing test**

Create `tests/export/voucher-workbook.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  VOUCHER_INDEX_SHEET, VOUCHER_HEADER_ROW, VOUCHER_FIRST_DATA_ROW,
  type VoucherRow,
} from '@/lib/export/voucher-index'
import { buildVoucherIndexWorkbook, TIMESTAMP_CELL } from '@/lib/export/voucher-workbook'

const GENERATED_AT = new Date('2026-09-10T14:30:00+08:00')

function row(overrides: Partial<VoucherRow> & { voucher: string }): VoucherRow {
  return {
    checkNumber: '6000353106',
    bank: 'BPI',
    company: 'STK',
    status: 'SIGNED',
    checkDate: new Date('2026-08-13'),
    payee: 'HENKEL PHILIPPINES INC.',
    releasedAt: null,
    supersedes: null,
    remarks: null,
    ...overrides,
  }
}

async function build(rows: readonly VoucherRow[], totalRows = rows.length) {
  const buffer = await buildVoucherIndexWorkbook({
    rows,
    meta: { generatedAt: GENERATED_AT, generatedBy: 'Paolo Parcon', totalRows },
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb
}

describe('buildVoucherIndexWorkbook', () => {
  it('writes one sheet, named INDEX', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    expect(wb.worksheets.map((w) => w.name)).toEqual([VOUCHER_INDEX_SHEET])
  })

  /**
   * The staleness cell. A fixed filename means a stale copy is indistinguishable
   * from a fresh one by name, so the Executive Report reads this cell instead:
   * `='…\[CHECK BY VOUCHER.xlsx]INDEX'!$A$2`. It must be a real Date, not text,
   * or Excel cannot format or compare it.
   */
  it('puts the generation timestamp in A2 as a date', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    const cell = wb.getWorksheet(VOUCHER_INDEX_SHEET)!.getCell(TIMESTAMP_CELL)
    expect(cell.value).toBeInstanceOf(Date)
    expect((cell.value as Date).getTime()).toBe(GENERATED_AT.getTime())
  })

  it('puts VOUCHER in column A of the header row', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(ws.getRow(VOUCHER_HEADER_ROW).getCell(1).value).toBe('VOUCHER')
  })

  it('writes the first voucher on the first data row', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(1).value).toBe('AP-ST042652')
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(2).value).toBe('6000353106')
  })

  it('leaves the cheque number blank rather than writing a guess', async () => {
    const wb = await build([row({ voucher: 'AP-ST036567', checkNumber: null, status: 'CONTESTED' })])
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(2).value).toBeNull()
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(5).value).toBe('CONTESTED')
  })

  it('states in the title block when the cap has bitten', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })], 20_100)
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(String(ws.getCell('A3').value)).toContain('FIRST 1 OF 20,100 VOUCHERS')
  })

  it('says on the sheet that cheques with no amount are excluded', async () => {
    const wb = await build([row({ voucher: 'AP-ST042652' })])
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(String(ws.getCell('A4').value)).toContain('no recorded amount')
  })
})
```

- [ ] **Step 4: Run it and watch it fail**

```bash
npx.cmd vitest run tests/export/voucher-workbook.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/export/voucher-workbook"`.

- [ ] **Step 5: Write the renderer**

Create `lib/export/voucher-workbook.ts`:

```ts
import ExcelJS from 'exceljs'
import { fitColumnWidth } from './report'
import { BAND_FILL, DATE_FORMAT, DATE_WIDTH_SAMPLE, styleHeaderCell } from './sheet-style'
import {
  VOUCHER_INDEX_SHEET, VOUCHER_HEADERS, VOUCHER_HEADER_ROW, VOUCHER_FIRST_DATA_ROW,
  describeVoucherScope, type VoucherRow,
} from './voucher-index'

/**
 * The voucher index, as a workbook. No database, no session, no request —
 * everything it needs is passed in, which is what lets the whole file be
 * generated into a buffer and read back cell by cell in the test.
 */

/**
 * THE STALENESS CELL, and the reason it is fixed.
 *
 * `CHECK BY VOUCHER.xlsx` never changes its name, because an external VLOOKUP
 * needs a stable path. The cost is that a copy left on a shared drive for three
 * months looks exactly like one generated this morning. So the Executive Report
 * reads the age off the sheet itself:
 *
 *     ='…\[CHECK BY VOUCHER.xlsx]INDEX'!$A$2
 *
 * A sheet that states its own age beats a filename nobody reads. Do not move it.
 */
export const TIMESTAMP_CELL = 'A2'

export type VoucherIndexMeta = {
  generatedAt: Date
  generatedBy: string
  /** How many vouchers there are in total, before the row cap. */
  totalRows: number
}

export type VoucherIndexInputForSheet = {
  rows: readonly VoucherRow[]
  meta: VoucherIndexMeta
}

/**
 * The one format this sheet does not share with the register export: the
 * staleness cell shows a TIME as well as a date, because a file regenerated
 * twice in one morning must be distinguishable from itself.
 */
const TIMESTAMP_FORMAT = 'dd mmm yyyy hh:mm AM/PM'

/** What the cell holds, as text, for width fitting. Dates measure as a sample. */
function widthSample(value: string | Date | null): string {
  if (value === null) return ''
  return value instanceof Date ? DATE_WIDTH_SAMPLE : value
}

export async function buildVoucherIndexWorkbook(
  { rows, meta }: VoucherIndexInputForSheet,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt

  const ws = wb.addWorksheet(VOUCHER_INDEX_SHEET, {
    views: [{ state: 'frozen', ySplit: VOUCHER_HEADER_ROW }],
  })

  // Four lines above the table, NOT merged — a merged cell clips text wider
  // than the merge, and the exclusion line on row 4 is the one that must not be
  // cut in half.
  ws.getCell('A1').value = 'CHECK BY VOUCHER — CHECK RELEASE MONITORING'
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF0F172A' } }
  ws.getRow(1).height = 24

  const stamp = ws.getCell(TIMESTAMP_CELL)
  stamp.value = meta.generatedAt
  stamp.numFmt = TIMESTAMP_FORMAT
  stamp.font = { bold: true, size: 12, color: { argb: 'FF0F172A' } }

  ws.getCell('A3').value = `${describeVoucherScope(rows.length, meta.totalRows)}  ·  generated by ${meta.generatedBy}`
  ws.getCell('A3').font = { size: 10, color: { argb: 'FF475569' } }

  ws.getCell('A4').value =
    'Excludes cheques with no recorded amount. A blank CHECK NUMBER means this system will not ' +
    'guess — read REMARKS.'
  ws.getCell('A4').font = { size: 10, color: { argb: 'FF475569' } }

  const header = ws.getRow(VOUCHER_HEADER_ROW)
  VOUCHER_HEADERS.forEach((label, i) => {
    styleHeaderCell(header.getCell(i + 1), label)
  })
  header.height = 20

  const samples: string[][] = VOUCHER_HEADERS.map(() => [])

  rows.forEach((r, i) => {
    const excelRow = ws.getRow(VOUCHER_FIRST_DATA_ROW + i)
    const values: (string | Date | null)[] = [
      r.voucher, r.checkNumber, r.bank, r.company, r.status,
      r.checkDate, r.payee, r.releasedAt, r.supersedes, r.remarks,
    ]
    values.forEach((value, col) => {
      const cell = excelRow.getCell(col + 1)
      cell.value = value
      if (value instanceof Date) cell.numFmt = DATE_FORMAT
      samples[col].push(widthSample(value))
    })
    if (i % 2 === 1) {
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } }
      })
    }
  })

  VOUCHER_HEADERS.forEach((label, i) => {
    ws.getColumn(i + 1).width = fitColumnWidth(label, samples[i])
  })

  // The header row filters, so a Finance user can find one voucher by eye
  // without disturbing the range an external VLOOKUP reads.
  ws.autoFilter = {
    from: { row: VOUCHER_HEADER_ROW, column: 1 },
    to: { row: VOUCHER_HEADER_ROW + rows.length, column: VOUCHER_HEADERS.length },
  }

  return wb.xlsx.writeBuffer()
}
```

- [ ] **Step 6: Run the test and the type-checker**

```bash
npx.cmd vitest run tests/export/voucher-workbook.test.ts
```

Expected: PASS, 7 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 7: Commit the renderer**

```bash
git add lib/export/voucher-workbook.ts tests/export/voucher-workbook.test.ts
git commit -m "feat: render the voucher index, with its own age in a fixed cell

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The route

**Files:**
- Create: `app/api/export/vouchers/route.ts`
- Test: `tests/export/voucher-route.test.ts`

**Interfaces:**
- Consumes: `listVoucherCandidates` (Task 2), `resolveVoucherRows` / `VOUCHER_INDEX_ROW_LIMIT` / `VOUCHER_INDEX_FILENAME` (Task 1), `buildVoucherIndexWorkbook` (Task 3), `getSessionUser` from `@/lib/auth`, `prisma` from `@/lib/db`.
- Produces: `GET(request: Request): Promise<Response>`.

- [ ] **Step 1: Write the failing test**

Create `tests/export/voucher-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { VOUCHER_INDEX_SHEET, VOUCHER_FIRST_DATA_ROW } from '@/lib/export/voucher-index'

/**
 * The route's guard. `middleware.ts` DOES NOT RUN in this project, so a route
 * handler has no perimeter in front of it. The database is reached through a
 * Proxy that counts every property touch, so "returned no data" is asserted as
 * "never asked the database for any".
 */
const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))

vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => state.user,
}))

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

const SIGNED_IN = {
  id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER',
}

async function get() {
  const { GET } = await import('@/app/api/export/vouchers/route')
  return GET(new Request('http://localhost/api/export/vouchers'))
}

beforeEach(async () => {
  await resetDb()
  state.user = SIGNED_IN
  state.dbTouches = 0
})

describe('GET /api/export/vouchers — the guard', () => {
  it('refuses an unauthenticated request with 401, not a redirect', async () => {
    state.user = null
    const res = await get()
    expect(res.status).toBe(401)
  })

  it('never touches the database when unauthenticated', async () => {
    state.user = null
    await get()
    expect(state.dbTouches).toBe(0)
  })
})

describe('GET /api/export/vouchers — the file', () => {
  it('serves the fixed filename an external VLOOKUP depends on', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="CHECK BY VOUCHER.xlsx"',
    )
  })

  it('is never cached — it is a register of real cheques', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const res = await get()
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('writes the resolved voucher onto the sheet', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'], checkNumber: '6000353106' })
    const res = await get()
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const ws = wb.getWorksheet(VOUCHER_INDEX_SHEET)!
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(1).value).toBe('AP-ST042652')
    expect(ws.getRow(VOUCHER_FIRST_DATA_ROW).getCell(2).value).toBe('6000353106')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/export/voucher-route.test.ts
```

Expected: FAIL — `Failed to resolve import "@/app/api/export/vouchers/route"`.

- [ ] **Step 3: Write the route**

Create `app/api/export/vouchers/route.ts`:

```ts
import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { listVoucherCandidates } from '@/lib/export/voucher-query'
import { resolveVoucherRows, VOUCHER_INDEX_ROW_LIMIT, VOUCHER_INDEX_FILENAME } from '@/lib/export/voucher-index'
import { buildVoucherIndexWorkbook } from '@/lib/export/voucher-workbook'

/**
 * THE VOUCHER INDEX — `CHECK BY VOUCHER.xlsx`.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` DOES NOT RUN in this project. Node-runtime middleware is
 * unsupported in Next 15.5.25 and the file is silently never registered. Pages
 * are protected because each one calls `requireUser()` itself; a route handler
 * has NOTHING in front of it, so this one authenticates on its first line,
 * before it reads anything at all.
 *
 * A 401, not a redirect: this is fetched as a download, and a 307 to /login
 * arrives as an HTML login page saved under an .xlsx filename — which, given
 * the filename is fixed and an Excel formula points at it, would be a login
 * page silently answering every VLOOKUP in the Executive Report.
 *
 * FINANCE_USER, not admin. This is a routine file somebody produces whenever
 * the Executive Report is refreshed, and there is currently one active
 * FINANCE_ADMIN — gating it would mean one forgotten password stops the
 * month-end pack. It discloses less than /api/export: no amounts.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ExcelJS is Node-only. Honoured here, unlike in middleware.
export const runtime = 'nodejs'
// Derived from a session and from live financial data.
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(_request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const candidates = await listVoucherCandidates(prisma)
  const resolved = resolveVoucherRows(candidates)

  // Capped after resolving, not before: the cap is about how large a file can be
  // assembled in a serverless function, and a voucher's answer depends on every
  // cheque that names it. Slicing the candidates would silently turn a re-issue
  // into a contested row.
  const rows = resolved.slice(0, VOUCHER_INDEX_ROW_LIMIT)

  const workbook = await buildVoucherIndexWorkbook({
    rows,
    meta: {
      generatedAt: new Date(),
      generatedBy: user.name,
      totalRows: resolved.length,
    },
  })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      // FIXED. The Executive Report stores this name inside an external
      // reference; a dated filename would break the link on every regeneration.
      'content-disposition': `attachment; filename="${VOUCHER_INDEX_FILENAME}"`,
      // No `content-length` — the runtime sets it from the body it actually sends.
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
```

- [ ] **Step 4: Run the test and the type-checker**

```bash
npx.cmd vitest run tests/export/voucher-route.test.ts
```

Expected: PASS, 5 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add app/api/export/vouchers/route.ts tests/export/voucher-route.test.ts
git commit -m "feat: serve CHECK BY VOUCHER.xlsx at a fixed name, behind the session guard

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The link, and the whole suite

**Files:**
- Modify: `components/QuickActions.tsx`

**Interfaces:**
- Consumes: `VOUCHER_INDEX_HREF` from `lib/export/voucher-index.ts` (Task 1).
- Produces: nothing other modules read.

- [ ] **Step 1: Add the anchor**

In `components/QuickActions.tsx`, add the import:

```ts
import { VOUCHER_INDEX_HREF } from '@/lib/export/voucher-index'
```

and insert this anchor immediately after the `PRINT RELEASE LIST` anchor, before the disabled `UPLOAD READY CHECKS` button:

```tsx
      {/**
        * THE VOUCHER INDEX — the file the Finance Executive Report looks into.
        *
        * Unlike the two anchors above it, this one carries NO dashboard
        * parameters, because it is not the view on screen: it is every voucher
        * this system knows, which is what a lookup table has to be. The label
        * says so, rather than leaving a reader to discover it by opening the
        * file and finding rows they had filtered out.
        */}
      <a
        href={VOUCHER_INDEX_HREF}
        title="Every AP voucher and the cheque that pays it. Ignores the filters on this page — a lookup table has to cover everything. Save it where the Finance Executive Report expects to find it."
        className="rounded-lg bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy ring-1 ring-hairline transition hover:ring-navy"
      >
        VOUCHER INDEX (ALL CHEQUES)
      </a>
```

- [ ] **Step 2: Type-check and build**

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

```bash
npx.cmd next build
```

Expected: build completes; `/api/export/vouchers` appears in the route list as a dynamic route (`ƒ`).

- [ ] **Step 3: Run the whole suite**

```bash
npx.cmd vitest run
```

Expected: PASS. 992 tests before this plan, plus 31 added here — no existing test should change.

Nothing else may run against the test database at the same time; concurrent runs produce `40P01` deadlocks.

- [ ] **Step 4: Commit**

```bash
git add components/QuickActions.tsx
git commit -m "feat: offer the voucher index from the dashboard

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Tell the codebase what changed

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Record the seam**

Add to the "Data facts, measured" section of `CLAUDE.md`:

```markdown
- **The Finance Executive Report reads this system through `CHECK BY VOUCHER.xlsx`.** Its `AP Local`
  sheet used to find a payable's cheque with three `VLOOKUP`s into the released sheets of
  `CHECK MONITORING <date>.xlsx`; the register was retired on 2026-09-10 and a `VLOOKUP` into a
  stale external returns its last cached value for ever rather than failing. `/api/export/vouchers`
  replaces them. **The filename and the sheet name (`INDEX`) are fixed** — they are stored inside an
  Excel external reference — so the file states its own age in `$A$2` instead, and the Executive
  Report displays it. Measured 2026-09-10 over `AP Local`'s 1,472 distinct vouchers: 986 name exactly
  one cheque, 54 name more than one (46 of them a re-issue with a single live cheque), 432 name none.
  The old formulas could answer 2 of the 1,472, because they looked only at released cheques and
  `AP Local` is the OPEN payables ledger. Do not "restore" released-only semantics.
```

- [ ] **Step 2: Update the state section**

In `CLAUDE.md` under "State", change `**992 tests across 55 files.**` to the count `npx.cmd vitest run` actually reports, and add to the list of what is missing that the cash-outflow forecast (spec §"What this is not") is the next seam.

- [ ] **Step 3: Write down the formulas Finance has to change**

The code is useless until the Executive Report points at it, and the person who does that is not
reading this repository. Add a `docs/voucher-index-handover.md` containing exactly this, so the
instruction survives the session that produced it:

```markdown
# CHECK BY VOUCHER.xlsx — what Finance does with it

1. Download it from the dashboard: **VOUCHER INDEX (ALL CHEQUES)**.
2. Save it to the agreed folder, **keeping the name exactly** `CHECK BY VOUCHER.xlsx`. The
   Executive Report finds it by that name; renaming it breaks every formula below.
3. In `Finance Executive Report`, sheet `AP Local`, the three working columns that used to look
   into `CHECK MONITORING` are replaced by one lookup each against the new file. `C` is
   `Reference Nbr.`:

   | wanted | formula |
   | --- | --- |
   | cheque number | `=IFERROR(VLOOKUP($C3,'[CHECK BY VOUCHER.xlsx]INDEX'!$A:$J,2,0),"")` |
   | bank | `=IFERROR(VLOOKUP($C3,'[CHECK BY VOUCHER.xlsx]INDEX'!$A:$J,3,0),"")` |
   | status | `=IFERROR(VLOOKUP($C3,'[CHECK BY VOUCHER.xlsx]INDEX'!$A:$J,5,0),"")` |

   A blank cheque number with a status of `CONTESTED` or `NOT KEYED` is **not** a failure — it means
   Check Release Monitoring will not guess. The `REMARKS` column (10) says why.

4. To show how old the file is anywhere in the workbook:
   `='[CHECK BY VOUCHER.xlsx]INDEX'!$A$2`
```

Regenerate the file and confirm in Excel that one of those formulas returns a cheque number before
calling this task done. A formula that silently returns `""` because the path is wrong is the exact
failure this whole plan exists to remove.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/voucher-index-handover.md
git commit -m "docs: record the voucher index as the Executive Report's seam

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Not in this plan

Stated so nobody adds them quietly:

- **No bank reconciliation, cash position, hedging or foreign outlook.** Three of the four have no source in this system; the spec's closing section records the measurements and where their sources actually live.
- **No `releasedAt` backfill.** The column is empty on all 11,923 cheques and the `RELEASED` column of the index will be blank until Finance releases through the app. A date reconstructed from a workbook is worse than none.
- **No clearing workflow.** Outstanding cheques cannot be computed until `recordClearing` is actually used.
- **No new `Check` column, no migration, no audit row.** This feature only reads.
