# The List: Sort, Per-Column Filters, Column Order (Part C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the LIST screen, every column but ACTION sorts server-side (asc → desc → default, remembered in a cookie), a filter row under the headers narrows every column, and the COLUMNS panel reorders as well as hides — with the export, the printed sheet and SIGN ALL acting on exactly the rows the table shows.

**Architecture:** A pure sort module (`lib/list-sort.ts`) turns `sort`/`dir`/the `cm_sort` cookie into a `SortSpec` and a Prisma `orderBy`; four keys that Prisma cannot order (APV, PO, BANK, DATE RELEASED) are ordered in the application over the full matching set, then the page is fetched by id. A pure filter module (`lib/column-filters.ts`) parses the `f.*` parameters into `ColumnFilters`; `buildWhere` applies them, and an unparseable value sets `refused`, which makes `buildWhere` match nothing — so every consumer fails closed. APV/PO "contains" is a raw-SQL id step (`unnest` + `ILIKE`) inside a new async `whereFor`. Column order is the existing v2 `localStorage` array read as an ordered list.

**Tech Stack:** Next.js 15 App Router, Prisma 6 on Neon, Vitest, TypeScript strict, ExcelJS.

Spec: `docs/superpowers/specs/2026-10-01-signing-schedule-apv-and-table-design.md`, part C. **Part B executes first.** This plan assumes its outcome: `ColumnKey` gains `'poNumbers'` right after `'apvNumbers'` (label `'PO NUMBER'`), `CheckTableRow.poNumbers: string[]`, `COLUMN_STORAGE_KEY = 'check-monitoring.columns.v2'`, the export has PO at column 3 and AMOUNT at column 8, the print page shows APV and PO, and the global search matches PO exactly. Before Task 1, confirm with `grep -n "poNumbers\|columns.v2" lib/table-columns.ts lib/queries.ts lib/export/workbook.ts`; if part B has not landed, stop and say so.

**PO source, read once before Task 2.** `prisma/schema.prisma` (2026-10-01) has **no** `Check.poNumbers` column — the PO a cheque shows is `CheckBill.poNumber`. Part B's `toTableRow` will have resolved that. Read `toTableRow` in `lib/queries.ts`: if its `poNumbers` expression reads only `r.bills`, use the bills-only code in this plan as written; if part B added a `Check.poNumbers String[]` column and its expression unions `r.poNumbers`, apply the two "**If `Check.poNumbers` exists**" variants this plan gives in Tasks 2 and 3.

## Global Constraints

- Sort params: `sort=<SortKey>&dir=asc|desc`. `SortKey` = every `ColumnKey` except `action`. Both must be valid or the pair is ignored.
- Default order: `checkDate desc nulls last`, then `checkNumber asc`, then `id asc`. Every sort is nulls-last in both directions with the same two tiebreaks.
- Cookie: `cm_sort=<key>:<dir>; Path=/; Max-Age=31536000; SameSite=Lax`. Read only when the URL has no valid sort. Invalid cookie ignored. RESET deletes it (`Max-Age=0`).
- Filter params: `f.checkNumber`, `f.apv`, `f.po`, `f.payee`, `f.status`, `f.checkDateFrom`, `f.checkDateTo`, `f.availablePickupDateFrom`, `f.availablePickupDateTo`, `f.scheduledPickupDateFrom`, `f.scheduledPickupDateTo`, `f.amountMin`, `f.amountMax`; plus the existing `company`, `cashAccount`, `releasedFrom`, `releasedTo`, `eligibility`.
- Day: `YYYY-MM-DD`, a real calendar day (`isIsoDay`), bounds `manilaDayStart` / `manilaDayEnd`. Amount: commas and spaces stripped, then `/^\d{1,16}(\.\d{1,2})?$/`, kept as a STRING (rule 8).
- Refusal messages, exact: day `NOT A DAY — TYPE YYYY-MM-DD`; amount `NOT AN AMOUNT — DIGITS, AT MOST TWO DECIMALS (E.G. 1250.50)`; status `NOT A STATUS`.
- A refused filter matches NOTHING (`buildWhere` returns `{ id: { in: [] } }`); its raw value stays in `selection.base` so export, print and SIGN ALL refuse too.
- Every `f.*` param is a LIST parameter; `TOTALS_KEYS` stays `['company', 'cashAccount', 'eligibility']`. `getSummary`, `getTodaysRelease` and RELEASE ALL never see a column filter.
- Column preference: key `check-monitoring.columns.v2` (part B's), a JSON array of the VISIBLE columns IN DISPLAY ORDER. ACTION always last. CHECK NUMBER, STATUS, ACTION always on. No v3.
- Export: `cols=<key>,<key>,…` (URL-encoded commas) sets column ORDER only; every export column is still in the file.
- Tests: `node node_modules/vitest/vitest.mjs run <files>` from Bash, only the files named; one agent at a time against the test database. Type check: `node node_modules/typescript/bin/tsc --noEmit` must print nothing before a task is done.
- Never run scripts or the dev server: the repo `.env` is PRODUCTION. Stage files by path. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Change |
| --- | --- |
| `lib/list-sort.ts` | new, pure: `SortKey`, `SortSpec`, `DEFAULT_SORT`, parsing, cookie string, `nextSort`, `dbOrderBy`, `compareSortValues`, `APP_SORTED_KEYS` |
| `lib/queries.ts` | `listChecks(db, filters, limit, sort)`; in-app ordering; `displayApvNumbers` / `displayPoNumbers`; `ColumnFilters`; `refused`; `whereFor` (APV/PO raw step); `columnFilterFields`; SIGN ALL queries take `columns` |
| `lib/dashboard-view.ts` | `DashboardSelection.sort?`; links carry it; `sortHref`, `sortLinks`, `SortLink`; `dashboardScreen` counts it |
| `lib/column-filters.ts` | new, pure: param names, `parseColumnFilters`, messages, `describeColumnFilters`, `columnParamsOf`, `activeFilterColumns`, `LIST_FILTER_FORM`, `describeRefusal` |
| `lib/dashboard-params.ts` | sort (URL → cookie → default), column filters, refusal, `columnValues`, DATE RELEASED refuses |
| `lib/export/report.ts` | `describeFilters` gains `columns` and `sort` |
| `lib/table-columns.ts` | ordered preference: `insertColumn`, `toggleColumn`, `moveColumn`, `canMoveColumn`, `withColumns`, `withColumnOrder` |
| `components/CheckTable.tsx` | rendered by column order; ◀ ▶; sort headers; filter row; table kept when empty |
| `components/ColumnFilterCell.tsx`, `components/sort-cookie.ts`, `components/ResetLink.tsx`, `components/ExportLink.tsx` | new |
| `components/FilterBar.tsx`, `components/FilterAutoSubmit.tsx` | form id, controls moved to the table, document-level listening |
| `components/ConfirmAllForm.tsx`, `app/checks/bulk-actions.ts` | SIGN ALL carries and honours column filters; RELEASE ALL refuses them |
| `components/QuickActions.tsx` | EXPORT EXCEL adds `cols=` |
| `app/page.tsx` | cookie, sort, filter row state, refusal banner, exclusion count, SIGN ALL offer |
| `lib/export/workbook.ts`, `app/api/export/route.ts`, `app/print/page.tsx` | order, filters, refusal, cookie |
| spec, `CLAUDE.md` | decisions written back; behaviour |

---

### Task 1: The sort module, and the spec written back

**Files:**
- Create: `lib/list-sort.ts`
- Modify: `docs/superpowers/specs/2026-10-01-signing-schedule-apv-and-table-design.md` (part C)
- Test: `tests/list-sort.test.ts` (new)

**Interfaces:**
- Consumes: `COLUMN_KEYS`, `COLUMN_LABELS`, `ColumnKey` from `lib/table-columns.ts`.
- Produces: `type SortKey = Exclude<ColumnKey, 'action'>`; `type SortDir = 'asc' | 'desc'`; `type SortSpec = { key: SortKey; dir: SortDir }`; `SORT_KEYS: readonly SortKey[]`; `DEFAULT_SORT: SortSpec`; `APP_SORTED_KEYS`; `type AppSortKey`; `type DbSortKey`; `isAppSorted(key): key is AppSortKey`; `SORT_COOKIE = 'cm_sort'`; `SORT_COOKIE_MAX_AGE = 31_536_000`; `parseSort(key?, dir?): SortSpec | null`; `formatSortCookie(s): string`; `parseSortCookie(raw?): SortSpec | null`; `sortCookieString(next: SortSpec | null): string`; `readCookie(header, name): string | undefined`; `nextSort(active: SortSpec | null, key: SortKey): SortSpec | null`; `sameSort(a, b): boolean`; `describeSort(s): string`; `type SortValue = string | number | null`; `compareSortValues(a, b, dir): number`; `dbOrderBy(key: DbSortKey, dir: SortDir): Prisma.CheckOrderByWithRelationInput[]`.

Decision: APV NUMBER, PO NUMBER, BANK and DATE RELEASED are ordered in the application (`APP_SORTED_KEYS`), not by Prisma. Prisma cannot order by an array's first element (APV/PO, which also union the bills), cannot put a null to-one relation last on a descending sort (BANK — `nulls` exists only on nullable scalars), and cannot order by `COALESCE(releasedAt, statedReleaseDate)`, which is the date the DATE RELEASED column shows. Task 2 does it over the whole matching set, so the 200-row page is still the right 200.

Decision: STATUS sorts by the ladder (the `CheckStatus` enum's declaration order — Postgres orders enums that way), not alphabetically: GENERATED first, VOIDED last is what a Finance reader means by "in order".

Decision: `id asc` follows `checkNumber asc` as a last tiebreak. Cheque numbers repeat across companies; without it two rows with the same number and the same sort value could swap between the screen and the export.

Decision: the first click on any header — including CHECK DATE while the default order is in force — sorts ascending; `nextSort` treats "no explicit sort" as the start of the cycle. Otherwise clicking CHECK DATE on a fresh list would compute "desc → default" and do nothing.

- [ ] **Step 1: Write the failing test** — create `tests/list-sort.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  SORT_KEYS, DEFAULT_SORT, APP_SORTED_KEYS, isAppSorted, SORT_COOKIE,
  parseSort, formatSortCookie, parseSortCookie, sortCookieString, readCookie,
  nextSort, sameSort, describeSort, compareSortValues, dbOrderBy,
} from '@/lib/list-sort'

describe('the sort keys', () => {
  it('are every column but ACTION', () => {
    expect(SORT_KEYS).not.toContain('action')
    expect(SORT_KEYS).toContain('checkNumber')
    expect(SORT_KEYS).toContain('poNumbers')
    expect(SORT_KEYS).toContain('releasedAt')
  })

  it('order APV, PO, BANK and DATE RELEASED in the application, the rest in the database', () => {
    expect([...APP_SORTED_KEYS]).toEqual(['apvNumbers', 'poNumbers', 'bank', 'releasedAt'])
    expect(isAppSorted('bank')).toBe(true)
    expect(isAppSorted('amount')).toBe(false)
  })

  it('default to check date, newest first', () => {
    expect(DEFAULT_SORT).toEqual({ key: 'checkDate', dir: 'desc' })
  })
})

describe('parseSort', () => {
  it('reads a known key and direction', () => {
    expect(parseSort('amount', 'asc')).toEqual({ key: 'amount', dir: 'asc' })
    expect(parseSort(' payeeName ', 'desc')).toEqual({ key: 'payeeName', dir: 'desc' })
  })

  // Sort cannot widen anything, so it falls back rather than refusing.
  it('ignores an unknown key, an unknown direction, ACTION, or half a pair', () => {
    expect(parseSort('action', 'asc')).toBeNull()
    expect(parseSort('sourceSheet', 'asc')).toBeNull()
    expect(parseSort('amount', 'up')).toBeNull()
    expect(parseSort('amount', undefined)).toBeNull()
    expect(parseSort(undefined, 'asc')).toBeNull()
  })
})

describe('the remembered sort', () => {
  it('round-trips through the cookie value', () => {
    expect(formatSortCookie({ key: 'amount', dir: 'desc' })).toBe('amount:desc')
    expect(parseSortCookie('amount:desc')).toEqual({ key: 'amount', dir: 'desc' })
  })

  it('ignores a cookie it cannot read', () => {
    for (const bad of [undefined, '', 'amount', 'amount:', 'amount:desc:x', 'action:asc', 'nope:asc']) {
      expect(parseSortCookie(bad), String(bad)).toBeNull()
    }
  })

  it('writes one year, path /, SameSite=Lax — and deletes with Max-Age=0', () => {
    expect(SORT_COOKIE).toBe('cm_sort')
    expect(sortCookieString({ key: 'amount', dir: 'asc' }))
      .toBe('cm_sort=amount:asc; Path=/; Max-Age=31536000; SameSite=Lax')
    expect(sortCookieString(null)).toBe('cm_sort=; Path=/; Max-Age=0; SameSite=Lax')
  })

  it('reads one cookie out of a Cookie header', () => {
    expect(readCookie('a=1; cm_sort=amount:desc; b=2', 'cm_sort')).toBe('amount:desc')
    expect(readCookie('a=1', 'cm_sort')).toBeUndefined()
    expect(readCookie(null, 'cm_sort')).toBeUndefined()
  })
})

describe('nextSort — the header cycle', () => {
  it('goes ascending, then descending, then back to the default', () => {
    expect(nextSort(null, 'amount')).toEqual({ key: 'amount', dir: 'asc' })
    expect(nextSort({ key: 'amount', dir: 'asc' }, 'amount')).toEqual({ key: 'amount', dir: 'desc' })
    expect(nextSort({ key: 'amount', dir: 'desc' }, 'amount')).toBeNull()
  })

  it('starts a different column at ascending', () => {
    expect(nextSort({ key: 'amount', dir: 'desc' }, 'payeeName')).toEqual({ key: 'payeeName', dir: 'asc' })
  })

  // With no explicit sort the default (check date, newest first) is in force;
  // clicking CHECK DATE must still do something.
  it('sorts CHECK DATE ascending on the first click under the default', () => {
    expect(nextSort(null, 'checkDate')).toEqual({ key: 'checkDate', dir: 'asc' })
  })
})

describe('describeSort and sameSort', () => {
  it('says the sort in words', () => {
    expect(describeSort({ key: 'amount', dir: 'asc' })).toBe('AMOUNT (ASCENDING)')
    expect(describeSort({ key: 'checkDate', dir: 'desc' })).toBe('CHECK DATE (DESCENDING)')
    expect(sameSort(DEFAULT_SORT, { key: 'checkDate', dir: 'desc' })).toBe(true)
    expect(sameSort(DEFAULT_SORT, { key: 'checkDate', dir: 'asc' })).toBe(false)
  })
})

describe('compareSortValues', () => {
  it('puts nulls last in BOTH directions', () => {
    const values = [3, null, 1, 2]
    expect([...values].sort((a, b) => compareSortValues(a, b, 'asc'))).toEqual([1, 2, 3, null])
    expect([...values].sort((a, b) => compareSortValues(a, b, 'desc'))).toEqual([3, 2, 1, null])
    expect(['B', null, 'A'].sort((a, b) => compareSortValues(a, b, 'asc'))).toEqual(['A', 'B', null])
  })
})

describe('dbOrderBy', () => {
  it('is the old default order, with id as the last tiebreak', () => {
    expect(dbOrderBy('checkDate', 'desc')).toEqual([
      { checkDate: { sort: 'desc', nulls: 'last' } }, { checkNumber: 'asc' }, { id: 'asc' },
    ])
  })

  it('puts nulls last on every nullable column, both ways', () => {
    expect(dbOrderBy('amount', 'asc')[0]).toEqual({ amount: { sort: 'asc', nulls: 'last' } })
    expect(dbOrderBy('payeeName', 'desc')[0]).toEqual({ payeeName: { sort: 'desc', nulls: 'last' } })
    expect(dbOrderBy('scheduledPickupDate', 'desc')[0]).toEqual({ scheduledPickupDate: { sort: 'desc', nulls: 'last' } })
  })

  it('orders the company by its code and the status by the ladder', () => {
    expect(dbOrderBy('companyCode', 'desc')[0]).toEqual({ company: { code: 'desc' } })
    expect(dbOrderBy('status', 'asc')[0]).toEqual({ status: 'asc' })
    expect(dbOrderBy('checkNumber', 'desc')).toEqual([{ checkNumber: 'desc' }, { id: 'asc' }])
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/list-sort.test.ts` → `Failed to resolve import "@/lib/list-sort"`.

- [ ] **Step 3: Implement** — create `lib/list-sort.ts`:

```ts
import type { Prisma } from '@prisma/client'
import { COLUMN_KEYS, COLUMN_LABELS, type ColumnKey } from './table-columns'

/**
 * How the LIST screen's table is ordered (spec 2026-10-01, part C1).
 *
 * Pure: no database, no clock, no `document`. The page reads `sort`/`dir` from
 * the URL, falls back to the `cm_sort` cookie, then to `DEFAULT_SORT` — and the
 * export and the printed sheet run the same resolver, so all three agree.
 *
 * Sorting is SERVER-SIDE over every matching cheque. The list shows at most
 * 200 rows; sorting them in the browser would sort the wrong set.
 *
 * Nulls go LAST in BOTH directions — the `checkDate` lesson: Postgres puts
 * NULLs first on a descending sort, and a list that opens on a screen of em
 * dashes buries the cheques somebody has to act on.
 */

export type SortKey = Exclude<ColumnKey, 'action'>
export type SortDir = 'asc' | 'desc'
export type SortSpec = { key: SortKey; dir: SortDir }

export const SORT_KEYS: readonly SortKey[] = COLUMN_KEYS.filter((k): k is SortKey => k !== 'action')

export const DEFAULT_SORT: SortSpec = { key: 'checkDate', dir: 'desc' }

/**
 * The four orders Prisma cannot express, done in `lib/queries.ts` over the full
 * matching set: APV and PO sort by their FIRST value (an array element, and a
 * union with the bills); BANK cannot put a cheque with no cash account last on
 * a descending sort (`nulls` exists only on nullable scalars); DATE RELEASED
 * shows `releasedAt`, else the register's `statedReleaseDate`, and sorts by
 * the date it shows.
 */
export const APP_SORTED_KEYS = ['apvNumbers', 'poNumbers', 'bank', 'releasedAt'] as const satisfies readonly SortKey[]
export type AppSortKey = (typeof APP_SORTED_KEYS)[number]
export type DbSortKey = Exclude<SortKey, AppSortKey>

export function isAppSorted(key: SortKey): key is AppSortKey {
  return (APP_SORTED_KEYS as readonly string[]).includes(key)
}

export const SORT_COOKIE = 'cm_sort'
export const SORT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

const isSortKey = (v: unknown): v is SortKey =>
  typeof v === 'string' && (SORT_KEYS as readonly string[]).includes(v)
const isSortDir = (v: unknown): v is SortDir => v === 'asc' || v === 'desc'

/** Both halves valid, or no sort at all — an unknown value cannot widen anything, so it falls back. */
export function parseSort(key: string | undefined, dir: string | undefined): SortSpec | null {
  const k = key?.trim()
  const d = dir?.trim()
  return isSortKey(k) && isSortDir(d) ? { key: k, dir: d } : null
}

export function formatSortCookie(s: SortSpec): string {
  return `${s.key}:${s.dir}`
}

export function parseSortCookie(raw: string | undefined | null): SortSpec | null {
  if (!raw) return null
  const parts = raw.split(':')
  return parts.length === 2 ? parseSort(parts[0], parts[1]) : null
}

/** The `document.cookie` assignment for a header click; `null` deletes the memory. */
export function sortCookieString(next: SortSpec | null): string {
  return next
    ? `${SORT_COOKIE}=${formatSortCookie(next)}; Path=/; Max-Age=${SORT_COOKIE_MAX_AGE}; SameSite=Lax`
    : `${SORT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

/** One cookie's value from a `Cookie` request header — the export route has no `cookies()`. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

/**
 * The header cycle: ascending, descending, back to the default (`null`).
 * `active` is the sort the URL or the cookie put in force — null under the
 * default, so the first click on CHECK DATE sorts it ascending rather than
 * computing "descending → default" and doing nothing.
 */
export function nextSort(active: SortSpec | null, key: SortKey): SortSpec | null {
  if (!active || active.key !== key) return { key, dir: 'asc' }
  return active.dir === 'asc' ? { key, dir: 'desc' } : null
}

export function sameSort(a: SortSpec, b: SortSpec): boolean {
  return a.key === b.key && a.dir === b.dir
}

export function describeSort(s: SortSpec): string {
  return `${COLUMN_LABELS[s.key]} (${s.dir === 'asc' ? 'ASCENDING' : 'DESCENDING'})`
}

export type SortValue = string | number | null

/** Nulls last in both directions; otherwise plain `<` / `>`, reversed for desc. */
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDir): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  const c = a < b ? -1 : a > b ? 1 : 0
  return dir === 'asc' ? c : -c
}

/**
 * The database's half. `checkNumber asc` is the tiebreak the spec names; `id
 * asc` after it because cheque numbers repeat across companies, and two rows
 * that compare equal must not swap places between the screen and the export.
 * STATUS orders by the enum's declaration order — the ladder.
 */
export function dbOrderBy(key: DbSortKey, dir: SortDir): Prisma.CheckOrderByWithRelationInput[] {
  const last = { sort: dir, nulls: 'last' } as const
  const tie: Prisma.CheckOrderByWithRelationInput[] = [{ checkNumber: 'asc' }, { id: 'asc' }]
  switch (key) {
    case 'checkNumber': return [{ checkNumber: dir }, { id: 'asc' }]
    case 'payeeName': return [{ payeeName: last }, ...tie]
    case 'companyCode': return [{ company: { code: dir } }, ...tie]
    case 'checkDate': return [{ checkDate: last }, ...tie]
    case 'amount': return [{ amount: last }, ...tie]
    case 'status': return [{ status: dir }, ...tie]
    case 'availablePickupDate': return [{ availablePickupDate: last }, ...tie]
    case 'scheduledPickupDate': return [{ scheduledPickupDate: last }, ...tie]
    default: {
      const unreachable: never = key
      throw new Error(`No database order for ${String(unreachable)}`)
    }
  }
}
```

- [ ] **Step 4: Run, expect PASS; tsc clean.** `node node_modules/vitest/vitest.mjs run tests/list-sort.test.ts`, then `node node_modules/typescript/bin/tsc --noEmit` (prints nothing).

- [ ] **Step 5: Write the decisions into the spec.** In part C of the spec, append to each subsection, verbatim from the "Decision:" lines of this plan: C1 — the four in-app keys and why, STATUS by ladder order, `id` tiebreak, first click ascending, an invalid pair is "no sort" (cookie, then default); C2 — APV/PO "contains" via the raw-SQL step (Task 3), refusal enforced in `buildWhere` with the raw value kept in `base`, DATE RELEASED now refuses too, `f.status` only on ALL CHEQUES and dropped elsewhere, CHECK DATE reuses `CheckFilters.from/to`, amounts accept thousands commas, search/ELIGIBILITY/INCOMPLETE stay on the bar, a filtered column cannot be hidden, the table stays when empty, the LIST exclusion count is the list's own; C3 — part B's v2 key is reused with no v3 (a B-written value is canonical order and reads as the default order — the spec's "v1 value" sentence is replaced), ACTION pinned last, a re-shown column returns beside its canonical neighbour, `cols=` is order only and print keeps its fixed columns; C4 — cookie written in the browser on click, never `HttpOnly`, RESET deletes it in the browser, export and print read it. Add under C2: "SIGN ALL honours the column filters; RELEASE ALL lives on TOTALS, which no column filter can reach, and refuses any `f.*` field."

- [ ] **Step 6: Commit**

```bash
git add lib/list-sort.ts tests/list-sort.test.ts docs/superpowers/specs/2026-10-01-signing-schedule-apv-and-table-design.md
git commit -m "feat(list): sort keys, cookie and database order, pure" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `listChecks` sorts every column across all matching cheques

**Files:**
- Modify: `lib/queries.ts` (`listChecks` at :438-466, `toTableRow` at :606-644; new helpers)
- Test: `tests/queries.test.ts` (new `describe('listChecks sort')`)

**Interfaces:**
- Consumes: Task 1 (`SortSpec`, `DEFAULT_SORT`, `isAppSorted`, `dbOrderBy`, `compareSortValues`, `AppSortKey`, `SortDir`, `SortValue`).
- Produces: `listChecks(db: Db, filters: CheckFilters, limit = 200, sort: SortSpec = DEFAULT_SORT)`; `displayApvNumbers(r: { apvNumbers: string[]; bills: { apvNumber: string }[] }): string[]`; `displayPoNumbers(r: { bills: { poNumber: string | null }[] }): string[]`; `appSortValue(key: AppSortKey, r: SortProbe): SortValue`. `CheckRow` keeps its type (same `include`).

- [ ] **Step 1: Failing tests** — append to `tests/queries.test.ts` (add `import type { SortKey } from '@/lib/list-sort'` to the imports):

```ts
// Part C1: every column but ACTION, both directions, nulls LAST both ways.
describe('listChecks sort', () => {
  type Over = NonNullable<Parameters<typeof makeCheck>[0]>
  const nums = (rows: { checkNumber: string }[]) => rows.map((r) => r.checkNumber)
  const sorted = async (key: SortKey, dir: 'asc' | 'desc', limit = 200) =>
    nums(await listChecks(testDb, {}, limit, { key, dir }))
  // 6000000001 is the low value, 02 the high one, 03 has none (where a column can be empty).
  const three = async (low: Over, high: Over, none: Over) => {
    const a = await makeCheck({ checkNumber: '6000000001', ...low })
    const b = await makeCheck({ checkNumber: '6000000002', ...high })
    const c = await makeCheck({ checkNumber: '6000000003', ...none })
    return [a, b, c] as const
  }
  const ASC = ['6000000001', '6000000002', '6000000003']
  const DESC = ['6000000002', '6000000001', '6000000003']

  it('SUPPLIER NAME', async () => {
    await three({ payeeName: 'ALPHA' }, { payeeName: 'ZULU' }, { payeeName: null })
    expect(await sorted('payeeName', 'asc')).toEqual(ASC)
    expect(await sorted('payeeName', 'desc')).toEqual(DESC)
  })

  it('CHECK DATE', async () => {
    await three({ checkDate: new Date('2026-01-01') }, { checkDate: new Date('2026-09-01') }, { checkDate: null })
    expect(await sorted('checkDate', 'asc')).toEqual(ASC)
    expect(await sorted('checkDate', 'desc')).toEqual(DESC)
  })

  it('AMOUNT', async () => {
    await three({ amount: '10.00' }, { amount: '900.00' }, { amount: null })
    expect(await sorted('amount', 'asc')).toEqual(ASC)
    expect(await sorted('amount', 'desc')).toEqual(DESC)
  })

  it('AVAILABLE DATE', async () => {
    await three(
      { availablePickupDate: new Date('2026-01-01') }, { availablePickupDate: new Date('2026-09-01') },
      { availablePickupDate: null },
    )
    expect(await sorted('availablePickupDate', 'asc')).toEqual(ASC)
    expect(await sorted('availablePickupDate', 'desc')).toEqual(DESC)
  })

  it('PICKUP SCHEDULE', async () => {
    const [a, b] = await three({}, {}, {})
    await testDb.check.update({ where: { id: a.id }, data: { scheduledPickupDate: new Date('2026-01-01') } })
    await testDb.check.update({ where: { id: b.id }, data: { scheduledPickupDate: new Date('2026-09-01') } })
    expect(await sorted('scheduledPickupDate', 'asc')).toEqual(ASC)
    expect(await sorted('scheduledPickupDate', 'desc')).toEqual(DESC)
  })

  it('COMPANY, by its code', async () => {
    const [a, b, c] = await three({}, {}, {})
    await testDb.company.update({ where: { id: a.companyId }, data: { code: 'AAA' } })
    await testDb.company.update({ where: { id: b.companyId }, data: { code: 'ZZZ' } })
    await testDb.company.update({ where: { id: c.companyId }, data: { code: 'MMM' } })
    expect(await sorted('companyCode', 'asc')).toEqual(['6000000001', '6000000003', '6000000002'])
    expect(await sorted('companyCode', 'desc')).toEqual(['6000000002', '6000000003', '6000000001'])
  })

  it('STATUS, by the ladder rather than the alphabet', async () => {
    await three({ status: 'SIGNATURE_PENDING' }, { status: 'RELEASED' }, { status: 'SIGNED' })
    // SIGNATURE_PENDING < SIGNED < RELEASED on the ladder; alphabetically RELEASED would be first.
    expect(await sorted('status', 'asc')).toEqual(['6000000001', '6000000003', '6000000002'])
    expect(await sorted('status', 'desc')).toEqual(['6000000002', '6000000003', '6000000001'])
  })

  it('CHECK NUMBER', async () => {
    await three({}, {}, {})
    expect(await sorted('checkNumber', 'asc')).toEqual(ASC)
    expect(await sorted('checkNumber', 'desc')).toEqual(['6000000003', '6000000002', '6000000001'])
  })

  it('APV NUMBER, by the first value shown — the cheque’s own or a bill’s', async () => {
    const [, , c] = await three({ apvNumbers: ['AP-B', 'AP-Z'] }, { apvNumbers: ['AP-C'] }, { apvNumbers: [] })
    expect(await sorted('apvNumbers', 'asc')).toEqual(ASC)
    expect(await sorted('apvNumbers', 'desc')).toEqual(DESC)
    // A bill's voucher counts: it is on screen in the same cell.
    await testDb.checkBill.create({ data: { checkId: c.id, apvNumber: 'AP-A', amount: '1.00' } })
    expect(await sorted('apvNumbers', 'asc')).toEqual(['6000000003', '6000000001', '6000000002'])
  })

  it('PO NUMBER, by the first value shown', async () => {
    const [a, b] = await three({}, {}, {})
    await testDb.checkBill.create({ data: { checkId: a.id, apvNumber: 'AP-1', poNumber: 'PO-1', amount: '1.00' } })
    await testDb.checkBill.create({ data: { checkId: b.id, apvNumber: 'AP-2', poNumber: 'PO-9', amount: '1.00' } })
    expect(await sorted('poNumbers', 'asc')).toEqual(ASC)
    expect(await sorted('poNumbers', 'desc')).toEqual(DESC)
  })

  it('BANK, by the cash account code, a cheque with none last both ways', async () => {
    const [a, b, c] = await three({}, {}, {})
    await testDb.cashAccount.update({ where: { id: a.cashAccountId! }, data: { code: 'AAA BANK' } })
    await testDb.cashAccount.update({ where: { id: b.cashAccountId! }, data: { code: 'ZZZ BANK' } })
    await testDb.check.update({ where: { id: c.id }, data: { cashAccountId: null } })
    expect(await sorted('bank', 'asc')).toEqual(ASC)
    expect(await sorted('bank', 'desc')).toEqual(DESC)
  })

  it('DATE RELEASED, by the date shown — the app’s, else the register’s', async () => {
    await three(
      { status: 'RELEASED', releasedAt: new Date('2026-09-10T02:00:00Z') },
      { status: 'RELEASED', statedReleaseDate: new Date('2026-09-20') },
      { status: 'RELEASED' },
    )
    expect(await sorted('releasedAt', 'asc')).toEqual(ASC)
    expect(await sorted('releasedAt', 'desc')).toEqual(DESC)
  })

  // The list shows at most 200: the sort must pick the right 200, not sort the first 200.
  it('sorts across every matching cheque before the limit, in the database and in the app', async () => {
    await makeCheck({ checkNumber: '6000000001', amount: '500.00', apvNumbers: ['AP-M'] })
    await makeCheck({ checkNumber: '6000000002', amount: '100.00', apvNumbers: ['AP-Z'] })
    await makeCheck({ checkNumber: '6000000003', amount: '300.00', apvNumbers: ['AP-A'] })
    expect(await sorted('amount', 'asc', 2)).toEqual(['6000000002', '6000000003'])
    expect(await sorted('apvNumbers', 'asc', 2)).toEqual(['6000000003', '6000000001'])
  })

  it('breaks a tie on the cheque number, ascending, in both directions', async () => {
    await makeCheck({ checkNumber: '6000000009', amount: '100.00' })
    await makeCheck({ checkNumber: '6000000008', amount: '100.00' })
    expect(await sorted('amount', 'asc')).toEqual(['6000000008', '6000000009'])
    expect(await sorted('amount', 'desc')).toEqual(['6000000008', '6000000009'])
    expect(await sorted('bank', 'desc')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/queries.test.ts -t "listChecks sort"` → the sort argument is ignored (only the CHECK DATE desc case passes).

- [ ] **Step 3: Implement** in `lib/queries.ts`.

Add to the imports: `import { DEFAULT_SORT, isAppSorted, dbOrderBy, compareSortValues, type SortSpec, type SortDir, type AppSortKey, type SortValue } from './list-sort'`.

Above `toTableRow`, add the two display helpers and use them in `toTableRow` (`apvNumbers: displayApvNumbers(r)`, `poNumbers: displayPoNumbers(r)` — replacing part B's inline expressions, whose comments move onto the helpers):

```ts
/**
 * What the APV NUMBER cell shows: the cheque's own vouchers and its bills',
 * deduplicated and ordered. One definition, because the sort orders by the
 * first value SHOWN — a second copy would sort by something nobody can see.
 */
export function displayApvNumbers(r: { apvNumbers: string[]; bills: { apvNumber: string }[] }): string[] {
  return [...new Set([...r.apvNumbers, ...r.bills.map((b) => b.apvNumber)])].sort()
}

/** What the PO NUMBER cell shows — the bills' Vendor Ref, deduplicated and ordered. */
export function displayPoNumbers(r: { bills: { poNumber: string | null }[] }): string[] {
  return [...new Set(r.bills.map((b) => b.poNumber).filter((p): p is string => p !== null))].sort()
}
```

**If `Check.poNumbers` exists** (see "PO source" above): widen the parameter to `{ poNumbers: string[]; bills: { poNumber: string | null }[] }` and return `[...new Set([...r.poNumbers, ...r.bills.map((b) => b.poNumber).filter((p): p is string => p !== null)])].sort()`.

Replace `listChecks` (keep its comments on `include` and on `nulls: 'last'`, moved onto the constant and `dbOrderBy` respectively):

```ts
const CHECK_ROW_INCLUDE = {
  company: true,
  cashAccount: { include: { bank: true } },
  bills: { orderBy: { apvNumber: 'asc' } },
} satisfies Prisma.CheckInclude

/** What the in-app order reads: enough to compute the four keys Prisma cannot order. */
type SortProbe = {
  apvNumbers: string[]
  releasedAt: Date | null
  statedReleaseDate: Date | null
  cashAccount: { code: string } | null
  bills: { apvNumber: string; poNumber: string | null }[]
}

export function appSortValue(key: AppSortKey, r: SortProbe): SortValue {
  switch (key) {
    case 'apvNumbers': return displayApvNumbers(r)[0] ?? null
    case 'poNumbers': return displayPoNumbers(r)[0] ?? null
    case 'bank': return r.cashAccount?.code ?? null
    case 'releasedAt': return (r.releasedAt ?? r.statedReleaseDate)?.getTime() ?? null
    default: {
      const unreachable: never = key
      throw new Error(`No in-app order for ${String(unreachable)}`)
    }
  }
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The ids of the first `limit` matching cheques in an order Prisma cannot
 * express (see APP_SORTED_KEYS). Every matching cheque is read — five small
 * columns and its bills' two references — because the page must be the first
 * `limit` of the WHOLE set. Production holds ~12,000 cheques; ALL CHEQUES
 * reads them all, which is a narrow select, once per request.
 */
async function appSortedIds(
  db: Db, where: Prisma.CheckWhereInput, key: AppSortKey, dir: SortDir, limit: number,
): Promise<string[]> {
  const probes = await db.check.findMany({
    where,
    select: {
      id: true, checkNumber: true, apvNumbers: true, releasedAt: true, statedReleaseDate: true,
      cashAccount: { select: { code: true } },
      bills: { select: { apvNumber: true, poNumber: true } },
    },
  })
  return probes
    .map((p) => ({ id: p.id, checkNumber: p.checkNumber, value: appSortValue(key, p) }))
    .sort((a, b) =>
      compareSortValues(a.value, b.value, dir) || byCodeUnit(a.checkNumber, b.checkNumber) || byCodeUnit(a.id, b.id))
    .slice(0, limit)
    .map((p) => p.id)
}

export async function listChecks(db: Db, filters: CheckFilters, limit = 200, sort: SortSpec = DEFAULT_SORT) {
  const where = buildWhere(filters)
  const { key, dir } = sort
  if (!isAppSorted(key)) {
    return db.check.findMany({ where, include: CHECK_ROW_INCLUDE, orderBy: dbOrderBy(key, dir), take: limit })
  }
  const ids = await appSortedIds(db, where, key, dir, limit)
  const rows = await db.check.findMany({ where: { id: { in: ids } }, include: CHECK_ROW_INCLUDE })
  const position = new Map(ids.map((id, i) => [id, i]))
  return rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
}
```

**If `Check.poNumbers` exists:** add `poNumbers: string[]` to `SortProbe` and `poNumbers: true` to the probe `select`.

`Prisma` is used as a type here (`satisfies Prisma.CheckInclude`); the existing `import type { Prisma, … }` covers it until Task 3 changes it to a value import.

- [ ] **Step 4: Run** `node node_modules/vitest/vitest.mjs run tests/queries.test.ts` → PASS (the whole file: the three existing `listChecks ordering` cases pin the default); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/queries.ts tests/queries.test.ts
git commit -m "feat(list): server-side sort on every column, nulls last both ways" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Column filters in `buildWhere`, refusal, and the SIGN ALL set

**Files:**
- Modify: `lib/queries.ts` (imports :1; `CheckFilters` :12-87; `pendingSignatureWhere`/`getPendingSignature`/`listPendingSignatureIds` :351-379; `buildWhere` :383-436; `listChecks`; `countChecks` :471-473)
- Test: `tests/queries.test.ts` (new `describe('column filters')`, `describe('SIGN ALL set with column filters')`)

**Interfaces:**
- Produces: `type ColumnFilters = { checkNumberContains?: string; apvContains?: string; poContains?: string; payeeContains?: string; from?: Date; to?: Date; availableFrom?: Date; availableTo?: Date; pickupFrom?: Date; pickupTo?: Date; amountMin?: string; amountMax?: string }`; `CheckFilters = ColumnFilters & { …existing…; refused?: true }`; `columnFilterFields(c: ColumnFilters): ColumnFilters`; `likePattern(text: string): string`; `getPendingSignature(db, narrow = {}, columns: ColumnFilters = {})`; `listPendingSignatureIds(db, narrow = {}, columns: ColumnFilters = {})`.

Decision: APV and PO "contains" is a raw-SQL id step, not the global search's exact `has`. The spec asks for case-insensitive substring; Postgres has no operator for that over a `text[]` that Prisma exposes, so `whereFor` runs `SELECT id FROM "Check" c WHERE EXISTS (SELECT 1 FROM unnest(c."apvNumbers") …ILIKE…) OR EXISTS (… "CheckBill" …)` and ANDs `id IN (…)` onto the Prisma `where`. The whole table is ~22,000 rows, inside Postgres's bind-parameter ceiling; the step runs only when an APV or PO box is filled. `%`, `_` and `\` are escaped so a typed character is text, never a wildcard.

Decision: a refused filter is enforced IN `buildWhere` (`refused: true` → `{ id: { in: [] } }`), not only by callers checking a flag. Every consumer — table, count, export, print, SIGN ALL — then fails closed even if one forgets to look.

Decision: the CHECK DATE range reuses the existing `CheckFilters.from` / `to` (already a `checkDate` range in `buildWhere`, used by nothing else) rather than adding a second way to filter one column.

- [ ] **Step 1: Failing tests** — append to `tests/queries.test.ts` (add `columnFilterFields, likePattern` to the `@/lib/queries` import and `import { manilaDayStart, manilaDayEnd } from '@/lib/audit-view'`):

```ts
describe('column filters', () => {
  const nums = (rows: { checkNumber: string }[]) => rows.map((r) => r.checkNumber).sort()

  it('matches part of a cheque number, any case', async () => {
    await makeCheck({ checkNumber: 'BPI6000329924' })
    await makeCheck({ checkNumber: '1791379619' })
    expect(nums(await listChecks(testDb, { checkNumberContains: 'bpi6000' }))).toEqual(['BPI6000329924'])
  })

  it('matches part of a supplier name, any case', async () => {
    await makeCheck({ checkNumber: '6000000001', payeeName: 'HENKEL PHILIPPINES INC.' })
    await makeCheck({ checkNumber: '6000000002', payeeName: 'SHELL PILIPINAS CORP.' })
    expect(nums(await listChecks(testDb, { payeeContains: 'philip' }))).toEqual(['6000000001'])
  })

  it('matches part of an APV held on the cheque or on one of its bills, any case', async () => {
    await makeCheck({ checkNumber: '6000000011', apvNumbers: ['AP-ST042652'] })
    const onBill = await makeCheck({ checkNumber: '6000000012' })
    await testDb.checkBill.create({ data: { checkId: onBill.id, apvNumber: 'AP-ST099042', amount: '1.00' } })
    await makeCheck({ checkNumber: '6000000013', apvNumbers: ['AP-ST000001'] })
    expect(nums(await listChecks(testDb, { apvContains: '042' }))).toEqual(['6000000011', '6000000012'])
    expect(await countChecks(testDb, { apvContains: 'st0426' })).toBe(1)
  })

  it('reads % and _ as text, never as wildcards', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    expect(await countChecks(testDb, { apvContains: '%' })).toBe(0)
    expect(await countChecks(testDb, { apvContains: 'AP_ST' })).toBe(0)
    expect(likePattern('5%_\\x')).toBe('%5\\%\\_\\\\x%')
  })

  it('matches part of a PO on a bill', async () => {
    const a = await makeCheck({ checkNumber: '6000000021' })
    await makeCheck({ checkNumber: '6000000022' })
    await testDb.checkBill.create({ data: { checkId: a.id, apvNumber: 'AP-1', poNumber: 'PO-STK-0451', amount: '1.00' } })
    expect(nums(await listChecks(testDb, { poContains: 'stk-04' }))).toEqual(['6000000021'])
  })

  it('bounds the amount inclusively, as decimal strings, and leaves out a cheque with no amount', async () => {
    await makeCheck({ checkNumber: '6000000031', amount: '100.00' })
    await makeCheck({ checkNumber: '6000000032', amount: '500.00' })
    await makeCheck({ checkNumber: '6000000033', amount: '900.00' })
    await makeCheck({ checkNumber: '6000000034', amount: null })
    expect(nums(await listChecks(testDb, { amountMin: '500.00', amountMax: '900' }))).toEqual(['6000000032', '6000000033'])
    expect(nums(await listChecks(testDb, { amountMax: '100' }))).toEqual(['6000000031'])
    expect(nums(await listChecks(testDb, { amountMin: '500.01' }))).toEqual(['6000000033'])
  })

  it('bounds the check, available and pickup dates by Manila day, inclusively', async () => {
    const a = await makeCheck({ checkNumber: '6000000041', checkDate: new Date('2026-09-01'), availablePickupDate: new Date('2026-09-05T01:00:00Z') })
    await makeCheck({ checkNumber: '6000000042', checkDate: new Date('2026-09-02'), availablePickupDate: new Date('2026-09-06T01:00:00Z') })
    await testDb.check.update({ where: { id: a.id }, data: { scheduledPickupDate: new Date('2026-09-07T03:00:00Z') } })
    const day = (d: string) => ({ start: manilaDayStart(d), end: manilaDayEnd(d) })
    expect(nums(await listChecks(testDb, { from: day('2026-09-01').start, to: day('2026-09-01').end }))).toEqual(['6000000041'])
    expect(nums(await listChecks(testDb, { availableFrom: day('2026-09-06').start }))).toEqual(['6000000042'])
    expect(nums(await listChecks(testDb, { pickupTo: day('2026-09-07').end }))).toEqual(['6000000041'])
  })

  it('narrows within the view and the search rather than widening past them', async () => {
    await makeCheck({ checkNumber: '6000000051', status: 'SIGNED', payeeName: 'HENKEL PHILIPPINES INC.', amount: '100.00' })
    await makeCheck({ checkNumber: '6000000052', status: 'RELEASED', payeeName: 'HENKEL PHILIPPINES INC.', amount: '100.00' })
    await makeCheck({ checkNumber: '6000000053', status: 'SIGNED', payeeName: 'HENKEL PHILIPPINES INC.', amount: '900.00' })
    expect(nums(await listChecks(testDb, { status: 'SIGNED', q: 'henkel', amountMax: '100' }))).toEqual(['6000000051'])
  })

  // A filter that cannot be read must not silently become no filter.
  it('lists nothing and counts nothing when a filter was refused', async () => {
    await makeCheck({})
    await makeCheck({ apvNumbers: ['AP-1'] })
    expect(await listChecks(testDb, { refused: true })).toEqual([])
    expect(await countChecks(testDb, { refused: true })).toBe(0)
    expect(await countChecks(testDb, { refused: true, apvContains: 'AP' })).toBe(0)
  })

  it('copies exactly the column filters and nothing else', () => {
    const copied = columnFilterFields({ payeeContains: 'x', status: 'SIGNED', incomplete: true, refused: true } as never)
    expect(copied).toEqual({ payeeContains: 'x' })
  })
})

describe('SIGN ALL set with column filters', () => {
  it('counts and lists only the pending cheques the column filters admit', async () => {
    const acme = await makeCheck({ status: 'SIGNATURE_PENDING', payeeName: 'ACME TRADING', amount: '100.00' })
    await makeCheck({ status: 'SIGNATURE_PENDING', payeeName: 'HENKEL PHILIPPINES INC.', amount: '200.00' })
    expect(await listPendingSignatureIds(testDb, {}, { payeeContains: 'acme' })).toEqual([acme.id])
    const pending = await getPendingSignature(testDb, {}, { payeeContains: 'acme' })
    expect(pending.count).toBe(1)
    expect(pending.totalsByCurrency).toEqual([{ currency: 'PHP', total: '100', count: 1 }])
  })

  // The anti-spread rule `todaysReleaseFilter` states: a whole CheckFilters
  // passed as `columns` must not override the status or the exclusion.
  it('cannot be widened by a status or incomplete smuggled in as a column filter', async () => {
    const p = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: null })
    const ids = await listPendingSignatureIds(testDb, {}, { status: 'SIGNED', incomplete: true } as never)
    expect(ids).toEqual([p.id])
  })
})
```

(`total: '100'` is what `Decimal.toString()` gives for `100.00`; if the existing `getPendingSignature` tests in the file assert a different spelling, match theirs.)

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/queries.test.ts -t "column filters|SIGN ALL set with column filters"` → type errors / unfiltered results.

- [ ] **Step 3: Implement** in `lib/queries.ts`.

Imports, line 1: `import { Prisma, type PrismaClient, type CheckStatus, type Eligibility } from '@prisma/client'` (a value import is needed for `Prisma.sql`; no client component imports a value from this module — `CheckTable` imports a type only).

Replace the `from?: Date` / `to?: Date` lines in `CheckFilters` and turn the type into an intersection:

```ts
/**
 * The LIST screen's per-column filters (spec 2026-10-01, part C2). Parsed from
 * the `f.*` URL parameters by `lib/column-filters.ts`; every bound is
 * inclusive. `from`/`to` are the CHECK DATE range — they were already a
 * `checkDate` range here, used by nothing, and one column gets one filter.
 * Amounts are DECIMAL STRINGS (rule 8); Prisma takes them as such.
 */
export type ColumnFilters = {
  checkNumberContains?: string
  apvContains?: string
  poContains?: string
  payeeContains?: string
  from?: Date
  to?: Date
  availableFrom?: Date
  availableTo?: Date
  pickupFrom?: Date
  pickupTo?: Date
  amountMin?: string
  amountMax?: string
}

export type CheckFilters = ColumnFilters & {
  // …every existing field except `from` and `to`, unchanged…
  /**
   * A filter value on the URL could not be read (an amount `12x`, a day that
   * is not a day). The query then matches NOTHING — never "no filter", which
   * would read as an applied one. Enforced here, in `buildWhere`, so every
   * consumer fails closed whether or not it checked.
   */
  refused?: true
}
```

Add after `CheckFilters`:

```ts
/**
 * The column filters and nothing else, named one by one — the reason
 * `todaysReleaseFilter` gives: SIGN ALL acts on this set, and a caller holding
 * a whole `CheckFilters` must not be able to override its status or its
 * exclusion of the cheques with no amount by spreading it in.
 */
export function columnFilterFields(c: ColumnFilters): ColumnFilters {
  const out: ColumnFilters = {
    checkNumberContains: c.checkNumberContains, apvContains: c.apvContains, poContains: c.poContains,
    payeeContains: c.payeeContains, from: c.from, to: c.to,
    availableFrom: c.availableFrom, availableTo: c.availableTo, pickupFrom: c.pickupFrom, pickupTo: c.pickupTo,
    amountMin: c.amountMin, amountMax: c.amountMax,
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as ColumnFilters
}
```

In `buildWhere`, as its first statement:

```ts
  if (filters.refused) return { id: { in: [] } }
```

and after the existing `checkDate` block:

```ts
  if (filters.checkNumberContains) where.checkNumber = { contains: filters.checkNumberContains, mode: 'insensitive' }
  if (filters.payeeContains) where.payeeName = { contains: filters.payeeContains, mode: 'insensitive' }
  if (filters.availableFrom || filters.availableTo) {
    where.availablePickupDate = { gte: filters.availableFrom, lte: filters.availableTo }
  }
  if (filters.pickupFrom || filters.pickupTo) {
    where.scheduledPickupDate = { gte: filters.pickupFrom, lte: filters.pickupTo }
  }
  // Decimal strings, straight through — Prisma takes a string for a Decimal
  // bound, and a JS number would be rule 8 broken one step from the database.
  // A cheque with no amount satisfies no bound and drops out, which is right:
  // nobody knows whether it is above 500.
  if (filters.amountMin || filters.amountMax) {
    where.amount = { gte: filters.amountMin, lte: filters.amountMax }
  }
```

After `buildWhere`, add the raw step and `whereFor`:

```ts
/** `%text%` for ILIKE … ESCAPE '\', with the user's own `\`, `%` and `_` made literal. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * APV and PO "contains" (part C2). Both columns show a union — the cheque's
 * own `apvNumbers` array and its bills — and Postgres offers no substring
 * match on an array element that Prisma can express (the global search's
 * `has` is whole-voucher only, and says so). So this asks Postgres directly
 * for the ids, case-insensitively, and `whereFor` ANDs `id IN (…)` onto the
 * Prisma `where`. Runs only when one of the two boxes is filled.
 */
async function arrayContainsIds(db: Db, f: ColumnFilters): Promise<string[] | null> {
  const conditions: Prisma.Sql[] = []
  if (f.apvContains) {
    const p = likePattern(f.apvContains)
    conditions.push(Prisma.sql`(
      EXISTS (SELECT 1 FROM unnest(c."apvNumbers") AS v(x) WHERE v.x ILIKE ${p} ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM "CheckBill" b WHERE b."checkId" = c."id" AND b."apvNumber" ILIKE ${p} ESCAPE '\\')
    )`)
  }
  if (f.poContains) {
    const p = likePattern(f.poContains)
    conditions.push(Prisma.sql`(
      EXISTS (SELECT 1 FROM "CheckBill" b WHERE b."checkId" = c."id" AND b."poNumber" ILIKE ${p} ESCAPE '\\')
    )`)
  }
  if (conditions.length === 0) return null
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c."id" FROM "Check" c WHERE ${Prisma.join(conditions, ' AND ')}`
  return rows.map((r) => r.id)
}

/** `buildWhere`, plus the APV/PO id step. Every query that can carry column filters goes through this. */
async function whereFor(db: Db, filters: CheckFilters): Promise<Prisma.CheckWhereInput> {
  const where = buildWhere(filters)
  if (filters.refused) return where
  const ids = await arrayContainsIds(db, filters)
  return ids === null ? where : { AND: [where, { id: { in: ids } }] }
}
```

**If `Check.poNumbers` exists:** the PO condition becomes `(EXISTS (SELECT 1 FROM unnest(c."poNumbers") AS v(x) WHERE v.x ILIKE ${p} ESCAPE '\\') OR EXISTS (SELECT 1 FROM "CheckBill" b WHERE b."checkId" = c."id" AND b."poNumber" ILIKE ${p} ESCAPE '\\'))`.

In `listChecks`, `const where = buildWhere(filters)` becomes `const where = await whereFor(db, filters)`. `countChecks` becomes `return db.check.count({ where: await whereFor(db, filters) })`.

Replace the SIGN ALL trio:

```ts
async function pendingSignatureWhere(
  db: Db, narrow: SummaryNarrowing, columns: ColumnFilters,
): Promise<Prisma.CheckWhereInput> {
  const where = await whereFor(db, {
    ...columnFilterFields(columns),
    status: 'SIGNATURE_PENDING', incomplete: false,
    companyId: narrow.companyId, cashAccountId: narrow.cashAccountId, eligibility: narrow.eligibility,
  })
  return { AND: [where, { isCheque: true }] }
}

export async function getPendingSignature(
  db: Db, narrow: SummaryNarrowing = {}, columns: ColumnFilters = {},
): Promise<TodaysRelease> {
  const grouped = await db.check.groupBy({
    by: ['currency'], _sum: { amount: true }, _count: { _all: true },
    where: await pendingSignatureWhere(db, narrow, columns),
  })
  return {
    count: grouped.reduce((n, g) => n + g._count._all, 0),
    totalsByCurrency: grouped.map((g) => ({ currency: g.currency, total: g._sum.amount?.toString() ?? null, count: g._count._all })),
  }
}

/** Read here, never from the form -- the same reason as `listTodaysReleaseIds`. Oldest cheque first. */
export async function listPendingSignatureIds(
  db: Db, narrow: SummaryNarrowing = {}, columns: ColumnFilters = {},
): Promise<string[]> {
  const rows = await db.check.findMany({
    where: await pendingSignatureWhere(db, narrow, columns),
    orderBy: [{ checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: { id: true },
  })
  return rows.map((r) => r.id)
}
```

Keep the existing doc comment on `pendingSignatureWhere`, adding one sentence: "Since part C the column filters on screen narrow it too (spec C2); `columnFilterFields` copies them by name."

- [ ] **Step 4: Run** `node node_modules/vitest/vitest.mjs run tests/queries.test.ts` → PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/queries.ts tests/queries.test.ts
git commit -m "feat(list): per-column filters in buildWhere; a refused filter matches nothing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The links carry the sort

**Files:**
- Modify: `lib/dashboard-view.ts` (`DashboardSelection` :92-111, `LinkState` :114, `query` :121-135, `cardHref`, `incompleteHref`, `exportHref`, `dashboardHref`, `printHref`, `dashboardScreen` :393-397, `signAllConfirmHref`/`signAllCancelHref`)
- Test: `tests/dashboard-view.test.ts`, `tests/dashboard-links.test.ts`

**Interfaces:**
- Consumes: `SortSpec` (Task 1).
- Produces: `DashboardSelection.sort?: SortSpec` (only the URL's explicit sort; absent otherwise); `sortHref(sel: DashboardSelection, next: SortSpec | null): string`.

Decision: an explicit URL sort is part of the view state — card links, the incomplete toggle, EXPORT, PRINT, the way back and SIGN ALL's confirm/cancel carry it; RESET (`clearFiltersHref`) and BACK TO TOTALS drop it. A sort the cookie supplied never enters a URL: the export and print read the same cookie (Task 10), so the URL stays what the reader chose.

Decision: `sort` on the URL opens the LIST. `dashboardScreen` fails closed on anything it does not read, and the TOTALS screen does not sort.

- [ ] **Step 1: Failing tests.** Append to `tests/dashboard-view.test.ts` (add `sortHref` to the import):

```ts
describe('the sort in the URL', () => {
  const SORTED: DashboardSelection = { ...NARROWED, status: 'SIGNED', sort: { key: 'amount', dir: 'asc' } }

  it('rides along on a card, after the view', () => {
    expect(cardHref('RELEASED', SORTED))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=RELEASED&sort=amount&dir=asc')
  })

  it('rides along on the incomplete toggle, the export, the print and the way back', () => {
    expect(incompleteHref(SORTED))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&incomplete=1&sort=amount&dir=asc')
    expect(exportHref(SORTED)).toBe(`${EXPORT_PATH}?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&sort=amount&dir=asc`)
    expect(dashboardHref(SORTED)).toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&sort=amount&dir=asc')
  })

  it('is dropped by RESET and by BACK TO TOTALS', () => {
    expect(clearFiltersHref(SORTED)).toBe('/?status=SIGNED')
    expect(totalsHref(SORTED)).toBe('/?company=c1&cashAccount=a1&eligibility=ELIGIBLE')
  })

  it('writes the next sort, or none for the default — and stays on the list', () => {
    expect(sortHref(SORTED, { key: 'payeeName', dir: 'desc' }))
      .toBe('/?q=ACME&company=c1&cashAccount=a1&eligibility=ELIGIBLE&status=SIGNED&sort=payeeName&dir=desc')
    expect(sortHref({ ...NOTHING, live: true }, null)).toBe('/?scope=live')
    expect(sortHref(NOTHING, { key: 'amount', dir: 'asc' })).toBe('/?scope=live&sort=amount&dir=asc')
  })

  it('opens the LIST on its own, and so does any f.* filter', () => {
    expect(dashboardScreen({ ...NOTHING, sort: { key: 'amount', dir: 'asc' } })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { company: 'c1', 'f.payee': 'henkel' } })).toBe('LIST')
  })
})
```

Append to `tests/dashboard-links.test.ts`:

```ts
describe('printHref carries the sort', () => {
  it('as the screen had it', () => {
    expect(printHref({ ...NOTHING, showAll: true, sort: { key: 'status', dir: 'desc' } }))
      .toBe(`${PRINT_PATH}?scope=all&sort=status&dir=desc`)
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts tests/dashboard-links.test.ts` → `sortHref` missing; sort absent from hrefs.

- [ ] **Step 3: Implement** in `lib/dashboard-view.ts`:
  - `import type { SortSpec } from './list-sort'`.
  - `DashboardSelection` gains, after `live`:

    ```ts
      /**
       * The order the URL asked for (`sort` + `dir`), and ONLY that — absent when
       * the URL names none, even if the `cm_sort` cookie supplied one. A cookie
       * sort never enters a link; the export and print read the cookie
       * themselves. Optional so the many literal selections in tests stay valid.
       */
      sort?: SortSpec
    ```
  - `LinkState` gains `sort?: SortSpec | null`.
  - In `query`, after the `incomplete` line: `if (view.sort) { qs.set('sort', view.sort.key); qs.set('dir', view.sort.dir) }`.
  - Add `sort: sel.sort` to the `LinkState` in: all three `href` calls in `cardHref`; `incompleteHref`; `exportHref`; `dashboardHref`; `printHref`; `signAllConfirmHref`; `signAllCancelHref`. Leave `clearFiltersHref`, `totalsHref`, `releaseConfirmHref`, `releaseCancelHref` without it (comment on `clearFiltersHref`: "RESET also drops the sort; the button deletes the remembered one too — components/ResetLink.tsx.").
  - `dashboardScreen`: `const listed = sel.status !== null || sel.showAll || sel.incomplete || sel.live || sel.sort !== undefined || …` and add to its doc: "a `sort` on the URL is a LIST parameter too: the TOTALS screen does not sort."
  - Add:

    ```ts
    /**
     * A header click: the same list, with `next` as its order — or with no
     * order at all (`null`, the third click), which falls back to the cookie
     * and then the default; the header's click handler deletes the cookie in
     * that case (components/sort-cookie.ts). `scope=live` on NEEDS ACTION for
     * the reason `incompleteHref` gives: a bare `/` is the TOTALS.
     */
    export function sortHref(sel: DashboardSelection, next: SortSpec | null): string {
      return href(sel.base, {
        status: sel.status, showAll: sel.showAll, incomplete: sel.incomplete,
        live: sel.live || (!sel.status && !sel.showAll), sort: next,
      })
    }
    ```

- [ ] **Step 4: Run** both files → PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard-view.ts tests/dashboard-view.test.ts tests/dashboard-links.test.ts
git commit -m "feat(list): the URL sort rides on every list link; RESET and totals drop it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Reading the URL — filters, refusal, sort from URL or cookie

**Files:**
- Create: `lib/column-filters.ts`
- Modify: `lib/dashboard-params.ts` (whole `resolveDashboardQuery`, types)
- Modify: `lib/export/report.ts` (`FilterDescription`, `describeFilters` :130-160)
- Test: `tests/column-filters.test.ts` (new), `tests/export/dashboard-params.test.ts`, `tests/export/report.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4.
- Produces (`lib/column-filters.ts`): `LIST_FILTER_FORM = 'list-filters'`; `F_PARAMS` (the 13 names in Global Constraints, in that order); `type FParam`; `COLUMN_FILTER_PARAMS: Record<SortKey, readonly string[]>`; `FILTER_MESSAGES`; `parseAmountBound(raw: string): string | null`; `parseColumnFilters(read: (name: FParam) => string | undefined, opts: { statusApplies: boolean }): ParsedColumnFilters` where `ParsedColumnFilters = { filters: ColumnFilters; status: CheckStatus | undefined; values: Record<string, string>; errors: Record<string, string> }`; `describeColumnFilters(values): string[]`; `columnParamsOf(base): Record<string, string>`; `describeRefusal(errors): string`.
- Produces (`lib/dashboard-params.ts`): `DashboardSearchParams` gains `sort?`, `dir?` and `Partial<Record<FParam, string>>`; `resolveDashboardQuery(params, options, context: { sortCookie?: string } = {})`; `DashboardQuery` gains `sort: SortSpec`, `activeSort: SortSpec | null`, `columnValues: Readonly<Record<string, string>>`, `filterErrors: Readonly<Record<string, string>>`, `refused: boolean`; `releasedFrom`/`releasedTo` become the raw trimmed values as typed (`''` when absent or off-view).
- Produces (`lib/export/report.ts`): `FilterDescription` gains `columns?: readonly string[]` and `sort?: string | null`.

Decision: an unparseable value stays in `selection.base` verbatim (unlike an unrecognised company id, which is still dropped). The export and print links are built from `base`; dropping a bad value there would make EXPORT hand over the unfiltered set while the screen lists nothing.

Decision: DATE RELEASED now refuses an unparseable day too. The spec's "same rules" for that row is read as the views it applies on and the either-date match; its C2 rule — a silently ignored filter reads as an applied one — is general. Off its two views it is still dropped, not refused (the box is not rendered there).

Decision: `f.status` applies only on ALL CHEQUES (`scope=all`, no `status`). On any other view the card fixes the status and the box is not rendered, so the parameter is dropped like DATE RELEASED off-view — not refused.

Decision: amounts accept thousands separators (`1,250.50`); commas and spaces are stripped before the pattern. Finance types amounts that way, and the stored string is the stripped one.

Decision: the export/print title states the sort only when it is not the default (`SORTED BY AMOUNT (ASCENDING)`), last on line 3; existing descriptions are unchanged.

- [ ] **Step 1: Failing tests.**

Create `tests/column-filters.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  F_PARAMS, FILTER_MESSAGES, COLUMN_FILTER_PARAMS, parseAmountBound, parseColumnFilters,
  describeColumnFilters, columnParamsOf, describeRefusal,
} from '@/lib/column-filters'
import { SORT_KEYS } from '@/lib/list-sort'

const read = (o: Record<string, string>) => (name: string) => o[name]

describe('parseAmountBound', () => {
  it('keeps a decimal string, commas and spaces stripped', () => {
    expect(parseAmountBound('1250.50')).toBe('1250.50')
    expect(parseAmountBound('1,250.5')).toBe('1250.5')
    expect(parseAmountBound(' 12 000 ')).toBe('12000')
  })
  it('refuses anything else', () => {
    for (const bad of ['12x', '-5', '1.234', '1e5', '₱100', '.5', '']) expect(parseAmountBound(bad), bad).toBeNull()
  })
})

describe('parseColumnFilters', () => {
  it('reads each box into its filter, trimmed', () => {
    const r = parseColumnFilters(read({
      'f.checkNumber': ' 600 ', 'f.apv': 'st04', 'f.po': 'PO-1', 'f.payee': 'henkel',
      'f.checkDateFrom': '2026-09-01', 'f.checkDateTo': '2026-09-30',
      'f.availablePickupDateFrom': '2026-09-02', 'f.scheduledPickupDateTo': '2026-09-03',
      'f.amountMin': '1,000', 'f.amountMax': '5000.50',
    }), { statusApplies: false })
    expect(r.errors).toEqual({})
    expect(r.filters).toEqual({
      checkNumberContains: '600', apvContains: 'st04', poContains: 'PO-1', payeeContains: 'henkel',
      from: new Date('2026-08-31T16:00:00.000Z'), to: new Date('2026-09-30T15:59:59.999Z'),
      availableFrom: new Date('2026-09-01T16:00:00.000Z'), pickupTo: new Date('2026-09-03T15:59:59.999Z'),
      amountMin: '1000', amountMax: '5000.50',
    })
    expect(r.values['f.checkNumber']).toBe('600')
    expect(r.values['f.amountMin']).toBe('1,000')
  })

  it('treats an empty box as no filter', () => {
    const r = parseColumnFilters(read({ 'f.payee': '   ', 'f.amountMin': '' }), { statusApplies: false })
    expect(r).toEqual({ filters: {}, status: undefined, values: {}, errors: {} })
  })

  it('refuses a value it cannot read, keeping it to render back', () => {
    const r = parseColumnFilters(read({ 'f.amountMax': '12x', 'f.checkDateFrom': '2026-02-30' }), { statusApplies: false })
    expect(r.errors).toEqual({ 'f.amountMax': FILTER_MESSAGES.amount, 'f.checkDateFrom': FILTER_MESSAGES.day })
    expect(r.values).toEqual({ 'f.amountMax': '12x', 'f.checkDateFrom': '2026-02-30' })
    expect(r.filters).toEqual({})
  })

  it('reads STATUS only where it applies, and refuses an unknown one there', () => {
    expect(parseColumnFilters(read({ 'f.status': 'SIGNED' }), { statusApplies: true }).status).toBe('SIGNED')
    const off = parseColumnFilters(read({ 'f.status': 'SIGNED' }), { statusApplies: false })
    expect(off).toEqual({ filters: {}, status: undefined, values: {}, errors: {} })
    expect(parseColumnFilters(read({ 'f.status': 'PAID' }), { statusApplies: true }).errors)
      .toEqual({ 'f.status': FILTER_MESSAGES.status })
  })
})

describe('the parameter map', () => {
  it('gives every sortable column its filter parameters, and names every f.* once', () => {
    expect(Object.keys(COLUMN_FILTER_PARAMS).sort()).toEqual([...SORT_KEYS].sort())
    const named = Object.values(COLUMN_FILTER_PARAMS).flat().filter((p) => p.startsWith('f.'))
    expect([...named].sort()).toEqual([...F_PARAMS].sort())
  })
})

describe('describeColumnFilters', () => {
  it('says each filter in words, in column order', () => {
    expect(describeColumnFilters({
      'f.payee': 'henkel', 'f.checkNumber': '600', 'f.status': 'READY_FOR_RELEASE',
      'f.amountMin': '1000', 'f.checkDateTo': '2026-09-30',
    })).toEqual([
      'CHECK NO. CONTAINS "600"', 'SUPPLIER CONTAINS "henkel"', 'CHECK DATE: TO 2026-09-30',
      'AMOUNT: FROM 1000', 'STATUS: READY FOR RELEASE',
    ])
  })
})

describe('columnParamsOf and describeRefusal', () => {
  it('picks the f.* parameters out of a base', () => {
    expect(columnParamsOf({ q: 'x', company: 'c1', 'f.payee': 'h', 'f.amountMin': '12x' }))
      .toEqual({ 'f.payee': 'h', 'f.amountMin': '12x' })
  })
  it('states every refused box', () => {
    expect(describeRefusal({ 'f.amountMin': FILTER_MESSAGES.amount }))
      .toBe(`A FILTER COULD NOT BE READ, SO NOTHING WAS LISTED.\nAMOUNT (MIN): ${FILTER_MESSAGES.amount}`)
  })
})
```

In `tests/export/dashboard-params.test.ts`: add `import { FILTER_MESSAGES } from '@/lib/column-filters'`, `import { DEFAULT_SORT } from '@/lib/list-sort'`, `import { dashboardScreen } from '@/lib/dashboard-view'`. Replace the test `'ignores a value that is not a real calendar day'` with:

```ts
    // Since part C (2026-10-01) a day that is not a day REFUSES rather than
    // silently opening the view unfiltered — an ignored filter reads as applied.
    it('refuses a value that is not a real calendar day, and keeps it to render back', () => {
      for (const bad of ['2026-02-30', '25/09/2026', '2026-9-1', 'today']) {
        const r = resolveDashboardQuery({ status: 'RELEASED', releasedFrom: bad }, options)
        expect(r.refused, bad).toBe(true)
        expect(r.filters.refused).toBe(true)
        expect(r.filterErrors).toEqual({ releasedFrom: FILTER_MESSAGES.day })
        expect(r.selection.base).toEqual({ releasedFrom: bad })
      }
      expect(resolveDashboardQuery({ status: 'RELEASED', releasedFrom: '' }, options).refused).toBe(false)
    })
```

and append inside the top-level `describe('resolveDashboardQuery')`:

```ts
  describe('the column filters', () => {
    it('reach the filters, ride in base and open the list', () => {
      const r = resolveDashboardQuery({ status: 'SIGNED', 'f.payee': ' henkel ', 'f.amountMin': '1,000' }, options)
      expect(r.filters.payeeContains).toBe('henkel')
      expect(r.filters.amountMin).toBe('1000')
      expect(r.selection.base).toEqual({ 'f.payee': 'henkel', 'f.amountMin': '1,000' })
      expect(r.columnValues).toEqual({ 'f.payee': 'henkel', 'f.amountMin': '1,000' })
      expect(r.refused).toBe(false)
      expect(dashboardScreen(resolveDashboardQuery({ 'f.payee': 'henkel' }, options).selection)).toBe('LIST')
    })

    it('refuses an unreadable value: nothing listed, the value kept everywhere', () => {
      const r = resolveDashboardQuery({ scope: 'all', 'f.amountMax': '12x' }, options)
      expect(r.refused).toBe(true)
      expect(r.filters.refused).toBe(true)
      expect(r.filterErrors).toEqual({ 'f.amountMax': FILTER_MESSAGES.amount })
      expect(r.selection.base).toEqual({ 'f.amountMax': '12x' })
    })

    it('applies STATUS on ALL CHEQUES only, without changing the view', () => {
      const all = resolveDashboardQuery({ scope: 'all', 'f.status': 'SIGNED' }, options)
      expect(all.filters.status).toBe('SIGNED')
      expect(all.selection.status).toBeNull()
      expect(all.selection.base).toEqual({ 'f.status': 'SIGNED' })
      const signed = resolveDashboardQuery({ status: 'RELEASED', 'f.status': 'SIGNED' }, options)
      expect(signed.filters.status).toBe('RELEASED')
      expect(signed.selection.base).toEqual({})
      expect(signed.refused).toBe(false)
    })

    it('carries company, bank and the release range in columnValues for the filter row', () => {
      const r = resolveDashboardQuery({ status: 'RELEASED', company: 'co-stk', cashAccount: 'ca-bpi', releasedTo: '2026-09-30' }, options)
      expect(r.columnValues).toEqual({ company: 'co-stk', cashAccount: 'ca-bpi', releasedTo: '2026-09-30' })
    })

    it('describes them for the title block', () => {
      const r = resolveDashboardQuery({ scope: 'all', 'f.payee': 'henkel' }, options)
      expect(r.filterDescription).toBe('SUPPLIER CONTAINS "henkel"  ·  EXCLUDES RECORDS WITH NO AMOUNT')
    })
  })

  describe('the sort', () => {
    it('defaults to check date, newest first, with nothing in force', () => {
      const r = resolveDashboardQuery({ status: 'SIGNED' }, options)
      expect(r.sort).toEqual(DEFAULT_SORT)
      expect(r.activeSort).toBeNull()
      expect(r.selection.sort).toBeUndefined()
    })

    it('reads the URL, and says a non-default sort in the title block', () => {
      const r = resolveDashboardQuery({ status: 'SIGNED', sort: 'amount', dir: 'asc' }, options)
      expect(r.sort).toEqual({ key: 'amount', dir: 'asc' })
      expect(r.selection.sort).toEqual({ key: 'amount', dir: 'asc' })
      expect(r.filterDescription).toBe('EXCLUDES RECORDS WITH NO AMOUNT  ·  SORTED BY AMOUNT (ASCENDING)')
    })

    it('falls back to the cookie when the URL names none — without putting it in the URL', () => {
      const r = resolveDashboardQuery({ status: 'SIGNED' }, options, { sortCookie: 'payeeName:desc' })
      expect(r.sort).toEqual({ key: 'payeeName', dir: 'desc' })
      expect(r.activeSort).toEqual({ key: 'payeeName', dir: 'desc' })
      expect(r.selection.sort).toBeUndefined()
    })

    it('lets the URL win over the cookie, and ignores an invalid either', () => {
      expect(resolveDashboardQuery({ sort: 'amount', dir: 'desc' }, options, { sortCookie: 'payeeName:asc' }).sort)
        .toEqual({ key: 'amount', dir: 'desc' })
      expect(resolveDashboardQuery({ sort: 'action', dir: 'asc' }, options, { sortCookie: 'payeeName:asc' }).sort)
        .toEqual({ key: 'payeeName', dir: 'asc' })
      expect(resolveDashboardQuery({}, options, { sortCookie: 'garbage' }).sort).toEqual(DEFAULT_SORT)
    })
  })
```

In `tests/export/report.test.ts` append (match the file's existing `describeFilters` import):

```ts
describe('describeFilters — column filters and sort', () => {
  it('lists the column filters after the search and the sort last', () => {
    expect(describeFilters({ q: 'x', columns: ['AMOUNT: FROM 1000'], incomplete: false, sort: 'AMOUNT (ASCENDING)' }))
      .toBe('SEARCH: "x"  ·  AMOUNT: FROM 1000  ·  EXCLUDES RECORDS WITH NO AMOUNT  ·  SORTED BY AMOUNT (ASCENDING)')
  })
  it('says nothing new when there are neither', () => {
    expect(describeFilters({})).toBe('No filters applied')
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/column-filters.test.ts tests/export/dashboard-params.test.ts tests/export/report.test.ts`.

- [ ] **Step 3: Implement.**

Create `lib/column-filters.ts`:

```ts
import type { CheckStatus } from '@prisma/client'
import type { ColumnFilters } from './queries'
import type { SortKey } from './list-sort'
import { isIsoDay } from './domain/details'
import { manilaDayStart, manilaDayEnd } from './audit-view'
import { LIVE_STATUSES, CLOSED_STATUSES } from './domain/check-status'

/**
 * The LIST screen's filter row (spec 2026-10-01, part C2), as URL parameters.
 *
 * Pure. Imported by the browser too (the filter row's controls), so it imports
 * only types from `./queries` and `@prisma/client`.
 *
 * AN UNREADABLE VALUE REFUSES. An amount `12x` or a day that is not a day is
 * reported against its box and the list shows nothing until it is corrected —
 * never dropped, because a silently ignored filter reads as an applied one.
 */

/** The form the bar and the filter row's controls belong to (`form=` attribute). */
export const LIST_FILTER_FORM = 'list-filters'

export const F_PARAMS = [
  'f.checkNumber', 'f.apv', 'f.po', 'f.payee', 'f.status',
  'f.checkDateFrom', 'f.checkDateTo',
  'f.availablePickupDateFrom', 'f.availablePickupDateTo',
  'f.scheduledPickupDateFrom', 'f.scheduledPickupDateTo',
  'f.amountMin', 'f.amountMax',
] as const
export type FParam = (typeof F_PARAMS)[number]

/**
 * Which parameters filter which column. COMPANY, BANK and DATE RELEASED keep
 * their pre-existing names (`company`, `cashAccount`, `releasedFrom/To`), so
 * `TOTALS_KEYS`, `totalsHref` and the TOTALS screen's own bar are unaffected.
 */
export const COLUMN_FILTER_PARAMS = {
  checkNumber: ['f.checkNumber'],
  apvNumbers: ['f.apv'],
  poNumbers: ['f.po'],
  payeeName: ['f.payee'],
  companyCode: ['company'],
  bank: ['cashAccount'],
  checkDate: ['f.checkDateFrom', 'f.checkDateTo'],
  amount: ['f.amountMin', 'f.amountMax'],
  status: ['f.status'],
  availablePickupDate: ['f.availablePickupDateFrom', 'f.availablePickupDateTo'],
  scheduledPickupDate: ['f.scheduledPickupDateFrom', 'f.scheduledPickupDateTo'],
  releasedAt: ['releasedFrom', 'releasedTo'],
} as const satisfies Record<SortKey, readonly string[]>

export const FILTER_MESSAGES = {
  day: 'NOT A DAY — TYPE YYYY-MM-DD',
  amount: 'NOT AN AMOUNT — DIGITS, AT MOST TWO DECIMALS (E.G. 1250.50)',
  status: 'NOT A STATUS',
} as const

/** The labels a refusal names its box by. */
const PARAM_LABELS: Record<string, string> = {
  'f.checkNumber': 'CHECK NUMBER', 'f.apv': 'APV NUMBER', 'f.po': 'PO NUMBER', 'f.payee': 'SUPPLIER NAME',
  'f.status': 'STATUS', 'f.checkDateFrom': 'CHECK DATE (FROM)', 'f.checkDateTo': 'CHECK DATE (TO)',
  'f.availablePickupDateFrom': 'AVAILABLE DATE (FROM)', 'f.availablePickupDateTo': 'AVAILABLE DATE (TO)',
  'f.scheduledPickupDateFrom': 'PICKUP SCHEDULE (FROM)', 'f.scheduledPickupDateTo': 'PICKUP SCHEDULE (TO)',
  'f.amountMin': 'AMOUNT (MIN)', 'f.amountMax': 'AMOUNT (MAX)',
  releasedFrom: 'DATE RELEASED (FROM)', releasedTo: 'DATE RELEASED (TO)',
}

const STATUSES: readonly CheckStatus[] = [...LIVE_STATUSES, ...CLOSED_STATUSES]

/** A decimal STRING (rule 8), thousands separators allowed, or null. Never a JS number. */
export function parseAmountBound(raw: string): string | null {
  const v = raw.replace(/[,\s]/g, '')
  return /^\d{1,16}(\.\d{1,2})?$/.test(v) ? v : null
}

export type ParsedColumnFilters = {
  filters: ColumnFilters
  /** STATUS, on ALL CHEQUES only — it narrows `CheckFilters.status`, not a column filter of its own. */
  status: CheckStatus | undefined
  /** Every non-empty box as typed (valid or not), for `base` and to render back. */
  values: Record<string, string>
  /** Parameter name → message, for each box that could not be read. */
  errors: Record<string, string>
}

export function parseColumnFilters(
  read: (name: FParam) => string | undefined,
  opts: { statusApplies: boolean },
): ParsedColumnFilters {
  const filters: ColumnFilters = {}
  const values: Record<string, string> = {}
  const errors: Record<string, string> = {}
  let status: CheckStatus | undefined

  const take = (name: FParam): string => {
    const v = read(name)?.trim() ?? ''
    if (v) values[name] = v
    return v
  }
  const text = (name: FParam): string | undefined => take(name) || undefined
  const day = (name: FParam, edge: 'start' | 'end'): Date | undefined => {
    const v = take(name)
    if (!v) return undefined
    if (!isIsoDay(v)) { errors[name] = FILTER_MESSAGES.day; return undefined }
    return edge === 'start' ? manilaDayStart(v) : manilaDayEnd(v)
  }
  const amount = (name: FParam): string | undefined => {
    const v = take(name)
    if (!v) return undefined
    const parsed = parseAmountBound(v)
    if (parsed === null) errors[name] = FILTER_MESSAGES.amount
    return parsed ?? undefined
  }

  const parsed: ColumnFilters = {
    checkNumberContains: text('f.checkNumber'),
    apvContains: text('f.apv'),
    poContains: text('f.po'),
    payeeContains: text('f.payee'),
    from: day('f.checkDateFrom', 'start'),
    to: day('f.checkDateTo', 'end'),
    availableFrom: day('f.availablePickupDateFrom', 'start'),
    availableTo: day('f.availablePickupDateTo', 'end'),
    pickupFrom: day('f.scheduledPickupDateFrom', 'start'),
    pickupTo: day('f.scheduledPickupDateTo', 'end'),
    amountMin: amount('f.amountMin'),
    amountMax: amount('f.amountMax'),
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (v !== undefined) (filters as Record<string, unknown>)[k] = v
  }

  if (opts.statusApplies) {
    const v = take('f.status')
    if (v) {
      if ((STATUSES as readonly string[]).includes(v)) status = v as CheckStatus
      else errors['f.status'] = FILTER_MESSAGES.status
    }
  }

  return { filters, status, values, errors }
}

/** The column filters in words, column order, for line 3 of the export's title block. */
export function describeColumnFilters(values: Readonly<Record<string, string>>): string[] {
  const parts: string[] = []
  const contains = (p: string, label: string) => { if (values[p]) parts.push(`${label} CONTAINS "${values[p]}"`) }
  const range = (from: string, to: string, label: string) => {
    const a = values[from]
    const b = values[to]
    if (a && b) parts.push(`${label}: ${a} TO ${b}`)
    else if (a) parts.push(`${label}: FROM ${a}`)
    else if (b) parts.push(`${label}: TO ${b}`)
  }
  contains('f.checkNumber', 'CHECK NO.')
  contains('f.apv', 'APV')
  contains('f.po', 'PO')
  contains('f.payee', 'SUPPLIER')
  range('f.checkDateFrom', 'f.checkDateTo', 'CHECK DATE')
  range('f.amountMin', 'f.amountMax', 'AMOUNT')
  if (values['f.status']) parts.push(`STATUS: ${values['f.status'].replace(/_/g, ' ')}`)
  range('f.availablePickupDateFrom', 'f.availablePickupDateTo', 'AVAILABLE DATE')
  range('f.scheduledPickupDateFrom', 'f.scheduledPickupDateTo', 'PICKUP SCHEDULE')
  return parts
}

/** The `f.*` pairs of a `base` — what SIGN ALL's confirm form writes back as hidden fields. */
export function columnParamsOf(base: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(base).filter(([k]) => (F_PARAMS as readonly string[]).includes(k)))
}

/** A refusal, in words: the export's 400 body and the print sheet's notice. */
export function describeRefusal(errors: Readonly<Record<string, string>>): string {
  const lines = Object.entries(errors).map(([name, message]) => `${PARAM_LABELS[name] ?? name}: ${message}`)
  return ['A FILTER COULD NOT BE READ, SO NOTHING WAS LISTED.', ...lines].join('\n')
}
```

(`lib/domain/check-status.ts` imports only `./errors` and Prisma types — confirm with `grep -n "^import" lib/domain/check-status.ts` — so this module is safe in the browser.)

In `lib/export/report.ts`, add to `FilterDescription`:

```ts
  /** The column filters in words (`describeColumnFilters`), after the search. */
  columns?: readonly string[]
  /** A non-default sort in words (`describeSort`), stated last. */
  sort?: string | null
```

and in `describeFilters`, after `if (q) parts.push(…)`: `for (const c of f.columns ?? []) parts.push(c)`; after the incomplete lines, before the `return`: `if (f.sort) parts.push(\`SORTED BY ${f.sort}\`)`.

In `lib/dashboard-params.ts`:
- Imports: add `import { parseColumnFilters, describeColumnFilters, FILTER_MESSAGES, type FParam } from './column-filters'` and `import { parseSort, parseSortCookie, DEFAULT_SORT, sameSort, describeSort, type SortSpec } from './list-sort'`; delete `parseDayParam`.
- Types:

```ts
export type DashboardSearchParams = {
  q?: string
  status?: string
  company?: string
  cashAccount?: string
  eligibility?: string
  incomplete?: string
  scope?: string
  /** DATE RELEASED bounds, `YYYY-MM-DD` Manila days. */
  releasedFrom?: string
  releasedTo?: string
  /** The order (part C1): both or neither. */
  sort?: string
  dir?: string
} & Partial<Record<FParam, string>>
```

  and in `DashboardQuery` change the `releasedFrom`/`releasedTo` doc to "The DATE RELEASED boxes as typed (valid or not), `''` when empty or off-view." and add:

```ts
  /** The order in force: the URL's, else the cookie's, else `DEFAULT_SORT`. */
  sort: SortSpec
  /** The URL's or the cookie's sort, null under the default — what the header cycle starts from. */
  activeSort: SortSpec | null
  /** Every filter-row box's value as typed (company/bank as validated ids), for the filter row to render back. */
  columnValues: Readonly<Record<string, string>>
  /** Parameter name → message for every box that could not be read. */
  filterErrors: Readonly<Record<string, string>>
  /** True when any box could not be read: `filters.refused` is set and the list shows nothing. */
  refused: boolean
```

- Replace the body of `resolveDashboardQuery` from the `releasedRangeApplies` comment through the `return` (keep every existing comment above its line):

```ts
export function resolveDashboardQuery(
  params: DashboardSearchParams,
  options: FilterOptions,
  context: { sortCookie?: string } = {},
): DashboardQuery {
  // …showAll, live, status, eligibility, companyId, cashAccountId, incomplete, q: unchanged…

  const errors: Record<string, string> = {}

  // DATE RELEASED: dropped off its two views (as before); ON them, a value that
  // is not a real day now REFUSES (part C2) instead of opening the view unfiltered.
  const releasedRangeApplies = status === 'RELEASED' || showAll
  const releasedBound = (name: 'releasedFrom' | 'releasedTo') => {
    const raw = releasedRangeApplies ? (params[name]?.trim() ?? '') : ''
    const day = raw && isIsoDay(raw) ? raw : undefined
    if (raw && !day) errors[name] = FILTER_MESSAGES.day
    return { raw, day }
  }
  const releasedFrom = releasedBound('releasedFrom')
  const releasedTo = releasedBound('releasedTo')

  // STATUS has a box only on ALL CHEQUES; a card fixes it everywhere else.
  const column = parseColumnFilters((name) => params[name], { statusApplies: showAll && !status })
  Object.assign(errors, column.errors)
  const refused = Object.keys(errors).length > 0

  const urlSort = parseSort(params.sort, params.dir)
  const activeSort = urlSort ?? parseSortCookie(context.sortCookie)
  const sort = activeSort ?? DEFAULT_SORT

  const nonEmpty = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''))

  const selection: DashboardSelection = {
    status: status ?? null,
    showAll,
    incomplete,
    live,
    ...(urlSort ? { sort: urlSort } : {}),
    // Validated company/bank/eligibility (an unrecognised id is still dropped),
    // and every other box AS TYPED — a refused value must survive into the
    // export and print links, or EXPORT would hand over what the screen refused.
    base: nonEmpty({
      q,
      company: companyId ?? '',
      cashAccount: cashAccountId ?? '',
      eligibility: eligibility ?? '',
      releasedFrom: releasedFrom.raw,
      releasedTo: releasedTo.raw,
      ...column.values,
    }),
  }

  const filters: CheckFilters = {
    ...column.filters,
    q: q || undefined,
    companyId,
    cashAccountId,
    eligibility,
    incomplete,
    releasedFrom: releasedFrom.day ? manilaDayStart(releasedFrom.day) : undefined,
    releasedTo: releasedTo.day ? manilaDayEnd(releasedTo.day) : undefined,
    ...viewStatusFilter(selection),
    ...(column.status ? { status: column.status } : {}),
    ...(refused ? { refused: true as const } : {}),
  }

  const company = options.companies.find((c) => c.id === companyId)
  const account = options.cashAccounts.find((a) => a.id === cashAccountId)

  return {
    q,
    releasedFrom: releasedFrom.raw,
    releasedTo: releasedTo.raw,
    status,
    eligibility,
    companyId,
    cashAccountId,
    incomplete,
    showAll,
    selection,
    filters,
    sort,
    activeSort,
    columnValues: nonEmpty({
      company: companyId ?? '', cashAccount: cashAccountId ?? '',
      releasedFrom: releasedFrom.raw, releasedTo: releasedTo.raw, ...column.values,
    }),
    filterErrors: errors,
    refused,
    viewLabel: exportViewLabel(selection),
    filterDescription: describeFilters({
      company: company?.code ?? null,
      bank: account ? bankLabel(account.code, account.bankCode) : null,
      eligibility: eligibility ?? null,
      q,
      columns: describeColumnFilters(column.values),
      incomplete,
      releasedFrom: releasedFrom.raw || null,
      releasedTo: releasedTo.raw || null,
      sort: activeSort && !sameSort(activeSort, DEFAULT_SORT) ? describeSort(activeSort) : null,
    }),
    narrowingDescription: /* unchanged */ describeFilters({
      company: company?.code ?? null,
      bank: account ? bankLabel(account.code, account.bankCode) : null,
      eligibility: eligibility ?? null,
      q: '',
      incomplete: undefined,
      releasedFrom: null,
      releasedTo: null,
    }),
  }
}
```

  Update the module's header comment with one paragraph: "Since part C (2026-10-01) it also resolves the order (URL, then the `cm_sort` cookie passed in `context`, then the default) and the filter row's `f.*` boxes; an unreadable box sets `refused`, which `buildWhere` reads as match-nothing."

- `app/page.tsx` still compiles: it destructures `releasedFrom`/`releasedTo` (now raw strings, same type). No other change in this task.

- [ ] **Step 4: Run** the three test files → PASS; `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts tests/dashboard-links.test.ts` still PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/column-filters.ts lib/dashboard-params.ts lib/export/report.ts tests/column-filters.test.ts tests/export/dashboard-params.test.ts tests/export/report.test.ts
git commit -m "feat(list): parse the filter row and the sort; an unreadable box refuses" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Column order as a preference

**Files:**
- Modify: `lib/table-columns.ts`
- Test: `tests/table-columns.test.ts`

**Interfaces:**
- Produces: `insertColumn(order, key): ColumnKey[]`; `toggleColumn(order, key): ColumnKey[]`; `moveColumn(order, key, delta: -1 | 1): ColumnKey[]`; `canMoveColumn(order, key, delta): boolean`; `withColumns(order, keys): ColumnKey[]`; `withColumnOrder(href: string, order: readonly ColumnKey[]): string`. `normaliseColumns` now KEEPS the given order. `COLUMN_STORAGE_KEY` stays `'check-monitoring.columns.v2'`.

Decision: no v3. Part B's v2 value is an array that `normaliseColumns` wrote in canonical order; read as "visible columns in display order" it is exactly the default order with the same visibility, so every existing preference renders unchanged. The spec's "a v1 value is read as the visibility of the default order" is superseded: part B deliberately stopped reading v1 so PO would appear.

Decision: ACTION is pinned last and has no arrows; the OR / CR column (not a `ColumnKey`) stays fixed just before it, and the tick-box column first. CHECK NUMBER and STATUS are always on but movable.

Decision: a column shown again comes back right after its nearest canonical predecessor that is on screen, so re-ticking BANK puts it beside COMPANY rather than at the end.

- [ ] **Step 1: Failing tests.** In `tests/table-columns.test.ts`: add `insertColumn, toggleColumn, moveColumn, canMoveColumn, withColumns, withColumnOrder, COLUMN_STORAGE_KEY` to the import. Replace the whole `describe('normaliseColumns')` block with:

```ts
describe('normaliseColumns', () => {
  // Part C3: the stored array is the VISIBLE columns IN DISPLAY ORDER.
  it('keeps the order it is given, ACTION last', () => {
    expect(normaliseColumns(['amount', 'checkNumber', 'status', 'action', 'bank']))
      .toEqual(['amount', 'checkNumber', 'status', 'bank', 'action'])
  })

  it('reads part B’s canonical-order value as the default order', () => {
    expect(normaliseColumns([...COLUMN_KEYS])).toEqual([...COLUMN_KEYS])
  })

  it('adds a missing always-on column beside its canonical neighbour', () => {
    expect(normaliseColumns(['amount'])).toEqual(['checkNumber', 'amount', 'status', 'action'])
    expect(normaliseColumns(['bank', 'amount'])).toEqual(['checkNumber', 'bank', 'amount', 'status', 'action'])
  })

  it('drops a key it does not recognise and de-duplicates', () => {
    expect(normaliseColumns(['amount', 'payeeSecretNotes', 'amount', 'bank']))
      .toEqual(['checkNumber', 'amount', 'status', 'bank', 'action'])
  })

  it('yields exactly the always-on columns when everything else is unticked', () => {
    expect(normaliseColumns([])).toEqual(['checkNumber', 'status', 'action'])
  })
})

describe('reordering', () => {
  const ORDER = ['checkNumber', 'payeeName', 'amount', 'status', 'action'] as const

  it('moves a column one place either way, never past ACTION or the ends', () => {
    expect(moveColumn([...ORDER], 'amount', -1)).toEqual(['checkNumber', 'amount', 'payeeName', 'status', 'action'])
    expect(moveColumn([...ORDER], 'payeeName', 1)).toEqual(['checkNumber', 'amount', 'payeeName', 'status', 'action'])
    expect(moveColumn([...ORDER], 'checkNumber', -1)).toEqual([...ORDER])
    expect(moveColumn([...ORDER], 'status', 1)).toEqual([...ORDER])
    expect(moveColumn([...ORDER], 'action', -1)).toEqual([...ORDER])
    expect(canMoveColumn([...ORDER], 'status', 1)).toBe(false)
    expect(canMoveColumn([...ORDER], 'status', -1)).toBe(true)
    expect(canMoveColumn([...ORDER], 'action', -1)).toBe(false)
  })

  it('hides and shows a column, bringing it back beside its canonical neighbour', () => {
    expect(toggleColumn([...ORDER], 'payeeName')).toEqual(['checkNumber', 'amount', 'status', 'action'])
    expect(toggleColumn(['checkNumber', 'amount', 'status', 'action'], 'bank'))
      .toEqual(['checkNumber', 'bank', 'amount', 'status', 'action'])
    expect(toggleColumn([...ORDER], 'status')).toEqual([...ORDER])
  })

  it('inserts at the front when no canonical predecessor is on screen', () => {
    expect(insertColumn(['amount', 'status', 'action'], 'checkNumber')).toEqual(['checkNumber', 'amount', 'status', 'action'])
  })

  it('forces columns in without disturbing the rest', () => {
    expect(withColumns(['status', 'checkNumber', 'action'], ['payeeName', 'amount']))
      .toEqual(['status', 'checkNumber', 'payeeName', 'amount', 'action'])
  })

  it('round-trips an order through storage', () => {
    const order = moveColumn([...COLUMN_KEYS], 'amount', -1)
    expect(parseColumnPreference(serialiseColumnPreference(order))).toEqual(order)
  })

  it('keeps part B’s storage key', () => {
    expect(COLUMN_STORAGE_KEY).toBe('check-monitoring.columns.v2')
  })
})

describe('withColumnOrder', () => {
  it('writes the order onto the export link, without ACTION', () => {
    expect(withColumnOrder('/api/export?status=SIGNED', ['amount', 'checkNumber', 'status', 'action']))
      .toBe('/api/export?status=SIGNED&cols=amount%2CcheckNumber%2Cstatus')
    expect(withColumnOrder('/api/export', ['checkNumber', 'status', 'action']))
      .toBe('/api/export?cols=checkNumber%2Cstatus')
  })
})
```

Then read the rest of the file: any remaining test that asserts canonical re-ordering of a shuffled input (search for `toEqual(['checkNumber'`) must be rewritten to the order-preserving result computed by the rules above — never deleted.

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/table-columns.test.ts`.

- [ ] **Step 3: Implement** in `lib/table-columns.ts`. Update the `COLUMN_STORAGE_KEY` comment with: "Since part C (2026-10-01) the array is the visible columns IN DISPLAY ORDER. A v2 value written before that is in canonical order and reads as the default order with the same visibility, so the key is not bumped again." Replace the `normaliseColumns` doc's ordering paragraph and the function, and add the new functions:

```ts
const canonical = (k: ColumnKey) => COLUMN_KEYS.indexOf(k)

/**
 * `key` added to `order` beside its nearest canonical predecessor that is
 * already there (at the front if none is) — a column shown again returns to
 * its usual neighbour, not to the end. ACTION is always appended last.
 */
export function insertColumn(order: readonly ColumnKey[], key: ColumnKey): ColumnKey[] {
  if (order.includes(key)) return [...order]
  if (key === 'action') return [...order, 'action']
  const out = order.filter((k) => k !== 'action')
  const before = COLUMN_KEYS.slice(0, canonical(key)).reverse().find((k) => out.includes(k))
  out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, key)
  return order.includes('action') ? [...out, 'action'] : out
}

/**
 * Canonicalises a stored choice: unknown keys dropped, duplicates removed,
 * the ORDER GIVEN KEPT, the always-on three added back beside their canonical
 * neighbours, and ACTION last.
 */
export function normaliseColumns(keys: readonly unknown[]): ColumnKey[] {
  let out: ColumnKey[] = [...new Set(keys.filter(isColumnKey))].filter((k) => k !== 'action')
  for (const key of ALWAYS_ON) out = insertColumn(out, key)
  return out
}

/** Show or hide one column. The always-on three do not toggle. */
export function toggleColumn(order: readonly ColumnKey[], key: ColumnKey): ColumnKey[] {
  if ((ALWAYS_ON as readonly ColumnKey[]).includes(key)) return [...order]
  return order.includes(key) ? order.filter((k) => k !== key) : insertColumn(order, key)
}

export function canMoveColumn(order: readonly ColumnKey[], key: ColumnKey, delta: -1 | 1): boolean {
  const at = order.indexOf(key)
  const to = at + delta
  return key !== 'action' && at >= 0 && to >= 0 && to < order.length && order[to] !== 'action'
}

/** One place left or right; ACTION never moves and nothing passes it. */
export function moveColumn(order: readonly ColumnKey[], key: ColumnKey, delta: -1 | 1): ColumnKey[] {
  if (!canMoveColumn(order, key, delta)) return [...order]
  const out = [...order]
  const at = out.indexOf(key)
  ;[out[at], out[at + delta]] = [out[at + delta], out[at]]
  return out
}

/** `order` with `keys` forced in — a filtered column stays on screen (part C2). */
export function withColumns(order: readonly ColumnKey[], keys: readonly ColumnKey[]): ColumnKey[] {
  return keys.reduce<ColumnKey[]>((acc, k) => insertColumn(acc, k), [...order])
}

/** The export link with `cols=` in the viewer's order (ACTION is not a file column). */
export function withColumnOrder(href: string, order: readonly ColumnKey[]): string {
  const [path, query = ''] = href.split('?')
  const qs = new URLSearchParams(query)
  qs.set('cols', order.filter((k) => k !== 'action').join(','))
  return `${path}?${qs.toString()}`
}
```

  `serialiseColumnPreference` and `parseColumnPreference` are unchanged (both go through `normaliseColumns`, which now keeps order).

- [ ] **Step 4: Run** `tests/table-columns.test.ts` → PASS; tsc clean (`components/CheckTable.tsx` still compiles: it calls `normaliseColumns` only).

- [ ] **Step 5: Commit**

```bash
git add lib/table-columns.ts tests/table-columns.test.ts
git commit -m "feat(list): the column preference is an ordered list (v2 kept)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The table — sortable headers, columns in the viewer's order

**Files:**
- Modify: `lib/dashboard-view.ts` (add `SortLink`, `sortLinks`)
- Create: `components/sort-cookie.ts`, `components/ResetLink.tsx`
- Modify (rewrite): `components/CheckTable.tsx`
- Modify: `components/FilterBar.tsx` (sort hidden inputs, RESET), `app/page.tsx` (cookie, sort, props)
- Test: `tests/dashboard-view.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5, 6.
- Produces: `type SortLink = { href: string; next: SortSpec | null }`; `sortLinks(sel: DashboardSelection, active: SortSpec | null): Record<SortKey, SortLink>`; `writeSortCookie(next: SortSpec | null): void`; `CheckTable` props `{ rows, canRelease, bulkCap, sort: SortSpec, sortLinks: Readonly<Record<SortKey, SortLink>> }`; `FilterBar` props gain `sort: SortSpec | undefined` and `hasSort: boolean`.

Decision: the cookie is written in the browser, on the header's click, before the soft navigation (`document.cookie`, not `HttpOnly` — it holds a column name). Without JavaScript the header link still sorts through the URL; only the memory is lost.

Decision: the table renders — headers and all — even when no row matches, with one full-width "NO CHECKS MATCH THESE FILTERS." row. Task 8 puts the filter row in the header; a filter that matches nothing must not remove the box needed to change it.

- [ ] **Step 1: Failing test** — append to `tests/dashboard-view.test.ts` (add `sortLinks` to the import):

```ts
describe('sortLinks — one per header', () => {
  const sel: DashboardSelection = { ...NOTHING, status: 'SIGNED' }

  it('offers ascending on a fresh column, and the cycle on the active one', () => {
    const links = sortLinks(sel, { key: 'amount', dir: 'desc' })
    expect(links.amount).toEqual({ href: '/?status=SIGNED', next: null })
    expect(links.payeeName).toEqual({ href: '/?status=SIGNED&sort=payeeName&dir=asc', next: { key: 'payeeName', dir: 'asc' } })
    expect(sortLinks(sel, { key: 'amount', dir: 'asc' }).amount.next).toEqual({ key: 'amount', dir: 'desc' })
  })

  it('has no link for ACTION, and sorts CHECK DATE ascending under the default', () => {
    const links = sortLinks(sel, null)
    expect(Object.keys(links)).not.toContain('action')
    expect(links.checkDate.next).toEqual({ key: 'checkDate', dir: 'asc' })
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts -t sortLinks`.

- [ ] **Step 3: Implement.**

`lib/dashboard-view.ts` — change the type import to `import { SORT_KEYS, nextSort, type SortKey, type SortSpec } from './list-sort'` and add:

```ts
/** A header's link, and the sort it would put in force (`null` = back to the default). */
export type SortLink = { href: string; next: SortSpec | null }

/**
 * Every sortable header's link, from the sort in force (`active`: the URL's
 * or the cookie's, null under the default). Built on the server and handed to
 * the table, so the browser does no URL arithmetic of its own.
 */
export function sortLinks(sel: DashboardSelection, active: SortSpec | null): Record<SortKey, SortLink> {
  const out = {} as Record<SortKey, SortLink>
  for (const key of SORT_KEYS) {
    const next = nextSort(active, key)
    out[key] = { href: sortHref(sel, next), next }
  }
  return out
}
```

`components/sort-cookie.ts`:

```ts
import { sortCookieString, type SortSpec } from '@/lib/list-sort'

/**
 * Remember (or forget) the list's order — "remember my sort", part C4. Called
 * from a click handler, before the navigation it belongs to, so the server
 * render that follows already sees it. A browser that blocks cookies loses
 * only the memory; the URL still carries the sort.
 */
export function writeSortCookie(next: SortSpec | null): void {
  try {
    document.cookie = sortCookieString(next)
  } catch {
    // Nothing on this screen is worth an error over a remembered preference.
  }
}
```

`components/ResetLink.tsx`:

```tsx
'use client'

import { writeSortCookie } from './sort-cookie'

/**
 * RESET: every filter AND the remembered sort. A plain anchor — a full page
 * load, for the reason FilterBar gives (the boxes' `defaultValue`s must be
 * re-applied) — that deletes `cm_sort` on the way out. Without JavaScript the
 * URL is still reset; the cookie survives, which only means the list opens on
 * the reader's own last sort.
 */
export function ResetLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      onClick={() => writeSortCookie(null)}
      className="h-10 rounded-lg px-3 py-2 text-sm font-medium text-navy underline underline-offset-2 hover:text-slate-900"
    >
      RESET
    </a>
  )
}
```

`components/FilterBar.tsx`:
- Props gain `sort: SortSpec | undefined` (the URL's own sort — `selection.sort`) and `hasSort: boolean` (`activeSort !== null`). Import `type { SortSpec } from '@/lib/list-sort'` and `{ ResetLink } from './ResetLink'`.
- After the hidden `scope` inputs: `{sort && <><input type="hidden" name="sort" value={sort.key} /><input type="hidden" name="dir" value={sort.dir} /></>}` with the comment "A filter change keeps the order the URL chose — a GET submit sends only the form's own controls."
- `anyFilter` gains `|| hasSort`.
- Replace the RESET `<a>` with `<ResetLink href={clearHref} />`, keeping the comment above it and adding: "It also forgets the remembered sort."

`components/CheckTable.tsx` — replace the file with the version below. Everything inside the tick-box cell, the OR / CR cell and the ACTION cell, and the `selected`/`drafts` state and handlers, is the current code moved unchanged; keep the current comments on them.

```tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatMoney } from '@/lib/money'
import { RECEIPT_TYPES } from '@/lib/domain/receipt'
import {
  isTickable, takesReceipt, draftTypeMissing, EMPTY_DRAFT, type ReceiptDraft,
} from '@/lib/row-receipts'
import {
  COLUMN_KEYS, COLUMN_LABELS, ALWAYS_ON, DEFAULT_COLUMNS, COLUMN_STORAGE_KEY,
  parseColumnPreference, serialiseColumnPreference, toggleColumn, moveColumn, canMoveColumn,
  type ColumnKey,
} from '@/lib/table-columns'
import type { SortKey, SortSpec } from '@/lib/list-sort'
import type { SortLink } from '@/lib/dashboard-view'
import { writeSortCookie } from './sort-cookie'
import { StatusPill } from './StatusPill'
import { BulkActionBar } from './BulkActionBar'
import type { CheckTableRow } from '@/lib/queries'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

// (the existing comment on `selectable`)
const selectable = isTickable

/** Every column but ACTION, which is pinned last and rendered after OR / CR. */
type DataColumn = Exclude<ColumnKey, 'action'>

const isAlwaysOn = (k: ColumnKey) => (ALWAYS_ON as readonly ColumnKey[]).includes(k)

const headerClass = (key: DataColumn) => (key === 'amount' ? 'px-4 py-3 text-right' : 'px-4 py-3')

/**
 * A sortable header: asc → desc → default (spec C1). The link is built on the
 * server (`sortLinks`); the click writes or deletes the `cm_sort` cookie before
 * the navigation so the next render — and the next visit — use it.
 */
function SortHeader({ column, sort, link }: { column: DataColumn; sort: SortSpec; link: SortLink }) {
  const active = sort.key === column ? sort.dir : null
  return (
    <th
      className={headerClass(column)}
      aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
    >
      <Link
        prefetch={false}
        scroll={false}
        href={link.href}
        onClick={() => writeSortCookie(link.next)}
        className="inline-flex items-center gap-1 hover:text-slate-900"
      >
        {COLUMN_LABELS[column]}
        <span aria-hidden className={active ? 'text-navy' : 'text-slate-300'}>
          {active === 'asc' ? '▲' : active === 'desc' ? '▼' : '↕'}
        </span>
      </Link>
    </th>
  )
}

/** One data cell. The markup of each case is the cell the table rendered before part C. */
function DataCell({ column, r }: { column: DataColumn; r: CheckTableRow }) {
  switch (column) {
    case 'checkNumber':
      return <td className="px-4 py-3 font-medium">{r.checkNumber}</td>
    case 'apvNumbers':
      return <td className="px-4 py-3 text-slate-600">{r.apvNumbers.length ? r.apvNumbers.join(', ') : '—'}</td>
    case 'poNumbers':
      return <td className="px-4 py-3 text-slate-600">{r.poNumbers.length ? r.poNumbers.join(', ') : '—'}</td>
    case 'payeeName':
      return (
        <td className="px-4 py-3">
          {r.payeeName ?? '—'}
          {r.eligibility === 'INTERNAL' && (
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] tracking-wide text-slate-600">
              INTERNAL
            </span>
          )}
        </td>
      )
    case 'companyCode':
      return <td className="px-4 py-3 text-slate-600">{r.companyCode}</td>
    case 'bank':
      return <td className="px-4 py-3 text-slate-600" title={r.bankCode ?? undefined}>{r.cashAccountCode ?? '—'}</td>
    case 'checkDate':
      return <td className="px-4 py-3 text-slate-600">{fmtDate(r.checkDate)}</td>
    case 'amount':
      return <td className="px-4 py-3 text-right font-medium tabular-nums">{formatMoney(r.amount, r.currency)}</td>
    case 'status':
      return <td className="px-4 py-3"><StatusPill status={r.status} /></td>
    case 'availablePickupDate':
      return <td className="px-4 py-3 text-slate-600">{fmtDate(r.availablePickupDate)}</td>
    case 'scheduledPickupDate':
      return <td className="px-4 py-3 text-slate-600">{fmtDate(r.scheduledPickupDate)}</td>
    case 'releasedAt':
      return (
        <td className="px-4 py-3 text-slate-600">
          {r.releasedAt
            ? fmtDate(r.releasedAt)
            : r.statedReleaseDate
              ? <>{fmtDate(r.statedReleaseDate)}<span className="ml-1 text-[10px] font-semibold tracking-widest text-slate-400">REGISTER</span></>
              : '—'}
        </td>
      )
    default: {
      const unreachable: never = column
      return unreachable
    }
  }
}

export function CheckTable({
  rows, canRelease, bulkCap, sort, sortLinks,
}: {
  rows: CheckTableRow[]
  canRelease: boolean
  bulkCap: number
  /** The order in force (URL, cookie or default) — which header shows an arrow. */
  sort: SortSpec
  sortLinks: Readonly<Record<SortKey, SortLink>>
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, ReceiptDraft>>({})

  /**
   * The viewer's columns, IN ORDER (part C3). Starts at the default and is
   * corrected in an effect, never read during render — the existing reasons:
   * no `localStorage` on the server, and a first paint that must match it.
   */
  const [preference, setPreference] = useState<readonly ColumnKey[]>(DEFAULT_COLUMNS)

  useEffect(() => {
    try {
      const stored = parseColumnPreference(window.localStorage.getItem(COLUMN_STORAGE_KEY))
      if (stored) setPreference(stored)
    } catch {
      // A private window, or blocked site data, throws on the accessor itself.
    }
  }, [])

  const visible = preference
  const shown = visible.filter((k): k is DataColumn => k !== 'action')
  const hidden = COLUMN_KEYS.filter((k): k is DataColumn => k !== 'action' && !visible.includes(k))

  const persist = (next: readonly ColumnKey[]) => {
    setPreference(next)
    try {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, serialiseColumnPreference(next))
    } catch {
      // Applies to this session; simply not remembered.
    }
  }

  // …selectableRows, selectedIds, allSelected, toggle, toggleAll, open: unchanged…

  const arrow = 'h-6 w-6 rounded border border-hairline text-[10px] leading-none text-slate-600 disabled:opacity-30'

  /**
   * The column chooser: show/hide, and ◀ ▶ to move (part C3). Outside the
   * table, for the reason it always was: a reader who narrowed the table to
   * three columns must be able to widen it again.
   */
  const picker = (
    <details className="rounded-2xl bg-white p-3 ring-1 ring-hairline">
      <summary className="cursor-pointer select-none text-xs font-medium tracking-wide text-slate-600">
        COLUMNS ({visible.length} OF {COLUMN_KEYS.length})
      </summary>
      <ol className="mt-3 space-y-1 border-t border-slate-100 pt-3">
        {shown.map((key) => (
          <li key={key} className="flex items-center gap-2 text-xs tracking-wide text-slate-700">
            <button type="button" className={arrow} aria-label={`Move ${COLUMN_LABELS[key]} left`}
              disabled={!canMoveColumn(visible, key, -1)} onClick={() => persist(moveColumn(visible, key, -1))}>◀</button>
            <button type="button" className={arrow} aria-label={`Move ${COLUMN_LABELS[key]} right`}
              disabled={!canMoveColumn(visible, key, 1)} onClick={() => persist(moveColumn(visible, key, 1))}>▶</button>
            {isAlwaysOn(key) ? (
              <span>{COLUMN_LABELS[key]} <span className="text-slate-400">(ALWAYS SHOWN)</span></span>
            ) : (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked onChange={() => persist(toggleColumn(visible, key))} />
                {COLUMN_LABELS[key]}
              </label>
            )}
          </li>
        ))}
        {hidden.map((key) => (
          <li key={key} className="flex items-center gap-2 pl-16 text-xs tracking-wide text-slate-500">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={false} onChange={() => persist(toggleColumn(visible, key))} />
              {COLUMN_LABELS[key]}
            </label>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-slate-500">
        ◀ ▶ MOVE A COLUMN. ACTION IS ALWAYS LAST. THE ORDER IS REMEMBERED IN THIS BROWSER AND USED BY EXPORT EXCEL.
      </p>
    </details>
  )

  return (
    <div className="space-y-3">
      {picker}

      {/* (the existing comment on the scrolling container) */}
      <div className="max-h-[70vh] overflow-auto rounded-2xl bg-white ring-1 ring-hairline">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white text-left text-xs tracking-wide text-slate-500 shadow-[inset_0_-1px_0_#E5E7EB]">
            <tr>
              <th className="px-4 py-3">{/* the existing select-all checkbox, unchanged */}</th>
              {shown.map((key) => <SortHeader key={key} column={key} sort={sort} link={sortLinks[key]} />)}
              <th className="px-4 py-3">OR / CR</th>
              <th className="px-4 py-3">{COLUMN_LABELS.action}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              // Kept inside the table (part C2): the headers — and, from the
              // filter row, the boxes — must survive a filter that matches nothing.
              <tr>
                <td colSpan={shown.length + 3} className="p-8 text-center text-sm text-slate-500">
                  NO CHECKS MATCH THESE FILTERS.
                </td>
              </tr>
            ) : rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => open(r.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') open(r.id) }}
                tabIndex={0}
                className="cursor-pointer border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground hover:bg-navy-bg focus:bg-navy-bg focus:outline-none"
              >
                {/* the tick-box <td>, unchanged */}
                {shown.map((key) => <DataCell key={key} column={key} r={r} />)}
                {/* the OR / CR <td>, unchanged */}
                {/* the ACTION <td> with the OPEN link, unchanged */}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* the BulkActionBar block, unchanged */}
    </div>
  )
}
```

The `{/* … unchanged */}` lines above mark where the current JSX is pasted verbatim from `components/CheckTable.tsx` (the select-all `<input>` at :194-198, the tick-box `<td>` at :237-255, the OR / CR `<td>` at :317-348, the ACTION `<td>` at :349-353, the `BulkActionBar` block at :360-368). The old `if (rows.length === 0)` early return, `OPTIONAL_COLUMNS`, `shows` and `toggleColumn` closure are removed.

`app/page.tsx`:
- Imports: `import { cookies } from 'next/headers'`; `import { SORT_COOKIE } from '@/lib/list-sort'`; add `sortLinks` to the `@/lib/dashboard-view` import; `import { resolveDashboardQuery, type DashboardSearchParams } from '@/lib/dashboard-params'`.
- `searchParams: Promise<DashboardSearchParams & { /* the existing confirm comment */ confirm?: string }>` replaces the inline type.
- Before resolving: `const sortCookie = (await cookies()).get(SORT_COOKIE)?.value` with the comment "The remembered order (part C4): read here so the list opens on it with no flicker. The export and print read the same cookie."
- `resolveDashboardQuery(params, options, { sortCookie })`; destructure `sort, activeSort` too.
- `listChecks(prisma, filters)` → `listChecks(prisma, filters, 200, sort)`.
- `<CheckTable … sort={sort} sortLinks={sortLinks(selection, activeSort)} />`.
- `<FilterBar … sort={selection.sort} hasSort={activeSort !== null} />`.

- [ ] **Step 4: Run** `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts` → PASS; tsc clean; `npx.cmd next build` is NOT run here (Task 11).

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard-view.ts components/sort-cookie.ts components/ResetLink.tsx components/CheckTable.tsx components/FilterBar.tsx app/page.tsx tests/dashboard-view.test.ts
git commit -m "feat(list): sortable headers, remembered sort, columns in the viewer's order" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The filter row

**Files:**
- Modify: `lib/column-filters.ts` (add `activeFilterColumns`)
- Create: `components/ColumnFilterCell.tsx`
- Modify: `components/CheckTable.tsx`, `components/FilterBar.tsx`, `components/FilterAutoSubmit.tsx`, `app/page.tsx`
- Test: `tests/column-filters.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 7.
- Produces: `activeFilterColumns(values: Readonly<Record<string, string>>): ColumnKey[]` (canonical order); `type FilterRowState = { options: FilterOptions; values: Readonly<Record<string, string>>; errors: Readonly<Record<string, string>>; showStatus: boolean; showReleasedRange: boolean; filteredColumns: readonly ColumnKey[] }`; `ColumnFilterCell({ column, state })`; `CheckTable` prop `filters: FilterRowState`; `FilterBar` props lose `companyId`, `cashAccountId`, `releasedFrom`, `releasedTo`, `showReleasedRange`, gain `hasColumnFilter: boolean`.

Decision: the search box, ELIGIBILITY and INCOMPLETE ONLY stay on the bar directly above the table — none has a column. Every other control lives in the filter row and belongs to the bar's `<form id="list-filters">` through the HTML `form=` attribute, so a native GET submit (APPLY, no JavaScript) still sends them.

Decision: `FilterAutoSubmit` listens on `document` and acts on events whose target's `.form` is the bar's form: controls in the table head are not DOM descendants of the form, so `change`/`input` from them never bubble to it.

Decision: a column carrying an active filter cannot be hidden — its tick-box is disabled and, if a stored preference hides it, it is shown anyway (`withColumns`). A filter in force on an invisible column is a narrowing nobody can see or clear.

Decision: on LIST, the "EXCLUDING N WITH NO RECORDED AMOUNT" count becomes the cheques with no amount that THIS list's filters match — view, search and column filters — `countChecks({ ...filters, incomplete: true })`. Its "Show them" link (`incompleteHref`) already opens exactly that set; the old count (company/bank/eligibility only) could name more cheques than the link showed. `getSummary` is no longer read on LIST.

- [ ] **Step 1: Failing test** — append to `tests/column-filters.test.ts` (add `activeFilterColumns` to the import):

```ts
describe('activeFilterColumns', () => {
  it('names each column with a box in force, in column order', () => {
    expect(activeFilterColumns({ 'f.payee': 'x', company: 'c1', releasedTo: '2026-09-01', 'f.amountMin': '1' }))
      .toEqual(['payeeName', 'companyCode', 'amount', 'releasedAt'])
  })
  it('ignores the search, the eligibility and an empty value', () => {
    expect(activeFilterColumns({ q: 'x', eligibility: 'SUPPLIER', 'f.apv': '' })).toEqual([])
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/column-filters.test.ts -t activeFilterColumns`.

- [ ] **Step 3: Implement.**

`lib/column-filters.ts` — add `import { COLUMN_KEYS, type ColumnKey } from './table-columns'` and:

```ts
/** The columns a box is in force on — kept on screen whatever the preference says. */
export function activeFilterColumns(values: Readonly<Record<string, string>>): ColumnKey[] {
  return COLUMN_KEYS.filter((k): k is keyof typeof COLUMN_FILTER_PARAMS =>
    k !== 'action' && COLUMN_FILTER_PARAMS[k as keyof typeof COLUMN_FILTER_PARAMS].some((p) => Boolean(values[p])))
}
```

`components/ColumnFilterCell.tsx`:

```tsx
'use client'

import type { ReactNode } from 'react'
import type { FilterOptions } from '@/lib/queries'
import type { ColumnKey } from '@/lib/table-columns'
import { bankLabel } from '@/lib/export/report'
import { LIST_FILTER_FORM } from '@/lib/column-filters'
import { LIVE_STATUSES, CLOSED_STATUSES } from '@/lib/domain/check-status'

/**
 * One box of the filter row under the headers (spec 2026-10-01, part C2).
 *
 * Every control belongs to the bar's form by `form={LIST_FILTER_FORM}` — it is
 * rendered in the table head, outside the form element, and the attribute is
 * what makes a native GET submit (no JavaScript) still send it.
 * Uncontrolled (`defaultValue`): `FilterAutoSubmit` soft-navigates and the DOM
 * survives, which is what keeps the caret in a box while typing.
 * Amounts are TEXT boxes: an amount is a decimal string (rule 8), and a
 * `type="number"` box would hide an unreadable value instead of letting the
 * server refuse it beside the box.
 */

export type FilterRowState = {
  options: FilterOptions
  /** Each box's value as typed (company and bank as ids). */
  values: Readonly<Record<string, string>>
  /** Parameter → message, for the boxes the server could not read. */
  errors: Readonly<Record<string, string>>
  /** STATUS has a box on ALL CHEQUES only. */
  showStatus: boolean
  /** DATE RELEASED has boxes on RELEASED and ALL CHEQUES only. */
  showReleasedRange: boolean
  /** Columns with a box in force — never hidden. */
  filteredColumns: readonly ColumnKey[]
}

const box = 'h-8 w-full min-w-[6.5rem] rounded border bg-white px-2 text-xs font-normal normal-case tracking-normal text-slate-900 focus:border-navy focus:outline-none'
const STATUSES = [...LIVE_STATUSES, ...CLOSED_STATUSES]

function Refusal({ name, errors }: { name: string; errors: FilterRowState['errors'] }) {
  return errors[name]
    ? <p role="alert" className="mt-1 text-[10px] font-semibold normal-case text-red-700">{errors[name]}</p>
    : null
}

export function ColumnFilterCell({ column, state }: { column: Exclude<ColumnKey, 'action'>; state: FilterRowState }): ReactNode {
  const value = (name: string) => state.values[name] ?? ''
  const border = (name: string) => (state.errors[name] ? 'border-red-600' : 'border-hairline')

  const text = (name: string, label: string) => (
    <>
      <input
        type="text" form={LIST_FILTER_FORM} name={name} defaultValue={value(name)}
        aria-label={`${label} contains`} aria-invalid={Boolean(state.errors[name])}
        placeholder="contains…" className={`${box} ${border(name)}`}
      />
      <Refusal name={name} errors={state.errors} />
    </>
  )

  const range = (from: string, to: string, label: string, kind: 'date' | 'amount') => (
    <div className="flex flex-col gap-1">
      {([[from, kind === 'amount' ? 'MIN' : 'FROM'], [to, kind === 'amount' ? 'MAX' : 'TO']] as const).map(([name, edge]) => (
        <input
          key={name}
          type={kind === 'date' ? 'date' : 'text'}
          inputMode={kind === 'amount' ? 'decimal' : undefined}
          form={LIST_FILTER_FORM} name={name} defaultValue={value(name)}
          aria-label={`${label} ${edge}`} aria-invalid={Boolean(state.errors[name])}
          placeholder={kind === 'amount' ? edge : undefined}
          className={`${box} ${border(name)}`}
        />
      ))}
      <Refusal name={from} errors={state.errors} />
      <Refusal name={to} errors={state.errors} />
    </div>
  )

  switch (column) {
    case 'checkNumber': return text('f.checkNumber', 'CHECK NUMBER')
    case 'apvNumbers': return text('f.apv', 'APV NUMBER')
    case 'poNumbers': return text('f.po', 'PO NUMBER')
    case 'payeeName': return text('f.payee', 'SUPPLIER NAME')
    case 'companyCode':
      return (
        <select form={LIST_FILTER_FORM} name="company" defaultValue={value('company')} aria-label="COMPANY" className={`${box} border-hairline`}>
          <option value="">ALL</option>
          {state.options.companies.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
      )
    case 'bank':
      return (
        <select form={LIST_FILTER_FORM} name="cashAccount" defaultValue={value('cashAccount')} aria-label="BANK / CASH ACCOUNT" className={`${box} border-hairline`}>
          <option value="">ALL</option>
          {state.options.cashAccounts.map((a) => <option key={a.id} value={a.id}>{bankLabel(a.code, a.bankCode)}</option>)}
        </select>
      )
    case 'status':
      return state.showStatus ? (
        <>
          <select form={LIST_FILTER_FORM} name="f.status" defaultValue={value('f.status')} aria-label="STATUS"
            aria-invalid={Boolean(state.errors['f.status'])} className={`${box} ${border('f.status')}`}>
            <option value="">ALL</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <Refusal name="f.status" errors={state.errors} />
        </>
      ) : null
    case 'checkDate': return range('f.checkDateFrom', 'f.checkDateTo', 'CHECK DATE', 'date')
    case 'amount': return range('f.amountMin', 'f.amountMax', 'AMOUNT', 'amount')
    case 'availablePickupDate': return range('f.availablePickupDateFrom', 'f.availablePickupDateTo', 'AVAILABLE DATE', 'date')
    case 'scheduledPickupDate': return range('f.scheduledPickupDateFrom', 'f.scheduledPickupDateTo', 'PICKUP SCHEDULE', 'date')
    case 'releasedAt':
      return state.showReleasedRange ? range('releasedFrom', 'releasedTo', 'DATE RELEASED', 'date') : null
    default: {
      const unreachable: never = column
      return unreachable
    }
  }
}
```

(Read `lib/export/report.ts`'s imports before relying on it in the browser: it imports `@prisma/client` as a type and `@/lib/settings/defaults`, a constants leaf — both safe.)

`components/CheckTable.tsx`:
- Imports: `withColumns` from `@/lib/table-columns`; `{ ColumnFilterCell, type FilterRowState } from './ColumnFilterCell'`.
- Prop `filters: FilterRowState` (doc: "The filter row's state, from the server: values to render back, refusals, which boxes apply.").
- `const visible = preference` becomes `const visible = withColumns(preference, filters.filteredColumns)` with the comment "A column with a filter in force is never hidden (part C2)."
- In the picker, the shown-column checkbox gains `disabled={filters.filteredColumns.includes(key)}` and `title={filters.filteredColumns.includes(key) ? 'FILTERED — CLEAR ITS FILTER TO HIDE IT' : undefined}`.
- In `<thead>`, after the header `<tr>`, add the filter row:

```tsx
            {/* THE FILTER ROW (part C2). Keyed on the dropdown values for the
                reason FilterBar's form is: a soft navigation that changes them
                from elsewhere leaves a mounted <select> showing the old one. */}
            <tr key={`${filters.values.company ?? ''}|${filters.values.cashAccount ?? ''}|${filters.values['f.status'] ?? ''}`} className="align-top">
              <th className="px-4 pb-3" />
              {shown.map((key) => (
                <th key={key} className="px-4 pb-3 font-normal">
                  <ColumnFilterCell column={key} state={filters} />
                </th>
              ))}
              <th className="px-4 pb-3" />
              <th className="px-4 pb-3" />
            </tr>
```

`components/FilterBar.tsx`:
- `import { LIST_FILTER_FORM } from '@/lib/column-filters'`; the `<form>` gains `id={LIST_FILTER_FORM}`.
- Remove the COMPANY `<select>`, the BANK `<select>` and the whole DATE RELEASED block (they are in the filter row now); remove the props `options`, `companyId`, `cashAccountId`, `releasedFrom`, `releasedTo` and `showReleasedRange`, and the now-unused `FilterOptions` and `bankLabel` imports (`ELIGIBILITIES` stays); add the prop `hasColumnFilter: boolean`.
- `anyFilter = Boolean(q || eligibility || incomplete || hasColumnFilter || hasSort)`.
- Form `key={\`${status}|${showAll}|${eligibility}|${incomplete}\`}`.
- Header comment: replace the one-row list with "SEARCH · ELIGIBILITY · INCOMPLETE · RESET. Every other filter is a box in the table's filter row (components/ColumnFilterCell.tsx), joined to this form by `form="list-filters"` — a native submit still sends it."

`components/FilterAutoSubmit.tsx` — replace the listener wiring inside the effect:

```ts
    // The filter row's controls sit in the table head, outside the form
    // element, joined to it by `form=` (part C2). Their events never bubble to
    // the form, so listen on the document and keep only this form's controls.
    const owns = (t: EventTarget | null): t is HTMLInputElement | HTMLSelectElement =>
      (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) && t.form === form

    const onChange = (e: Event) => {
      const t = e.target
      if (!owns(t)) return
      // A `change` on a text box fires on blur and would double-submit behind the debounce.
      if (t instanceof HTMLInputElement && t.type === 'text') return
      go()
    }

    const onInput = (e: Event) => {
      const t = e.target
      if (!owns(t) || !(t instanceof HTMLInputElement) || t.type !== 'text') return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(go, DEBOUNCE_MS)
    }

    form.addEventListener('submit', onSubmit)
    document.addEventListener('change', onChange)
    document.addEventListener('input', onInput)

    return () => {
      if (timer.current) clearTimeout(timer.current)
      form.removeEventListener('submit', onSubmit)
      document.removeEventListener('change', onChange)
      document.removeEventListener('input', onInput)
      if (apply) apply.hidden = false
    }
```

`new FormData(form)` already includes `form=`-associated controls, so `go` is unchanged. Pressing Enter in a filter-row text box submits the associated form, which `onSubmit` intercepts.

`app/page.tsx` (LIST branch):
- Imports: `{ activeFilterColumns } from '@/lib/column-filters'`; drop `getSummary` from the LIST `Promise.all` only (TOTALS still uses it).
- Destructure `columnValues, filterErrors, refused` from `resolveDashboardQuery`.
- Replace `getSummary(prisma, narrow),` in the LIST `Promise.all` with `countChecks(prisma, { ...filters, incomplete: true }),` bound to `excludedIncomplete`, and in the disclosure use `excludedIncomplete` for `summary.incomplete`, with the comment: "The cheques with no amount THIS list's own filters match — view, search, column filters — so the count is exactly what 'Show them' opens (part C2)."
- Under the bar (before the disclosure), add:

```tsx
      {/* A box that could not be read lists NOTHING rather than being dropped
          (part C2): an ignored filter reads as an applied one. The box itself
          says what is wrong; this says why the table is empty. */}
      {refused && (
        <p role="alert" className="rounded-lg bg-warning-bg px-4 py-2 text-sm font-semibold text-warning-ink">
          A FILTER COULD NOT BE READ, SO NOTHING IS LISTED. Correct the box marked in red, or press RESET.
        </p>
      )}
```

- `<FilterBar>`: remove `options`, `companyId`, `cashAccountId`, `releasedFrom`, `releasedTo`, `showReleasedRange`; add `hasColumnFilter={Object.keys(columnValues).length > 0}`.
- `<CheckTable … filters={{ options, values: columnValues, errors: filterErrors, showStatus: showAll && !status, showReleasedRange: status === 'RELEASED' || showAll, filteredColumns: activeFilterColumns(columnValues) }} />`.

- [ ] **Step 4: Run** `tests/column-filters.test.ts` → PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/column-filters.ts components/ColumnFilterCell.tsx components/CheckTable.tsx components/FilterBar.tsx components/FilterAutoSubmit.tsx app/page.tsx tests/column-filters.test.ts
git commit -m "feat(list): a filter row under the headers; a refused box empties the list and says why" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: SIGN ALL honours the column filters; RELEASE ALL refuses them

**Files:**
- Modify: `app/checks/bulk-actions.ts` (`ConfirmedAll` :241-255, `runConfirmedAll` :285-…, `releaseAllReadyAction`, `signAllPendingAction` :420-439)
- Modify: `components/ConfirmAllForm.tsx`, `app/page.tsx`
- Test: `tests/actions/bulk-actions.test.ts`

**Interfaces:**
- Consumes: `parseColumnFilters`, `F_PARAMS`, `columnParamsOf` (Task 5); `listPendingSignatureIds(db, narrow, columns)`, `getPendingSignature(db, narrow, columns)`, `columnFilterFields` (Task 3).
- Produces: `ConfirmedAll.listIds: (narrow: SummaryNarrowing, columns: ColumnFilters) => Promise<string[]>`; `ConfirmedAll.acceptsColumnFilters: boolean`; `ConfirmAllForm` prop `columnParams?: Readonly<Record<string, string>>`.

Decision: SIGN ALL's set is the pending set narrowed by company/bank/eligibility AND the column filters on screen; it is still offered only on SIGNATURE PENDING with no search and the incomplete toggle off (the set takes no search), and now also never while a filter is refused. The column filters ride to the server as hidden `f.*` fields and are re-parsed there; one that cannot be read refuses the action rather than widening it.

Decision: RELEASE ALL refuses any non-empty `f.*` field. Its panel is on TOTALS, which no column filter can reach, so such a field is a form the server did not render; ignoring it would act on a set other than the one the sender saw.

- [ ] **Step 1: Failing tests** — append inside `describe('signAllPendingAction')` in `tests/actions/bulk-actions.test.ts`:

```ts
  it('signs only the pending cheques the column filters on screen admit', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const acme = await makeCheck({ status: 'SIGNATURE_PENDING', payeeName: 'ACME TRADING' })
    const other = await makeCheck({ status: 'SIGNATURE_PENDING', payeeName: 'HENKEL PHILIPPINES INC.' })
    const r = await signAllPendingAction(null, confirmFd(1, { 'f.payee': 'acme' }))
    expect(r).toMatchObject({ ok: true, succeeded: 1, failed: 0 })
    if (!r.ok) return
    expect(r.outcomes.map((o) => o.checkId)).toEqual([acme.id])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('refuses a column filter it cannot read rather than signing everything', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const r = await signAllPendingAction(null, confirmFd(1, { 'f.amountMin': '12x' }))
    expect(r).toMatchObject({ ok: false, message: 'The filter on screen was not recognised. Press SIGN ALL again and re-read the figures.' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SIGNATURE_PENDING')
    expect(await signedRows()).toBe(0)
  })
```

and inside `describe('releaseAllReadyAction')`:

```ts
  it('refuses a column filter, which its panel never sends', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const r = await releaseAllReadyAction(null, fd([], { confirm: 'release', expectedCount: '1', 'f.payee': 'henkel' }))
    expect(r).toMatchObject({ ok: false })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })
```

(Read the existing FINANCE_ADMIN release tests in that `describe` first; if they promote the user differently — e.g. by creating an admin with `makeUser('FINANCE_ADMIN')` and setting `currentUser.id` — do the same.)

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/actions/bulk-actions.test.ts -t "column filter"`.

- [ ] **Step 3: Implement.**

`app/checks/bulk-actions.ts`:
- Imports: `import { parseColumnFilters, F_PARAMS } from '@/lib/column-filters'`; add `type ColumnFilters` to the `@/lib/queries` import.
- After `readNarrowing`:

```ts
/**
 * The column filters SIGN ALL's confirm form wrote back (spec C2), parsed by
 * the SAME function the page used. One it cannot read → null → refuse: a
 * filter dropped here would sign every pending cheque instead of the few the
 * reader was looking at.
 */
function readColumnFilters(formData: FormData): ColumnFilters | null {
  const parsed = parseColumnFilters((name) => {
    const v = formData.get(name)
    return typeof v === 'string' ? v : undefined
  }, { statusApplies: false })
  return Object.keys(parsed.errors).length > 0 ? null : parsed.filters
}

const sentColumnFilter = (formData: FormData) =>
  F_PARAMS.some((p) => { const v = formData.get(p); return typeof v === 'string' && v.trim() !== '' })
```

- `ConfirmedAll`: `listIds: (narrow: SummaryNarrowing, columns: ColumnFilters) => Promise<string[]>` and

```ts
  /**
   * SIGN ALL's list can carry the filter row's boxes; RELEASE ALL's panel is
   * on TOTALS, which none can reach, so a box arriving there is refused.
   */
  acceptsColumnFilters: boolean
```

- In `runConfirmedAll`, replace `const checkIds = await spec.listIds(narrow)` with:

```ts
  let columns: ColumnFilters = {}
  if (spec.acceptsColumnFilters) {
    const read = readColumnFilters(formData)
    if (read === null) return { ok: false, message: messages.badFilter }
    columns = read
  } else if (sentColumnFilter(formData)) {
    return { ok: false, message: messages.badFilter }
  }
  const checkIds = await spec.listIds(narrow, columns)
```

- `releaseAllReadyAction`'s spec: `acceptsColumnFilters: false`, `listIds: (narrow) => listTodaysReleaseIds(prisma, narrow)`. `signAllPendingAction`'s: `acceptsColumnFilters: true`, `listIds: (narrow, columns) => listPendingSignatureIds(prisma, narrow, columns)`.

`components/ConfirmAllForm.tsx` — add the prop and render it after the three narrowing hidden fields:

```tsx
  /** SIGN ALL only: the filter row's `f.*` boxes on screen, re-parsed by the server. */
  columnParams?: Readonly<Record<string, string>>
…
            {Object.entries(columnParams ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
```

`app/page.tsx`:
- Imports: `columnParamsOf` from `@/lib/column-filters`; `columnFilterFields` from `@/lib/queries`.
- `const signAllOffered = status === 'SIGNATURE_PENDING' && !showAll && !q && !incomplete && !refused` — update its comment: "SIGN ALL is offered only when the rows shown are exactly the set it would act on: its set takes the column filters (part C2) but not the search, and nothing is listed while a box is refused."
- `getPendingSignature(prisma, narrow)` → `getPendingSignature(prisma, narrow, columnFilterFields(filters))`.
- `<ConfirmAllForm … columnParams={columnParamsOf(selection.base)} />`.

- [ ] **Step 4: Run** `node node_modules/vitest/vitest.mjs run tests/actions/bulk-actions.test.ts` → PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add app/checks/bulk-actions.ts components/ConfirmAllForm.tsx app/page.tsx tests/actions/bulk-actions.test.ts
git commit -m "feat(sign-all): honour the filter row; RELEASE ALL refuses a column filter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Export and print — same rows, same order, the viewer's columns

**Files:**
- Modify: `lib/export/workbook.ts` (`REGISTER_HEADERS` :30-33, `AMOUNT_COLUMN` :45, `ExportInput` :75-79, `buildRegisterSheet` :136-239, `writeTotals` :254-…)
- Modify: `app/api/export/route.ts`, `app/print/page.tsx`
- Create: `components/ExportLink.tsx`; Modify: `components/QuickActions.tsx`
- Test: `tests/export/workbook.test.ts`, `tests/export/route.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5, 6.
- Produces: `EXPORT_COLUMN_KEYS` (the 11 file columns, canonical order); `type ExportColumnKey`; `exportColumnOrder(cols: string | null | undefined): ExportColumnKey[]`; `REGISTER_HEADERS: readonly string[]` (derived); `ExportInput.columns?: readonly ExportColumnKey[]`; `ExportLink({ href, className, children })`.

Decision: `cols=` sets the ORDER of the file's columns, never its set. The columns the reader named come first in their order; every other file column follows in canonical order. A file that silently lacked AMOUNT because someone hid it on screen would be read as complete. ACTION and DATE RELEASED (not file columns) are ignored, as are unknown or repeated names; no `cols` is today's order.

Decision: the printed sheet follows the sort and the filters (it runs the same resolver and `listChecks`) but keeps its fixed paper columns: it is a release sheet carried to the vault, not a copy of the screen, and C3 names only the export.

Decision: a refused export answers `400` with `describeRefusal` as plain text and no file — a download of an empty workbook would read as "nothing matches".

Decision: EXPORT EXCEL appends `cols=` in the browser at click time (`ExportLink`), from the same `localStorage` value the table reads. The server never sees the preference otherwise; without JavaScript the link exports in the default order.

- [ ] **Step 1: Failing tests.**

Append to `tests/export/workbook.test.ts` (add `exportColumnOrder, EXPORT_COLUMN_KEYS` to the workbook import and `currencyNumberFormat` from `@/lib/export/report`):

```ts
describe('CHECK REGISTER — the viewer’s column order', () => {
  it('reads no cols as today’s order, and keeps every column whatever cols names', () => {
    expect(exportColumnOrder(null)).toEqual([...EXPORT_COLUMN_KEYS])
    expect(exportColumnOrder('status')).toHaveLength(EXPORT_COLUMN_KEYS.length)
    expect(exportColumnOrder('status')[0]).toBe('status')
  })

  it('ignores ACTION, DATE RELEASED, unknown and repeated names', () => {
    expect(exportColumnOrder('action,releasedAt,nope,amount,amount'))
      .toEqual(['amount', ...EXPORT_COLUMN_KEYS.filter((k) => k !== 'amount')])
  })

  it('writes header and cells in that order, with the amount still a formatted number', async () => {
    const ws = (await readBack(input({ columns: exportColumnOrder('amount,checkNumber') }))).getWorksheet(REGISTER_SHEET)!
    const header = ws.getRow(HEADER_ROW)
    expect([1, 2, 3].map((c) => header.getCell(c).value)).toEqual(['AMOUNT', 'CHECK NUMBER', 'APV NUMBER'])
    const r = ws.getRow(FIRST_DATA_ROW)
    expect(r.getCell(1).value).toBe(197715.42)
    expect(r.getCell(1).numFmt).toBe(currencyNumberFormat('PHP'))
    expect(r.getCell(2).value).toBe('6000240287')
  })

  it('writes the totals under AMOUNT wherever it stands, its label beside it when it is first', async () => {
    const ws = (await readBack(input({ columns: exportColumnOrder('amount') }))).getWorksheet(REGISTER_SHEET)!
    // One data row, one blank row, the count row, then the first currency row.
    const totalRow = ws.getRow(FIRST_DATA_ROW + 3)
    expect(totalRow.getCell(1).value).toBe(197715.42)
    expect(String(totalRow.getCell(2).value)).toMatch(/^TOTAL VALUE — PHP/)
  })
})
```

(Read `writeTotals` in the file first: the count row is at `FIRST_DATA_ROW + rows.length + 1` and the first currency row one below it — `FIRST_DATA_ROW + 3` for one row. If part B moved it, adjust the row, not the assertion.)

Append to `tests/export/route.test.ts`:

```ts
describe('GET /api/export — sort, filters, columns', () => {
  async function getWithCookie(url: string, cookie: string) {
    const { GET } = await import('@/app/api/export/route')
    return GET(new Request(url, { headers: { cookie } }))
  }
  const column1 = (ws: ExcelJS.Worksheet) => {
    const out: string[] = []
    for (let r = FIRST_DATA_ROW; r <= FIRST_DATA_ROW + 5; r++) {
      const v = ws.getRow(r).getCell(1).value
      if (typeof v === 'string' && /^\d/.test(v)) out.push(v)
    }
    return out
  }
  const seed = async () => {
    await makeCheck({ checkNumber: '6000000001', amount: '300.00', payeeName: 'HENKEL PHILIPPINES INC.' })
    await makeCheck({ checkNumber: '6000000002', amount: '100.00', payeeName: 'SHELL PILIPINAS CORP.' })
    await makeCheck({ checkNumber: '6000000003', amount: '200.00', payeeName: 'HENKEL PHILIPPINES INC.' })
  }

  it('sorts the file as the URL asks, across every matching cheque', async () => {
    await seed()
    const ws = (await sheetsFrom(await get('http://localhost/api/export?scope=all&sort=amount&dir=asc'))).getWorksheet(REGISTER_SHEET)!
    expect(column1(ws)).toEqual(['6000000002', '6000000003', '6000000001'])
  })

  it('falls back to the remembered sort when the URL names none', async () => {
    await seed()
    const res = await getWithCookie('http://localhost/api/export?scope=all', 'cm_sort=amount:desc')
    expect(column1((await sheetsFrom(res)).getWorksheet(REGISTER_SHEET)!)).toEqual(['6000000001', '6000000003', '6000000002'])
  })

  it('narrows by a column filter', async () => {
    await seed()
    const ws = (await sheetsFrom(await get('http://localhost/api/export?scope=all&f.payee=henk'))).getWorksheet(REGISTER_SHEET)!
    expect(column1(ws).sort()).toEqual(['6000000001', '6000000003'])
  })

  it('orders the columns as the screen does', async () => {
    await seed()
    const ws = (await sheetsFrom(await get('http://localhost/api/export?scope=all&cols=amount%2CcheckNumber'))).getWorksheet(REGISTER_SHEET)!
    expect(ws.getRow(HEADER_ROW).getCell(1).value).toBe('AMOUNT')
    expect(ws.getRow(HEADER_ROW).getCell(2).value).toBe('CHECK NUMBER')
  })

  it('refuses with 400 and no file when a filter cannot be read', async () => {
    await seed()
    const res = await get('http://localhost/api/export?scope=all&f.amountMin=12x')
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toContain('NOT AN AMOUNT')
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `node node_modules/vitest/vitest.mjs run tests/export/workbook.test.ts tests/export/route.test.ts`.

- [ ] **Step 3: Implement.**

`lib/export/workbook.ts`:
- Imports: `import { COLUMN_LABELS, type ColumnKey } from '../table-columns'`.
- Replace `REGISTER_HEADERS` and `AMOUNT_COLUMN` with:

```ts
/**
 * The file's columns, in their default order — the table's columns less ACTION
 * and DATE RELEASED. Since part C (2026-10-01) the viewer's on-screen order
 * reorders them (`cols=`), but never removes one: a file missing AMOUNT because
 * somebody hid it on screen would be read as complete.
 */
export const EXPORT_COLUMN_KEYS = [
  'checkNumber', 'apvNumbers', 'poNumbers', 'payeeName', 'companyCode', 'bank',
  'checkDate', 'amount', 'status', 'availablePickupDate', 'scheduledPickupDate',
] as const satisfies readonly ColumnKey[]
export type ExportColumnKey = (typeof EXPORT_COLUMN_KEYS)[number]

export const REGISTER_HEADERS: readonly string[] = EXPORT_COLUMN_KEYS.map((k) => COLUMN_LABELS[k])

/** The named columns first, in the order named; every other file column after, in default order. */
export function exportColumnOrder(cols: string | null | undefined): ExportColumnKey[] {
  const isExport = (k: string): k is ExportColumnKey => (EXPORT_COLUMN_KEYS as readonly string[]).includes(k)
  const named = [...new Set((cols ?? '').split(',').map((s) => s.trim()).filter(isExport))]
  return [...named, ...EXPORT_COLUMN_KEYS.filter((k) => !named.includes(k))]
}
```

- `ExportInput` gains `/** The column order (`exportColumnOrder`); default order when absent. */ columns?: readonly ExportColumnKey[]`.
- After `amountAsNumber`, add the per-column cell table:

```ts
type ExportCell = {
  kind: 'text' | 'date' | 'amount'
  value: (r: CheckTableRow) => ExcelJS.CellValue
  /** What the column's width is fitted to — the formatted figure for AMOUNT. */
  sample: (r: CheckTableRow) => string
}

const listOrNull = (xs: readonly string[]) => (xs.length ? xs.join(', ') : null)
const dateCell = (pick: (r: CheckTableRow) => Date | null): ExportCell =>
  ({ kind: 'date', value: pick, sample: (r) => (pick(r) ? DATE_WIDTH_SAMPLE : '') })

const EXPORT_CELLS: Record<ExportColumnKey, ExportCell> = {
  checkNumber: { kind: 'text', value: (r) => r.checkNumber, sample: (r) => r.checkNumber },
  apvNumbers: { kind: 'text', value: (r) => listOrNull(r.apvNumbers), sample: (r) => listOrNull(r.apvNumbers) ?? '' },
  poNumbers: { kind: 'text', value: (r) => listOrNull(r.poNumbers), sample: (r) => listOrNull(r.poNumbers) ?? '' },
  payeeName: { kind: 'text', value: (r) => r.payeeName, sample: (r) => r.payeeName ?? '' },
  companyCode: { kind: 'text', value: (r) => r.companyCode, sample: (r) => r.companyCode },
  bank: {
    kind: 'text',
    value: (r) => bankLabel(r.cashAccountCode, r.bankCode),
    sample: (r) => bankLabel(r.cashAccountCode, r.bankCode) ?? '',
  },
  checkDate: dateCell((r) => r.checkDate),
  // BLANK, never 0, when no amount was recorded — the existing comment on this moves here.
  amount: {
    kind: 'amount',
    value: (r) => (r.amount === null ? null : amountAsNumber(r.amount)),
    sample: (r) => (r.amount === null ? '' : formatMoney(r.amount, r.currency)),
  },
  status: { kind: 'text', value: (r) => statusWords(r.status), sample: (r) => statusWords(r.status) },
  availablePickupDate: dateCell((r) => r.availablePickupDate),
  scheduledPickupDate: dateCell((r) => r.scheduledPickupDate),
}
```

- In `buildRegisterSheet`, take `columns` from the input; replace everything from `const header = ws.getRow(HEADER_ROW)` to `writeTotals(ws, rows)` with:

```ts
  // Always a full order, whatever the caller passed: `exportColumnOrder` puts
  // back any column a partial list left out.
  const order = exportColumnOrder((columns ?? EXPORT_COLUMN_KEYS).join(','))
  const amountColumn = order.indexOf('amount') + 1

  const header = ws.getRow(HEADER_ROW)
  order.forEach((key, i) => {
    styleHeaderCell(header.getCell(i + 1), COLUMN_LABELS[key], key === 'amount' ? 'right' : 'left')
  })
  header.height = 20

  const widthSamples: string[][] = order.map(() => [])

  rows.forEach((r, i) => {
    const excelRow = ws.getRow(FIRST_DATA_ROW + i)
    order.forEach((key, c) => {
      const spec = EXPORT_CELLS[key]
      const cell = excelRow.getCell(c + 1)
      cell.value = spec.value(r)
      cell.border = {
        bottom: { style: 'thin', color: { argb: GRID } },
        left: { style: 'thin', color: { argb: GRID } },
        right: { style: 'thin', color: { argb: GRID } },
      }
      // Banded, so a wide row can be followed across the columns on paper.
      if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } }
      if (spec.kind === 'date') cell.numFmt = DATE_FORMAT
      if (spec.kind === 'amount') {
        cell.numFmt = currencyNumberFormat(r.currency)
        cell.alignment = { horizontal: 'right' }
      }
      widthSamples[c].push(spec.sample(r))
    })
  })

  order.forEach((key, i) => {
    ws.getColumn(i + 1).width = fitColumnWidth(COLUMN_LABELS[key], widthSamples[i])
  })

  ws.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to: { row: HEADER_ROW + rows.length, column: order.length },
  }

  writeTotals(ws, rows, amountColumn)
```

- `writeTotals(ws, rows, amountColumn: number)`: replace each `ws.mergeCells(r, 1, r, AMOUNT_COLUMN - 1)` with `mergeLabel(r)` and each `AMOUNT_COLUMN` with `amountColumn`; write the per-currency label into `ws.getCell(r, labelColumn)`; define at the top of the function:

```ts
  // The labels sit left of AMOUNT, merged across the columns before it — or,
  // when the reader put AMOUNT first, in the column right of it, unmerged.
  const labelColumn = amountColumn > 1 ? 1 : 2
  const mergeLabel = (row: number) => { if (amountColumn > 2) ws.mergeCells(row, 1, row, amountColumn - 1) }
```

  and set the per-currency label's alignment to `{ horizontal: amountColumn > 1 ? 'right' : 'left' }`. The count line stays in column 1.

`app/api/export/route.ts`:
- Imports: `import { SORT_COOKIE, readCookie } from '@/lib/list-sort'`; `import { describeRefusal } from '@/lib/column-filters'`; `exportColumnOrder` from `@/lib/export/workbook`; `type DashboardSearchParams` from `@/lib/dashboard-params`.
- Replace the `read` helper and the hand-picked object:

```ts
  const params = new URL(request.url).searchParams
  // The remembered order (part C4) arrives as a cookie on the download
  // request — same origin, SameSite=Lax — so the file is ordered as the
  // screen was even when the URL names no sort.
  const sortCookie = readCookie(request.headers.get('cookie'), SORT_COOKIE)

  const [options, settings] = await Promise.all([getFilterOptions(prisma), loadSettings(prisma)])

  // Every parameter the dashboard reads, through the dashboard's own resolver.
  // An unknown one is simply never read.
  // A cast, not a conversion: every value is a string, which is all the type claims.
  const query = resolveDashboardQuery(
    Object.fromEntries(params.entries()) as DashboardSearchParams, options, { sortCookie },
  )

  // A box the screen refused is refused here too — never a file of everything.
  if (query.refused) {
    return new Response(describeRefusal(query.filterErrors), {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
```

- `listChecks(prisma, query.filters, settings.values['caps.exportRows'])` → add `, query.sort`.
- `buildExportWorkbook({ …, columns: exportColumnOrder(params.get('cols')) })`.

`app/print/page.tsx`:
- Imports: `import { cookies } from 'next/headers'`; `import { SORT_COOKIE } from '@/lib/list-sort'`; `import { describeRefusal } from '@/lib/column-filters'`.
- `const sortCookie = (await cookies()).get(SORT_COOKIE)?.value`; `resolveDashboardQuery(params, options, { sortCookie })`; destructure `sort, refused, filterErrors`.
- `listChecks(prisma, filters, PRINT_ROW_LIMIT, sort)`.
- In the header block, after the truncation notice:

```tsx
        {refused && (
          // The sheet refuses with the screen: `buildWhere` has already
          // matched nothing, and this says why the sheet is empty.
          <p role="alert" className="mt-2 whitespace-pre-line text-xs font-semibold tracking-wide text-warning-ink">
            {describeRefusal(filterErrors)}
          </p>
        )}
```

`components/ExportLink.tsx`:

```tsx
'use client'

import type { ReactNode } from 'react'
import { COLUMN_STORAGE_KEY, DEFAULT_COLUMNS, parseColumnPreference, withColumnOrder } from '@/lib/table-columns'

/**
 * EXPORT EXCEL, in the viewer's column order (spec C3). The order lives only in
 * this browser's `localStorage`, so it is added to the link at click time.
 * Without JavaScript — or with storage blocked — the plain link exports in
 * the default order. A modified click (new tab, save link) is left alone.
 */
export function ExportLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        let order = DEFAULT_COLUMNS
        try {
          order = parseColumnPreference(window.localStorage.getItem(COLUMN_STORAGE_KEY)) ?? DEFAULT_COLUMNS
        } catch {
          // Blocked storage: the default order.
        }
        e.preventDefault()
        window.location.assign(withColumnOrder(href, order))
      }}
    >
      {children}
    </a>
  )
}
```

`components/QuickActions.tsx`: import `ExportLink`; replace the EXPORT `<a href={exportHref(selection)} className="…">EXPORT EXCEL</a>` with `<ExportLink href={exportHref(selection)} className="…same classes…">EXPORT EXCEL</ExportLink>`, keeping the comment above it.

- [ ] **Step 4: Run** `node node_modules/vitest/vitest.mjs run tests/export/workbook.test.ts tests/export/route.test.ts tests/export/dashboard-params.test.ts` → PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/export/workbook.ts app/api/export/route.ts app/print/page.tsx components/ExportLink.tsx components/QuickActions.tsx tests/export/workbook.test.ts tests/export/route.test.ts
git commit -m "feat(export): sort, filters and the viewer's column order; a refused export is a 400" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Verify, document, full suite, hand-off

**Files:** `CLAUDE.md`

- [ ] **Step 1: Build.** `node node_modules/next/dist/bin/next build` — must compile with no type or lint error (it type-checks client/server boundaries `tsc` does not: a value import of `@prisma/client` reaching a client component fails here). It does not need a database.

- [ ] **Step 2: Browser check (conditional).** The repo `.env` is production. If `.claude/launch.json` has no configuration that sets `DATABASE_URL` to the test URL, skip this step and say so in the hand-off; do not improvise one. If it exists: open `/?scope=all`; click AMOUNT twice (▲ then ▼) and confirm the order; reload `/?scope=all` and confirm ▼ is still on AMOUNT (cookie); type `henk` in SUPPLIER's box and confirm the list narrows without losing the caret; type `12x` in AMOUNT MIN and confirm the red message, the refusal banner and an empty table with the boxes still there; RESET and confirm the default order returns; in COLUMNS move AMOUNT left twice, press EXPORT EXCEL and confirm the request URL carries `cols=`. Screenshot the filter row and the refusal.

- [ ] **Step 3: CLAUDE.md.**
  - In "Things that will catch you out", the TOTALS/LIST paragraph: after "`scope=live` is …", add: "**Since 2026-10-0X (part C) a `sort`/`dir` pair and every `f.*` filter-row parameter are LIST parameters too** — `dashboardScreen` counts `selection.sort`, and the `f.*` values ride in `base`."
  - Add a new paragraph after the DATE RELEASED one: "**The list sorts, filters per column and reorders** (part C, spec `2026-10-01-signing-schedule-apv-and-table-design.md`). Sort: `sort=<column>&dir=asc|desc`, server-side over every matching cheque, nulls last both ways, `checkNumber` then `id` as tiebreaks; APV, PO, BANK and DATE RELEASED are ordered in `listChecks` in the app (`APP_SORTED_KEYS`, `lib/list-sort.ts`) because Prisma cannot. The `cm_sort` cookie (`<key>:<dir>`, a year, `SameSite=Lax`, written in the browser on a header click, deleted by RESET) applies when the URL names no sort; export and print read it. Filters: `lib/column-filters.ts`; COMPANY/BANK/DATE RELEASED keep their old names; APV/PO 'contains' is a raw `unnest … ILIKE` id step (`whereFor`, `lib/queries.ts`). **An unreadable box refuses**: `CheckFilters.refused` makes `buildWhere` match nothing, the raw value stays in `base`, the export answers 400, print and SIGN ALL refuse. DATE RELEASED now refuses a non-day too (it used to be dropped). SIGN ALL's set takes the column filters (re-parsed from hidden `f.*` fields); RELEASE ALL refuses any. The LIST's EXCLUDING N count is now the list's own (`countChecks({ ...filters, incomplete: true })`). Column order: the v2 `localStorage` array, now the visible columns in display order; ACTION last; a filtered column cannot be hidden; EXPORT EXCEL adds `cols=` (order only, every column still exported). Print keeps its fixed columns."
  - Layout table: add `lib/list-sort.ts` ("the list's order: params, cookie, database and in-app keys, pure") and `lib/column-filters.ts` ("the filter row's parameters, parsing, refusal, pure").
  - "State": leave the test count for Step 4.

- [ ] **Step 4: Full suite** (Bash, `run_in_background: true`, ONLY when the controller says the shared test database is free): `node node_modules/vitest/vitest.mjs run`. Expected: 0 failures. Record the measured count and duration in the State paragraph in the existing style ("**N tests across M files** (measured, full run 2026-10-0X, T minutes, 0 failures)…" with the per-file deltas of this plan: `list-sort` new, `column-filters` new, `queries` +, `dashboard-view` +, `dashboard-links` +1, `export/dashboard-params` +, `export/report` +2, `table-columns` rewritten +, `actions/bulk-actions` +3, `export/workbook` +4, `export/route` +5). A failure that passes alone straight after is recorded as such, as the file already does; any other failure is fixed before the commit.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: the list sorts, filters per column and reorders; suite count" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand-off note** (to the controller, not a file): the commits of this plan; whether Step 2 ran; the suite figure; and three things for the user: (1) a migration is NOT needed; (2) the first visit after deploy opens on the default order — nobody has a `cm_sort` cookie yet — and every saved column choice renders unchanged (v2 kept); (3) a bookmarked `?status=RELEASED&releasedFrom=<not a day>` now shows a refusal instead of an unfiltered list.
