# Two-screen Dashboard and Per-row OR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard opens on a TOTALS screen (cards, TODAY'S RELEASE, timeline, a search box). Any card, filter or search opens a full-width LIST screen with a BACK TO TOTALS bar. On the list, ticking a READY FOR RELEASE, SCHEDULED or RELEASED-without-OR row opens that row's own OR box. RELEASE releases each ticked cheque with its own receipt, and a new SAVE RECEIPTS records late receipts on ticked released cheques.

**Architecture:**
- The screen is a pure function of the URL: `dashboardScreen` in `lib/dashboard-view.ts`, which `app/page.tsx` branches on.
- Row receipts travel as keyed form fields (`orNumber:<checkId>`, `receiptType:<checkId>`):
  - read on the server by `readRowReceipts` (`lib/receipt-form.ts`)
  - built in the browser by the pure helpers in `lib/row-receipts.ts`
  - written only through the existing `markReleased` / `recordReceipt`, which stay the controls

**Tech Stack:** Next.js 15 App Router (server page and client table), Prisma 6, Vitest, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-25-dashboard-screens-and-row-receipts-design.md`

## Global Constraints

- **Rule 11:** a supplier receipt is written only to `orNumber` / `orDate` / `receiptType`, never to `crNumber`. Only `markReleased` and `recordReceipt` write receipts. `tests/actions/receipt.test.ts` must pass unchanged.
- Receipts are never overwritten. `recordReceipt` refuses an overwrite and stays the control; the tick box is a courtesy.
- RELEASE is FINANCE_ADMIN only, and the server re-checks the role. SAVE RECEIPTS is open to any signed-in Finance user, as `recordReceiptAction` is.
- Every bulk write goes through `parseSelection` with the `caps.bulkSelection` setting, and through `runEach` (one transaction per cheque; refusals reported per cheque with the domain's own sentence).
- A receipt number without an OR/CR type is refused: disabled in the browser, and refused again on the server before anything is written.
- The receipt DATE is not in the row. Receipts saved from the row carry no date.
- Screen rule: TOTALS when `status === null && !showAll && !incomplete && Object.keys(base).length === 0`, otherwise LIST.
- Export (`/api/export`) and print (`/print`) are not changed.
- Test runner: `node node_modules/vitest/vitest.mjs run <files>`. Type check: `npx.cmd tsc --noEmit`, which must be clean before every commit. Build check: `npx.cmd next build`. Run only the files named. The full suite takes about 20 minutes, and only one agent at a time may use the shared test DB.
- **Never run `npm run dev` or anything under `scripts/`: the local `.env` is PRODUCTION.**
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `lib/dashboard-view.ts` | modify | `dashboardScreen(sel)` |
| `app/page.tsx` | modify | branch into the TOTALS and LIST screens |
| `lib/queries.ts` | modify | `CheckTableRow` gains `orNumber`, `receiptType`, `hasReceipt` |
| `lib/row-receipts.ts` | create | pure, client-safe: field prefixes, tickable rule, which rows take a box, form entries |
| `lib/receipt-form.ts` | modify | `readRowReceipts(formData, checkIds)` |
| `app/checks/bulk-actions.ts` | modify | per-row receipts on RELEASE; new `bulkRecordReceiptsAction` |
| `components/CheckTable.tsx` | modify | new tick rule, OR column, per-row drafts |
| `components/BulkActionBar.tsx` | modify | actions on their own subsets; SAVE RECEIPTS; the single receipt box removed |
| `CLAUDE.md` | modify | state, test count |

---

### Task 1: `dashboardScreen`

**Files:**
- Modify: `lib/dashboard-view.ts` (append after `describeView`)
- Test: `tests/dashboard-view.test.ts`

**Interfaces:**
- Produces: `export type DashboardScreen = 'TOTALS' | 'LIST'` and `export function dashboardScreen(sel: DashboardSelection): DashboardScreen`.

- [ ] **Step 1: Write the failing test.** Add `dashboardScreen` to the file's import from `@/lib/dashboard-view` and append:

```ts
describe('dashboardScreen', () => {
  it('opens on TOTALS when nothing narrows the view', () => {
    expect(dashboardScreen(NOTHING)).toBe('TOTALS')
  })

  it('opens the LIST for a card, all cheques, the incomplete toggle, any filter, or a search', () => {
    expect(dashboardScreen({ ...NOTHING, status: 'SIGNED' })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, showAll: true })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, incomplete: true })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { company: 'c1' } })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { cashAccount: 'a1' } })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { eligibility: 'ELIGIBLE' } })).toBe('LIST')
    expect(dashboardScreen({ ...NOTHING, base: { q: '6000351234' } })).toBe('LIST')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails.** `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts` fails, because `dashboardScreen` is not exported.

- [ ] **Step 3: Implement.** Append to `lib/dashboard-view.ts`:

```ts
/**
 * Which of the dashboard's two screens a URL opens (client, 2026-09-25: "just
 * only show the totals. Once it is click, it will only the list so i can have
 * more space").
 *
 * The URL IS the screen. Every card, timeline node, search and filter already
 * writes one of these parameters, so each opens the LIST with no change of its
 * own. The browser's back button returns to the totals, and export and print,
 * which read the same URL, need to know nothing about screens. A bare `/` is
 * the TOTALS. `base` is only ever built from validated, non-empty values
 * (`resolveDashboardQuery`), so an empty search box does not count as a
 * filter.
 */
export type DashboardScreen = 'TOTALS' | 'LIST'

export function dashboardScreen(sel: DashboardSelection): DashboardScreen {
  const narrowed = sel.status !== null || sel.showAll || sel.incomplete || Object.keys(sel.base).length > 0
  return narrowed ? 'LIST' : 'TOTALS'
}
```

`resolveDashboardQuery` builds `base` with `.filter(([, v]) => v !== '')` (`lib/dashboard-params.ts:95-102`), so an empty value never reaches this function.

- [ ] **Step 4: Run it to confirm it passes.** The same command passes. Then run `npx.cmd tsc --noEmit`, which must be clean.

- [ ] **Step 5: Commit.**

```bash
git add lib/dashboard-view.ts tests/dashboard-view.test.ts
git commit -m "feat(dashboard): dashboardScreen - a bare URL is TOTALS, anything that narrows is LIST"
```

---

### Task 2: The two screens

**Files:**
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `dashboardScreen(selection)` from Task 1.

There is no test file for this task. The page is a server component, and its branching rule is Task 1's tested function. Verification is `tsc` and `next build`.

- [ ] **Step 1: Reorder the data loading.** In `DashboardPage`:
  - The first `Promise.all` loads only `getSummary`, `getFilterOptions` and `loadSettings`. `getTodaysRelease` moves out of it.
  - Then `resolveDashboardQuery(params, options)` runs as today. Keep its long comment.
  - Then `const screen = dashboardScreen(selection)`.
  - On **TOTALS**, load `getTodaysRelease(prisma)` and the sync overview (`getSyncOverview` + `describeStaleness`, exactly as today).
  - On **LIST**, load `listChecks` / `countChecks` as today.
  - Neither screen loads the other's data.

Code shape:

```tsx
  const [summary, options, settings] = await Promise.all([
    getSummary(prisma), getFilterOptions(prisma), loadSettings(prisma),
  ])
  const {
    q, status, companyId, cashAccountId, eligibility, incomplete, showAll, selection, filters,
  } = resolveDashboardQuery(params, options)
  const screen = dashboardScreen(selection)

  if (screen === 'TOTALS') {
    const [todaysRelease, syncOverview] = await Promise.all([
      getTodaysRelease(prisma),
      getSyncOverview(prisma, undefined, settings.values['sync.abandonedAfterMinutes']),
    ])
    const staleness = describeStaleness(/* exactly as today */)
    return ( /* TOTALS JSX, Step 2 */ )
  }

  const [rows, matching] = await Promise.all([listChecks(prisma, filters), countChecks(prisma, filters)])
  return ( /* LIST JSX, Step 3 */ )
```

Keep the existing explanatory comments with the code they explain. Update the file's header comment block ("THE ORDER OF THIS PAGE") with a short paragraph saying that since 2026-09-25 the page has two screens, why, and that `dashboardScreen` decides.

- [ ] **Step 2: The TOTALS JSX**, in this order inside the existing `<main className="mx-auto max-w-[1600px] space-y-6 p-8">`:
  - `<AppHeader user={user} title="CHECK RELEASE" />`
  - `<SyncStatusLine … />`
  - `<SummaryCards summary={summary} todaysRelease={todaysRelease} selection={selection} />`
  - `<TodaysReleasePanel … />`, with the same props as today
  - `<ReleaseTimeline summary={summary} selection={selection} />`
  - then the search box:

```tsx
      {/* Finding one cheque by its number is the commonest reason to open the
          list, so the totals keep one box for it. It submits to `/?q=…`, which
          `dashboardScreen` reads as the LIST. */}
      <form action="/" method="get" className="flex max-w-xl items-center gap-2" role="search">
        <label htmlFor="totals-search" className="sr-only">Search cheques</label>
        <input
          id="totals-search" name="q" type="search"
          placeholder="Search cheque no., payee, CV or AP voucher"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-lg bg-navy px-4 py-2 text-sm font-semibold tracking-wide text-white">
          SEARCH
        </button>
      </form>
```

Keep the existing comments that sit above `SummaryCards`, `TodaysReleasePanel` and `ReleaseTimeline`.

- [ ] **Step 3: The LIST JSX**, in this order:
  - `<AppHeader user={user} title="CHECK RELEASE" />`
  - the top bar below
  - the existing "EXCLUDING N CHEQUES …" disclosure paragraph (unchanged, with its comment)
  - `<FilterBar …/>` (unchanged)
  - the incomplete-only notice
  - the "SHOWING X OF Y" notice
  - `<CheckTable …/>` (unchanged props)

The top bar:

```tsx
      {/* The list gets the page (client, 2026-09-25): one slim bar says where
          you are and how to get back, and the export and print act on exactly
          what is listed below it. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 ring-1 ring-hairline">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/" className="text-sm font-semibold tracking-wide text-navy underline-offset-2 hover:underline">
            ← BACK TO TOTALS
          </Link>
          <span className="text-xs font-medium tracking-wide text-slate-600">
            {describeView(selection)} · {matching.toLocaleString('en-PH')} CHEQUE{matching === 1 ? '' : 'S'}
          </span>
        </div>
        <QuickActions selection={selection} />
      </div>
```

The old "VIEWING: …" line and the old `QuickActions` row are replaced by this bar. Their disclosure paragraph moves under it unchanged.

- [ ] **Step 4: Verify.** `npx.cmd tsc --noEmit` must be clean. `npx.cmd next build` must complete, with `/` as a dynamic route (ƒ). Grep `app/page.tsx` to confirm `getTodaysRelease` is called only in the TOTALS branch, and `listChecks` / `countChecks` only in the LIST branch.

- [ ] **Step 5: Commit.**

```bash
git add app/page.tsx
git commit -m "feat(dashboard): two screens - totals by default, the full-width list once a view is chosen"
```

---

### Task 3: The row carries its receipt

**Files:**
- Modify: `lib/queries.ts` (`CheckTableRow` at about line 456, `toTableRow` at about line 482)
- Test: `tests/queries.test.ts` (`describe('toTableRow')`)

**Interfaces:**
- Produces: `CheckTableRow.orNumber: string | null`, `CheckTableRow.receiptType: 'OR' | 'CR' | null`, `CheckTableRow.hasReceipt: boolean`.

- [ ] **Step 1: Write the failing test.** Add inside `describe('toTableRow', …)`:

```ts
  it('carries the supplier receipt, and says whether one is recorded', async () => {
    const withReceipt = await makeCheck({ status: 'RELEASED' })
    await testDb.check.update({ where: { id: withReceipt.id }, data: { orNumber: 'OR-000123', receiptType: 'OR' } })
    await makeCheck({ status: 'RELEASED' })

    const rows = (await listChecks(testDb, { statusIn: ['RELEASED'] })).map(toTableRow)
    const a = rows.find((r) => r.id === withReceipt.id)!
    const b = rows.find((r) => r.id !== withReceipt.id)!

    expect(a).toMatchObject({ orNumber: 'OR-000123', receiptType: 'OR', hasReceipt: true })
    expect(b).toMatchObject({ orNumber: null, receiptType: null, hasReceipt: false })
  })
```

- [ ] **Step 2: Run it to confirm it fails.** `node node_modules/vitest/vitest.mjs run tests/queries.test.ts -t "carries the supplier receipt"` fails.

- [ ] **Step 3: Implement.** Add to `CheckTableRow`:

```ts
  /**
   * The supplier's receipt (rule 11: never `crNumber`). Shown in the OR column,
   * and `hasReceipt` decides whether a RELEASED row may be ticked to add one:
   * a receipt is never overwritten.
   */
  orNumber: string | null
  receiptType: 'OR' | 'CR' | null
  hasReceipt: boolean
```

Add to `toTableRow`:

```ts
    orNumber: r.orNumber,
    receiptType: r.receiptType,
    hasReceipt: r.orNumber !== null,
```

- [ ] **Step 4: Run it to confirm it passes.** Run `node node_modules/vitest/vitest.mjs run tests/queries.test.ts`; the whole file must pass, including the JSON-serialisable check. Then `npx.cmd tsc --noEmit` must be clean.

- [ ] **Step 5: Commit.**

```bash
git add lib/queries.ts tests/queries.test.ts
git commit -m "feat(queries): the table row carries its supplier receipt"
```

---

### Task 4: Row receipts, pure, for both ends

**Files:**
- Create: `lib/row-receipts.ts`
- Modify: `lib/receipt-form.ts`
- Test: `tests/row-receipts.test.ts` (new), `tests/receipt-form.test.ts` (new)

**Interfaces:**
- Produces, in `lib/row-receipts.ts` (client-safe; imports only `lib/domain/check-status` and `lib/domain/receipt`):
  - `ROW_OR_NUMBER = 'orNumber:'`, `ROW_RECEIPT_TYPE = 'receiptType:'`
  - `type ReceiptDraft = { orNumber: string; receiptType: ReceiptType | '' }`, `EMPTY_DRAFT`
  - `type RowFacts = { id: string; isCheque: boolean; status: CheckStatus; hasReceipt: boolean }`
  - `isTickable(r: RowFacts): boolean`
  - `takesReceipt(r: RowFacts): boolean`
  - `liveIds(rows: RowFacts[]): string[]`
  - `releasedIds(rows: RowFacts[]): string[]`
  - `draftTypeMissing(d: ReceiptDraft): boolean`
  - `receiptEntries(ids: readonly string[], drafts: Readonly<Record<string, ReceiptDraft>>): [string, string][]`
- Produces, in `lib/receipt-form.ts`:
  - `type RowReceipt = { orNumber: string; receiptType: ReceiptType }`
  - `readRowReceipts(formData: FormData, checkIds: readonly string[]): { ok: true; receipts: Map<string, RowReceipt> } | { ok: false; message: string }`

- [ ] **Step 1: Write the failing tests.**

`tests/row-receipts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  isTickable, takesReceipt, liveIds, releasedIds, draftTypeMissing, receiptEntries,
  EMPTY_DRAFT, type RowFacts,
} from '@/lib/row-receipts'

const row = (o: Partial<RowFacts> = {}): RowFacts => ({ id: 'x', isCheque: true, status: 'SIGNED', hasReceipt: false, ...o })

describe('isTickable', () => {
  it('ticks a live cheque, and a released one that has no receipt yet', () => {
    for (const status of ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const) {
      expect(isTickable(row({ status })), status).toBe(true)
    }
    expect(isTickable(row({ status: 'RELEASED' }))).toBe(true)
  })

  it('never ticks a released cheque with a receipt, a closed one, or a non-cheque', () => {
    expect(isTickable(row({ status: 'RELEASED', hasReceipt: true }))).toBe(false)
    expect(isTickable(row({ status: 'CANCELLED' }))).toBe(false)
    expect(isTickable(row({ status: 'VOIDED' }))).toBe(false)
    expect(isTickable(row({ isCheque: false }))).toBe(false)
  })
})

describe('takesReceipt', () => {
  it('opens a box only where a receipt can exist: ready, scheduled, released without one', () => {
    expect(takesReceipt(row({ status: 'READY_FOR_RELEASE' }))).toBe(true)
    expect(takesReceipt(row({ status: 'SCHEDULED' }))).toBe(true)
    expect(takesReceipt(row({ status: 'RELEASED' }))).toBe(true)
    expect(takesReceipt(row({ status: 'RELEASED', hasReceipt: true }))).toBe(false)
    expect(takesReceipt(row({ status: 'SIGNED' }))).toBe(false)
    expect(takesReceipt(row({ status: 'SIGNATURE_PENDING' }))).toBe(false)
  })
})

describe('liveIds / releasedIds', () => {
  it('splits a selection by what each action may act on', () => {
    const rows = [row({ id: 'a', status: 'SIGNED' }), row({ id: 'b', status: 'READY_FOR_RELEASE' }), row({ id: 'c', status: 'RELEASED' })]
    expect(liveIds(rows)).toEqual(['a', 'b'])
    expect(releasedIds(rows)).toEqual(['c'])
  })
})

describe('draftTypeMissing', () => {
  it('is true only when a reference is typed with no OR/CR', () => {
    expect(draftTypeMissing(EMPTY_DRAFT)).toBe(false)
    expect(draftTypeMissing({ orNumber: '4471', receiptType: '' })).toBe(true)
    expect(draftTypeMissing({ orNumber: '  ', receiptType: '' })).toBe(false)
    expect(draftTypeMissing({ orNumber: '4471', receiptType: 'CR' })).toBe(false)
  })
})

describe('receiptEntries', () => {
  it('keys each typed receipt to its own cheque, and sends nothing for a blank box or an unlisted id', () => {
    const drafts = {
      a: { orNumber: ' OR-1 ', receiptType: 'OR' as const },
      b: EMPTY_DRAFT,
      z: { orNumber: 'CR 9', receiptType: 'CR' as const },
    }
    expect(receiptEntries(['a', 'b'], drafts)).toEqual([['orNumber:a', 'OR-1'], ['receiptType:a', 'OR']])
  })
})
```

`tests/receipt-form.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readRowReceipts } from '@/lib/receipt-form'

const form = (entries: [string, string][]) => {
  const f = new FormData()
  for (const [k, v] of entries) f.append(k, v)
  return f
}

describe('readRowReceipts', () => {
  it('reads one receipt per keyed row and omits a blank box', () => {
    const r = readRowReceipts(form([
      ['orNumber:a', ' OR-000123 '], ['receiptType:a', 'OR'],
      ['orNumber:b', 'CR 88'], ['receiptType:b', 'CR'],
      ['orNumber:c', ''], ['receiptType:c', ''],
    ]), ['a', 'b', 'c'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([...r.receipts]).toEqual([
      ['a', { orNumber: 'OR-000123', receiptType: 'OR' }],
      ['b', { orNumber: 'CR 88', receiptType: 'CR' }],
    ])
  })

  it('ignores a type chosen with no reference typed', () => {
    const r = readRowReceipts(form([['receiptType:a', 'OR']]), ['a'])
    expect(r.ok && r.receipts.size).toBe(0)
  })

  it('refuses a reference with no OR/CR, and nothing is read', () => {
    const r = readRowReceipts(form([['orNumber:a', '4471']]), ['a'])
    expect(r).toEqual({ ok: false, message: 'Choose OR or CR for every receipt reference you typed. Nothing was saved.' })
  })

  it('refuses a type that is neither OR nor CR', () => {
    expect(readRowReceipts(form([['orNumber:a', 'X'], ['receiptType:a', 'CRN']]), ['a']))
      .toEqual({ ok: false, message: 'Invalid receipt type.' })
  })

  it('refuses a receipt keyed to a cheque that is not ticked', () => {
    const r = readRowReceipts(form([['orNumber:z', 'OR-1'], ['receiptType:z', 'OR']]), ['a'])
    expect(r).toEqual({ ok: false, message: 'A receipt was sent for a cheque that is not ticked. Nothing was saved.' })
  })

  it('refuses the old single-box fields rather than silently dropping a typed receipt', () => {
    const r = readRowReceipts(form([['orNumber', 'OR-1'], ['receiptType', 'OR']]), ['a'])
    expect(r).toEqual({ ok: false, message: 'This page is out of date. Reload it and type the receipt in the row.' })
  })
})
```

- [ ] **Step 2: Run them to confirm they fail.** `node node_modules/vitest/vitest.mjs run tests/row-receipts.test.ts tests/receipt-form.test.ts` fails, because the module and export are missing.

- [ ] **Step 3: Implement.** Create `lib/row-receipts.ts`:

```ts
import { isLiveStatus, type CheckStatus } from '@/lib/domain/check-status'
import type { ReceiptType } from '@/lib/domain/receipt'

/**
 * THE OR BOX ON A TICKED ROW (client, 2026-09-25: "Once the box was clicked the
 * box for the OR part will be fillable").
 *
 * Pure and client-safe: the table uses it to decide what to draw, and the
 * server's `readRowReceipts` shares the field names. Every box belongs to one
 * row, and that is what makes a receipt typed in a batch safe. The old rule
 * refusing one box for several cheques existed because a single box had no
 * owner; a box per row always has one.
 *
 * Presentation, not a control: `markReleased` and `recordReceipt` re-decide
 * everything on the server (rule 11, no overwrite, released only).
 */

export const ROW_OR_NUMBER = 'orNumber:'
export const ROW_RECEIPT_TYPE = 'receiptType:'

export type ReceiptDraft = { orNumber: string; receiptType: ReceiptType | '' }
export const EMPTY_DRAFT: ReceiptDraft = { orNumber: '', receiptType: '' }

export type RowFacts = { id: string; isCheque: boolean; status: CheckStatus; hasReceipt: boolean }

const releasedWithoutReceipt = (r: RowFacts) => r.status === 'RELEASED' && !r.hasReceipt

/** A live cheque, as before, or a released one still waiting for its receipt. */
export function isTickable(r: RowFacts): boolean {
  return r.isCheque && (isLiveStatus(r.status) || releasedWithoutReceipt(r))
}

/** Only where a supplier's receipt can exist: at the counter, or after it. */
export function takesReceipt(r: RowFacts): boolean {
  return r.status === 'READY_FOR_RELEASE' || r.status === 'SCHEDULED' || releasedWithoutReceipt(r)
}

/** The ticked rows SIGN / READY / RELEASE act on: the live ones, as before. */
export function liveIds(rows: readonly RowFacts[]): string[] {
  return rows.filter((r) => isLiveStatus(r.status)).map((r) => r.id)
}

/** The ticked rows SAVE RECEIPTS acts on. */
export function releasedIds(rows: readonly RowFacts[]): string[] {
  return rows.filter((r) => r.status === 'RELEASED').map((r) => r.id)
}

export function draftTypeMissing(d: ReceiptDraft): boolean {
  return d.orNumber.trim() !== '' && d.receiptType === ''
}

/** The keyed form fields for the given ids' typed receipts; a blank box sends nothing. */
export function receiptEntries(
  ids: readonly string[], drafts: Readonly<Record<string, ReceiptDraft>>,
): [string, string][] {
  const out: [string, string][] = []
  for (const id of ids) {
    const d = drafts[id]
    if (!d || d.orNumber.trim() === '') continue
    out.push([ROW_OR_NUMBER + id, d.orNumber.trim()], [ROW_RECEIPT_TYPE + id, d.receiptType])
  }
  return out
}
```

Check that `lib/domain/check-status.ts` exports the `CheckStatus` type. If it does not, import it with `import type { CheckStatus } from '@prisma/client'`.

In `lib/receipt-form.ts`, add the import `import { ROW_OR_NUMBER, ROW_RECEIPT_TYPE } from './row-receipts'` and append:

```ts
export type RowReceipt = { orNumber: string; receiptType: ReceiptType }

export type RowReceiptsResult =
  | { ok: true; receipts: Map<string, RowReceipt> }
  | { ok: false; message: string }

/**
 * One receipt per ticked row, keyed `orNumber:<checkId>` / `receiptType:<checkId>`
 * (lib/row-receipts.ts). Refused whole, before anything is written, if any row
 * is malformed. A batch half-saved over a typo is worse than none saved and the
 * box still showing what was typed.
 *
 * A key for a cheque that is not in the ticked selection is refused rather
 * than ignored. So are the old single-box fields, which a page loaded before
 * this change would still send: dropping them silently would lose a receipt
 * somebody typed.
 */
export function readRowReceipts(formData: FormData, checkIds: readonly string[]): RowReceiptsResult {
  if (str(formData, 'orNumber') !== '' || str(formData, 'receiptType') !== '') {
    return { ok: false, message: 'This page is out of date. Reload it and type the receipt in the row.' }
  }
  const ticked = new Set(checkIds)
  for (const key of formData.keys()) {
    for (const prefix of [ROW_OR_NUMBER, ROW_RECEIPT_TYPE]) {
      if (key.startsWith(prefix) && !ticked.has(key.slice(prefix.length))) {
        return { ok: false, message: 'A receipt was sent for a cheque that is not ticked. Nothing was saved.' }
      }
    }
  }
  const receipts = new Map<string, RowReceipt>()
  for (const id of checkIds) {
    const orNumber = str(formData, ROW_OR_NUMBER + id)
    if (orNumber === '') continue
    const raw = str(formData, ROW_RECEIPT_TYPE + id)
    if (raw === '') {
      return { ok: false, message: 'Choose OR or CR for every receipt reference you typed. Nothing was saved.' }
    }
    const parsed = receiptTypeSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid receipt type.' }
    receipts.set(id, { orNumber, receiptType: parsed.data })
  }
  return { ok: true, receipts }
}
```

- [ ] **Step 4: Run them to confirm they pass.** The same command passes. Then `npx.cmd tsc --noEmit` must be clean.

- [ ] **Step 5: Commit.**

```bash
git add lib/row-receipts.ts lib/receipt-form.ts tests/row-receipts.test.ts tests/receipt-form.test.ts
git commit -m "feat(receipts): an OR box per ticked row - the rules, and reading them off the wire"
```

---

### Task 5: The server actions

**Files:**
- Modify: `app/checks/bulk-actions.ts` (the imports; `bulkReleaseAction` and its comment, at about lines 83–139; a new action after it)
- Test: `tests/actions/bulk-actions.test.ts` (`describe('bulkReleaseAction')` receipt cases at about lines 250–345; a new `describe`)

**Interfaces:**
- Consumes: `readRowReceipts` (Task 4); `markReleased`, `recordReceipt` from `@/lib/domain/actions`.
- Produces: `bulkRecordReceiptsAction(formData: FormData): Promise<BulkActionResult>`. `bulkReleaseAction` keeps its signature and now reads keyed receipts.

- [ ] **Step 1: Rewrite the receipt tests (failing).** In `describe('bulkReleaseAction')`:
  - Replace the cases `'records the receipt when exactly one cheque is ticked'`, `'refuses a receipt typed against more than one ticked cheque, …'`, `'refuses a reference with no type chosen, …'` and `'rejects a receipt type that is neither OR nor CR'` with the cases below.
  - Keep `'releases a batch with no receipt at all'` and every non-receipt case as they are.
  - Add a `const rk = (id: string, orNumber: string, receiptType: string) => ({ [\`orNumber:${id}\`]: orNumber, [\`receiptType:${id}\`]: receiptType })` helper beside `fd`.

```ts
  it('releases each ticked cheque with its OWN receipt, a blank box with none, and never touches crNumber', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const b = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const c = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await bulkReleaseAction(fd([a.id, b.id, c.id], {
      ...rk(a.id, 'OR-000123', 'OR'), ...rk(b.id, 'CR 88', 'CR'), ...rk(c.id, '', ''),
    }))

    expect(result.ok && result.succeeded).toBe(3)
    const [ra, rb, rc] = await Promise.all([a, b, c].map((x) => testDb.check.findUniqueOrThrow({ where: { id: x.id } })))
    expect(ra).toMatchObject({ status: 'RELEASED', orNumber: 'OR-000123', receiptType: 'OR', crNumber: null, clearingStatus: 'NONE' })
    expect(rb).toMatchObject({ status: 'RELEASED', orNumber: 'CR 88', receiptType: 'CR', crNumber: null })
    expect(rc).toMatchObject({ status: 'RELEASED', orNumber: null, receiptType: null, crNumber: null })
  })

  it('refuses a reference with no OR/CR before releasing anything', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const b = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await bulkReleaseAction(fd([a.id, b.id], { [`orNumber:${a.id}`]: '4471' }))

    expect(result).toEqual({ ok: false, message: 'Choose OR or CR for every receipt reference you typed. Nothing was saved.' })
    for (const id of [a.id, b.id]) {
      expect((await testDb.check.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_RELEASE')
    }
  })

  it('rejects a receipt type that is neither OR nor CR', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await bulkReleaseAction(fd([a.id], rk(a.id, 'X', 'CRN')))
    expect(result).toEqual({ ok: false, message: 'Invalid receipt type.' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })

  it('refuses a receipt keyed to a cheque that is not ticked', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const other = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await bulkReleaseAction(fd([a.id], rk(other.id, 'OR-1', 'OR')))
    expect(result.ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })
```

Append a new `describe`:

```ts
describe('bulkRecordReceiptsAction', () => {
  it('records each typed receipt on its own released cheque, skips blanks, and any Finance user may', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'RELEASED' })
    const b = await makeCheck({ status: 'RELEASED' })
    const blank = await makeCheck({ status: 'RELEASED' })

    const result = await bulkRecordReceiptsAction(fd([a.id, b.id, blank.id], {
      ...rk(a.id, 'OR-000123', 'OR'), ...rk(b.id, 'CR 88', 'CR'), ...rk(blank.id, '', ''),
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.outcomes.map((o) => o.checkId).sort()).toEqual([a.id, b.id].sort())
    expect(await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ orNumber: 'OR-000123', receiptType: 'OR', crNumber: null })
    expect(await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ orNumber: 'CR 88', receiptType: 'CR', crNumber: null })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: blank.id } })).orNumber).toBeNull()
  })

  it('refuses by name a cheque that already has a receipt, and saves the rest', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const done = await makeCheck({ status: 'RELEASED' })
    await testDb.check.update({ where: { id: done.id }, data: { orNumber: 'OR-OLD', receiptType: 'OR' } })
    const fresh = await makeCheck({ status: 'RELEASED' })

    const result = await bulkRecordReceiptsAction(fd([done.id, fresh.id], {
      ...rk(done.id, 'OR-NEW', 'OR'), ...rk(fresh.id, 'OR-2', 'OR'),
    }))

    expect(result.ok && result.succeeded).toBe(1)
    expect(outcomeFor(result, done.id).ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: done.id } })).orNumber).toBe('OR-OLD')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: fresh.id } })).orNumber).toBe('OR-2')
  })

  it('refuses a cheque that is not released', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await bulkRecordReceiptsAction(fd([ready.id], rk(ready.id, 'OR-1', 'OR')))
    expect(result.ok && result.succeeded).toBe(0)
    expect(outcomeFor(result, ready.id).ok).toBe(false)
  })

  it('refuses when nothing was typed', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'RELEASED' })
    expect(await bulkRecordReceiptsAction(fd([a.id])))
      .toEqual({ ok: false, message: 'Type a receipt reference on at least one ticked cheque before saving.' })
  })

  it('holds the bulk cap', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const tooMany = Array.from({ length: MAX_BULK_SELECTION + 1 }, (_, i) => `id-${i}`)
    expect((await bulkRecordReceiptsAction(fd(tooMany))).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to confirm they fail.** `node node_modules/vitest/vitest.mjs run tests/actions/bulk-actions.test.ts` fails: the new cases fail, and `bulkRecordReceiptsAction` is not exported.

- [ ] **Step 3: Implement** in `app/checks/bulk-actions.ts`:
  - Change the imports:
    - `import { markSigned, markReadyForRelease, markReleased, recordReceipt } from '@/lib/domain/actions'`
    - `import { readRowReceipts } from '@/lib/receipt-form'`, dropping `readReceiptFields` and `receiptWasTyped` if nothing else here uses them.
  - Replace the body of `bulkReleaseAction` after the selection is parsed:

```ts
  const read = readRowReceipts(formData, selection.checkIds)
  if (!read.ok) return { ok: false, message: read.message }

  const now = new Date()
  return runEach(prisma, selection.checkIds, (checkId) => {
    const receipt = read.receipts.get(checkId)
    return markReleased(prisma, {
      checkId, userId: user.id, now,
      orNumber: receipt?.orNumber, orDate: undefined, receiptType: receipt?.receiptType ?? null,
    })
  })
```

  - Replace the comment section "THE RECEIPT BOX, AND WHY IT IS ONE CHEQUE ONLY" with one that explains:
    - since 2026-09-25 every ticked row has its own box (`lib/row-receipts.ts`), so each receipt has exactly one owner
    - the old refusal of one box for a batch is therefore replaced, not loosened
    - a receipt keyed to an unticked cheque, a number without a type, and the old unkeyed fields are all refused before anything is released
    - an empty box releases as before, which RELEASE ALL depends on

  - Add after `bulkReleaseAction`:

```ts
/**
 * SAVE RECEIPTS — the late receipts, typed in the rows of ticked RELEASED
 * cheques (client, 2026-09-25: "i dont need to click the checks").
 *
 * Open to any signed-in Finance user, like `recordReceiptAction`: it records a
 * reference against a hand-over that already happened, moves no status and
 * cannot overwrite a receipt (`recordReceipt` refuses). Rows left blank are not
 * sent to the domain at all. Each typed row is its own transaction, so one
 * refusal — released by nobody, receipt added a moment ago — names that cheque
 * and the rest still save.
 */
export async function bulkRecordReceiptsAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const selection = parseSelection(ids(formData), settings.values['caps.bulkSelection'])
  if (!selection.ok) return { ok: false, message: selection.message }

  const read = readRowReceipts(formData, selection.checkIds)
  if (!read.ok) return { ok: false, message: read.message }

  const typed = selection.checkIds.filter((id) => read.receipts.has(id))
  if (typed.length === 0) {
    return { ok: false, message: 'Type a receipt reference on at least one ticked cheque before saving.' }
  }

  const now = new Date()
  return runEach(prisma, typed, (checkId) => {
    const receipt = read.receipts.get(checkId)!
    return recordReceipt(prisma, {
      checkId, userId: user.id, orNumber: receipt.orNumber, receiptType: receipt.receiptType, now,
    })
  })
}
```

- [ ] **Step 4: Run them to confirm they pass.** Run `node node_modules/vitest/vitest.mjs run tests/actions/bulk-actions.test.ts tests/actions/receipt.test.ts`; both files must pass, and `receipt.test.ts` is unchanged. Then `npx.cmd tsc --noEmit` must be clean. Between this task and Task 6, the bar still sends the old single-box fields, and the server now refuses them with "out of date". That is expected, and Task 6 removes them.

- [ ] **Step 5: Commit.**

```bash
git add app/checks/bulk-actions.ts tests/actions/bulk-actions.test.ts
git commit -m "feat(actions): RELEASE with a receipt per row; SAVE RECEIPTS for released cheques"
```

---

### Task 6: The table and the bar

**Files:**
- Modify: `components/CheckTable.tsx`
- Modify: `components/BulkActionBar.tsx`

**Interfaces:**
- Consumes: the `lib/row-receipts.ts` helpers (Task 4); `CheckTableRow.orNumber`, `receiptType` and `hasReceipt` (Task 3); `bulkRecordReceiptsAction` (Task 5).
- `BulkActionBar` props become `{ selectedRows: RowFacts[]; drafts: Readonly<Record<string, ReceiptDraft>>; canRelease: boolean; cap: number; onDone: () => void }`.

There is no new test file here: every decision is a Task 4 pure function or a Task 5 action. Verification is `tsc` and `next build`.

- [ ] **Step 1: CheckTable.**
  - Replace `const selectable = (r) => r.isCheque && isLiveStatus(r.status)` with `isTickable` from `@/lib/row-receipts`, and update its comment: RELEASED rows without a receipt are tickable so a late receipt can be typed in the row.
  - Add state `const [drafts, setDrafts] = useState<Record<string, ReceiptDraft>>({})`.
  - `toggle(id)`: when a row is unticked, delete its draft. When selection clears (`onDone`), reset `drafts` to `{}`. `toggleAll` clears drafts when unselecting all.
  - Add a header cell `<th className="px-4 py-3">OR / CR</th>` immediately before the ACTION header. This column is not in `COLUMN_KEYS`: it is always shown.
  - Add the matching body cell before the ACTION cell:

```tsx
                {/* The supplier's receipt. A ticked row that can carry one gets
                    its own box, which is what lets a batch carry receipts safely:
                    every reference has exactly one cheque. Keys and clicks stop
                    here so typing never opens the cheque (the row navigates on
                    click and on Enter). */}
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  {selected.has(r.id) && takesReceipt(r) ? (
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Receipt type for check ${r.checkNumber}`}
                        value={(drafts[r.id] ?? EMPTY_DRAFT).receiptType}
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...(d[r.id] ?? EMPTY_DRAFT), receiptType: e.target.value as ReceiptDraft['receiptType'] } }))}
                        className={`rounded-lg border px-2 py-1 text-sm ${draftTypeMissing(drafts[r.id] ?? EMPTY_DRAFT) ? 'border-amber-500' : 'border-slate-300'}`}
                      >
                        <option value="">OR / CR</option>
                        {RECEIPT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input
                        aria-label={`Receipt reference for check ${r.checkNumber}`}
                        value={(drafts[r.id] ?? EMPTY_DRAFT).orNumber}
                        placeholder="Reference"
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: { ...(d[r.id] ?? EMPTY_DRAFT), orNumber: e.target.value } }))}
                        className="w-32 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                  ) : r.orNumber ? (
                    <span>{r.orNumber} <span className="text-xs text-slate-500">({r.receiptType ?? '?'})</span></span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
```

  - Import `RECEIPT_TYPES` from `@/lib/domain/receipt`.
  - Replace the `BulkActionBar` render with:

```tsx
      {selectedIds.length > 0 && (
        <BulkActionBar
          selectedRows={rows.filter((r) => selected.has(r.id))}
          drafts={drafts}
          canRelease={canRelease}
          cap={bulkCap}
          onDone={() => { setSelected(new Set()); setDrafts({}) }}
        />
      )}
```

- [ ] **Step 2: BulkActionBar.**
  - Remove: the `ReceiptFields` import and the single receipt box, the `single` / `receipt` / `typeMissing` state, the "A RECEIPT REFERENCE BELONGS TO ONE CHEQUE" note, and the `receiptPending` offer with its link. The late receipt is now typed in the row itself.
  - Compute:

```ts
  const live = liveIds(selectedRows)
  const released = releasedIds(selectedRows)
  const total = selectedRows.length
  const overCap = total > cap
  const disabled = pending || overCap
  const missingType = selectedRows.some((r) => draftTypeMissing(drafts[r.id] ?? EMPTY_DRAFT))
  const releasedTyped = receiptEntries(released, drafts).length > 0
```

  - `submit(action, ids, extra)` appends `checkId` for **the given ids only**, then `extra` entries (an array of `[k, v]`).
  - MARK SIGNED, MARK READY FOR RELEASE and MARK RELEASED send `live`, and are disabled when `live.length === 0`.
  - MARK RELEASED also sends `receiptEntries(live, drafts)` and is disabled while `missingType`.
  - Its confirm text: `Mark ${live.length} cheque(s) RELEASED? …`, plus `${n} with a supplier receipt` when entries exist.
  - Add, visible whenever `released.length > 0`:

```tsx
        <button
          type="button" disabled={disabled || missingType || !releasedTyped}
          onClick={() => submit(bulkRecordReceiptsAction, released, receiptEntries(released, drafts))}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          SAVE RECEIPTS
        </button>
```

  - Under the buttons:
    - when `missingType`: `<p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Choose OR or CR for every receipt reference you typed.</p>`
    - when `released.length > 0`: a one-line hint that ticked released cheques take their receipt in the OR / CR column and SAVE RECEIPTS records the ones typed
  - `{checkIds.length} SELECTED` becomes `{total} SELECTED`. The over-cap message uses `total`. Keep the result and failure rendering as it is.
  - Update the component's header comment: actions act on their own subset; each ticked row carries its own receipt box.

- [ ] **Step 3: Verify.** `npx.cmd tsc --noEmit` must be clean. `npx.cmd next build` must complete. Run `node node_modules/vitest/vitest.mjs run tests/row-receipts.test.ts tests/actions/bulk-actions.test.ts`, which must pass.

- [ ] **Step 4: Commit.**

```bash
git add components/CheckTable.tsx components/BulkActionBar.tsx
git commit -m "feat(table): tick a row to type its OR - RELEASE and SAVE RECEIPTS carry one receipt per cheque"
```

---

### Task 7: Documentation and final checks

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md.**
  - In "Things that will catch you out", add a short paragraph: **the dashboard has two screens and the URL decides which** (`dashboardScreen`). A bare `/` is TOTALS and loads no rows; anything that narrows is LIST.
  - Under rule 11, add one sentence: since 2026-09-25 the list's OR / CR column takes a receipt per ticked row (`lib/row-receipts.ts`, `readRowReceipts`). RELEASE and SAVE RECEIPTS write through `markReleased` / `recordReceipt` only, and the old one-box-per-batch refusal is replaced because every box now has one owner.
  - Update the test-count line with the real counts: `find tests -name "*.test.ts" | wc -l`, and the per-file cases added.

- [ ] **Step 2: Final verification.** Run `npx.cmd tsc --noEmit`. Then run `node node_modules/vitest/vitest.mjs run tests/dashboard-view.test.ts tests/queries.test.ts tests/row-receipts.test.ts tests/receipt-form.test.ts tests/actions/bulk-actions.test.ts tests/actions/receipt.test.ts tests/actions/server-actions.test.ts`, which must all pass. Then `npx.cmd next build`.

- [ ] **Step 3: Commit.**

```bash
git add CLAUDE.md
git commit -m "docs: the two-screen dashboard and the per-row OR in CLAUDE.md"
```

- [ ] **Step 4: Go-live.** No migration is needed. Deploy with `npx.cmd vercel --prod --yes` after the full suite, on the user's instruction.

---

## Self-review against the spec

- Screen rule, cards, timeline, "Show them", export and print unchanged → Task 1 and Task 2.
- TOTALS content (sync line, cards, TODAY'S RELEASE, timeline, search) with no row queries → Task 2.
- LIST content (back bar with the view and count, quick actions, disclosure, filters, notices, table) → Task 2.
- Tickable rows, including RELEASED without an OR; a receipt never overwritten → Task 4 (`isTickable`), Task 6, and the domain.
- The box only on READY / SCHEDULED / RELEASED; the OR column always present; no date in the row; unticking discards the draft → Task 4 (`takesReceipt`) and Task 6.
- RELEASE per-row receipts (admin only); SAVE RECEIPTS (any user); blanks skipped; per-cheque refusals; cap → Task 5 and Task 6.
- Old batch refusal replaced; unticked keys and old fields refused; a number without a type refused on both ends → Task 4 and Task 5.
- Rule 11 pinned: `receipt.test.ts` unchanged and passing, and `crNumber: null` asserted → Task 5.
- The tests named in the spec → Tasks 1, 3, 4 and 5. `hasReceipt` is covered in `tests/queries.test.ts`.
- The names match across tasks: `dashboardScreen`, `DashboardScreen`, `ROW_OR_NUMBER`, `ROW_RECEIPT_TYPE`, `ReceiptDraft`, `EMPTY_DRAFT`, `RowFacts`, `isTickable`, `takesReceipt`, `liveIds`, `releasedIds`, `draftTypeMissing`, `receiptEntries`, `RowReceipt`, `readRowReceipts`, `bulkRecordReceiptsAction`.
