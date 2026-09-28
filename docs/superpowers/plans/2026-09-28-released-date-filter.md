# DATE RELEASED Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CHECK RELEASE dashboard's filter bar gets a DATE RELEASED FROM / TO range that narrows the list, its count, the Excel export and the print sheet to cheques whose release was recorded on a Manila day inside it.

**Architecture:** The range is two URL parameters (`releasedFrom`, `releasedTo`) read by the one resolver `resolveDashboardQuery`, honoured only in the RELEASED and ALL CHEQUES views, converted to Manila-day bounds and applied to `Check.releasedAt` by the shared `buildWhere`. The bar renders the two boxes only in those views; the page discloses how many released cheques carry no release date and so cannot match; the table gains a DATE RELEASED column.

**Tech Stack:** Next.js 15 App Router server components, Prisma 6, Vitest (the query tests hit the TEST database), TypeScript strict.

Spec: `docs/superpowers/specs/2026-09-28-released-date-filter-design.md`.

## Global Constraints

- **Windows:** run `npx.cmd`, never `npx`. Tests: `npx.cmd vitest run <file>`. Type check: `npx.cmd tsc --noEmit`.
- **Never run the full suite per change.** Run only the touched test files; the whole suite is ~20 minutes across the sea.
- **`npx.cmd tsc --noEmit` is REQUIRED before claiming any task done.** Vitest erases types.
- **Days are Manila calendar days.** `manilaDayStart` / `manilaDayEnd` in `lib/audit-view.ts` are the only converters. 2026-09-25 Manila is `2026-09-24T16:00:00.000Z` to `2026-09-25T15:59:59.999Z`.
- **The range is applied only when the view is RELEASED (`status=RELEASED`) or ALL CHEQUES (`scope=all`).** Elsewhere the two parameters are dropped: not applied, not in `selection.base`, not described.
- **An invalid day is ignored, never an error.** `isIsoDay` in `lib/domain/details.ts` decides validity.
- **FROM after TO is not swapped.** It matches nothing and is described as given.
- **No backfill of `releasedAt`.** The rule against a fabricated release timestamp stands (CLAUDE.md).
- **No new column in the Excel export or the print sheet.** Their title blocks name the range; that is all.
- **Labels are ALL CAPS**, like every other label on the bar.
- **Do not print or commit `.env` or any `.xlsx`.**
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: The query layer — range, null flag, table row

**Files:**
- Modify: `lib/queries.ts` (`CheckFilters` ~line 12, `buildWhere` ~line 282, `CheckTableRow` ~line 456, `toTableRow` ~line 490)
- Modify: `tests/helpers/factory.ts` (`makeCheck`, lines 11–65)
- Test: `tests/queries.test.ts`

**Interfaces:**
- Produces: `CheckFilters.releasedFrom?: Date`, `CheckFilters.releasedTo?: Date`, `CheckFilters.releasedAtIsNull?: true`; `CheckTableRow.releasedAt: Date | null`; `makeCheck({ releasedAt?: Date | null })`.
- Consumes: nothing new.

- [ ] **Step 1: Let the factory set `releasedAt`**

In `tests/helpers/factory.ts`, add to the `overrides` type after `availablePickupDate?: Date | null`:

```ts
  /** When the release was recorded HERE. Defaults to null — the state of every
   * cheque released before the app recorded releases. */
  releasedAt?: Date | null
```

and to the `data` object after `availablePickupDate: ...`:

```ts
      releasedAt: overrides.releasedAt ?? null,
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/queries.test.ts` (after the `filters compose` describe, before `getTodaysRelease`):

```ts
/**
 * DATE RELEASED. The range is over `releasedAt` — the instant `markReleased`
 * wrote — and a release nobody recorded here has none, so it can never fall
 * inside a range. That is the fact the dashboard discloses with a count, and
 * `releasedAtIsNull` is how it gets the count from the same `buildWhere`.
 */
describe('DATE RELEASED range', () => {
  // Manila 2026-09-25, as the resolver would hand it over.
  const from = new Date('2026-09-24T16:00:00.000Z')
  const to = new Date('2026-09-25T15:59:59.999Z')

  it('returns only the cheques released inside the range, never one with no recorded release', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-IN', releasedAt: new Date('2026-09-25T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-BEFORE', releasedAt: new Date('2026-09-20T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-AFTER', releasedAt: new Date('2026-09-26T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-UNDATED', releasedAt: null })

    const filters = { status: 'RELEASED' as const, releasedFrom: from, releasedTo: to }
    const rows = await listChecks(testDb, filters)
    expect(rows.map((r) => r.checkNumber)).toEqual(['R-IN'])
    expect(await countChecks(testDb, filters)).toBe(1)
  })

  it('is inclusive at both Manila-day edges', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-FIRST-MS', releasedAt: from })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-LAST-MS', releasedAt: to })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-ONE-MS-LATE', releasedAt: new Date(to.getTime() + 1) })

    const rows = await listChecks(testDb, { status: 'RELEASED', releasedFrom: from, releasedTo: to })
    expect(rows.map((r) => r.checkNumber).sort()).toEqual(['R-FIRST-MS', 'R-LAST-MS'])
  })

  it('honours an open-ended bound on either side', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-EARLY', releasedAt: new Date('2026-09-20T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-LATE', releasedAt: new Date('2026-09-26T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-UNDATED', releasedAt: null })

    const onOrAfter = await listChecks(testDb, { status: 'RELEASED', releasedFrom: from })
    expect(onOrAfter.map((r) => r.checkNumber)).toEqual(['R-LATE'])

    const onOrBefore = await listChecks(testDb, { status: 'RELEASED', releasedTo: to })
    expect(onOrBefore.map((r) => r.checkNumber)).toEqual(['R-EARLY'])
  })

  it('counts the released cheques with no recorded release, for the disclosure', async () => {
    await makeCheck({ status: 'RELEASED', releasedAt: new Date('2026-09-25T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', releasedAt: null })
    await makeCheck({ status: 'RELEASED', releasedAt: null })
    // Live, so no release instant either — must NOT be counted: the disclosure
    // is about released cheques.
    await makeCheck({ status: 'SIGNED', releasedAt: null })

    expect(await countChecks(testDb, { status: 'RELEASED', releasedAtIsNull: true })).toBe(2)
  })

  it('carries the release instant into the table row, null when none was recorded', async () => {
    const when = new Date('2026-09-25T02:00:00.000Z')
    const dated = await makeCheck({ status: 'RELEASED', releasedAt: when })
    const undated = await makeCheck({ status: 'RELEASED', releasedAt: null })

    const [datedRow] = await listChecks(testDb, { q: dated.checkNumber })
    expect(toTableRow(datedRow).releasedAt).toEqual(when)

    const [undatedRow] = await listChecks(testDb, { q: undated.checkNumber })
    expect(toTableRow(undatedRow).releasedAt).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx.cmd vitest run tests/queries.test.ts -t "DATE RELEASED"`
Expected: FAIL — the first four fail because the range is ignored (every RELEASED row comes back) and `releasedAtIsNull` is unknown to `buildWhere`; the last fails with `releasedAt` undefined on the table row. (TypeScript errors on the unknown fields are expected here; Vitest erases types.)

- [ ] **Step 4: Add the fields to `CheckFilters`**

In `lib/queries.ts`, inside `CheckFilters`, after `to?: Date`:

```ts
  /**
   * DATE RELEASED, as a range over `releasedAt` — the instant `markReleased`
   * wrote when the cheque was released THROUGH THIS APP. Both bounds are
   * inclusive instants; the resolver builds them from Manila calendar days.
   *
   * A release nobody recorded here has no instant — every cheque the register
   * load imported at RELEASED and every one the two catch-ups moved — so it
   * never matches a bound. That is correct, and the dashboard says so with a
   * count rather than letting a short table read as the whole picture.
   */
  releasedFrom?: Date
  releasedTo?: Date
  /**
   * Only the cheques whose release has NO recorded instant. The disclosure's
   * count, taken through the same `buildWhere` as the table so it is narrowed
   * by the same company, bank, search and incompleteness. When set it replaces
   * the range, never combines with it — a cheque cannot be both.
   */
  releasedAtIsNull?: true
```

- [ ] **Step 5: Apply them in `buildWhere`**

In `buildWhere`, after the `checkDate` block:

```ts
  if (filters.releasedAtIsNull) {
    where.releasedAt = null
  } else if (filters.releasedFrom || filters.releasedTo) {
    // A null `releasedAt` satisfies neither bound, so an undated release is
    // left out without an extra clause.
    where.releasedAt = { gte: filters.releasedFrom, lte: filters.releasedTo }
  }
```

- [ ] **Step 6: Carry it on the table row**

In `CheckTableRow`, after `scheduledPickupDate: Date | null`:

```ts
  /** When the release was recorded here; null for every release that was not. */
  releasedAt: Date | null
```

In `toTableRow`, after `scheduledPickupDate: r.scheduledPickupDate,`:

```ts
    releasedAt: r.releasedAt,
```

- [ ] **Step 7: Run to verify they pass**

Run: `npx.cmd vitest run tests/queries.test.ts`
Expected: PASS, every case in the file (the existing cases must stay green — the factory default of null changes nothing for them).

- [ ] **Step 8: Type check and commit**

Run: `npx.cmd tsc --noEmit`
Expected: no output.

```bash
git add lib/queries.ts tests/helpers/factory.ts tests/queries.test.ts
git commit -m "feat(queries): DATE RELEASED range and undated-release count on CheckFilters; releasedAt on the table row

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The filter description

**Files:**
- Modify: `lib/export/report.ts` (`FilterDescription` ~line 113, `describeFilters` ~line 127)
- Test: `tests/export/report.test.ts` (`describe('describeFilters')`)

**Interfaces:**
- Produces: `FilterDescription.releasedFrom?: string | null`, `FilterDescription.releasedTo?: string | null` (the days as typed, `YYYY-MM-DD`).
- Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Inside `describe('describeFilters', ...)` in `tests/export/report.test.ts`, add:

```ts
  /**
   * The range as the reader typed it — days, not instants. A title block that
   * printed "2026-09-24T16:00:00.000Z" would be read as the wrong day by
   * everyone in Manila.
   */
  it('names the DATE RELEASED range in the three ways it can be given', () => {
    expect(describeFilters({ releasedFrom: '2026-09-01', releasedTo: '2026-09-15' }))
      .toBe('DATE RELEASED: 2026-09-01 TO 2026-09-15')
    expect(describeFilters({ releasedFrom: '2026-09-01' })).toBe('DATE RELEASED: FROM 2026-09-01')
    expect(describeFilters({ releasedTo: '2026-09-15' })).toBe('DATE RELEASED: TO 2026-09-15')
  })

  it('places the range after the search and before the incomplete clause', () => {
    expect(describeFilters({ q: 'henkel', releasedFrom: '2026-09-01', incomplete: false }))
      .toBe('SEARCH: "henkel"  ·  DATE RELEASED: FROM 2026-09-01  ·  EXCLUDES RECORDS WITH NO AMOUNT')
  })

  it('ignores a blank day rather than printing an empty bound', () => {
    expect(describeFilters({ releasedFrom: '  ', releasedTo: null })).toBe('No filters applied')
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx.cmd vitest run tests/export/report.test.ts -t "DATE RELEASED|places the range|blank day"`

Note the `|` — under Git Bash use `node node_modules/vitest/vitest.mjs run tests/export/report.test.ts -t "DATE RELEASED|places the range|blank day"` instead (the `.cmd` shim mis-tokenises a pipe).
Expected: FAIL — the first two get `'No filters applied'` / a line without the range.

- [ ] **Step 3: Implement**

In `lib/export/report.ts`, extend the type:

```ts
export type FilterDescription = {
  company?: string | null
  bank?: string | null
  eligibility?: string | null
  q?: string | null
  incomplete?: boolean
  /** DATE RELEASED bounds, as the days the reader typed (`YYYY-MM-DD`). */
  releasedFrom?: string | null
  releasedTo?: string | null
}
```

In `describeFilters`, after `if (q) parts.push(...)` and before the incomplete block:

```ts
  // As typed, never as an instant: the bounds are Manila days and the reader
  // is in Manila. Either side may stand alone.
  const releasedFrom = f.releasedFrom?.trim()
  const releasedTo = f.releasedTo?.trim()
  if (releasedFrom && releasedTo) parts.push(`DATE RELEASED: ${releasedFrom} TO ${releasedTo}`)
  else if (releasedFrom) parts.push(`DATE RELEASED: FROM ${releasedFrom}`)
  else if (releasedTo) parts.push(`DATE RELEASED: TO ${releasedTo}`)
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx.cmd vitest run tests/export/report.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Type check and commit**

Run: `npx.cmd tsc --noEmit`
Expected: no output.

```bash
git add lib/export/report.ts tests/export/report.test.ts
git commit -m "feat(export): the title block names the DATE RELEASED range

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The resolver — parse, gate on the view, Manila bounds

**Files:**
- Modify: `lib/dashboard-params.ts`
- Test: `tests/export/dashboard-params.test.ts`

**Interfaces:**
- Consumes: `CheckFilters.releasedFrom/releasedTo` (Task 1), `FilterDescription.releasedFrom/releasedTo` (Task 2), `isIsoDay` from `lib/domain/details.ts`, `manilaDayStart` / `manilaDayEnd` from `lib/audit-view.ts` (both import-free, no cycle).
- Produces: `DashboardSearchParams.releasedFrom?: string`, `DashboardSearchParams.releasedTo?: string`; `DashboardQuery.releasedFrom: string`, `DashboardQuery.releasedTo: string` (validated days or `''`); `selection.base.releasedFrom` / `.releasedTo` when in force.

- [ ] **Step 1: Write the failing tests**

Append to `tests/export/dashboard-params.test.ts`, inside the top-level `describe('resolveDashboardQuery')`, a nested describe:

```ts
  /**
   * DATE RELEASED. Honoured on the two views that can contain a released
   * cheque — RELEASED and ALL CHEQUES — and dropped everywhere else exactly as
   * an unrecognised company id is: a live cheque has no release instant, and a
   * range on SIGNED could only empty the table without saying why.
   */
  describe('the DATE RELEASED range', () => {
    it('becomes inclusive Manila-day bounds on the RELEASED view, and rides in `base`', () => {
      const r = resolveDashboardQuery(
        { status: 'RELEASED', releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },
        options,
      )
      expect(r.filters.releasedFrom).toEqual(new Date('2026-08-31T16:00:00.000Z'))
      expect(r.filters.releasedTo).toEqual(new Date('2026-09-15T15:59:59.999Z'))
      expect(r.releasedFrom).toBe('2026-09-01')
      expect(r.releasedTo).toBe('2026-09-15')
      expect(r.selection.base).toEqual({ releasedFrom: '2026-09-01', releasedTo: '2026-09-15' })
      expect(r.filterDescription).toBe('DATE RELEASED: 2026-09-01 TO 2026-09-15  ·  EXCLUDES RECORDS WITH NO AMOUNT')
    })

    it('accepts either bound alone', () => {
      const from = resolveDashboardQuery({ status: 'RELEASED', releasedFrom: '2026-09-01' }, options)
      expect(from.filters.releasedFrom).toEqual(new Date('2026-08-31T16:00:00.000Z'))
      expect(from.filters.releasedTo).toBeUndefined()
      expect(from.selection.base).toEqual({ releasedFrom: '2026-09-01' })

      const to = resolveDashboardQuery({ status: 'RELEASED', releasedTo: '2026-09-15' }, options)
      expect(to.filters.releasedFrom).toBeUndefined()
      expect(to.filters.releasedTo).toEqual(new Date('2026-09-15T15:59:59.999Z'))
      expect(to.selection.base).toEqual({ releasedTo: '2026-09-15' })
    })

    it('applies on ALL CHEQUES too', () => {
      const r = resolveDashboardQuery({ scope: 'all', releasedFrom: '2026-09-01' }, options)
      expect(r.filters.releasedFrom).toEqual(new Date('2026-08-31T16:00:00.000Z'))
      expect(r.selection.base).toEqual({ releasedFrom: '2026-09-01' })
    })

    it('is dropped — from the filters, `base` and the description — on every other view', () => {
      for (const params of [
        { releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },                       // NEEDS ACTION
        { status: 'SIGNED', releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },
        { status: 'READY_FOR_RELEASE', releasedFrom: '2026-09-01' },
        { status: 'SIGNATURE_PENDING', releasedTo: '2026-09-15' },
      ]) {
        const r = resolveDashboardQuery(params, options)
        expect(r.filters.releasedFrom).toBeUndefined()
        expect(r.filters.releasedTo).toBeUndefined()
        expect(r.releasedFrom).toBe('')
        expect(r.releasedTo).toBe('')
        expect(r.selection.base).toEqual({})
        expect(r.filterDescription).toBe('EXCLUDES RECORDS WITH NO AMOUNT')
      }
    })

    // A hand-edited or half-typed value opens the view unfiltered, never a 500
    // — the same contract every other parameter on this URL has.
    it('ignores a value that is not a real calendar day', () => {
      for (const bad of ['2026-02-30', '25/09/2026', '2026-9-1', 'today', '']) {
        const r = resolveDashboardQuery({ status: 'RELEASED', releasedFrom: bad, releasedTo: bad }, options)
        expect(r.filters.releasedFrom).toBeUndefined()
        expect(r.filters.releasedTo).toBeUndefined()
        expect(r.selection.base).toEqual({})
      }
    })

    // Not swapped: the honest answer to a backwards question is an empty table,
    // and the title block says what was asked.
    it('keeps FROM after TO as given rather than swapping them', () => {
      const r = resolveDashboardQuery(
        { status: 'RELEASED', releasedFrom: '2026-09-15', releasedTo: '2026-09-01' },
        options,
      )
      expect(r.filters.releasedFrom).toEqual(new Date('2026-09-14T16:00:00.000Z'))
      expect(r.filters.releasedTo).toEqual(new Date('2026-09-01T15:59:59.999Z'))
      expect(r.filterDescription).toBe('DATE RELEASED: 2026-09-15 TO 2026-09-01  ·  EXCLUDES RECORDS WITH NO AMOUNT')
    })
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx.cmd vitest run tests/export/dashboard-params.test.ts -t "DATE RELEASED"`
Expected: FAIL — `filters.releasedFrom` undefined on the RELEASED case, `r.releasedFrom` undefined rather than `''`, `base` `{}`.

- [ ] **Step 3: Implement**

In `lib/dashboard-params.ts`:

Add imports after the existing ones:

```ts
import { isIsoDay } from './domain/details'
import { manilaDayStart, manilaDayEnd } from './audit-view'
```

Extend `DashboardSearchParams`:

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
}
```

Extend `DashboardQuery`, after `q: string`:

```ts
  /** The validated DATE RELEASED days as the bar should render them back, or `''`. */
  releasedFrom: string
  releasedTo: string
```

Add a helper above `resolveDashboardQuery`:

```ts
/** A `YYYY-MM-DD` that is a real calendar day, else nothing. Never an error. */
function parseDayParam(value: string | undefined): string | undefined {
  const v = value?.trim() ?? ''
  return isIsoDay(v) ? v : undefined
}
```

Inside `resolveDashboardQuery`, after `const q = params.q?.trim() ?? ''`:

```ts
  /**
   * DATE RELEASED applies only where a released cheque can be: the RELEASED
   * view and ALL CHEQUES. On any other view the two are dropped exactly as an
   * unrecognised company id is — a live cheque has no release instant, so the
   * range could only empty the table without saying why — and, being dropped
   * here, they leave `base` and the description too, so a card link out of
   * RELEASED does not carry a filter the destination cannot honour.
   */
  const releasedRangeApplies = status === 'RELEASED' || showAll
  const releasedFrom = releasedRangeApplies ? parseDayParam(params.releasedFrom) : undefined
  const releasedTo = releasedRangeApplies ? parseDayParam(params.releasedTo) : undefined
```

In `selection.base`, add two entries to the object passed to `Object.entries`:

```ts
        eligibility: eligibility ?? '',
        releasedFrom: releasedFrom ?? '',
        releasedTo: releasedTo ?? '',
```

In `filters`, after `incomplete,`:

```ts
    // Manila calendar days become inclusive instants: the day's first and last
    // millisecond in UTC+8. FROM after TO is passed through as given.
    releasedFrom: releasedFrom ? manilaDayStart(releasedFrom) : undefined,
    releasedTo: releasedTo ? manilaDayEnd(releasedTo) : undefined,
```

In the returned object, after `q,`:

```ts
    releasedFrom: releasedFrom ?? '',
    releasedTo: releasedTo ?? '',
```

and in the `describeFilters({...})` call add:

```ts
      releasedFrom: releasedFrom ?? null,
      releasedTo: releasedTo ?? null,
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx.cmd vitest run tests/export/dashboard-params.test.ts`
Expected: PASS, whole file. The existing `carries the narrowing filters, but not the view, in base` case must still give `{ q: 'henkel', company: 'co-stk' }` — the two new keys are filtered out when empty by the existing `v !== ''` filter.

- [ ] **Step 5: Type check and commit**

Run: `npx.cmd tsc --noEmit`
Expected: no output. (`app/page.tsx`, `app/print/page.tsx` and the export route compile unchanged: the new `DashboardSearchParams` keys are optional.)

```bash
git add lib/dashboard-params.ts tests/export/dashboard-params.test.ts
git commit -m "feat(dashboard): resolve releasedFrom/releasedTo on the RELEASED and ALL CHEQUES views as Manila-day bounds

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The DATE RELEASED table column

**Files:**
- Modify: `lib/table-columns.ts` (`COLUMN_KEYS`, `COLUMN_LABELS`)
- Modify: `components/CheckTable.tsx` (header row ~line 208, body row ~line 296)
- Test: `tests/table-columns.test.ts`

**Interfaces:**
- Consumes: `CheckTableRow.releasedAt` (Task 1).
- Produces: `ColumnKey` gains `'releasedAt'`, label `DATE RELEASED`.

- [ ] **Step 1: Write the failing tests**

In `tests/table-columns.test.ts`, extend the existing `recognises its own keys and nothing else` case with one line:

```ts
    expect(isColumnKey('releasedAt')).toBe(true)
```

and add inside `describe('normaliseColumns')`:

```ts
  // The column arrived after the preference feature shipped. A viewer who
  // saved a set before it existed keeps that set — the column is offered, not
  // imposed — and when they tick it, it takes its designed place before ACTION.
  it('leaves DATE RELEASED out of a stored set that predates it, and orders it before ACTION when chosen', () => {
    expect(normaliseColumns(['checkNumber', 'amount', 'status', 'action'])).not.toContain('releasedAt')
    const chosen = normaliseColumns(['releasedAt', 'scheduledPickupDate', 'checkNumber'])
    expect(chosen).toEqual(['checkNumber', 'status', 'scheduledPickupDate', 'releasedAt', 'action'])
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx.cmd vitest run tests/table-columns.test.ts`
Expected: FAIL — `isColumnKey('releasedAt')` is false; the chosen set lacks `'releasedAt'`.

- [ ] **Step 3: Add the column key and label**

In `lib/table-columns.ts`:

```ts
export const COLUMN_KEYS = [
  'checkNumber',
  'apvNumbers',
  'payeeName',
  'companyCode',
  'bank',
  'checkDate',
  'amount',
  'status',
  'availablePickupDate',
  'scheduledPickupDate',
  'releasedAt',
  'action',
] as const
```

and in `COLUMN_LABELS`, after `scheduledPickupDate: 'PICKUP SCHEDULE',`:

```ts
  // When the release was recorded HERE. Blank on every release the register
  // load imported or a catch-up moved — that is the fact, not a gap to fill.
  releasedAt: 'DATE RELEASED',
```

Do NOT bump `COLUMN_STORAGE_KEY`: an older stored set still parses and simply omits the new key, which is the behaviour the test above pins.

- [ ] **Step 4: Render it**

In `components/CheckTable.tsx`, in the header row after the `scheduledPickupDate` `<th>`:

```tsx
              {shows('releasedAt') && <th className="px-4 py-3">{COLUMN_LABELS.releasedAt}</th>}
```

In the body row after the `scheduledPickupDate` `<td>` block:

```tsx
                {shows('releasedAt') && (
                  <td className="px-4 py-3 text-slate-600">{fmtDate(r.releasedAt)}</td>
                )}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx.cmd vitest run tests/table-columns.test.ts`
Expected: PASS, whole file — including `labels every column` and `defaults to every column`, which now cover twelve keys.

- [ ] **Step 6: Type check and commit**

Run: `npx.cmd tsc --noEmit`
Expected: no output. If the column-picker component (search `COLUMN_KEYS` under `components/`) enumerates keys with a `Record<ColumnKey, …>` of its own, the compiler names it here; add the `releasedAt` entry there with the same label.

```bash
git add lib/table-columns.ts components/CheckTable.tsx tests/table-columns.test.ts
git commit -m "feat(table): DATE RELEASED column, off in a saved preference that predates it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The bar, the page, the export route, the disclosure

**Files:**
- Modify: `components/FilterBar.tsx`
- Modify: `app/page.tsx` (searchParams type ~line 63, destructure ~line 119, LIST queries ~line 221, disclosure and `FilterBar` call ~lines 246–281)
- Modify: `app/api/export/route.ts` (the `resolveDashboardQuery({...})` call ~line 65)
- Test: `tests/dashboard-links.test.ts`

**Interfaces:**
- Consumes: `DashboardQuery.releasedFrom/releasedTo` and `DashboardSearchParams` (Task 3), `CheckFilters.releasedAtIsNull` (Task 1).
- Produces: `FilterBar` props `releasedFrom: string`, `releasedTo: string`, `showReleasedRange: boolean`.

- [ ] **Step 1: Write the failing link tests**

In `tests/dashboard-links.test.ts`, add inside `describe('filterHref')`:

```ts
  // The two date boxes are ordinary form controls: an empty one is dropped like
  // an empty search, a filled one is carried as the day the browser typed.
  it('carries a filled DATE RELEASED box and drops an empty one', () => {
    expect(filterHref([['status', 'RELEASED'], ['releasedFrom', ''], ['releasedTo', '2026-09-15']]))
      .toBe('/?status=RELEASED&releasedTo=2026-09-15')
  })
```

and inside `describe('dashboardHref')`:

```ts
  it('carries the DATE RELEASED range the resolver put in `base`', () => {
    const sel: DashboardSelection = {
      status: 'RELEASED', showAll: false, incomplete: false,
      base: { releasedFrom: '2026-09-01', releasedTo: '2026-09-15' },
    }
    expect(dashboardHref(sel)).toBe('/?releasedFrom=2026-09-01&releasedTo=2026-09-15&status=RELEASED')
    expect(exportHref(sel)).toBe('/api/export?releasedFrom=2026-09-01&releasedTo=2026-09-15&status=RELEASED')
  })
```

- [ ] **Step 2: Run them**

Run: `npx.cmd vitest run tests/dashboard-links.test.ts`
Expected: PASS already — `filterHref` and `href` are generic over `base`. These cases pin that no change to either is needed; keep them. (If either fails, the URL builders have a hidden allow-list and it must be widened, not the test changed.)

- [ ] **Step 3: The filter bar**

In `components/FilterBar.tsx`, replace the component signature and the `anyFilter` line:

```tsx
export function FilterBar({
  options, showAll, q, status, companyId, cashAccountId, eligibility, incomplete,
  releasedFrom, releasedTo, showReleasedRange, clearHref,
}: {
  options: FilterOptions
  showAll: boolean
  q: string
  status: string
  companyId: string
  cashAccountId: string
  eligibility: string
  incomplete: boolean
  /** The validated DATE RELEASED days, or `''`. */
  releasedFrom: string
  releasedTo: string
  /** True on the RELEASED and ALL CHEQUES views — the only views a release date can narrow. */
  showReleasedRange: boolean
  clearHref: string
}) {
  // A RESET control that is always there is furniture, and on an unfiltered
  // screen it invites the user to wonder what it would clear.
  // The status is NOT counted. It is the view, not a filter, and RESET
  // deliberately keeps it: a bar offering RESET on an otherwise untouched
  // SIGNED view would promise to clear something it does not clear.
  const anyFilter = Boolean(q || companyId || cashAccountId || eligibility || incomplete || releasedFrom || releasedTo)
```

Then, between the ELIGIBILITY `<select>` and the INCOMPLETE ONLY `<label>`, insert:

```tsx
      {/* DATE RELEASED — only where a released cheque can be. On NEEDS ACTION,
          READY, SIGNED and PENDING the boxes are not rendered at all: a live
          cheque has no release instant, so a range there could only empty the
          table, and the resolver drops the parameters on those views anyway.
          Two plain date inputs: a native GET submit sends them, the enhancement
          submits them on change like the dropdowns, and `filterHref` drops an
          empty one the way it drops an empty search. */}
      {showReleasedRange && (
        <>
          <label htmlFor="filter-released-from" className="whitespace-nowrap text-[11px] font-semibold tracking-widest text-slate-500">
            DATE RELEASED FROM
          </label>
          <input
            id="filter-released-from" name="releasedFrom" type="date" defaultValue={releasedFrom}
            className={field}
          />
          <label htmlFor="filter-released-to" className="whitespace-nowrap text-[11px] font-semibold tracking-widest text-slate-500">
            TO
          </label>
          <input
            id="filter-released-to" name="releasedTo" type="date" defaultValue={releasedTo}
            className={field}
          />
        </>
      )}
```

Update the file's opening doc comment's first line to read:

```
 * The dashboard's filter bar: one row — SEARCH · COMPANY · BANK · ELIGIBILITY ·
 * DATE RELEASED (RELEASED and ALL CHEQUES views only) · INCOMPLETE · RESET.
```

- [ ] **Step 4: Check that `FilterAutoSubmit` submits a date input on change**

Open `components/FilterAutoSubmit.tsx` and find the `change` listener. If it is bound to the form (`form.addEventListener('change', …)`) it already covers the new inputs — a `<input type="date">` fires `change` when a full date is picked or typed. If instead it iterates `form.querySelectorAll('select')`, widen the selector to `'select, input[type="date"]'`. Make no other change.

- [ ] **Step 5: The page**

In `app/page.tsx`:

Add to the inline `searchParams` type, after `scope?: string`:

```ts
    releasedFrom?: string
    releasedTo?: string
```

Replace the destructure:

```ts
  const {
    q, status, companyId, cashAccountId, eligibility, incomplete, showAll, selection, filters,
    releasedFrom, releasedTo,
  } = resolveDashboardQuery(params, options)
```

Replace the LIST screen's query block:

```ts
  // LIST never loads TODAY'S RELEASE or the sync overview — that state belongs
  // to the totals screen, and this table has its own row counts to state.
  //
  // With a DATE RELEASED range in force, a third count: the released cheques
  // in this same view that carry NO release instant and so cannot match any
  // range. Same filters, range removed, narrowed to RELEASED with a null
  // `releasedAt` — so the number is the number of rows the reader's own view
  // would have shown had those releases been recorded here.
  const releasedRange = Boolean(filters.releasedFrom || filters.releasedTo)
  const [rows, matching, undatedReleases] = await Promise.all([
    listChecks(prisma, filters),
    countChecks(prisma, filters),
    releasedRange
      ? countChecks(prisma, {
          ...filters,
          releasedFrom: undefined,
          releasedTo: undefined,
          status: 'RELEASED',
          statusIn: undefined,
          releasedAtIsNull: true,
        })
      : Promise.resolve(0),
  ])
```

After the no-amount disclosure `<p>` (the one ending `Show them</Link>.`) and before `<FilterBar`, add:

```tsx
      {/* ── THE OTHER DISCLOSURE ────────────────────────────────────────────
          `releasedAt` is written only by `markReleased`, when a cheque is
          released THROUGH THIS APP. Every release the register load imported
          and every one the two catch-ups moved has none — on purpose: a
          timestamp fabricated from a spreadsheet on a release record is worse
          than none (CLAUDE.md). So a date range can only ever match releases
          recorded here, and a reader filtering September must be told how much
          of RELEASED that leaves out, or a short table reads as the whole
          picture. */}
      {releasedRange && undatedReleases > 0 && (
        <p className="text-xs font-medium tracking-wide text-slate-500">
          NOT MATCHED: {undatedReleases.toLocaleString('en-PH')} RELEASED{' '}
          {undatedReleases === 1 ? 'CHEQUE CARRIES' : 'CHEQUES CARRY'} NO RELEASE DATE — released
          before this system recorded releases, or moved from the register. Only releases recorded
          here can fall inside a date range.
        </p>
      )}
```

Replace the `<FilterBar … />` call:

```tsx
      <FilterBar
        options={options}
        showAll={showAll}
        q={q}
        status={status ?? ''}
        companyId={companyId ?? ''}
        cashAccountId={cashAccountId ?? ''}
        eligibility={eligibility ?? ''}
        incomplete={incomplete}
        releasedFrom={releasedFrom}
        releasedTo={releasedTo}
        showReleasedRange={status === 'RELEASED' || showAll}
        clearHref={clearFiltersHref(selection)}
      />
```

- [ ] **Step 6: The export route**

In `app/api/export/route.ts`, extend the `resolveDashboardQuery({...})` call:

```ts
  const query = resolveDashboardQuery({
    q: read('q'),
    status: read('status'),
    company: read('company'),
    cashAccount: read('cashAccount'),
    eligibility: read('eligibility'),
    incomplete: read('incomplete'),
    scope: read('scope'),
    releasedFrom: read('releasedFrom'),
    releasedTo: read('releasedTo'),
  }, options)
```

`app/print/page.tsx` passes its `searchParams` object straight through as `DashboardSearchParams` and needs no change.

- [ ] **Step 7: Type check, then run every touched test file**

Run: `npx.cmd tsc --noEmit`
Expected: no output.

Run, one after another (never two at once — one agent at a time against the test database):

```
npx.cmd vitest run tests/dashboard-links.test.ts
npx.cmd vitest run tests/export/route.test.ts
npx.cmd vitest run tests/queries.test.ts
```

Expected: PASS for all three. `tests/export/route.test.ts` pins that an unauthenticated request never touches the database; it is run because the route changed.

- [ ] **Step 8: See it working**

Start the app with `preview_start` (name from `.claude/launch.json`; create the entry `{"name":"dev","runtimeExecutable":"npm.cmd","runtimeArgs":["run","dev"],"port":3000}` if missing). Sign in with the dev seed's known account. Then check, with `read_page` rather than screenshots where text suffices:

1. `/?status=SIGNED` — the bar shows NO date boxes.
2. `/?status=RELEASED` — the bar shows DATE RELEASED FROM / TO.
3. `/?status=RELEASED&releasedFrom=2026-09-01&releasedTo=2026-09-30` — the header line reads `RELEASED · N CHEQUES`, the NOT MATCHED line appears if the seed holds an undated release, the DATE RELEASED column renders, and the EXPORT link in QUICK ACTIONS carries both parameters.
4. `/?status=SIGNED&releasedFrom=2026-09-01` — the SIGNED view opens unfiltered with no date boxes and no NOT MATCHED line.
5. `read_console_messages` shows no errors.

Take one screenshot of (3) for the final report.

**The local `.env` points at PRODUCTION** (memory: `local-env-is-production`). The dev server therefore reads live data; that is fine for a read-only look, but do not sign, release, void or edit anything while checking, and do not run any script.

- [ ] **Step 9: Commit**

```bash
git add components/FilterBar.tsx components/FilterAutoSubmit.tsx app/page.tsx app/api/export/route.ts tests/dashboard-links.test.ts
git commit -m "feat(dashboard): DATE RELEASED FROM/TO on the filter bar in the RELEASED and ALL CHEQUES views, with the undated-releases disclosure

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Omit `components/FilterAutoSubmit.tsx` from `git add` if Step 4 found it needed no change.)

---

### Task 6: CLAUDE.md note and the final gate

**Files:**
- Modify: `CLAUDE.md` (the "Things that will catch you out" section, after the two-screens paragraph)

- [ ] **Step 1: Record the trap for the next reader**

Insert after the paragraph that begins `**The dashboard has two screens, and the URL decides which**`:

```markdown
**DATE RELEASED on the filter bar reads `releasedAt`, which is null on every release
that did not go through the app** (2026-09-28, spec
`2026-09-28-released-date-filter-design.md`). `releasedFrom` / `releasedTo` are Manila
days, honoured only on the RELEASED and ALL CHEQUES views and dropped everywhere else by
`resolveDashboardQuery`; the LIST screen states how many RELEASED cheques carry no date
whenever a range is in force. The register's DATE RELEASED lives only in the catch-ups'
audit rows and is never written to `releasedAt` — do not "fix" the blank column with it.
```

- [ ] **Step 2: The final gate, in order**

```
npx.cmd tsc --noEmit
npx.cmd vitest run tests/queries.test.ts
npx.cmd vitest run tests/export/dashboard-params.test.ts
npx.cmd vitest run tests/export/report.test.ts
npx.cmd vitest run tests/table-columns.test.ts
npx.cmd vitest run tests/dashboard-links.test.ts
npx.cmd vitest run tests/export/route.test.ts
```

Expected: `tsc` prints nothing; every file PASS. Record the counts.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: DATE RELEASED filter reads releasedAt, which history does not carry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Report**

State what was built, the test counts per file, the screenshot from Task 5 Step 8, and the one caveat the user must hear: the filter matches only releases recorded through the app, and the page says how many are not.
