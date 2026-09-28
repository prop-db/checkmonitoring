# Stated Release Date Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every cheque released outside the app the day the retired register states, in its own column, so the DATE RELEASED filter finds the 25 September pick-ups without touching the app's own release timestamp.

**Architecture:** A nullable `Check.statedReleaseDate` column; a one-off backfill (`lib/admin/stated-release-dates.ts` + `scripts/backfill-stated-release-dates.ts`) that reuses `readRegisterReleases` and the catch-ups' matching rule, with dry run, snapshot and one audit row per cheque; `buildWhere` matches the range on either date under `AND`; the table prefers the app timestamp and tags a stated date REGISTER.

**Tech Stack:** Next.js 15, Prisma 6 + one migration, Vitest against the TEST database, TypeScript strict.

Spec: `docs/superpowers/specs/2026-09-28-stated-release-date-design.md`.

## Global Constraints

- **From the Bash tool run `node node_modules/vitest/vitest.mjs run <file>` and `node node_modules/typescript/bin/tsc --noEmit`.** `npx.cmd` fails under Git Bash on this machine.
- **`node scripts/migrate.mjs test` before any database test**, and regenerate the client after the schema edit, or every test fails on a missing column.
- **Never run the full suite per change.** Touched files only; the full suite is the merge gate (~30 minutes).
- **Type check is REQUIRED before claiming any task done.**
- **`releasedAt` is never written by anything here.** `statedReleaseDate` is never written by the import or by `markReleased`.
- **Stated days are stored as the day's UTC midnight** (`YYYY-MM-DDT00:00:00.000Z`), the `checkDate` convention.
- **The production write (`--apply`) and the production migration are the user's to run.** Dry run only from here.
- **Never print a payee or an amount** from any script.
- **Do not print or commit `.env` or any `.xlsx`.**
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: The column — schema, migration, client, classification, factory

**Files:**
- Modify: `prisma/schema.prisma` (after `releasedAt         DateTime?` ~line 261; index list ~line 364)
- Create: `prisma/migrations/20260928000100_check_stated_release_date/migration.sql`
- Modify: `tests/import/upsert.test.ts` (`NEVER_WRITTEN_BY_IMPORT` ~line 309)
- Modify: `tests/helpers/factory.ts` (`makeCheck` overrides and data)
- Test: `tests/import/upsert.test.ts` (the exhaustiveness case)

**Interfaces:**
- Produces: `Check.statedReleaseDate: Date | null` on the Prisma client; `makeCheck({ statedReleaseDate?: Date | null })`.

- [ ] **Step 1: Schema**

In `prisma/schema.prisma`, after `releasedAt         DateTime?`:

```prisma
  // The day the retired register's DATE RELEASED column states, for a cheque
  // released outside this app (2026-09-28). Filled once by
  // scripts/backfill-stated-release-dates.ts from a register file; never by
  // the import, never by markReleased, never a substitute for releasedAt.
  statedReleaseDate  DateTime?
```

and after `@@index([availablePickupDate])`:

```prisma
  @@index([statedReleaseDate])
```

- [ ] **Step 2: Migration**

Create `prisma/migrations/20260928000100_check_stated_release_date/migration.sql`:

```sql
-- The register's stated release day, kept apart from releasedAt (the app's own
-- record of a release). See docs/superpowers/specs/2026-09-28-stated-release-date-design.md.
ALTER TABLE "Check" ADD COLUMN "statedReleaseDate" TIMESTAMP(3);
CREATE INDEX "Check_statedReleaseDate_idx" ON "Check"("statedReleaseDate");
```

- [ ] **Step 3: Apply to TEST and regenerate the client**

Run: `node scripts/migrate.mjs test`
Expected: prints the test host and database, then Prisma reports 1 migration applied.

Run: `node node_modules/prisma/build/index.js generate`
Expected: "Generated Prisma Client".

- [ ] **Step 4: Run the exhaustiveness test to see it fail**

Run: `node node_modules/vitest/vitest.mjs run tests/import/upsert.test.ts -t "classif"`
(If `-t` matches nothing, run the whole file.)
Expected: FAIL — the sorted column list now contains `statedReleaseDate` and the union of the three lists does not.

- [ ] **Step 5: Classify it**

In `tests/import/upsert.test.ts`, inside `NEVER_WRITTEN_BY_IMPORT`, after the `expectedOutflowDate` line:

```ts
      'statedReleaseDate',          // the register's stated day; written only by the stated-release-dates backfill (2026-09-28)
```

- [ ] **Step 6: Factory**

In `tests/helpers/factory.ts`, in the overrides type after `releasedAt?: Date | null`:

```ts
  /** The register's stated release day. Defaults to null. */
  statedReleaseDate?: Date | null
```

and in `data` after `releasedAt: overrides.releasedAt ?? null,`:

```ts
      statedReleaseDate: overrides.statedReleaseDate ?? null,
```

- [ ] **Step 7: Run the file, type check, commit**

Run: `node node_modules/vitest/vitest.mjs run tests/import/upsert.test.ts`
Expected: PASS, whole file.

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no output.

```bash
git add prisma/schema.prisma prisma/migrations/20260928000100_check_stated_release_date/migration.sql tests/import/upsert.test.ts tests/helpers/factory.ts
git commit -m "feat(schema): Check.statedReleaseDate — the register's stated release day, apart from releasedAt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The query — either date matches, `noReleaseDate`, table row

**Files:**
- Modify: `lib/queries.ts` (`CheckFilters`, `buildWhere`, `CheckTableRow`, `toTableRow`)
- Modify: `app/page.tsx` (the disclosure count's `releasedAtIsNull: true`)
- Test: `tests/queries.test.ts` (`describe('DATE RELEASED range')`)

**Interfaces:**
- Consumes: `Check.statedReleaseDate` (Task 1).
- Produces: `CheckFilters.noReleaseDate?: true` (replaces `releasedAtIsNull`); `CheckTableRow.statedReleaseDate: Date | null`.

- [ ] **Step 1: Rewrite the tests**

In `tests/queries.test.ts`, inside `describe('DATE RELEASED range')`, replace the case `counts the released cheques with no recorded release, for the disclosure` with:

```ts
  it('counts, for the disclosure, only the released cheques with neither date', async () => {
    await makeCheck({ status: 'RELEASED', releasedAt: new Date('2026-09-25T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED' })
    await makeCheck({ status: 'RELEASED' })
    // Live, so no release date of either kind — must NOT be counted.
    await makeCheck({ status: 'SIGNED' })

    expect(await countChecks(testDb, { status: 'RELEASED', noReleaseDate: true })).toBe(2)
  })
```

and add these cases to the same describe:

```ts
  // The register's stated day is stored as UTC midnight — 08:00 Manila — so it
  // sits inside the Manila-day bounds the resolver builds.
  it('matches a cheque on its stated release day when the app recorded no release', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'S-IN', statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'S-OUT', statedReleaseDate: new Date('2026-09-22T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'S-NONE' })

    const rows = await listChecks(testDb, { status: 'RELEASED', releasedFrom: from, releasedTo: to })
    expect(rows.map((r) => r.checkNumber)).toEqual(['S-IN'])
  })

  it('matches on either date when a cheque carries both', async () => {
    // App says the 25th, register says the 22nd: inside on the app date.
    await makeCheck({ status: 'RELEASED', checkNumber: 'B-APP', releasedAt: new Date('2026-09-25T02:00:00.000Z'), statedReleaseDate: new Date('2026-09-22T00:00:00.000Z') })
    // App says the 20th, register says the 25th: inside on the stated date.
    await makeCheck({ status: 'RELEASED', checkNumber: 'B-REG', releasedAt: new Date('2026-09-20T02:00:00.000Z'), statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    // Both outside.
    await makeCheck({ status: 'RELEASED', checkNumber: 'B-OUT', releasedAt: new Date('2026-09-20T02:00:00.000Z'), statedReleaseDate: new Date('2026-09-22T00:00:00.000Z') })

    const rows = await listChecks(testDb, { status: 'RELEASED', releasedFrom: from, releasedTo: to })
    expect(rows.map((r) => r.checkNumber).sort()).toEqual(['B-APP', 'B-REG'])
  })

  // The range lives under AND so it composes with the search, which owns the
  // top-level OR. Without that wrapping one of the two would silently replace
  // the other.
  it('still composes with a search', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'Q-IN-MATCH', payeeName: 'ACME TRADING', statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'Q-IN-OTHER', payeeName: 'HENKEL', statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'Q-OUT-MATCH', payeeName: 'ACME TRADING', statedReleaseDate: new Date('2026-09-22T00:00:00.000Z') })

    const rows = await listChecks(testDb, { status: 'RELEASED', q: 'acme', releasedFrom: from, releasedTo: to })
    expect(rows.map((r) => r.checkNumber)).toEqual(['Q-IN-MATCH'])
  })

  it('carries the stated day into the table row', async () => {
    const day = new Date('2026-09-25T00:00:00.000Z')
    const c = await makeCheck({ status: 'RELEASED', statedReleaseDate: day })
    const [row] = await listChecks(testDb, { q: c.checkNumber })
    expect(toTableRow(row).statedReleaseDate).toEqual(day)
    expect(toTableRow(row).releasedAt).toBeNull()
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run tests/queries.test.ts -t "DATE RELEASED"`
Expected: FAIL — the stated-day cases return no rows, `noReleaseDate` is ignored (count 4), `statedReleaseDate` undefined on the row.

- [ ] **Step 3: `CheckFilters`**

In `lib/queries.ts`, replace the `releasedAtIsNull` field and its comment with:

```ts
  /**
   * Only the cheques with NO release date of either kind — `releasedAt` null
   * and `statedReleaseDate` null. The disclosure's count, taken through the
   * same `buildWhere` as the table so it is narrowed by the same company,
   * bank, search and incompleteness. When set it replaces the range, never
   * combines with it — a cheque cannot be both.
   */
  noReleaseDate?: true
```

and extend the `releasedFrom` / `releasedTo` comment's last paragraph to read:

```ts
   * Since 2026-09-28 the range also matches `statedReleaseDate` — the day the
   * retired register states for a release the app never recorded — so a
   * cheque matches when EITHER date falls inside it. The two are never merged.
```

- [ ] **Step 4: `buildWhere`**

Replace the released block:

```ts
  if (filters.noReleaseDate) {
    where.releasedAt = null
    where.statedReleaseDate = null
  } else if (filters.releasedFrom || filters.releasedTo) {
    // Either date. Under AND rather than on `where.OR`, which the search owns
    // below — two top-level ORs would not both apply, the second would
    // replace the first. A null date satisfies neither bound, so a cheque with
    // neither date is left out without an extra clause.
    const bounds = { gte: filters.releasedFrom, lte: filters.releasedTo }
    where.AND = [{ OR: [{ releasedAt: bounds }, { statedReleaseDate: bounds }] }]
  }
```

- [ ] **Step 5: Table row**

In `CheckTableRow`, after `releasedAt: Date | null`:

```ts
  /** The register's stated release day, when the app recorded no release. Shown tagged REGISTER. */
  statedReleaseDate: Date | null
```

In `toTableRow`, after `releasedAt: r.releasedAt,`:

```ts
    statedReleaseDate: r.statedReleaseDate,
```

- [ ] **Step 6: The page's count**

In `app/page.tsx`, in the third `countChecks` call, replace `releasedAtIsNull: true,` with `noReleaseDate: true,`.

- [ ] **Step 7: Run, fix the workbook fixture, type check, commit**

Run: `node node_modules/vitest/vitest.mjs run tests/queries.test.ts`
Expected: PASS, whole file.

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: one error in `tests/export/workbook.test.ts`, the `row()` fixture missing `statedReleaseDate`. Add `statedReleaseDate: null,` after `releasedAt: null,` there and re-run: no output.

```bash
git add lib/queries.ts app/page.tsx tests/queries.test.ts tests/export/workbook.test.ts
git commit -m "feat(queries): the DATE RELEASED range matches releasedAt or statedReleaseDate; noReleaseDate counts neither

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The backfill module

**Files:**
- Create: `lib/admin/stated-release-dates.ts`
- Test: `tests/admin/stated-release-dates.test.ts` (new)

**Interfaces:**
- Consumes: `readRegisterReleases`, `RegisterRelease` from `lib/admin/register-releases.ts`; `isIsoDay` from `lib/domain/details.ts`; `writeAudit` from `lib/audit.ts`; `makeCheck({ statedReleaseDate })` (Task 1).
- Produces: `STATED_RELEASE_DATE_ACTION`, `statedDay`, `dayToDate`, `dateToDay`, `judge`, `planStatedReleaseDates`, `snapshotOf`, `applyStatedReleaseDates`, types `Candidate`, `Verdict`, `StatedPlan`.

- [ ] **Step 1: Write the failing tests**

Create `tests/admin/stated-release-dates.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import type { CompanyReferenceData } from '@/lib/import/company'
import type { RawRow } from '@/lib/import/workbook'
import type { RegisterRelease } from '@/lib/admin/register-releases'
import {
  statedDay, dayToDate, dateToDay, judge, planStatedReleaseDates, applyStatedReleaseDates, snapshotOf,
  STATED_RELEASE_DATE_ACTION, type Candidate,
} from '@/lib/admin/stated-release-dates'

const REF: CompanyReferenceData = {
  cashAccounts: [{ code: 'BPI STK', company: 'STK' }],
  checkBooks: [{ code: 'BPI-S-4636', company: 'STK' }, { code: 'MBT-A-4155', company: 'A1+' }],
}

const HEADER = [
  'REMARKS', 'PO NUMBER', 'CHECK NUMBER', 'CHECKS APV', 'PAYEE', 'DESCRIPTION', 'TYPE',
  'VOUCHER NUMBER', 'CHECK DATE', 'CHECK AMOUNT', 'DATE RELEASED', 'REMARKS',
]

/** A register row as the RELEASED sheets lay it out. Serial 46290 = 2026-09-25. */
function row(sheet: string, n: number, checkNumber: string, book: string | null = 'BPI-S-4636', released: unknown = 46290): RawRow {
  return {
    sheet, row: n, header: HEADER,
    cells: ['PAID', null, checkNumber, 'CV-ST011550', 'SUPPLIER INC.', null, book, 'AP-ST036198', 46014, 7950, released, 'DEPOSITED'],
  }
}

const release = (rows: RegisterRelease['rows'], companyCodes: string[] = ['STK']): RegisterRelease =>
  ({ checkNumber: '6000308584', companyCodes, rows })

describe('statedDay', () => {
  it('is the one day the rows state, ignoring blanks and text', () => {
    expect(statedDay(release([
      { sheet: 'A', row: 1, dateReleased: '2026-09-25' },
      { sheet: 'B', row: 2, dateReleased: null },
      { sheet: 'C', row: 3, dateReleased: 'SEPT 25' },
      { sheet: 'D', row: 4, dateReleased: '2026-09-25' },
    ]))).toEqual({ kind: 'DAY', day: '2026-09-25' })
  })

  it('refuses two different days rather than picking one', () => {
    expect(statedDay(release([
      { sheet: 'A', row: 1, dateReleased: '2026-09-25' },
      { sheet: 'B', row: 2, dateReleased: '2026-09-22' },
    ]))).toEqual({ kind: 'CONFLICTING_DATES', days: ['2026-09-22', '2026-09-25'] })
  })

  it('reports text and blanks as no usable date, keeping the text for a human', () => {
    expect(statedDay(release([{ sheet: 'A', row: 1, dateReleased: 'SEPT 22' }, { sheet: 'B', row: 2, dateReleased: null }])))
      .toEqual({ kind: 'NO_USABLE_DATE', verbatim: ['SEPT 22'] })
    expect(statedDay(release([]))).toEqual({ kind: 'NO_USABLE_DATE', verbatim: [] })
  })

  it('does not accept a day that is not on the calendar', () => {
    expect(statedDay(release([{ sheet: 'A', row: 1, dateReleased: '2026-02-30' }])))
      .toEqual({ kind: 'NO_USABLE_DATE', verbatim: ['2026-02-30'] })
  })
})

describe('day conversion', () => {
  it('stores a day as its UTC midnight and reads it back unchanged', () => {
    expect(dayToDate('2026-09-25').toISOString()).toBe('2026-09-25T00:00:00.000Z')
    expect(dateToDay(new Date('2026-09-25T00:00:00.000Z'))).toBe('2026-09-25')
  })
})

describe('judge', () => {
  const rel = release([{ sheet: 'BPI RELEASED', row: 5, dateReleased: '2026-09-25' }])
  const c = (o: Partial<Candidate> = {}): Candidate => ({
    id: 'x', checkNumber: '6000308584', companyCode: 'STK', status: 'RELEASED', statedReleaseDate: null, ...o,
  })

  it('writes the day onto the one RELEASED cheque with that number', () => {
    expect(judge(rel, [c()])).toEqual({ kind: 'WRITE', check: c(), day: '2026-09-25' })
  })

  it('matches on the number even when the register names another company', () => {
    expect(judge(rel, [c({ id: 'a', companyCode: 'A1+' })])).toMatchObject({ kind: 'WRITE', check: { id: 'a' } })
  })

  it('uses the register’s company only to break a tie', () => {
    expect(judge(rel, [c({ id: 'a', companyCode: 'A1+' }), c({ id: 'b' })])).toMatchObject({ kind: 'WRITE', check: { id: 'b' } })
    expect(judge(rel, [c({ id: 'a', companyCode: 'A1+' }), c({ id: 'b', companyCode: 'IND' })])).toEqual({ kind: 'AMBIGUOUS', count: 2 })
    expect(judge(release(rel.rows, []), [c({ id: 'a' }), c({ id: 'b' })])).toEqual({ kind: 'AMBIGUOUS', count: 2 })
  })

  it('leaves a cheque that is absent, not released here, or already stated', () => {
    expect(judge(rel, [])).toEqual({ kind: 'NOT_IN_SYSTEM' })
    expect(judge(rel, [c({ status: 'SIGNED' })])).toMatchObject({ kind: 'NOT_RELEASED_HERE' })
    expect(judge(rel, [c({ status: 'CANCELLED' })])).toMatchObject({ kind: 'NOT_RELEASED_HERE' })
    expect(judge(rel, [c({ statedReleaseDate: dayToDate('2026-09-25') })])).toMatchObject({ kind: 'ALREADY_STATED' })
  })

  it('never overwrites a different stated day', () => {
    expect(judge(rel, [c({ statedReleaseDate: dayToDate('2026-09-22') })]))
      .toMatchObject({ kind: 'DIFFERENT_DATE_STATED', stated: '2026-09-22', day: '2026-09-25' })
  })

  it('reports an unusable or conflicting date before looking anything up', () => {
    expect(judge(release([{ sheet: 'A', row: 1, dateReleased: 'SEPT 25' }]), [c()])).toEqual({ kind: 'NO_USABLE_DATE', verbatim: ['SEPT 25'] })
    expect(judge(release([{ sheet: 'A', row: 1, dateReleased: '2026-09-25' }, { sheet: 'B', row: 2, dateReleased: '2026-09-24' }]), [c()]))
      .toEqual({ kind: 'CONFLICTING_DATES', days: ['2026-09-24', '2026-09-25'] })
  })
})

describe('plan and apply', () => {
  beforeEach(resetDb)

  it('writes the stated day and one audit row, touches nothing else, and a second run does nothing', async () => {
    const released = await makeCheck({ status: 'RELEASED', checkNumber: '7000000001' })
    const signed = await makeCheck({ status: 'SIGNED', checkNumber: '7000000002' })
    const text = await makeCheck({ status: 'RELEASED', checkNumber: '7000000003' })
    const raw = [
      row('STK P&P RELEASED', 5, '7000000001', null),
      row('STK P&P RELEASED', 6, '7000000002', null),
      row('STK P&P RELEASED', 7, '7000000003', null, 'SEPT 25'),
    ]

    const plan = await planStatedReleaseDates(testDb, 'REGISTER.xlsx', raw, REF)
    expect(plan.toWrite.map((t) => [t.check.id, t.day])).toEqual([[released.id, '2026-09-25']])
    expect(plan.counts.NOT_RELEASED_HERE).toBe(1)
    expect(plan.counts.NO_USABLE_DATE).toBe(1)
    expect(plan.listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkNumber: '7000000002', kind: 'NOT_RELEASED_HERE' }),
      expect.objectContaining({ checkNumber: '7000000003', kind: 'NO_USABLE_DATE', detail: 'SEPT 25' }),
    ]))
    expect(snapshotOf(plan, new Date()).rows).toEqual([
      expect.objectContaining({ id: released.id, status: 'RELEASED', statedReleaseDate: null }),
    ])

    expect(await applyStatedReleaseDates(testDb, plan)).toEqual({ written: 1, raced: 0 })

    const after = Object.fromEntries((await testDb.check.findMany()).map((c) => [c.id, c]))
    expect(after[released.id].statedReleaseDate).toEqual(dayToDate('2026-09-25'))
    expect(after[released.id].releasedAt).toBeNull()
    expect(after[released.id].releasedById).toBeNull()
    expect(after[released.id].status).toBe('RELEASED')
    expect(after[signed.id].statedReleaseDate).toBeNull()
    expect(after[signed.id].status).toBe('SIGNED')
    expect(after[text.id].statedReleaseDate).toBeNull()

    const audit = await testDb.auditLog.findMany({ where: { action: STATED_RELEASE_DATE_ACTION } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ checkId: released.id, actorType: 'SYSTEM', userId: null })
    expect(audit[0].details).toMatchObject({
      file: 'REGISTER.xlsx', statedReleaseDate: '2026-09-25',
      registerRows: [{ sheet: 'STK P&P RELEASED', row: 5, dateReleased: '2026-09-25' }],
    })

    const again = await planStatedReleaseDates(testDb, 'REGISTER.xlsx', raw, REF)
    expect(again.toWrite).toEqual([])
    expect(again.counts.ALREADY_STATED).toBe(1)
  })

  it('also writes the stated day onto a cheque the app released, leaving the timestamp alone', async () => {
    const when = new Date('2026-09-25T02:00:00.000Z')
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '7000000004', releasedAt: when })
    const plan = await planStatedReleaseDates(testDb, 'R.xlsx', [row('BPI RELEASED', 2, '7000000004', null)], REF)
    expect(await applyStatedReleaseDates(testDb, plan)).toEqual({ written: 1, raced: 0 })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.releasedAt).toEqual(when)
    expect(after.statedReleaseDate).toEqual(dayToDate('2026-09-25'))
  })

  it('skips a cheque that changed between the plan and the write', async () => {
    const c = await makeCheck({ status: 'RELEASED', checkNumber: '7000000009' })
    const plan = await planStatedReleaseDates(testDb, 'R.xlsx', [row('BPI RELEASED', 2, '7000000009', null)], REF)
    await testDb.check.update({ where: { id: c.id }, data: { statedReleaseDate: dayToDate('2026-09-20') } })
    expect(await applyStatedReleaseDates(testDb, plan)).toEqual({ written: 0, raced: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).statedReleaseDate).toEqual(dayToDate('2026-09-20'))
    expect(await testDb.auditLog.count({ where: { action: STATED_RELEASE_DATE_ACTION } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/admin/stated-release-dates.test.ts`
Expected: FAIL to import — the module does not exist.

- [ ] **Step 3: Implement**

Create `lib/admin/stated-release-dates.ts`:

```ts
import type { CheckStatus, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { isIsoDay } from '@/lib/domain/details'
import type { CompanyReferenceData } from '@/lib/import/company'
import type { RawRow } from '@/lib/import/workbook'
import { readRegisterReleases, type RegisterReading, type RegisterRelease } from './register-releases'

/**
 * Give a cheque released outside this app the day the retired register states.
 *
 * WHY. The DATE RELEASED filter reads `releasedAt`, which only `markReleased`
 * writes. The 228 pick-ups of 25 September 2026 were moved to RELEASED by the
 * register catch-up with no timestamp — correctly, because a spreadsheet
 * cannot say when a cheque changed hands — and so the filter could not find
 * them. The user's ruling (2026-09-28): "it should have the date stated in the
 * summary". This writes that stated day into ITS OWN column,
 * `statedReleaseDate`, and never into `releasedAt`: the app's timestamp keeps
 * meaning "released through this system" (which `lib/recon/outstanding.ts`
 * relies on), and the register's day — hand-typed into a file whose amounts
 * and companies were measured wrong at scale — is shown apart and tagged.
 *
 * WHAT IT READS. `readRegisterReleases`, unchanged: every cheque the register
 * shows picked up, with each RELEASED-sheet row's DATE RELEASED as
 * `YYYY-MM-DD` when the cell was a date, verbatim text otherwise, null when
 * blank. A day is written only when the cheque's rows state exactly ONE
 * calendar day; text ("SEPT 22") is listed for a human and never parsed.
 *
 * WHAT IT MATCHES. The cheque number is the identity and the register's
 * company only breaks a tie — the rule `judge` in register-releases.ts
 * applies, for the measured reason given there. Only a cheque RELEASED here
 * qualifies; one already carrying the same day is skipped, one carrying a
 * different day is listed and left.
 *
 * WHAT IT WRITES. `statedReleaseDate` and one SYSTEM audit row. Nothing else.
 * Dry run by default; snapshot first on --apply; idempotent.
 */

export const STATED_RELEASE_DATE_ACTION = 'stated_release_date_from_register'

/** Same override as `lib/import/upsert.ts` — see CLAUDE.md on Prisma's defaults. */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

export type StatedDay =
  | { kind: 'DAY'; day: string }
  | { kind: 'CONFLICTING_DATES'; days: string[] }
  | { kind: 'NO_USABLE_DATE'; verbatim: string[] }

/** Pure. The one calendar day a cheque's RELEASED rows state, or why there is none. */
export function statedDay(release: RegisterRelease): StatedDay {
  const stated = release.rows.map((r) => r.dateReleased).filter((d): d is string => d !== null)
  const days = [...new Set(stated.filter(isIsoDay))].sort()
  if (days.length === 1) return { kind: 'DAY', day: days[0] }
  if (days.length > 1) return { kind: 'CONFLICTING_DATES', days }
  return { kind: 'NO_USABLE_DATE', verbatim: [...new Set(stated)] }
}

/** `YYYY-MM-DD` as the day's UTC midnight — the convention `checkDate` follows. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

export function dateToDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export type Candidate = {
  id: string
  checkNumber: string
  companyCode: string
  status: CheckStatus
  statedReleaseDate: Date | null
}

export type Verdict =
  | { kind: 'WRITE'; check: Candidate; day: string }
  | { kind: 'NOT_IN_SYSTEM' }
  | { kind: 'AMBIGUOUS'; count: number }
  | { kind: 'NOT_RELEASED_HERE'; check: Candidate }
  | { kind: 'ALREADY_STATED'; check: Candidate }
  | { kind: 'DIFFERENT_DATE_STATED'; check: Candidate; stated: string; day: string }
  | { kind: 'CONFLICTING_DATES'; days: string[] }
  | { kind: 'NO_USABLE_DATE'; verbatim: string[] }

/** Pure. Exactly one RELEASED cheque and exactly one stated day, or nothing is written. */
export function judge(release: RegisterRelease, candidates: readonly Candidate[]): Verdict {
  const stated = statedDay(release)
  if (stated.kind !== 'DAY') return stated

  const same = candidates.filter((c) => c.checkNumber === release.checkNumber)
  const narrowed = same.length > 1 && release.companyCodes.length === 1
    ? same.filter((c) => c.companyCode === release.companyCodes[0])
    : same
  if (same.length === 0) return { kind: 'NOT_IN_SYSTEM' }
  if (narrowed.length === 0) return { kind: 'AMBIGUOUS', count: same.length }
  if (narrowed.length > 1) return { kind: 'AMBIGUOUS', count: narrowed.length }

  const check = narrowed[0]
  if (check.status !== 'RELEASED') return { kind: 'NOT_RELEASED_HERE', check }
  if (check.statedReleaseDate) {
    const existing = dateToDay(check.statedReleaseDate)
    if (existing === stated.day) return { kind: 'ALREADY_STATED', check }
    return { kind: 'DIFFERENT_DATE_STATED', check, stated: existing, day: stated.day }
  }
  return { kind: 'WRITE', check, day: stated.day }
}

export type StatedPlan = {
  file: string
  toWrite: { release: RegisterRelease; check: Candidate; day: string }[]
  counts: Record<Exclude<Verdict['kind'], 'WRITE'>, number>
  /** What a human should look at: everything left alone for a stated reason. */
  listed: { checkNumber: string; kind: Verdict['kind']; detail: string }[]
  reading: RegisterReading
}

export async function planStatedReleaseDates(
  db: PrismaClient, file: string, raw: RawRow[], ref: CompanyReferenceData,
): Promise<StatedPlan> {
  const reading = readRegisterReleases(raw, ref)
  const numbers = reading.released.map((r) => r.checkNumber)

  const found = await db.check.findMany({
    where: { checkNumber: { in: numbers } },
    select: { id: true, checkNumber: true, status: true, statedReleaseDate: true, company: { select: { code: true } } },
  })
  const byNumber = new Map<string, Candidate[]>()
  for (const f of found) {
    const c: Candidate = {
      id: f.id, checkNumber: f.checkNumber, companyCode: f.company.code,
      status: f.status, statedReleaseDate: f.statedReleaseDate,
    }
    byNumber.set(c.checkNumber, [...(byNumber.get(c.checkNumber) ?? []), c])
  }

  const plan: StatedPlan = {
    file,
    toWrite: [],
    counts: {
      NOT_IN_SYSTEM: 0, AMBIGUOUS: 0, NOT_RELEASED_HERE: 0, ALREADY_STATED: 0,
      DIFFERENT_DATE_STATED: 0, CONFLICTING_DATES: 0, NO_USABLE_DATE: 0,
    },
    listed: [],
    reading,
  }
  for (const release of reading.released) {
    const v = judge(release, byNumber.get(release.checkNumber) ?? [])
    if (v.kind === 'WRITE') { plan.toWrite.push({ release, check: v.check, day: v.day }); continue }
    plan.counts[v.kind]++
    switch (v.kind) {
      case 'NOT_RELEASED_HERE':
        plan.listed.push({ checkNumber: release.checkNumber, kind: v.kind, detail: v.check.status }); break
      case 'DIFFERENT_DATE_STATED':
        plan.listed.push({ checkNumber: release.checkNumber, kind: v.kind, detail: `${v.stated} here, ${v.day} in the file` }); break
      case 'CONFLICTING_DATES':
        plan.listed.push({ checkNumber: release.checkNumber, kind: v.kind, detail: v.days.join(' / ') }); break
      case 'NO_USABLE_DATE':
        // A blank cell states nothing and needs nobody's eyes; text does.
        if (v.verbatim.length > 0) plan.listed.push({ checkNumber: release.checkNumber, kind: v.kind, detail: v.verbatim.join(' / ') })
        break
      default:
        break
    }
  }
  return plan
}

/** Every cheque about to change, as it stands — CLAUDE.md item 7, built in. */
export function snapshotOf(plan: StatedPlan, takenAt: Date) {
  return {
    takenAt: takenAt.toISOString(),
    file: plan.file,
    rows: plan.toWrite.map(({ check }) => ({
      id: check.id, checkNumber: check.checkNumber, companyCode: check.companyCode,
      status: check.status, statedReleaseDate: check.statedReleaseDate?.toISOString() ?? null,
    })),
  }
}

export async function applyStatedReleaseDates(
  db: PrismaClient, plan: StatedPlan,
): Promise<{ written: number; raced: number }> {
  let written = 0
  let raced = 0
  for (const { release, check, day } of plan.toWrite) {
    await db.$transaction(async (tx) => {
      // The planned state re-asserted: still RELEASED, still no stated day. A
      // cheque somebody changed between the plan and now matches nothing.
      const { count } = await tx.check.updateMany({
        where: { id: check.id, status: 'RELEASED', statedReleaseDate: null },
        data: { statedReleaseDate: dayToDate(day) },
      })
      if (count === 0) { raced++; return }
      await writeAudit(tx, {
        checkId: check.id,
        actorType: 'SYSTEM',
        action: STATED_RELEASE_DATE_ACTION,
        details: {
          file: plan.file,
          statedReleaseDate: day,
          registerRows: release.rows,
        },
        remarks:
          `${plan.file} states DATE RELEASED ${day} for this cheque (${release.rows.map((r) => `${r.sheet} row ${r.row}`).join(', ')}). ` +
          'Recorded as the stated release day on the request of 2026-09-28 so the DATE RELEASED filter can find it. ' +
          'Only statedReleaseDate was written; releasedAt, releasedById and the status are untouched — ' +
          'the app did not record this release and does not claim to have.',
      })
      written++
    }, TX_OPTIONS)
  }
  return { written, raced }
}
```

- [ ] **Step 4: Run to verify it passes, type check, commit**

Run: `node node_modules/vitest/vitest.mjs run tests/admin/stated-release-dates.test.ts`
Expected: PASS, 15 cases.

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no output.

```bash
git add lib/admin/stated-release-dates.ts tests/admin/stated-release-dates.test.ts
git commit -m "feat(admin): stated-release-dates backfill — the register's stated day onto RELEASED cheques, apart from releasedAt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The script, the table, the disclosure, the notes

**Files:**
- Create: `scripts/backfill-stated-release-dates.ts`
- Modify: `components/CheckTable.tsx` (the DATE RELEASED cell)
- Modify: `app/page.tsx` (the disclosure line's wording)
- Modify: `CLAUDE.md` (the DATE RELEASED paragraph; the commands block)

**Interfaces:**
- Consumes: everything Task 3 produces; `CheckTableRow.statedReleaseDate` (Task 2).

- [ ] **Step 1: The script**

Create `scripts/backfill-stated-release-dates.ts`:

```ts
import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { loadCompanyReferenceData } from '../lib/import/reference'
import { readWorkbook } from '../lib/import/workbook'
import {
  applyStatedReleaseDates, planStatedReleaseDates, snapshotOf,
} from '../lib/admin/stated-release-dates'

/**
 * Write the register's stated DATE RELEASED onto the RELEASED cheques it names,
 * into `statedReleaseDate` — never `releasedAt`. See
 * `lib/admin/stated-release-dates.ts` for what it will and will not touch.
 *
 *   npx.cmd tsx scripts/backfill-stated-release-dates.ts "CHECK MONITORING 9.25.2026.xlsx"          # dry run
 *   npx.cmd tsx scripts/backfill-stated-release-dates.ts "CHECK MONITORING 9.25.2026.xlsx" --apply  # snapshot, then write
 *
 * Dry run by default. `--apply` writes `snapshots/stated-release-dates-<ts>.json`
 * first. Prints counts and cheque numbers only — never a payee, never an amount.
 * Reads `DATABASE_URL`, which on this machine is PRODUCTION. Idempotent: a
 * second run finds every one of them ALREADY_STATED.
 */

const APPLY = process.argv.includes('--apply')
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && a !== '--apply')
const n = (v: number) => v.toLocaleString('en-PH')
const line = (label: string, value: number) => console.log('  ' + label.padEnd(48) + n(value).padStart(8))

async function main(): Promise<void> {
  if (unknown.length > 0) throw new Error(`Unrecognised option(s): ${unknown.join(', ')}`)
  if (files.length !== 1) throw new Error('Usage: backfill-stated-release-dates.ts <register.xlsx> [--apply]')
  const file = basename(files[0])

  const db = new PrismaClient()
  try {
    const raw = await readWorkbook(await readFile(files[0]))
    const ref = await loadCompanyReferenceData(db)
    const plan = await planStatedReleaseDates(db, file, raw, ref)

    console.log(`\nREGISTER  ${file}`)
    line('cheques the register says were picked up', plan.reading.released.length)
    line('sheet clash nobody has ruled on (left)', plan.reading.unruled.length)

    console.log('\nAGAINST THIS SYSTEM')
    line('WILL WRITE statedReleaseDate', plan.toWrite.length)
    line('already carrying that day (skipped)', plan.counts.ALREADY_STATED)
    line('carrying a DIFFERENT day (left, listed)', plan.counts.DIFFERENT_DATE_STATED)
    line('not RELEASED here (left, listed)', plan.counts.NOT_RELEASED_HERE)
    line('rows state two different days (left, listed)', plan.counts.CONFLICTING_DATES)
    line('no usable date in the file (left)', plan.counts.NO_USABLE_DATE)
    line('no cheque here (left; the sync creates cheques)', plan.counts.NOT_IN_SYSTEM)
    line('more than one cheque here (left)', plan.counts.AMBIGUOUS)

    const byDay = new Map<string, number>()
    for (const { day } of plan.toWrite) byDay.set(day, (byDay.get(day) ?? 0) + 1)
    console.log('\n  stated days about to be written (latest first, top 15)')
    for (const [k, v] of [...byDay].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 15)) line(`  ${k}`, v)

    if (plan.listed.length > 0) {
      console.log('\nLEFT ALONE, for a human')
      for (const l of plan.listed) console.log(`     ${l.checkNumber}  ${l.kind}  ${l.detail}`)
    }

    if (!APPLY) { console.log('\nDRY RUN — nothing was written. Re-run with --apply.\n'); return }
    if (plan.toWrite.length === 0) { console.log('\nNothing to write.\n'); return }

    const takenAt = new Date()
    const dir = join(process.cwd(), 'snapshots')
    await mkdir(dir, { recursive: true })
    const snap = join(dir, `stated-release-dates-${takenAt.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify(snapshotOf(plan, takenAt), null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const out = await applyStatedReleaseDates(db, plan)
    console.log('\nDONE')
    line('stated days written', out.written)
    line('skipped: changed since the plan', out.raced)
    console.log('')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
```

- [ ] **Step 2: The table cell**

In `components/CheckTable.tsx`, replace the `releasedAt` cell:

```tsx
                {shows('releasedAt') && (
                  // The app's own timestamp when it has one; otherwise the day
                  // the retired register stated, tagged so nobody reads a
                  // spreadsheet date as a release this system recorded.
                  <td className="px-4 py-3 text-slate-600">
                    {r.releasedAt
                      ? fmtDate(r.releasedAt)
                      : r.statedReleaseDate
                        ? <>{fmtDate(r.statedReleaseDate)}<span className="ml-1 text-[10px] font-semibold tracking-widest text-slate-400">REGISTER</span></>
                        : '—'}
                  </td>
                )}
```

- [ ] **Step 3: The disclosure wording**

In `app/page.tsx`, replace the NOT MATCHED paragraph's text:

```tsx
        <p className="text-xs font-medium tracking-wide text-slate-500">
          NOT MATCHED: {undatedReleases.toLocaleString('en-PH')} RELEASED{' '}
          {undatedReleases === 1 ? 'CHEQUE CARRIES' : 'CHEQUES CARRY'} NO RELEASE DATE — neither recorded
          here nor stated in the register. Only a cheque with one of those dates can fall inside a range.
        </p>
```

and update the comment block above it: replace its last two sentences with

```
          Since 2026-09-28 the register's stated day fills the gap for the
          cheques it names (`statedReleaseDate`, its own column); what is left
          is the cheques with neither date, and this line counts exactly those.
```

- [ ] **Step 4: The notes**

In `CLAUDE.md`, replace the DATE RELEASED paragraph in "Things that will catch you out" with:

```markdown
**DATE RELEASED on the filter bar matches either of two dates that are never merged**
(2026-09-28, specs `2026-09-28-released-date-filter-design.md` and
`2026-09-28-stated-release-date-design.md`). `releasedAt` is the app's own record of a
release and only `markReleased` writes it; `statedReleaseDate` is the day the retired
register states, written once by `scripts/backfill-stated-release-dates.ts` from the
RELEASED sheets of a register file (exactly one calendar day per cheque, exactly one
RELEASED cheque per number, never overwritten, one `stated_release_date_from_register`
audit row each, snapshot first). `releasedFrom` / `releasedTo` are Manila days, honoured
only on the RELEASED and ALL CHEQUES views; the table shows the app timestamp or, failing
that, the stated day tagged REGISTER; the LIST screen counts the cheques with neither. Do
not write the stated day into `releasedAt`, and do not read `statedReleaseDate` as "the app
recorded a release" — `lib/recon/outstanding.ts` deliberately reads only `releasedAt`.
```

In the commands block, after the `backfill-released-from-register.ts` lines:

```bash
npx tsx scripts/backfill-stated-release-dates.ts "CHECK MONITORING 9.25.2026.xlsx"            # dry run: the register's DATE RELEASED onto RELEASED cheques
npx tsx scripts/backfill-stated-release-dates.ts "<register>.xlsx" --apply                     # snapshot, then statedReleaseDate only, one audit row each
```

- [ ] **Step 5: Type check, then the dry run against production (read-only)**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no output.

Run: `node node_modules/tsx/dist/cli.mjs scripts/backfill-stated-release-dates.ts "CHECK MONITORING 9.25.2026.xlsx"`
Expected: the counts block, the stated-days block, and `DRY RUN — nothing was written.` Read the counts. The WILL WRITE number should be in the region of 10,000 and the 2026-09-25 line in the region of 228. If the script fails on the production column not existing, that is the production migration not yet applied — stop and report; do not apply it.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-stated-release-dates.ts components/CheckTable.tsx app/page.tsx CLAUDE.md
git commit -m "feat(dashboard): stated release day shown tagged REGISTER; backfill script; disclosure counts cheques with neither date

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The gate, then stop for the user

- [ ] **Step 1: Touched files, one at a time**

```
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run tests/import/upsert.test.ts
node node_modules/vitest/vitest.mjs run tests/queries.test.ts
node node_modules/vitest/vitest.mjs run tests/admin/stated-release-dates.test.ts
node node_modules/vitest/vitest.mjs run tests/admin/register-releases.test.ts
node node_modules/vitest/vitest.mjs run tests/export/workbook.test.ts
node node_modules/vitest/vitest.mjs run tests/schema.test.ts
```

Expected: `tsc` silent; every file PASS.

- [ ] **Step 2: Report and stop**

State the dry-run counts, the test counts, and the three steps that are the user's: the full suite before merge, `node scripts/migrate.mjs prod --confirm` before the deploy, and the `--apply` run after it. Do not run any of the three unprompted.
