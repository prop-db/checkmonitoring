# Voucher Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/vouchers` page in this application that answers "which cheque pays this AP voucher, and where is it?" on screen, with the existing Excel index as its extract — so nobody repoints a formula in the Finance Executive Report.

**Architecture:** The voucher index shipped earlier today (`lib/export/voucher-index.ts` resolver, `voucher-query.ts` read, `voucher-workbook.ts` renderer, `/api/export/vouchers` route) is the engine and its judgement does not change. This plan threads a `checkId` through it so numbers can link, pushes a voucher search into the SQL, adds a pure view module for parameters and hrefs, and puts a server-rendered page in front. The handover document is deleted.

**Tech Stack:** Next 15 App Router server components · Prisma 6 raw SQL (tagged templates, bound parameters) · Tailwind classes already in use · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-voucher-screen-design.md`. Read it before Task 1.

## Global Constraints

- **`npx tsc --noEmit` must pass before any task is called done.** Vitest transpiles with esbuild, which erases types; this project has repeatedly had a green suite over unsound types.
- **On Windows use `npx.cmd` / `npm.cmd`.** PowerShell's execution policy blocks `npx.ps1`.
- **Run ONLY the test files named in the task. Never the full suite.** Every test crosses the network to Neon; the whole suite is ~20 minutes and the user has ruled it out for routine work. All test files share one database and `resetDb()` truncates it — never run two test processes at once.
- **Never write a raw control character into a source file.** Write escape sequences as escape sequences.
- **This feature only READS.** No migration, no schema change, no write of any kind, no audit row.
- **`middleware.ts` does not run.** The page authenticates itself with `requireUser()` on its first line.
- **No amount column, anywhere on this screen or in the export.** Amounts are decimal strings end to end and this feature never touches one.
- **`INDEX`, `CHECK BY VOUCHER.xlsx` and `$A$2` stay exactly as they are** — the extract keeps its stable shape.
- **The 129 `isIncomplete` cheques stay excluded**, as the query already does.
- **British spelling in prose** ("cheque"), matching the codebase.
- **Never commit or print** `.env`, any credential, or any `.xlsx`.
- **Commit messages end with:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/export/voucher-index.ts` | **Modify.** `CheckCandidate.checkId`, `VoucherRow.checkId`; the resolver passes it through. Judgement unchanged. |
| `lib/export/voucher-query.ts` | **Modify.** Selects `c.id`; optional `{ voucher }` filter as a bound `ilike` parameter in both queries. |
| `lib/vouchers-view.ts` | **Create.** Pure: the row cap, the status options, `parseVoucherStatusParam`, `filterByStatus`, `vouchersHref`, `describeVoucherView`. |
| `lib/status-pill.ts` | **Modify.** `VOUCHER_STATUS_PILL_CLASS` for the three synthetic statuses and `voucherStatusPillClass`, which also answers for a real status given as words. |
| `components/VoucherTable.tsx` | **Create.** Server component: the table, with the cheque number linked and the status as a pill. |
| `app/vouchers/page.tsx` | **Create.** Guard, params, query, resolve, filter, cap, render. Decides nothing the pure module can decide. |
| `components/AppHeader.tsx` | **Modify.** A `VOUCHERS` link for every signed-in user. |
| `components/QuickActions.tsx` | **Modify.** The `VOUCHER INDEX (ALL CHEQUES)` anchor and its import come off; the doc comment describes three actions again. |
| `docs/voucher-index-handover.md` | **Delete.** |
| `CLAUDE.md` | **Modify.** The voucher bullet rewritten. |
| `docs/superpowers/specs/2026-09-10-voucher-index-export-design.md` | **Modify.** One line at the top pointing at the superseding spec. |
| `tests/export/voucher-index.test.ts` | **Modify.** `checkId` in the helper; two assertions. |
| `tests/export/voucher-query.test.ts` | **Modify.** `checkId` returned; the filter narrows both reads. |
| `tests/export/voucher-workbook.test.ts` | **Modify.** `checkId` in the `row()` helper only. |
| `tests/vouchers-view.test.ts` | **Create.** The pure module. |
| `tests/status-pill.test.ts` | **Modify.** The synthetic map covers exactly three; a real status given as words matches the dashboard's colour. |

---

### Task 1: Thread `checkId` through the engine

The screen links each cheque number to `/checks/[id]`, so the row has to carry the id. The workbook ignores it.

**Files:**
- Modify: `lib/export/voucher-index.ts`
- Modify: `lib/export/voucher-query.ts`
- Test: `tests/export/voucher-index.test.ts`, `tests/export/voucher-query.test.ts`, `tests/export/voucher-workbook.test.ts`

**Interfaces:**
- Produces: `CheckCandidate.checkId: string` (required); `VoucherRow.checkId: string | null` — null exactly when `checkNumber` is null.

- [ ] **Step 1: Write the failing tests**

In `tests/export/voucher-index.test.ts`, add `checkId: 'chk_0001'` to the `candidate()` helper's defaults, between `voucher` handling and `checkNumber` — the helper becomes:

```ts
function candidate(overrides: Partial<CheckCandidate> & { voucher: string }): CheckCandidate {
  return {
    checkId: 'chk_0001',
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
```

Then add, inside `describe('resolveVoucherRows — one row per voucher', ...)`:

```ts
  it('carries the cheque id so a screen can link the number', () => {
    const [row] = resolveVoucherRows({
      checks: [candidate({ voucher: 'AP-ST042652', checkId: 'chk_link' })],
      staged: [],
    })
    expect(row.checkId).toBe('chk_link')
  })

  it('has no cheque id when it has no cheque number', () => {
    const rows = resolveVoucherRows({
      checks: [
        candidate({ voucher: 'AP-ST036567', checkId: 'chk_a', checkNumber: '6000300003', status: 'SIGNED' }),
        candidate({ voucher: 'AP-ST036567', checkId: 'chk_b', checkNumber: '6000300004', status: 'SIGNED' }),
      ],
      staged: [],
    })
    expect(rows[0].checkNumber).toBeNull()
    expect(rows[0].checkId).toBeNull()
  })
```

In `tests/export/voucher-workbook.test.ts`, add `checkId: 'chk_0001',` as the first line of the `row()` helper's returned object. No new assertion — the sheet does not show it.

In `tests/export/voucher-query.test.ts`, add inside `describe('listVoucherCandidates', ...)`:

```ts
  it('returns the cheque id alongside its number', async () => {
    const check = await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const { checks } = await listVoucherCandidates(testDb)
    expect(checks[0].checkId).toBe(check.id)
  })
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx.cmd vitest run tests/export/voucher-index.test.ts
```

Expected: FAIL — type errors are erased, so the two new tests fail on `expected undefined to be 'chk_link'` and the like.

- [ ] **Step 3: Thread the id**

In `lib/export/voucher-index.ts`:

`CheckCandidate` gains, as its first field after `voucher`:

```ts
  /** `Check.id`, so a screen can link the number. The workbook ignores it. */
  checkId: string
```

`VoucherRow` gains, after `voucher`:

```ts
  /** Null exactly when `checkNumber` is — the screen links one to the other. */
  checkId: string | null
```

In `fromCheque`, add `checkId: c.checkId,` immediately after `voucher,`. In `withoutCheque`, add `checkId: null,` immediately after `voucher,`.

In `lib/export/voucher-query.ts`, add one select line to the cheque query, directly after the `v.voucher` line:

```sql
             c.id                                       as "checkId",
```

- [ ] **Step 4: Run the three test files and the type-checker**

```bash
npx.cmd vitest run tests/export/voucher-index.test.ts tests/export/voucher-query.test.ts tests/export/voucher-workbook.test.ts
```

Expected: PASS — 17, 7 and 7.

```bash
npx.cmd tsc --noEmit
```

Expected: no output. If `tests/export/voucher-route.test.ts` or `voucher-workbook.ts` complains about a missing `checkId`, that is the type-checker doing its job — fix the literal, never widen the type.

- [ ] **Step 5: Commit**

```bash
git add lib/export/voucher-index.ts lib/export/voucher-query.ts tests/export/voucher-index.test.ts tests/export/voucher-query.test.ts tests/export/voucher-workbook.test.ts
git commit -m "feat: carry the cheque id through the voucher index so a screen can link it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: A voucher search, in the SQL

**Files:**
- Modify: `lib/export/voucher-query.ts`
- Test: `tests/export/voucher-query.test.ts`

**Interfaces:**
- Produces: `export type VoucherCandidateFilter = { voucher?: string }` and `listVoucherCandidates(db, filter?: VoucherCandidateFilter)`. Omitting the filter, or passing an empty string, returns everything — the route and the export keep calling it with one argument.

- [ ] **Step 1: Write the failing tests**

Add to `tests/export/voucher-query.test.ts`, inside the existing `describe`:

```ts
  it('narrows to vouchers containing the search, case-insensitively', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    await makeCheck({ apvNumbers: ['AP-A1033692'] })
    const { checks } = await listVoucherCandidates(testDb, { voucher: 'st0426' })
    expect(checks.map((c) => c.voucher)).toEqual(['AP-ST042652'])
  })

  it('narrows the staged rows by the same search', async () => {
    await testDb.stagedCheck.create({
      data: {
        source: 'WORKBOOK', sourceSheet: 'BPI STK', sourceRow: 412,
        reason: 'NO_COMPANY', checkNumber: '6000353110',
        apvNumbers: ['AP-A1-02663'], impliedStatus: 'SIGNED',
      },
    })
    await testDb.stagedCheck.create({
      data: {
        source: 'WORKBOOK', sourceSheet: 'BPI STK', sourceRow: 413,
        reason: 'NO_COMPANY', checkNumber: '6000353111',
        apvNumbers: ['AP-ST099001'], impliedStatus: 'SIGNED',
      },
    })
    const { staged } = await listVoucherCandidates(testDb, { voucher: 'a1-02' })
    expect(staged.map((s) => s.voucher)).toEqual(['AP-A1-02663'])
  })

  it('treats an empty search as no search', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    const { checks } = await listVoucherCandidates(testDb, { voucher: '   ' })
    expect(checks).toHaveLength(1)
  })
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/export/voucher-query.test.ts
```

Expected: FAIL — the first new test returns both vouchers; the second returns both staged rows.

- [ ] **Step 3: Add the filter**

In `lib/export/voucher-query.ts`, replace the function signature and add the pattern, and add one `where` clause to each query. The full function after the change:

```ts
/**
 * The screen's search. `voucher` is matched as a case-insensitive SUBSTRING,
 * so "042652" finds `AP-ST042652` — unlike the dashboard's `q`, which can only
 * test whole-array containment over `apvNumbers` and finds nothing for a
 * fragment. That is the point of unnesting: once a voucher is a row, it is a
 * string, and `ilike` works on it.
 *
 * A bound parameter, never string-built. `%` and `_` inside the search act as
 * wildcards; a voucher reference contains neither, so nothing is escaped.
 */
export type VoucherCandidateFilter = { voucher?: string }

export async function listVoucherCandidates(
  db: Db,
  filter: VoucherCandidateFilter = {},
): Promise<VoucherIndexInput> {
  const needle = filter.voucher?.trim()
  // `%` alone matches every voucher, so the unfiltered read is the same query
  // with the same plan rather than a second query to keep in step.
  const pattern = needle ? `%${needle}%` : '%'

  const [checks, staged] = await Promise.all([
    db.$queryRaw<RawCheckCandidate[]>`
      select v.voucher                                  as "voucher",
             c.id                                       as "checkId",
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
       where c."isIncomplete" = false
         and v.voucher ilike ${pattern}`,
    db.$queryRaw<StagedCandidate[]>`
      select distinct
             v.voucher          as "voucher",
             s."sourceSheet"    as "sourceSheet",
             s."sourceRow"      as "sourceRow",
             s."statedCheckRef" as "statedCheckRef",
             s."checkNumber"    as "checkNumber",
             s."acumaticaRef"   as "acumaticaRef"
        from "StagedCheck" s
        cross join lateral unnest(s."apvNumbers") as v(voucher)
       where v.voucher ilike ${pattern}`,
  ])

  return {
    checks: checks.map((c) => ({ ...c, status: c.status as CheckStatus })),
    staged,
  }
}
```

Keep the two existing comment blocks above the queries (the `isIncomplete` reasoning and the `distinct` reasoning) exactly where they are.

- [ ] **Step 4: Run the test file and the type-checker**

```bash
npx.cmd vitest run tests/export/voucher-query.test.ts
```

Expected: PASS, 10 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/export/voucher-query.ts tests/export/voucher-query.test.ts
git commit -m "feat: search vouchers by substring, in the SQL

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The pure view module and the synthetic pills

**Files:**
- Create: `lib/vouchers-view.ts`
- Modify: `lib/status-pill.ts`
- Test: `tests/vouchers-view.test.ts` (create), `tests/status-pill.test.ts` (extend)

**Interfaces:**
- Consumes: `CONTESTED`, `ALL_CANCELLED`, `NOT_KEYED`, `type VoucherRow` from `lib/export/voucher-index.ts`; `ALL_STATUSES` from `lib/queries.ts`; `statusWords` from `lib/export/report.ts`.
- Produces, from `lib/vouchers-view.ts`: `VOUCHERS_PATH = '/vouchers'`, `VOUCHER_SCREEN_ROW_LIMIT = 200`, `SYNTHETIC_STATUSES`, `VOUCHER_STATUS_OPTIONS: readonly string[]`, `parseVoucherStatusParam(value: string | undefined): string | undefined`, `filterByStatus(rows: readonly VoucherRow[], status: string | undefined): VoucherRow[]`, `vouchersHref(params: { q?: string; status?: string }): string`, `describeVoucherView(total: number, shown: number, q: string | undefined, status: string | undefined): string`.
- Produces, from `lib/status-pill.ts`: `VOUCHER_STATUS_PILL_CLASS`, `voucherStatusPillClass(status: string): string` — takes a status AS WORDS (`'READY FOR RELEASE'`, `'CONTESTED'`).

- [ ] **Step 1: Write the failing tests**

Create `tests/vouchers-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  VOUCHERS_PATH, VOUCHER_SCREEN_ROW_LIMIT, VOUCHER_STATUS_OPTIONS,
  parseVoucherStatusParam, filterByStatus, vouchersHref, describeVoucherView,
} from '@/lib/vouchers-view'
import { CONTESTED, ALL_CANCELLED, NOT_KEYED, type VoucherRow } from '@/lib/export/voucher-index'

/**
 * Pure. The page reads these and decides nothing itself, which is what lets
 * every decision on the screen be pinned here with literals.
 */
function row(overrides: Partial<VoucherRow> & { voucher: string }): VoucherRow {
  return {
    checkId: 'chk_0001',
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

describe('the STATUS select', () => {
  it('offers every ladder status as words, then the three the resolver invents', () => {
    expect(VOUCHER_STATUS_OPTIONS).toContain('READY FOR RELEASE')
    expect(VOUCHER_STATUS_OPTIONS).not.toContain('READY_FOR_RELEASE')
    expect(VOUCHER_STATUS_OPTIONS.slice(-3)).toEqual([CONTESTED, ALL_CANCELLED, NOT_KEYED])
  })
})

describe('parseVoucherStatusParam', () => {
  it('accepts a status as words', () => {
    expect(parseVoucherStatusParam('READY FOR RELEASE')).toBe('READY FOR RELEASE')
  })

  it('accepts the underscore spelling and answers in words', () => {
    expect(parseVoucherStatusParam('READY_FOR_RELEASE')).toBe('READY FOR RELEASE')
  })

  it('accepts a synthetic status', () => {
    expect(parseVoucherStatusParam('NOT KEYED')).toBe(NOT_KEYED)
  })

  it('ignores anything it does not recognise, rather than filtering to nothing', () => {
    expect(parseVoucherStatusParam('DELIVERED')).toBeUndefined()
    expect(parseVoucherStatusParam('')).toBeUndefined()
    expect(parseVoucherStatusParam(undefined)).toBeUndefined()
  })
})

describe('filterByStatus', () => {
  const rows = [
    row({ voucher: 'AP-1', status: 'SIGNED' }),
    row({ voucher: 'AP-2', status: CONTESTED, checkId: null, checkNumber: null }),
    row({ voucher: 'AP-3', status: 'READY FOR RELEASE' }),
  ]

  it('keeps every row when no status is chosen', () => {
    expect(filterByStatus(rows, undefined)).toHaveLength(3)
  })

  it('narrows to a real status', () => {
    expect(filterByStatus(rows, 'SIGNED').map((r) => r.voucher)).toEqual(['AP-1'])
  })

  it('narrows to a synthetic status', () => {
    expect(filterByStatus(rows, CONTESTED).map((r) => r.voucher)).toEqual(['AP-2'])
  })
})

describe('vouchersHref', () => {
  it('is the bare path with nothing set', () => {
    expect(vouchersHref({})).toBe(VOUCHERS_PATH)
  })

  it('carries the search and the status, and drops an empty search', () => {
    expect(vouchersHref({ q: 'ST0426', status: CONTESTED })).toBe('/vouchers?q=ST0426&status=CONTESTED')
    expect(vouchersHref({ q: '   ', status: CONTESTED })).toBe('/vouchers?status=CONTESTED')
  })
})

describe('describeVoucherView', () => {
  it('states the count', () => {
    expect(describeVoucherView(1032, 200, undefined, undefined))
      .toBe('1,032 VOUCHERS · SHOWING FIRST 200 — narrow the search to see the rest')
  })

  it('says so when everything is shown', () => {
    expect(describeVoucherView(12, 12, 'ST0426', undefined)).toBe('12 VOUCHERS MATCHING "ST0426"')
  })

  it('names the status in force', () => {
    expect(describeVoucherView(6, 6, undefined, CONTESTED)).toBe('6 VOUCHERS WITH STATUS CONTESTED')
  })

  it('does not leave an empty result silent', () => {
    expect(describeVoucherView(0, 0, 'ZZZ', undefined)).toBe('NO VOUCHERS MATCHING "ZZZ"')
  })

  it('caps at 200', () => {
    expect(VOUCHER_SCREEN_ROW_LIMIT).toBe(200)
  })
})
```

Add to `tests/status-pill.test.ts` — extend the import line to
`import { statusPillClass, STATUS_PILL_CLASS, voucherStatusPillClass, VOUCHER_STATUS_PILL_CLASS } from '@/lib/status-pill'`, add
`import { CONTESTED, ALL_CANCELLED, NOT_KEYED } from '@/lib/export/voucher-index'`, and append:

```ts
/**
 * The voucher screen shows statuses AS WORDS — `READY FOR RELEASE` — because
 * the resolver has already spelled them out for the Excel index, and three of
 * them are not cheque statuses at all. This lookup answers for both kinds.
 */
describe('voucherStatusPillClass', () => {
  it('covers exactly the three statuses only the resolver produces', () => {
    expect(Object.keys(VOUCHER_STATUS_PILL_CLASS).sort())
      .toEqual([CONTESTED, ALL_CANCELLED, NOT_KEYED].sort())
  })

  it('paints a real status the colour the dashboard gives it, from its words', () => {
    expect(voucherStatusPillClass('READY FOR RELEASE')).toBe(statusPillClass('READY_FOR_RELEASE'))
    expect(voucherStatusPillClass('SIGNATURE PENDING')).toBe(statusPillClass('SIGNATURE_PENDING'))
  })

  it('warns on a contested or unkeyed voucher and marks all-cancelled as gone wrong', () => {
    expect(voucherStatusPillClass(CONTESTED)).toContain('warning')
    expect(voucherStatusPillClass(NOT_KEYED)).toContain('warning')
    expect(voucherStatusPillClass(ALL_CANCELLED)).toContain('danger')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx.cmd vitest run tests/vouchers-view.test.ts tests/status-pill.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/vouchers-view"`, and the pill test fails on the missing exports.

- [ ] **Step 3: Write the module and the pill map**

Create `lib/vouchers-view.ts`:

```ts
import { ALL_STATUSES } from './queries'
import { statusWords } from './export/report'
import { CONTESTED, ALL_CANCELLED, NOT_KEYED, type VoucherRow } from './export/voucher-index'

/**
 * The voucher screen's arithmetic: what its URL means, what its select offers,
 * how its rows are narrowed, and what its count line says.
 *
 * Pure, for the same reason `dashboard-view.ts` is: the page reads these and
 * decides nothing itself, so every decision on the screen is pinned here with
 * literals rather than by rendering a page and reading text out of it.
 */

export const VOUCHERS_PATH = '/vouchers'

/**
 * How many rows the screen draws. A cap that says so — `describeVoucherView`
 * states the true total beside it — rather than pagination, for the same
 * reason the dashboard caps at 200: a voucher is found by searching for it,
 * not by paging to it.
 */
export const VOUCHER_SCREEN_ROW_LIMIT = 200

/**
 * The three statuses that are facts about a ROW rather than about a cheque.
 * They exist only after resolution, which is why the status filter is applied
 * to resolved rows and not pushed into the SQL like the search is.
 */
export const SYNTHETIC_STATUSES = [CONTESTED, ALL_CANCELLED, NOT_KEYED] as const

/**
 * What the STATUS select offers: every rung of the ladder, spelled as the row
 * spells it — `VoucherRow.status` already holds `statusWords` output — then the
 * three synthetic ones. The ladder is read from `ALL_STATUSES`, not restated:
 * a restatement is how a ninth status ends up on the dashboard and not here.
 */
export const VOUCHER_STATUS_OPTIONS: readonly string[] = [
  ...ALL_STATUSES.map(statusWords),
  ...SYNTHETIC_STATUSES,
]

/**
 * `?status=` as the screen reads it. Words or underscores are both accepted —
 * a link pasted from the dashboard carries `READY_FOR_RELEASE` — and the answer
 * is always words. Anything unrecognised is ignored rather than passed on: a
 * filter to a status that does not exist would show an empty table that looks
 * like a broken one.
 */
export function parseVoucherStatusParam(value: string | undefined): string | undefined {
  if (!value) return undefined
  const words = value.trim().toUpperCase().replace(/_/g, ' ')
  return VOUCHER_STATUS_OPTIONS.includes(words) ? words : undefined
}

export function filterByStatus(
  rows: readonly VoucherRow[],
  status: string | undefined,
): VoucherRow[] {
  if (!status) return [...rows]
  return rows.filter((r) => r.status === status)
}

/** The URL a filled-in form means. An empty search is dropped, as the dashboard drops it. */
export function vouchersHref(params: { q?: string; status?: string }): string {
  const qs = new URLSearchParams()
  const q = params.q?.trim()
  if (q) qs.set('q', q)
  if (params.status) qs.set('status', params.status)
  const s = qs.toString()
  return s ? `${VOUCHERS_PATH}?${s}` : VOUCHERS_PATH
}

const count = (n: number) => n.toLocaleString('en-PH')

/**
 * The line above the table. Says how many there are, how many are drawn, and
 * what narrowed them — the same discipline as `describeScope` in the export:
 * a table of 200 that does not say it is the first 200 reads as the whole.
 */
export function describeVoucherView(
  total: number,
  shown: number,
  q: string | undefined,
  status: string | undefined,
): string {
  const scope = [
    q?.trim() ? `MATCHING "${q.trim()}"` : null,
    status ? `WITH STATUS ${status}` : null,
  ].filter(Boolean).join(' · ')
  const suffix = scope ? ` ${scope}` : ''
  if (total === 0) return `NO VOUCHERS${suffix}`
  const what = `${count(total)} VOUCHER${total === 1 ? '' : 'S'}${suffix}`
  if (shown < total) return `${what} · SHOWING FIRST ${count(shown)} — narrow the search to see the rest`
  return what
}
```

In `lib/status-pill.ts`, add the import at the top:

```ts
import { CONTESTED, ALL_CANCELLED, NOT_KEYED } from './export/voucher-index'
```

and append at the end of the file:

```ts
/**
 * The three statuses the voucher screen shows that are not cheque statuses.
 *
 * Kept OUT of `STATUS_PILL_CLASS` deliberately: that map is `Record<CheckStatus,
 * string>` and tested to hold exactly the ladder, so a status that is a fact
 * about a voucher row rather than about a cheque has no business in it.
 *
 * CONTESTED and NOT KEYED are "waiting on a person" — the warning tone the
 * dashboard gives SIGNATURE PENDING. ALL CANCELLED is "gone wrong", the danger
 * tone CANCELLED and VOIDED carry, because every cheque behind it is one of
 * those. Pastel, like everything else: the client's standing note.
 */
export const VOUCHER_STATUS_PILL_CLASS: Record<
  typeof CONTESTED | typeof ALL_CANCELLED | typeof NOT_KEYED, string
> = {
  [CONTESTED]:     'bg-warning-bg text-warning-ink',
  [ALL_CANCELLED]: 'bg-danger-bg text-danger-ink',
  [NOT_KEYED]:     'bg-warning-bg text-warning-ink',
}

/**
 * The class for a status the voucher screen holds — AS WORDS, because
 * `VoucherRow.status` is already `statusWords` output. A synthetic status has
 * its own colour; a real one is turned back into the enum spelling and painted
 * exactly as the dashboard paints it, so `READY FOR RELEASE` is the same green
 * on both screens.
 */
export function voucherStatusPillClass(status: string): string {
  const synthetic = VOUCHER_STATUS_PILL_CLASS[status as keyof typeof VOUCHER_STATUS_PILL_CLASS]
  if (synthetic) return synthetic
  return statusPillClass(status.replace(/ /g, '_'))
}
```

- [ ] **Step 4: Run the two test files and the type-checker**

```bash
npx.cmd vitest run tests/vouchers-view.test.ts tests/status-pill.test.ts
```

Expected: PASS — 15 in `vouchers-view`, and the pill file's existing tests plus 3.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/vouchers-view.ts lib/status-pill.ts tests/vouchers-view.test.ts tests/status-pill.test.ts
git commit -m "feat: the voucher screen's arithmetic, pure, and a pill for the statuses only it shows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The page, the table, and the navigation

**Files:**
- Create: `components/VoucherTable.tsx`
- Create: `app/vouchers/page.tsx`
- Modify: `components/AppHeader.tsx`
- Modify: `components/QuickActions.tsx`

**Interfaces:**
- Consumes: everything Tasks 1–3 produce; `requireUser` from `@/lib/auth`; `prisma` from `@/lib/db`; `AppHeader`, `EmptyState`, `Panel` components; `VOUCHER_INDEX_HREF` from `lib/export/voucher-index.ts`.
- Produces: `VoucherTable({ rows }: { rows: readonly VoucherRow[] })`; `AppHeader` gains `showVouchersLink?: boolean` (default `true`).

No new unit test: no page in this repository has one. Verification is `tsc`, `next build` listing `/vouchers`, and the pure module's tests already in place.

- [ ] **Step 1: The table**

Create `components/VoucherTable.tsx`:

```tsx
import Link from 'next/link'
import { voucherStatusPillClass } from '@/lib/status-pill'
import type { VoucherRow } from '@/lib/export/voucher-index'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

/**
 * One voucher per row, exactly as the Excel index lays it out, minus RELEASED
 * — empty on every row today and shown on the cheque's own page when it fills.
 *
 * A server component, on purpose: nothing here is interactive. The cheque
 * number is a link to the cheque, the status is a pill, and the remarks wrap.
 * Not `CheckTable`, whose column picker, checkboxes and bulk bar are about
 * cheques Finance can act on — nothing on this screen is acted on, it is read.
 *
 * A blank CHECK NUMBER is drawn as a dash, and the row's STATUS and REMARKS say
 * why. The explanation under the table on the page repeats it in full.
 */
export function VoucherTable({ rows }: { rows: readonly VoucherRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">VOUCHER</th>
            <th className="px-4 py-3">CHECK NUMBER</th>
            <th className="px-4 py-3">BANK</th>
            <th className="px-4 py-3">COMPANY</th>
            <th className="px-4 py-3">STATUS</th>
            <th className="px-4 py-3">CHECK DATE</th>
            <th className="px-4 py-3">PAYEE</th>
            <th className="px-4 py-3">SUPERSEDES</th>
            <th className="px-4 py-3">REMARKS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.voucher}
              className="border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground hover:bg-navy-bg"
            >
              <td className="whitespace-nowrap px-4 py-3 font-medium">{r.voucher}</td>
              <td className="whitespace-nowrap px-4 py-3">
                {r.checkId && r.checkNumber
                  ? (
                    <Link href={`/checks/${r.checkId}`} className="underline underline-offset-2">
                      {r.checkNumber}
                    </Link>
                  )
                  : '—'}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{r.bank ?? '—'}</td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{r.company ?? '—'}</td>
              <td className="whitespace-nowrap px-4 py-3">
                <span
                  className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide ${voucherStatusPillClass(r.status)}`}
                >
                  {r.status}
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmtDate(r.checkDate)}</td>
              <td className="px-4 py-3">{r.payee ?? '—'}</td>
              <td className="px-4 py-3 text-slate-600">{r.supersedes ?? '—'}</td>
              <td className="min-w-[24rem] px-4 py-3 text-slate-600">{r.remarks ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: The page**

Create `app/vouchers/page.tsx`:

```tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { Panel } from '@/components/Panel'
import { VoucherTable } from '@/components/VoucherTable'
import { listVoucherCandidates } from '@/lib/export/voucher-query'
import {
  resolveVoucherRows, VOUCHER_INDEX_HREF, CONTESTED, ALL_CANCELLED, NOT_KEYED,
} from '@/lib/export/voucher-index'
import {
  VOUCHERS_PATH, VOUCHER_SCREEN_ROW_LIMIT, VOUCHER_STATUS_OPTIONS,
  parseVoucherStatusParam, filterByStatus, describeVoucherView,
} from '@/lib/vouchers-view'

/**
 * VOUCHERS — which cheque pays this AP voucher, and where is it.
 *
 * The client, shown a document asking Finance to repoint three VLOOKUPs in the
 * Executive Report (2026-09-10): "why do i need to calibrate the excel formula?
 * I want the report to be done in the portal. And report can be extracted from
 * there." So the report is this page, and EXPORT EXCEL is the extract.
 *
 * Everything shown here is decided by `resolveVoucherRows` — the same judgement
 * the Excel index is built from, so the screen and the file can never disagree
 * about a voucher. The page reads parameters through `lib/vouchers-view.ts`
 * and decides nothing itself.
 *
 * A plain `<form method="get">`, like the dashboard's filter bar: a search is
 * linkable, bookmarkable, and works on a workstation whose JavaScript has
 * failed. The dashboard's auto-submit enhancement is wired to `/`, so this
 * form keeps its APPLY button.
 */
export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const q = params.q?.trim() ?? ''
  const status = parseVoucherStatusParam(params.status)

  // The search goes into the SQL; the status is applied after resolution,
  // because CONTESTED, ALL CANCELLED and NOT KEYED exist only once a voucher's
  // cheques have been looked at together.
  const candidates = await listVoucherCandidates(prisma, { voucher: q || undefined })
  const matching = filterByStatus(resolveVoucherRows(candidates), status)
  const rows = matching.slice(0, VOUCHER_SCREEN_ROW_LIMIT)

  const anyFilter = Boolean(q || status)
  const field = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 p-8">
      <AppHeader
        user={user}
        title="VOUCHERS"
        back={{ href: '/', label: '← DASHBOARD' }}
        showVouchersLink={false}
      />

      <form className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline" method="get">
        <label className="sr-only" htmlFor="voucher-q">SEARCH VOUCHER</label>
        <input
          id="voucher-q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Voucher, e.g. AP-ST042652 or 042652"
          className={`${field} w-72`}
        />

        <label className="sr-only" htmlFor="voucher-status">STATUS</label>
        <select id="voucher-status" name="status" defaultValue={status ?? ''} className={field}>
          <option value="">ANY STATUS</option>
          {VOUCHER_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <button
          type="submit"
          className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
        >
          APPLY
        </button>

        {anyFilter && (
          <Link href={VOUCHERS_PATH} className="text-sm text-slate-500 underline underline-offset-2">
            RESET
          </Link>
        )}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-slate-600">
          {describeVoucherView(matching.length, rows.length, q || undefined, status)}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          {/* The whole index, NOT the filtered view: a lookup extract has to
              cover everything, and a reader who narrowed to CONTESTED must not
              think the file did too. Said beside the button, not in a tooltip. */}
          <span className="text-xs text-slate-500">The file holds every voucher, not this filtered view.</span>
          <a
            href={VOUCHER_INDEX_HREF}
            className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
          >
            EXPORT EXCEL
          </a>
        </div>
      </div>

      {rows.length === 0
        ? (
          <EmptyState title={anyFilter ? 'NO VOUCHERS MATCH' : 'NO VOUCHERS ARE KNOWN'}>
            {anyFilter
              ? 'Nothing carries that voucher with that status. A voucher no cheque has been written for has no row here at all.'
              : 'No cheque carries an AP voucher yet. Vouchers arrive with the register import and the approval-for-release workbook.'}
          </EmptyState>
        )
        : <VoucherTable rows={rows} />}

      <Panel title="WHEN THE CHECK NUMBER IS BLANK">
        <p className="text-sm leading-relaxed text-slate-600">
          A blank cheque number is not a failure. It means this system will not guess, and
          the STATUS column says which of three reasons applies. REMARKS spells it out every time.
        </p>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-semibold text-navy">{CONTESTED}</dt>
            <dd className="mt-1 text-slate-600">
              Two live cheques both name this voucher. Naming one would tell a supplier the wrong
              thing. REMARKS names both, with their companies. Settle it on the cheques themselves.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-navy">{ALL_CANCELLED}</dt>
            <dd className="mt-1 text-slate-600">
              Every cheque that named this voucher was cancelled or voided. The payable still needs
              a cheque. REMARKS lists the cancelled ones.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-navy">{NOT_KEYED}</dt>
            <dd className="mt-1 text-slate-600">
              A staged row names this voucher and was never settled. REMARKS names the sheet and
              row; an administrator settles it on the STAGED QUEUE.
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          A voucher with <span className="font-semibold">no row at all</span> is the ordinary case: no cheque
          has been written for that payable yet.
        </p>
      </Panel>
    </main>
  )
}
```

- [ ] **Step 3: The header link**

In `components/AppHeader.tsx`, change the props to add `showVouchersLink`:

```tsx
export function AppHeader({
  user, title, back, showAdminLink = true, showVouchersLink = true,
}: {
  user: SessionUser
  title: string
  back?: { href: string; label: string }
  /** False on the admin pages, which ARE the administration area. */
  showAdminLink?: boolean
  /** False on the vouchers page, which IS the voucher screen. */
  showVouchersLink?: boolean
}) {
```

and, inside the right-hand `<div className="flex items-baseline gap-4 ...">`, insert **before** the admin link block:

```tsx
        {/* Every signed-in user. The page is guarded server-side; the link is
            shown to everyone because the question it answers — which cheque
            pays this voucher — is a Finance user's question, not an admin's. */}
        {showVouchersLink && (
          <Link href="/vouchers" className="underline underline-offset-2">VOUCHERS</Link>
        )}
```

- [ ] **Step 4: Take the anchor off the dashboard**

In `components/QuickActions.tsx`:

1. Delete the line `import { VOUCHER_INDEX_HREF } from '@/lib/export/voucher-index'`.
2. Delete the whole `VOUCHER INDEX (ALL CHEQUES)` block — the JSX comment beginning `THE VOUCHER INDEX — the file the Finance Executive Report looks into` and the `<a href={VOUCHER_INDEX_HREF} ...>` element after it, through its closing `</a>`.
3. Replace the component's doc comment with:

```tsx
/**
 * The three things a Finance user does with the list in front of them.
 *
 * Both live actions are plain anchors, not buttons with an onClick: the export
 * and the print sheet have to work on a workstation whose JavaScript has
 * failed, the same reasoning as the filter bar and the sign-out form. Each
 * carries the SAME parameters the dashboard is reading, so the file and the
 * sheet hold exactly the view on screen.
 *
 * The voucher index is deliberately NOT here. It briefly was, on 2026-09-10,
 * and it did not belong: it ignores every parameter this bar carries, because
 * a lookup extract has to cover every voucher rather than the filtered view.
 * It lives on /vouchers, the screen that explains it, beside its own EXPORT.
 */
```

- [ ] **Step 5: Type-check and build**

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

```bash
npx.cmd next build
```

Expected: build completes; `/vouchers` appears in the route list as `ƒ` (dynamic), and `/api/export/vouchers` is still there.

- [ ] **Step 6: Commit**

```bash
git add components/VoucherTable.tsx app/vouchers/page.tsx components/AppHeader.tsx components/QuickActions.tsx
git commit -m "feat: the voucher screen - which cheque pays this voucher, on screen, with Excel as the extract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Retire the handover

**Files:**
- Delete: `docs/voucher-index-handover.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-10-voucher-index-export-design.md`

- [ ] **Step 1: Delete the handover**

```bash
git rm docs/voucher-index-handover.md
```

- [ ] **Step 2: Rewrite the CLAUDE.md bullet**

In `CLAUDE.md`, find the bullet in "Data facts, measured" that begins
`- **The Finance Executive Report reads this system through \`CHECK BY VOUCHER.xlsx\`.**`
and replace the whole bullet (it ends with `Do not "restore" released-only semantics.`) with:

```markdown
- **Which cheque pays an AP voucher is answered on `/vouchers`, and `CHECK BY VOUCHER.xlsx` is
  its extract.** The Finance Executive Report's `AP Local` sheet used to find a payable's cheque
  with three `VLOOKUP`s into the released sheets of `CHECK MONITORING <date>.xlsx`; the register
  was retired on 2026-09-10 and a `VLOOKUP` into a stale external returns its last cached value for
  ever rather than failing. A handover asking Finance to repoint those formulas was written and
  then withdrawn the same day on the client's ruling: *"I want the report to be done in the portal.
  And report can be extracted from there."* Measured over `AP Local`'s 1,472 distinct vouchers: 986
  name exactly one cheque, 54 name more than one (46 of them a re-issue with a single live cheque),
  432 name none. The old formulas could answer 2 of the 1,472, because they looked only at released
  cheques and `AP Local` is the OPEN payables ledger. `resolveVoucherRows` in
  `lib/export/voucher-index.ts` is the one judgement both the screen and the file are built from;
  do not add a second. The extract keeps its fixed filename, fixed sheet `INDEX` and the timestamp
  in `$A$2` — a stable shape costs nothing — but nothing outside this system depends on them now.
```

- [ ] **Step 3: Point the old spec at the new one**

At the very top of `docs/superpowers/specs/2026-09-10-voucher-index-export-design.md`, before the `# Voucher index export — design` heading, insert:

```markdown
> **Superseded in part, the same day.** The delivery model here — a fixed-filename file that the
> Executive Report's formulas are repointed at — was withdrawn on the client's ruling that the
> report lives in this application and Excel is the extract. See
> `2026-09-10-voucher-screen-design.md`. The resolver, the read, the workbook and the route
> described below are unchanged and are that screen's engine.

```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-10-voucher-index-export-design.md
git commit -m "docs: the voucher report lives on /vouchers; nobody repoints a formula

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

`git rm` already staged the deletion, so this commit carries all three changes.

---

## Not in this plan

- **Paste-a-list.** Declined for now; EXPORT EXCEL is the bulk path.
- **The AP ageing report.** Needs the open-AP bills feed from Acumatica, which this system has never read. Its own spec.
- **A component or page test.** No page in this repository has one; the pure module carries the screen's decisions.
