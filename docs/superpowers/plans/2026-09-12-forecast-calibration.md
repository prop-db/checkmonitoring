# Forecast Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finance can type the day a cheque is expected to leave the bank, and can type planned non-cheque outflows; `/forecast` and its extract place both alongside the cheques.

**Architecture:** One additive migration (a `Check` column, a `PlannedOutflow` table). The expected date rides the existing `updateDetails` path as a fifth detail field held as an ISO day string in the pure layer. Planned lines get a pure rules module (`lib/domain/planned-outflow.ts`), four writers in `lib/planned-outflow/actions.ts` (one transaction each, one audit row each), a read module, and a screen at `/forecast/planned`. The forecast query gains `listPlannedRows`; `ForecastRow` gains `kind` and `expectedOutflowDate`; the matrix chooses the bucketing date per row; the workbook gains three DETAIL columns.

**Tech Stack:** Next 15 App Router · Prisma 6 · ExcelJS · Vitest · TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-12-forecast-calibration-design.md`. Read it before Task 1.

## Global Constraints

- **`npx.cmd tsc --noEmit` must pass before any task is called done.**
- **On Windows use `npx.cmd` / `npm.cmd`.** A `|` inside `-t` breaks `npx.cmd vitest`; use `node node_modules/vitest/vitest.mjs run … -t "a|b"` for a filtered run.
- **Run ONLY the test files named in the task. Never the full suite.** One test process at a time.
- **Task 1's migration reaches the TEST database before any test runs:** `node scripts/migrate.mjs test`, then `npx.cmd prisma generate`. Production gets it by hand before deploy.
- **Rule 4:** `expectedOutflowDate` is never written by an import; it goes in the upsert test's `NEVER_WRITTEN_BY_IMPORT` list.
- **Rule 7:** `writeAudit` in `lib/audit.ts` is the only writer of audit rows.
- **Rule 8:** amounts are decimal strings end to end. A planned amount is validated as text (`^\d+(\.\d{1,2})?$`, greater than zero), stored `Decimal(18,2)`, read back with `.toFixed(2)`. **No `Decimal` crosses to a client component.**
- **Dates are calendar days** stored at UTC midnight (`new Date(Date.UTC(y, m-1, d))`), as every date column is; shown with `timeZone: 'UTC'` or through `manilaDay` so a day never shifts.
- **Any Finance user** may do everything in this plan. Every page calls `requireUser()` first; every server action calls `requireUser()` first.
- **No delete path for a planned line, and no move out of PAID or CANCELLED.**
- **British spelling in prose. Never commit or print `.env`, credentials or any `.xlsx`. No raw control characters.**
- **Commit messages end with:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma`, `prisma/migrations/20260912000000_planned_outflow_and_expected_date/migration.sql` | **Modify / Create.** The column, the enum, the table, its index, the CHECK constraint, the relations. |
| `tests/import/upsert.test.ts` | **Modify.** `NEVER_WRITTEN_BY_IMPORT` gains `expectedOutflowDate`. |
| `lib/domain/details.ts` | **Modify.** Fifth field; `isoDay`, `dayToDate`, `isIsoDay`. |
| `lib/domain/actions.ts` | **Modify.** `updateDetails` converts the day at the write. |
| `app/checks/actions.ts`, `components/DetailsForm.tsx`, `app/checks/[id]/page.tsx` | **Modify.** EXPECTED OUT on the form and the page. |
| `lib/domain/planned-outflow.ts` | **Create.** Pure: input guard, normaliser, diff. |
| `lib/planned-outflow/actions.ts` | **Create.** `createPlannedOutflow`, `updatePlannedOutflow`, `markPlannedOutflowPaid`, `cancelPlannedOutflow`. |
| `lib/planned-outflow/query.ts` | **Create.** `listPlannedOutflows`, `listBanks`. |
| `lib/forecast/query.ts`, `lib/forecast/matrix.ts`, `lib/forecast-view.ts`, `lib/export/forecast-workbook.ts` | **Modify.** Planned rows, expected dates, the PLANNED stage, the new columns. |
| `app/forecast/planned/actions.ts`, `app/forecast/planned/page.tsx`, `components/PlannedOutflowForm.tsx`, `components/PlannedOutflowList.tsx` | **Create.** The screen. |
| `app/forecast/page.tsx`, `app/api/export/forecast/route.ts` | **Modify.** Both sources, the counts, the PLANNED link. |
| `CLAUDE.md` | **Modify.** Item 10 and the Layout row. |
| Tests | `tests/domain/details.test.ts`, `tests/actions/update-details.test.ts`, `tests/actions/server-actions.test.ts`, `tests/domain/planned-outflow.test.ts`, `tests/planned-outflow/actions.test.ts`, `tests/forecast/query.test.ts`, `tests/forecast/matrix.test.ts`, `tests/forecast-view.test.ts`, `tests/export/forecast-workbook.test.ts`, `tests/export/forecast-route.test.ts` (run only), `tests/actions/planned-outflow-actions.test.ts`. |

---

### Task 1: The migration

**Files:**
- Modify: `prisma/schema.prisma` (models `Check`, `User`, `Bank`, `Company`; new model and enum), `tests/import/upsert.test.ts:~291-300`
- Create: `prisma/migrations/20260912000000_planned_outflow_and_expected_date/migration.sql`
- Test: `tests/import/upsert.test.ts` (the one exhaustiveness case)

**Interfaces:**
- Produces: `Check.expectedOutflowDate: Date | null`; model `PlannedOutflow` with fields exactly as below; enum `PlannedOutflowStatus = PLANNED | PAID | CANCELLED`; relations `Bank.plannedOutflows`, `Company.plannedOutflows`, `User.plannedOutflowsCreated / plannedOutflowsPaid / plannedOutflowsCancelled`.

- [ ] **Step 1: Write the failing test**

In `tests/import/upsert.test.ts`, inside `NEVER_WRITTEN_BY_IMPORT` (the array in `accounts for every column of Check exactly once`), add after the `'remarks', 'pointPerson', 'checksPossession'` line:

```ts
      'expectedOutflowDate',        // typed by Finance on the cheque page (2026-09-12); neither source can know it
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx.cmd vitest run tests/import/upsert.test.ts -t "accounts for every column"`
Expected: FAIL — the column set and the three lists no longer match (the list names a column the model lacks).

- [ ] **Step 3: The schema**

In `prisma/schema.prisma`:

On `model Check`, directly after the `checksPossession   String?` line:
```prisma
  // The day Finance expects the money to leave the bank (2026-09-12). Typed on
  // the cheque page beside remarks; never imported — neither source can know
  // it. The forecast buckets on it when set, else on `checkDate`.
  expectedOutflowDate DateTime?
```

On `model Bank`, after `checkBooks   CheckBook[]`: `  plannedOutflows PlannedOutflow[]`
On `model Company`, after `checks       Check[]`: `  plannedOutflows PlannedOutflow[]`
On `model User`, after `overriddenChecks  Check[]   @relation("eligibilityOverriddenBy")`:
```prisma
  plannedOutflowsCreated   PlannedOutflow[] @relation("PlannedOutflowCreatedBy")
  plannedOutflowsPaid      PlannedOutflow[] @relation("PlannedOutflowPaidBy")
  plannedOutflowsCancelled PlannedOutflow[] @relation("PlannedOutflowCancelledBy")
```

Directly before `model Setting {`:
```prisma
/// An outflow that is not a cheque — payroll, a tax remittance, loan
/// amortisation, a transfer — typed by Finance so the daily cash position is
/// not cheques only (decided 2026-09-12). One-off: a line is typed each time it
/// is due. It stays until somebody marks it PAID or CANCELLED; nothing here is
/// ever deleted, and neither closed status is ever reopened.
model PlannedOutflow {
  id            String               @id @default(cuid())
  /// The day the money leaves the bank. A calendar day at UTC midnight.
  date          DateTime
  amount        Decimal              @db.Decimal(18, 2)
  currency      String               @default("PHP")
  bankId        String
  companyId     String
  description   String
  /// PAYROLL, TAX, LOAN, TRANSFER — free text, upper-cased on save.
  category      String?
  status        PlannedOutflowStatus @default(PLANNED)
  createdById   String
  createdAt     DateTime             @default(now())
  updatedAt     DateTime             @updatedAt
  paidById      String?
  paidAt        DateTime?
  cancelledById String?
  cancelledAt   DateTime?
  cancelReason  String?

  bank        Bank    @relation(fields: [bankId], references: [id])
  company     Company @relation(fields: [companyId], references: [id])
  createdBy   User    @relation("PlannedOutflowCreatedBy", fields: [createdById], references: [id])
  paidBy      User?   @relation("PlannedOutflowPaidBy", fields: [paidById], references: [id])
  cancelledBy User?   @relation("PlannedOutflowCancelledBy", fields: [cancelledById], references: [id])

  @@index([status, date])
}

enum PlannedOutflowStatus {
  PLANNED
  PAID
  CANCELLED
}
```

- [ ] **Step 4: The migration**

Create `prisma/migrations/20260912000000_planned_outflow_and_expected_date/migration.sql`:

```sql
-- The day Finance expects a cheque to leave the bank. Typed, never imported.
ALTER TABLE "Check" ADD COLUMN "expectedOutflowDate" TIMESTAMP(3);

-- Planned non-cheque outflows (2026-09-12). One-off lines; never deleted.
CREATE TYPE "PlannedOutflowStatus" AS ENUM ('PLANNED', 'PAID', 'CANCELLED');

CREATE TABLE "PlannedOutflow" (
    "id"            TEXT NOT NULL,
    "date"          TIMESTAMP(3) NOT NULL,
    "amount"        DECIMAL(18,2) NOT NULL,
    "currency"      TEXT NOT NULL DEFAULT 'PHP',
    "bankId"        TEXT NOT NULL,
    "companyId"     TEXT NOT NULL,
    "description"   TEXT NOT NULL,
    "category"      TEXT,
    "status"        "PlannedOutflowStatus" NOT NULL DEFAULT 'PLANNED',
    "createdById"   TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "paidById"      TEXT,
    "paidAt"        TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt"   TIMESTAMP(3),
    "cancelReason"  TEXT,

    CONSTRAINT "PlannedOutflow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlannedOutflow_status_date_idx" ON "PlannedOutflow"("status", "date");

ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_bankId_fkey"
  FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_paidById_fkey"
  FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "PlannedOutflow_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The actor columns say the same thing the status does, structurally: a PAID
-- line always records who and when; a CANCELLED line always records who, when
-- and why; a PLANNED line records none of them. The same discipline `Check`
-- keeps for its own actor columns.
ALTER TABLE "PlannedOutflow" ADD CONSTRAINT "planned_outflow_status_columns" CHECK (
  (("status" = 'PAID') = ("paidAt" IS NOT NULL AND "paidById" IS NOT NULL))
  AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL))
);
```

- [ ] **Step 5: Migrate the test database, regenerate, run the test**

Run: `node scripts/migrate.mjs test` then `npx.cmd prisma generate`.
Run: `npx.cmd vitest run tests/import/upsert.test.ts -t "accounts for every column"`
Expected: PASS. Then `npx.cmd tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260912000000_planned_outflow_and_expected_date tests/import/upsert.test.ts
git commit -m "feat(schema): expected outflow date on the cheque; planned outflow lines

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: EXPECTED OUT on the cheque

**Files:**
- Modify: `lib/domain/details.ts`, `lib/domain/actions.ts` (`updateDetails`), `app/checks/actions.ts` (`updateDetailsAction`), `components/DetailsForm.tsx`, `app/checks/[id]/page.tsx`
- Test: `tests/domain/details.test.ts`, `tests/actions/update-details.test.ts`, `tests/actions/server-actions.test.ts`

**Interfaces:**
- Produces, from `lib/domain/details.ts`:
  ```ts
  export const DETAIL_FIELDS = ['remarks', 'pointPerson', 'checksPossession', 'category', 'expectedOutflowDate'] as const
  export function isIsoDay(s: string): boolean            // 'YYYY-MM-DD' naming a real day
  export function dayToDate(day: string): Date            // UTC midnight
  export function isoDay(d: Date | null): string | null   // the UTC calendar day
  ```
  `normaliseDetails` throws `DomainError('INVALID_DATE', 'EXPECTED OUT must be a date, YYYY-MM-DD.')` for a non-empty string that is not a day. In `DetailValues`, `expectedOutflowDate` is the ISO day string or null.

- [ ] **Step 1: Write the failing tests**

In `tests/domain/details.test.ts`: change `current` to include `expectedOutflowDate: null`; change the `names the four register fields` case to:

```ts
  it('names the four register fields and the expected outflow date, and no other', () => {
    expect([...DETAIL_FIELDS]).toEqual(['remarks', 'pointPerson', 'checksPossession', 'category', 'expectedOutflowDate'])
  })

  it('keeps the expected outflow date as an ISO day, and refuses anything that is not one', () => {
    expect(normaliseDetails({ expectedOutflowDate: ' 2026-09-20 ' }, current).expectedOutflowDate).toBe('2026-09-20')
    expect(normaliseDetails({ expectedOutflowDate: '' }, current).expectedOutflowDate).toBeNull()
    expect(() => normaliseDetails({ expectedOutflowDate: '20/09/2026' }, current)).toThrow(DomainError)
    expect(() => normaliseDetails({ expectedOutflowDate: '2026-02-30' }, current)).toThrow(DomainError)
  })
```
and add a describe:
```ts
describe('day helpers', () => {
  it('round-trips a day through a UTC-midnight instant', () => {
    expect(dayToDate('2026-09-20').toISOString()).toBe('2026-09-20T00:00:00.000Z')
    expect(isoDay(dayToDate('2026-09-20'))).toBe('2026-09-20')
    expect(isoDay(null)).toBeNull()
    expect(isIsoDay('2026-09-31')).toBe(false)
  })
})
```
Imports: add `dayToDate, isoDay, isIsoDay` and `import { DomainError } from '@/lib/domain/errors'`. The existing `toEqual` in `trims, and stores an empty box as null` must include `expectedOutflowDate: null`.

In `tests/actions/update-details.test.ts` add:

```ts
  it('sets and clears the expected outflow date, as a day on the trail', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    const set = await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { expectedOutflowDate: '2026-09-20' } })
    expect(set.expectedOutflowDate).toEqual(new Date('2026-09-20T00:00:00.000Z'))
    const cleared = await updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { expectedOutflowDate: '' } })
    expect(cleared.expectedOutflowDate).toBeNull()
    const rows = await trail(check.id)
    expect(rows[0].details).toEqual({ expectedOutflowDate: { from: null, to: '2026-09-20' } })
    expect(rows[1].details).toEqual({ expectedOutflowDate: { from: '2026-09-20', to: null } })
  })

  it('refuses a date it cannot read, writing nothing', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED' })
    await expect(updateDetails(testDb, { checkId: check.id, userId: user.id, now: NOW, fields: { expectedOutflowDate: 'next week' } }))
      .rejects.toMatchObject({ code: 'INVALID_DATE' })
    expect(await trail(check.id)).toHaveLength(0)
  })
```
The existing first test's `details` expectation (four fields) still holds — an unsent field is not a change.

In `tests/actions/server-actions.test.ts`, inside `describe('updateDetailsAction')`:
```ts
  it('reads the expected outflow date from the form', async () => {
    const { updateDetailsAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await updateDetailsAction(fd({ checkId: check.id, expectedOutflowDate: '2026-09-20' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.expectedOutflowDate).toEqual(new Date('2026-09-20T00:00:00.000Z'))
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx.cmd vitest run tests/domain/details.test.ts`
Expected: FAIL — five fields expected; helpers missing.

- [ ] **Step 3: The pure module**

`lib/domain/details.ts` becomes:

```ts
import { DomainError } from './errors'

/**
 * THE FOUR THINGS FINANCE TYPED INTO THE REGISTER — AND ONE IT NEVER COULD.
 *
 * Remarks, the point person, who is holding the cheque, and its category
 * (2026-09-11); and, since 2026-09-12, the day Finance expects the money to
 * leave the bank, which the forecast buckets on when it is set.
 *
 * Pure. No status is involved: a note can go on a cancelled cheque. An empty
 * box is stored as null, not as "", so "nothing recorded" stays one value.
 * The category is folded to upper case because the import folds it. The date
 * is held here as an ISO day string — the shape a form sends and an audit row
 * reads — and `updateDetails` converts it to the column's UTC-midnight instant
 * at the write. A string that is not a day is refused, never coerced.
 */

export const DETAIL_FIELDS = ['remarks', 'pointPerson', 'checksPossession', 'category', 'expectedOutflowDate'] as const
export type DetailField = (typeof DETAIL_FIELDS)[number]
export type DetailValues = Record<DetailField, string | null>
/** `undefined` means the form did not send the field; it is left as it is. */
export type DetailInput = Partial<Record<DetailField, string | null | undefined>>
export type DetailChange = { from: string | null; to: string | null }

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for `YYYY-MM-DD` naming a real calendar day (not 2026-02-30). */
export function isIsoDay(s: string): boolean {
  const m = ISO_DAY.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

/** A day as the UTC-midnight instant every date column stores. Caller has checked `isIsoDay`. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/** The UTC calendar day of a stored date column, or null. */
export function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null
}

function clean(value: string | null): string | null {
  const s = (value ?? '').trim()
  return s === '' ? null : s
}

export function normaliseDetails(input: DetailInput, current: DetailValues): DetailValues {
  const out: DetailValues = { ...current }
  for (const field of DETAIL_FIELDS) {
    const v = input[field]
    if (v === undefined) continue
    const cleaned = clean(v)
    if (field === 'expectedOutflowDate' && cleaned !== null && !isIsoDay(cleaned)) {
      throw new DomainError('INVALID_DATE', 'EXPECTED OUT must be a date, YYYY-MM-DD.')
    }
    out[field] = field === 'category' && cleaned !== null ? cleaned.toUpperCase() : cleaned
  }
  return out
}

export function diffDetails(
  before: DetailValues, after: DetailValues,
): Partial<Record<DetailField, DetailChange>> {
  const changes: Partial<Record<DetailField, DetailChange>> = {}
  for (const field of DETAIL_FIELDS) {
    if (before[field] !== after[field]) changes[field] = { from: before[field], to: after[field] }
  }
  return changes
}
```

- [ ] **Step 4: The action**

In `lib/domain/actions.ts`, change the import to `import { normaliseDetails, diffDetails, dayToDate, isoDay, type DetailInput, type DetailValues } from './details'` and in `updateDetails`:

```ts
    const before: DetailValues = {
      remarks: check.remarks, pointPerson: check.pointPerson,
      checksPossession: check.checksPossession, category: check.category,
      expectedOutflowDate: isoDay(check.expectedOutflowDate),
    }
    const after = normaliseDetails(args.fields, before)
    const changes = diffDetails(before, after)
    const changed = Object.keys(changes) as (keyof typeof changes)[]
    if (changed.length === 0) return check

    // The day string becomes the column's instant here and nowhere else.
    const data: Prisma.CheckUncheckedUpdateInput = {}
    for (const field of changed) {
      if (field === 'expectedOutflowDate') data.expectedOutflowDate = after[field] === null ? null : dayToDate(after[field])
      else data[field] = after[field]
    }
```
(`Prisma` is already imported as a type in that file.)

- [ ] **Step 5: The server action, the form, the page**

`app/checks/actions.ts` `updateDetailsAction` — add to `fields`: `expectedOutflowDate: str(formData, 'expectedOutflowDate'),`.

`components/DetailsForm.tsx` — `values` gains `expectedOutflowDate: string | null` (the ISO day). Add, before the REMARKS block inside the grid:

```tsx
        <div>
          <label htmlFor="details-expectedOutflowDate" className={label}>EXPECTED OUT</label>
          <input id="details-expectedOutflowDate" name="expectedOutflowDate" type="date" defaultValue={values.expectedOutflowDate ?? ''} disabled={pending} className={field} />
          <p className="mt-1 text-[11px] text-slate-500">The day the money is expected to leave the bank. The forecast places the cheque on it. Clear it to go back to the cheque date.</p>
        </div>
```

`app/checks/[id]/page.tsx` — import `isoDay` from `@/lib/domain/details`; pass `expectedOutflowDate: isoDay(check.expectedOutflowDate)` in the `DetailsForm` `values`; in the CHECK INFORMATION `<dl>` after the `CHECK DATE` field add `<Field label="EXPECTED OUT" value={fmtDate(check.expectedOutflowDate)} />`.

- [ ] **Step 6: Run the tests and tsc**

Run: `npx.cmd vitest run tests/domain/details.test.ts tests/actions/update-details.test.ts` then `node node_modules/vitest/vitest.mjs run tests/actions/server-actions.test.ts -t "updateDetailsAction"`.
Expected: PASS. Then `npx.cmd tsc --noEmit` — clean.

- [ ] **Step 7: Commit**

```bash
git add lib/domain/details.ts lib/domain/actions.ts app/checks/actions.ts components/DetailsForm.tsx "app/checks/[id]/page.tsx" tests/domain/details.test.ts tests/actions/update-details.test.ts tests/actions/server-actions.test.ts
git commit -m "feat: the day a cheque is expected to leave the bank, typed on the cheque

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Planned outflow lines — rules, writers, reads

**Files:**
- Create: `lib/domain/planned-outflow.ts`, `lib/planned-outflow/actions.ts`, `lib/planned-outflow/query.ts`
- Test: `tests/domain/planned-outflow.test.ts`, `tests/planned-outflow/actions.test.ts`

**Interfaces:**
- Produces, from `lib/domain/planned-outflow.ts`:
  ```ts
  export const MONEY = /^\d+(\.\d{1,2})?$/
  export type PlannedOutflowInput = { date: string; amount: string; currency?: string; bankId: string; companyId: string; description: string; category?: string | null }
  export type PlannedOutflowValues = { date: string; amount: string; currency: string; bankId: string; companyId: string; description: string; category: string | null }
  export function checkPlannedOutflowInput(input: PlannedOutflowInput): GuardResult
  export function normalisePlannedOutflow(input: PlannedOutflowInput): PlannedOutflowValues   // caller has passed the guard
  export function diffPlannedOutflow(before: PlannedOutflowValues, after: PlannedOutflowValues): Partial<Record<keyof PlannedOutflowValues, { from: string | null; to: string | null }>>
  ```
- From `lib/planned-outflow/actions.ts` (all take `db: PrismaClient`, all throw `DomainError`):
  ```ts
  export async function createPlannedOutflow(db, args: { input: PlannedOutflowInput; userId: string; now: Date }): Promise<PlannedOutflow>
  export async function updatePlannedOutflow(db, args: { id: string; input: PlannedOutflowInput; userId: string; now: Date }): Promise<PlannedOutflow>
  export async function markPlannedOutflowPaid(db, args: { id: string; paidOn: string; userId: string; now: Date }): Promise<PlannedOutflow>
  export async function cancelPlannedOutflow(db, args: { id: string; reason: string; userId: string; now: Date }): Promise<PlannedOutflow>
  ```
  Audit actions: `planned_outflow_created`, `planned_outflow_updated`, `planned_outflow_paid`, `planned_outflow_cancelled`; every `details` carries `plannedOutflowId` and `description`.
- From `lib/planned-outflow/query.ts`:
  ```ts
  export type PlannedOutflowRow = { id: string; date: Date; amount: string; currency: string; bankId: string; bankCode: string; companyId: string; companyCode: string; description: string; category: string | null; status: 'PLANNED' | 'PAID' | 'CANCELLED'; createdBy: string; createdAt: Date; paidBy: string | null; paidAt: Date | null; cancelledBy: string | null; cancelledAt: Date | null; cancelReason: string | null }
  export async function listPlannedOutflows(db, opts: { includeClosed: boolean }): Promise<PlannedOutflowRow[]>   // open first by date asc, then closed newest first
  export async function listBanks(db): Promise<{ id: string; code: string }[]>
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/planned-outflow.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  checkPlannedOutflowInput, normalisePlannedOutflow, diffPlannedOutflow, MONEY,
  type PlannedOutflowInput,
} from '@/lib/domain/planned-outflow'

const good: PlannedOutflowInput = {
  date: '2026-09-15', amount: '1250000.00', bankId: 'b1', companyId: 'c1',
  description: ' September 2nd-half payroll ', category: 'payroll',
}

describe('checkPlannedOutflowInput', () => {
  it('accepts a complete line', () => {
    expect(checkPlannedOutflowInput(good)).toEqual({ ok: true })
  })

  it('refuses a date that is not a day', () => {
    expect(checkPlannedOutflowInput({ ...good, date: '15/09/2026' })).toMatchObject({ ok: false, code: 'INVALID_DATE' })
    expect(checkPlannedOutflowInput({ ...good, date: '' })).toMatchObject({ ok: false, code: 'INVALID_DATE' })
  })

  it('refuses an amount that is not money, or is nothing', () => {
    for (const amount of ['', '1,250,000', '12.345', '-5', 'abc', '0', '0.00']) {
      expect(checkPlannedOutflowInput({ ...good, amount }), amount).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' })
    }
    expect(MONEY.test('0.01')).toBe(true)
  })

  it('refuses a blank description, bank or company', () => {
    expect(checkPlannedOutflowInput({ ...good, description: '  ' })).toMatchObject({ ok: false, code: 'DESCRIPTION_REQUIRED' })
    expect(checkPlannedOutflowInput({ ...good, bankId: '' })).toMatchObject({ ok: false, code: 'BANK_REQUIRED' })
    expect(checkPlannedOutflowInput({ ...good, companyId: '' })).toMatchObject({ ok: false, code: 'COMPANY_REQUIRED' })
  })
})

describe('normalisePlannedOutflow', () => {
  it('trims, pads the amount to two decimals, upper-cases category and currency, defaults PHP', () => {
    expect(normalisePlannedOutflow({ ...good, amount: '5' })).toEqual({
      date: '2026-09-15', amount: '5.00', currency: 'PHP', bankId: 'b1', companyId: 'c1',
      description: 'September 2nd-half payroll', category: 'PAYROLL',
    })
    expect(normalisePlannedOutflow({ ...good, amount: '5.5', currency: 'usd', category: '' }).amount).toBe('5.50')
    expect(normalisePlannedOutflow({ ...good, currency: 'usd', category: '' }).currency).toBe('USD')
    expect(normalisePlannedOutflow({ ...good, category: '' }).category).toBeNull()
  })
})

describe('diffPlannedOutflow', () => {
  it('reports only what changed', () => {
    const a = normalisePlannedOutflow(good)
    expect(diffPlannedOutflow(a, { ...a, amount: '1300000.00', category: null })).toEqual({
      amount: { from: '1250000.00', to: '1300000.00' },
      category: { from: 'PAYROLL', to: null },
    })
    expect(diffPlannedOutflow(a, { ...a })).toEqual({})
  })
})
```

Create `tests/planned-outflow/actions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import {
  createPlannedOutflow, updatePlannedOutflow, markPlannedOutflowPaid, cancelPlannedOutflow,
} from '@/lib/planned-outflow/actions'
import { listPlannedOutflows, listBanks } from '@/lib/planned-outflow/query'

const NOW = new Date('2026-09-12T10:00:00+08:00')
beforeEach(resetDb)

async function refs() {
  const user = await makeUser()
  const company = await testDb.company.create({ data: { code: `C${Math.random().toString(36).slice(2, 7)}`, name: 'Starkson', legalNames: [] } })
  const bank = await testDb.bank.create({ data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
  return { user, company, bank }
}

const input = (bankId: string, companyId: string, o: Partial<{ date: string; amount: string; description: string; category: string | null }> = {}) => ({
  date: '2026-09-15', amount: '1250000', bankId, companyId, description: 'SEPT 2ND-HALF PAYROLL', category: 'payroll', ...o,
})

const trail = (id: string, action: string) =>
  testDb.auditLog.findMany({ where: { action, details: { path: ['plannedOutflowId'], equals: id } } })

describe('createPlannedOutflow', () => {
  it('creates a PLANNED line with its audit row', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    expect(line.status).toBe('PLANNED')
    expect(line.amount.toFixed(2)).toBe('1250000.00')
    expect(line.date).toEqual(new Date('2026-09-15T00:00:00.000Z'))
    expect(line.category).toBe('PAYROLL')
    expect(line.createdById).toBe(user.id)
    const rows = await trail(line.id, 'planned_outflow_created')
    expect(rows).toHaveLength(1)
    expect(rows[0].actorType).toBe('USER')
    expect(rows[0].checkId).toBeNull()
    expect(rows[0].details).toMatchObject({ plannedOutflowId: line.id, description: 'SEPT 2ND-HALF PAYROLL', amount: '1250000.00' })
  })

  it('refuses bad input before touching the database', async () => {
    const { user, company, bank } = await refs()
    await expect(createPlannedOutflow(testDb, { input: input(bank.id, company.id, { amount: '1,250,000' }), userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    expect(await testDb.plannedOutflow.count()).toBe(0)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('refuses a bank or company that does not exist', async () => {
    const { user, company, bank } = await refs()
    await expect(createPlannedOutflow(testDb, { input: input('nope', company.id), userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'UNKNOWN_BANK' })
    await expect(createPlannedOutflow(testDb, { input: input(bank.id, 'nope'), userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'UNKNOWN_COMPANY' })
  })
})

describe('updatePlannedOutflow', () => {
  it('writes the changed fields and records from → to', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    const out = await updatePlannedOutflow(testDb, { id: line.id, input: input(bank.id, company.id, { amount: '1300000', date: '2026-09-16' }), userId: user.id, now: NOW })
    expect(out.amount.toFixed(2)).toBe('1300000.00')
    expect(out.date).toEqual(new Date('2026-09-16T00:00:00.000Z'))
    const rows = await trail(line.id, 'planned_outflow_updated')
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toMatchObject({
      changes: { amount: { from: '1250000.00', to: '1300000.00' }, date: { from: '2026-09-15', to: '2026-09-16' } },
    })
  })

  it('writes nothing when nothing changed', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await updatePlannedOutflow(testDb, { id: line.id, input: input(bank.id, company.id), userId: user.id, now: NOW })
    expect(await trail(line.id, 'planned_outflow_updated')).toHaveLength(0)
  })

  it('refuses to edit a line that is not PLANNED', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await markPlannedOutflowPaid(testDb, { id: line.id, paidOn: '2026-09-15', userId: user.id, now: NOW })
    await expect(updatePlannedOutflow(testDb, { id: line.id, input: input(bank.id, company.id, { amount: '1' }), userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_PLANNED' })
  })
})

describe('markPlannedOutflowPaid and cancelPlannedOutflow', () => {
  it('marks PAID with who and when', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    const out = await markPlannedOutflowPaid(testDb, { id: line.id, paidOn: '2026-09-15', userId: user.id, now: NOW })
    expect(out.status).toBe('PAID')
    expect(out.paidById).toBe(user.id)
    expect(out.paidAt).toEqual(new Date('2026-09-15T00:00:00.000Z'))
    expect(await trail(line.id, 'planned_outflow_paid')).toHaveLength(1)
  })

  it('refuses a paid date it cannot read', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await expect(markPlannedOutflowPaid(testDb, { id: line.id, paidOn: 'yesterday', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'INVALID_DATE' })
  })

  it('cancels with a reason, and refuses a blank one', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await expect(cancelPlannedOutflow(testDb, { id: line.id, reason: ' ', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' })
    const out = await cancelPlannedOutflow(testDb, { id: line.id, reason: 'Paid by cheque instead', userId: user.id, now: NOW })
    expect(out.status).toBe('CANCELLED')
    expect(out.cancelReason).toBe('Paid by cheque instead')
    expect(out.cancelledById).toBe(user.id)
    const rows = await trail(line.id, 'planned_outflow_cancelled')
    expect(rows[0].remarks).toBe('Paid by cheque instead')
  })

  it('never reopens a closed line', async () => {
    const { user, company, bank } = await refs()
    const line = await createPlannedOutflow(testDb, { input: input(bank.id, company.id), userId: user.id, now: NOW })
    await cancelPlannedOutflow(testDb, { id: line.id, reason: 'dup', userId: user.id, now: NOW })
    await expect(markPlannedOutflowPaid(testDb, { id: line.id, paidOn: '2026-09-15', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_PLANNED' })
    await expect(cancelPlannedOutflow(testDb, { id: line.id, reason: 'again', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_PLANNED' })
  })

  it('reports an unknown id as NOT_FOUND', async () => {
    const user = await makeUser()
    await expect(markPlannedOutflowPaid(testDb, { id: 'nope', paidOn: '2026-09-15', userId: user.id, now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('listPlannedOutflows', () => {
  it('lists open lines soonest first, and the closed ones only on request, newest first', async () => {
    const { user, company, bank } = await refs()
    const later = await createPlannedOutflow(testDb, { input: input(bank.id, company.id, { date: '2026-09-20', description: 'LATER' }), userId: user.id, now: NOW })
    const sooner = await createPlannedOutflow(testDb, { input: input(bank.id, company.id, { date: '2026-09-10', description: 'SOONER' }), userId: user.id, now: NOW })
    const paid = await createPlannedOutflow(testDb, { input: input(bank.id, company.id, { description: 'PAID ONE' }), userId: user.id, now: NOW })
    await markPlannedOutflowPaid(testDb, { id: paid.id, paidOn: '2026-09-12', userId: user.id, now: NOW })

    const open = await listPlannedOutflows(testDb, { includeClosed: false })
    expect(open.map((r) => r.id)).toEqual([sooner.id, later.id])
    expect(open[0]).toMatchObject({ amount: '1250000.00', bankCode: bank.code, companyCode: company.code, status: 'PLANNED', createdBy: user.name })
    expect(typeof open[0].amount).toBe('string')

    const all = await listPlannedOutflows(testDb, { includeClosed: true })
    expect(all.map((r) => r.id)).toEqual([sooner.id, later.id, paid.id])
    expect(all[2]).toMatchObject({ status: 'PAID', paidBy: user.name })
  })

  it('lists banks by id and code', async () => {
    const { bank } = await refs()
    expect(await listBanks(testDb)).toEqual([{ id: bank.id, code: bank.code }])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx.cmd vitest run tests/domain/planned-outflow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: The pure module**

Create `lib/domain/planned-outflow.ts`:

```ts
import type { GuardResult } from './check-status'
import { isIsoDay } from './details'

/**
 * A PLANNED OUTFLOW THAT IS NOT A CHEQUE.
 *
 * Payroll, a tax remittance, loan amortisation, a transfer — money that leaves
 * the same account as the cheques and appeared nowhere in this system until
 * 2026-09-12. Typed one line at a time; nothing here recurs, so nothing is
 * forecast that nobody typed.
 *
 * Pure. The amount is money as TEXT (rule 8): the guard reads the string, the
 * normaliser pads it to two decimals, and it reaches the database as a
 * decimal string. Zero is refused — a planned outflow of nothing is a line
 * somebody forgot to fill in, not a fact.
 */

export const MONEY = /^\d+(\.\d{1,2})?$/

export type PlannedOutflowInput = {
  date: string
  amount: string
  currency?: string
  bankId: string
  companyId: string
  description: string
  category?: string | null
}

export type PlannedOutflowValues = {
  date: string
  amount: string
  currency: string
  bankId: string
  companyId: string
  description: string
  category: string | null
}

const blank = (s: string | null | undefined) => (s ?? '').trim() === ''

export function checkPlannedOutflowInput(input: PlannedOutflowInput): GuardResult {
  if (!isIsoDay((input.date ?? '').trim())) {
    return { ok: false, code: 'INVALID_DATE', message: 'DATE must be a day, YYYY-MM-DD.' }
  }
  const amount = (input.amount ?? '').trim()
  if (!MONEY.test(amount) || Number(amount) === 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'AMOUNT must be a number with up to two decimals, greater than zero, without commas.' }
  }
  if (blank(input.description)) return { ok: false, code: 'DESCRIPTION_REQUIRED', message: 'Describe the outflow — what it is for.' }
  if (blank(input.bankId)) return { ok: false, code: 'BANK_REQUIRED', message: 'Choose the bank it leaves from.' }
  if (blank(input.companyId)) return { ok: false, code: 'COMPANY_REQUIRED', message: 'Choose the company it belongs to.' }
  return { ok: true }
}

/** Two decimals, as text. `'5'` → `'5.00'`, `'5.5'` → `'5.50'`. Never through a float. */
function padMoney(s: string): string {
  const [whole, frac = ''] = s.split('.')
  return `${whole}.${(frac + '00').slice(0, 2)}`
}

export function normalisePlannedOutflow(input: PlannedOutflowInput): PlannedOutflowValues {
  const category = (input.category ?? '').trim()
  return {
    date: input.date.trim(),
    amount: padMoney(input.amount.trim()),
    currency: (input.currency ?? '').trim() === '' ? 'PHP' : input.currency!.trim().toUpperCase(),
    bankId: input.bankId.trim(),
    companyId: input.companyId.trim(),
    description: input.description.trim(),
    category: category === '' ? null : category.toUpperCase(),
  }
}

export type PlannedOutflowChange = { from: string | null; to: string | null }

export function diffPlannedOutflow(
  before: PlannedOutflowValues, after: PlannedOutflowValues,
): Partial<Record<keyof PlannedOutflowValues, PlannedOutflowChange>> {
  const changes: Partial<Record<keyof PlannedOutflowValues, PlannedOutflowChange>> = {}
  for (const key of Object.keys(before) as (keyof PlannedOutflowValues)[]) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] }
  }
  return changes
}
```

- [ ] **Step 4: Run the pure test**

Run: `npx.cmd vitest run tests/domain/planned-outflow.test.ts`
Expected: PASS.

- [ ] **Step 5: The writers and the reads**

Create `lib/planned-outflow/actions.ts`:

```ts
import type { PlannedOutflow, Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { dayToDate, isIsoDay, isoDay } from '@/lib/domain/details'
import {
  checkPlannedOutflowInput, normalisePlannedOutflow, diffPlannedOutflow,
  type PlannedOutflowInput, type PlannedOutflowValues,
} from '@/lib/domain/planned-outflow'

/**
 * The four things that happen to a planned line. Each is one transaction that
 * writes the row and its audit row together, as `lib/domain/actions.ts` does
 * for a cheque. The audit table keys on cheques, so these rows carry
 * `checkId` null and the line's id in `details` — `/admin/audit` shows them as
 * detached rows with the description alongside.
 *
 * No delete, and no way out of PAID or CANCELLED: a wrong PAID is a new line.
 */

const TX = { timeout: 30_000, maxWait: 15_000 } as const

async function loadLine(tx: Prisma.TransactionClient, id: string): Promise<PlannedOutflow> {
  const line = await tx.plannedOutflow.findUnique({ where: { id } })
  if (!line) throw new DomainError('NOT_FOUND', 'Planned outflow not found.')
  return line
}

function assertPlanned(line: PlannedOutflow): void {
  if (line.status !== 'PLANNED') {
    throw new DomainError('NOT_PLANNED', `This line is ${line.status}; a closed line is not changed. Add a new line instead.`)
  }
}

function valuesOf(line: PlannedOutflow): PlannedOutflowValues {
  return {
    date: isoDay(line.date)!, amount: line.amount.toFixed(2), currency: line.currency,
    bankId: line.bankId, companyId: line.companyId, description: line.description, category: line.category,
  }
}

async function assertRefsExist(tx: Prisma.TransactionClient, v: PlannedOutflowValues): Promise<void> {
  if (!(await tx.bank.findUnique({ where: { id: v.bankId }, select: { id: true } }))) {
    throw new DomainError('UNKNOWN_BANK', 'That bank does not exist.')
  }
  if (!(await tx.company.findUnique({ where: { id: v.companyId }, select: { id: true } }))) {
    throw new DomainError('UNKNOWN_COMPANY', 'That company does not exist.')
  }
}

function validated(input: PlannedOutflowInput): PlannedOutflowValues {
  const guard = checkPlannedOutflowInput(input)
  if (!guard.ok) throw new DomainError(guard.code, guard.message)
  return normalisePlannedOutflow(input)
}

export async function createPlannedOutflow(
  db: PrismaClient, args: { input: PlannedOutflowInput; userId: string; now: Date },
): Promise<PlannedOutflow> {
  const v = validated(args.input)
  return db.$transaction(async (tx) => {
    await assertRefsExist(tx, v)
    const line = await tx.plannedOutflow.create({
      data: {
        date: dayToDate(v.date), amount: v.amount, currency: v.currency,
        bankId: v.bankId, companyId: v.companyId, description: v.description, category: v.category,
        createdById: args.userId,
      },
    })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'planned_outflow_created',
      details: { plannedOutflowId: line.id, ...v },
    })
    return line
  }, TX)
}

export async function updatePlannedOutflow(
  db: PrismaClient, args: { id: string; input: PlannedOutflowInput; userId: string; now: Date },
): Promise<PlannedOutflow> {
  const after = validated(args.input)
  return db.$transaction(async (tx) => {
    const line = await loadLine(tx, args.id)
    assertPlanned(line)
    const changes = diffPlannedOutflow(valuesOf(line), after)
    if (Object.keys(changes).length === 0) return line
    await assertRefsExist(tx, after)
    const updated = await tx.plannedOutflow.update({
      where: { id: line.id },
      data: {
        date: dayToDate(after.date), amount: after.amount, currency: after.currency,
        bankId: after.bankId, companyId: after.companyId, description: after.description, category: after.category,
      },
    })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'planned_outflow_updated',
      details: { plannedOutflowId: line.id, description: updated.description, changes },
    })
    return updated
  }, TX)
}

export async function markPlannedOutflowPaid(
  db: PrismaClient, args: { id: string; paidOn: string; userId: string; now: Date },
): Promise<PlannedOutflow> {
  const paidOn = args.paidOn.trim()
  if (!isIsoDay(paidOn)) throw new DomainError('INVALID_DATE', 'PAID ON must be a day, YYYY-MM-DD.')
  return db.$transaction(async (tx) => {
    const line = await loadLine(tx, args.id)
    assertPlanned(line)
    const updated = await tx.plannedOutflow.update({
      where: { id: line.id },
      data: { status: 'PAID', paidAt: dayToDate(paidOn), paidById: args.userId },
    })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'planned_outflow_paid',
      details: { plannedOutflowId: line.id, description: line.description, amount: line.amount.toFixed(2), paidOn },
    })
    return updated
  }, TX)
}

export async function cancelPlannedOutflow(
  db: PrismaClient, args: { id: string; reason: string; userId: string; now: Date },
): Promise<PlannedOutflow> {
  const reason = args.reason.trim()
  if (reason === '') throw new DomainError('REASON_REQUIRED', 'A reason is required to cancel a planned outflow.')
  return db.$transaction(async (tx) => {
    const line = await loadLine(tx, args.id)
    assertPlanned(line)
    const updated = await tx.plannedOutflow.update({
      where: { id: line.id },
      data: { status: 'CANCELLED', cancelledAt: args.now, cancelledById: args.userId, cancelReason: reason },
    })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'planned_outflow_cancelled', remarks: reason,
      details: { plannedOutflowId: line.id, description: line.description, amount: line.amount.toFixed(2) },
    })
    return updated
  }, TX)
}
```

Create `lib/planned-outflow/query.ts`:

```ts
import type { PlannedOutflowStatus, Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

/** One planned line as the screen shows it. `amount` is a decimal STRING — rule 8. */
export type PlannedOutflowRow = {
  id: string
  date: Date
  amount: string
  currency: string
  bankId: string
  bankCode: string
  companyId: string
  companyCode: string
  description: string
  category: string | null
  status: PlannedOutflowStatus
  createdBy: string
  createdAt: Date
  paidBy: string | null
  paidAt: Date | null
  cancelledBy: string | null
  cancelledAt: Date | null
  cancelReason: string | null
}

const select = {
  id: true, date: true, amount: true, currency: true, bankId: true, companyId: true,
  description: true, category: true, status: true, createdAt: true, paidAt: true, cancelledAt: true, cancelReason: true,
  bank: { select: { code: true } }, company: { select: { code: true } },
  createdBy: { select: { name: true } }, paidBy: { select: { name: true } }, cancelledBy: { select: { name: true } },
} satisfies Prisma.PlannedOutflowSelect

type Picked = Prisma.PlannedOutflowGetPayload<{ select: typeof select }>

const toRow = (l: Picked): PlannedOutflowRow => ({
  id: l.id, date: l.date, amount: l.amount.toFixed(2), currency: l.currency,
  bankId: l.bankId, bankCode: l.bank.code, companyId: l.companyId, companyCode: l.company.code,
  description: l.description, category: l.category, status: l.status,
  createdBy: l.createdBy.name, createdAt: l.createdAt,
  paidBy: l.paidBy?.name ?? null, paidAt: l.paidAt,
  cancelledBy: l.cancelledBy?.name ?? null, cancelledAt: l.cancelledAt, cancelReason: l.cancelReason,
})

/** Open lines soonest first; then, on request, the closed ones newest first. */
export async function listPlannedOutflows(db: Db, opts: { includeClosed: boolean }): Promise<PlannedOutflowRow[]> {
  const open = await db.plannedOutflow.findMany({
    where: { status: 'PLANNED' }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }], select,
  })
  if (!opts.includeClosed) return open.map(toRow)
  const closed = await db.plannedOutflow.findMany({
    where: { status: { in: ['PAID', 'CANCELLED'] } }, orderBy: [{ updatedAt: 'desc' }], select,
  })
  return [...open, ...closed].map(toRow)
}

export async function listBanks(db: Db): Promise<{ id: string; code: string }[]> {
  return db.bank.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true } })
}
```

- [ ] **Step 6: Run the DB test and tsc**

Run: `npx.cmd vitest run tests/planned-outflow/actions.test.ts`
Expected: PASS (12 tests). Then `npx.cmd tsc --noEmit` — clean. If the `details: { path: ['plannedOutflowId'], equals: id }` JSON filter is refused by the Prisma version, replace `trail` with `findMany({ where: { action } })` filtered in JS on `(r.details as { plannedOutflowId?: string })?.plannedOutflowId === id` and note it in the report.

- [ ] **Step 7: Commit**

```bash
git add lib/domain/planned-outflow.ts lib/planned-outflow tests/domain/planned-outflow.test.ts tests/planned-outflow
git commit -m "feat: planned non-cheque outflow lines - rules, writers, reads

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The forecast takes both

**Files:**
- Modify: `lib/forecast/query.ts`, `lib/forecast/matrix.ts`, `lib/forecast-view.ts`, `lib/export/forecast-workbook.ts`
- Test: `tests/forecast/query.test.ts`, `tests/forecast/matrix.test.ts`, `tests/forecast-view.test.ts`, `tests/export/forecast-workbook.test.ts`; run `tests/export/forecast-route.test.ts` unchanged

**Interfaces:**
- `lib/forecast/query.ts`:
  ```ts
  export const PLANNED_STAGE = 'PLANNED' as const
  export type ForecastStage = CheckStatus | typeof PLANNED_STAGE
  export type ForecastFilters = { bankCode?: string; companyId?: string; stage?: ForecastStage }
  export type ForecastRow = { id; checkNumber; payee; bank; company; stage: ForecastStage; currency; amount; checkDate: Date | null; kind: 'CHEQUE' | 'PLANNED'; expectedOutflowDate: Date | null }
  export async function listForecastRows(db, filters?): Promise<ForecastRow[]>   // [] when stage is PLANNED
  export async function listPlannedRows(db, filters?): Promise<ForecastRow[]>    // [] when stage is a cheque stage
  export async function countExcludedIncomplete(db, filters?): Promise<number>   // 0 when stage is PLANNED
  ```
- `lib/forecast/matrix.ts`: `BucketedRow = ForecastRow & { bucket; days; dateBasis: 'EXPECTED' | 'CHEQUE DATE' | 'PLANNED' }`; `export function outflowDate(r: ForecastRow): Date | null`; by-stage columns end with `PLANNED` when any planned row is present.
- `lib/forecast-view.ts`: `STAGE_OPTIONS` ends with `{ value: 'PLANNED', label: 'PLANNED' }`; `parseStageParam` returns `ForecastStage | undefined`; `describeForecastFilters` accepts `stage?: ForecastStage | null`.
- `lib/export/forecast-workbook.ts`: `DETAIL_HEADERS = ['KIND', 'CHECK NUMBER', 'PAYEE', 'BANK', 'COMPANY', 'STAGE', 'CHECK DATE', 'EXPECTED OUT', 'DATE BASIS', 'DAYS PRESENTABLE', 'BUCKET', 'CURRENCY', 'AMOUNT']`; `ForecastMeta` gains `plannedCount: number` and `expectedCount: number`.

- [ ] **Step 1: Write the failing tests**

In `tests/forecast/matrix.test.ts` extend `row()` defaults with `kind: 'CHEQUE', expectedOutflowDate: null,` and add:

```ts
describe('buildMatrices — expected dates and planned lines', () => {
  const planned = (o: Partial<ForecastRow> & { id: string }): ForecastRow => row({
    checkNumber: 'PLANNED', payee: 'SEPT PAYROLL', stage: 'PLANNED', kind: 'PLANNED', ...o,
  })

  it('places a cheque on its expected date when it has one, and says so', () => {
    const { byBank, bucketed } = buildMatrices([
      row({ id: 'a', checkDate: daysAgo(40), expectedOutflowDate: daysAgo(-1) }),
      row({ id: 'b', checkDate: daysAgo(40) }),
    ], TODAY)
    expect(bucketed.find((r) => r.id === 'a')).toMatchObject({ bucket: 'THIS WEEK', dateBasis: 'EXPECTED', days: -1 })
    expect(bucketed.find((r) => r.id === 'b')).toMatchObject({ bucket: '31–60 DAYS', dateBasis: 'CHEQUE DATE' })
    expect(byBank.rows.find((r) => r.bucket === '31–60 DAYS')!.cells.BPI.count).toBe(1)
  })

  it('adds PLANNED as the last stage column only when a line is present, and counts it in the totals', () => {
    const without = buildMatrices([row({ id: 'a' })], TODAY)
    expect(without.byStage.columns).toEqual(['SIGNED'])
    const { byStage, byBank, bucketed } = buildMatrices([
      row({ id: 'a', amount: '100.00' }),
      planned({ id: 'p', amount: '250.00', checkDate: daysAgo(0), bank: 'MBTC' }),
    ], TODAY)
    expect(byStage.columns).toEqual(['SIGNED', 'PLANNED'])
    expect(byStage.rows.find((r) => r.bucket === 'TODAY')!.cells.PLANNED.totals).toEqual([{ currency: 'PHP', count: 1, total: '250.00' }])
    expect(byStage.total.total.totals).toEqual([{ currency: 'PHP', count: 2, total: '350.00' }])
    expect(byBank.columns).toEqual(['BPI', 'MBTC'])
    expect(bucketed.find((r) => r.id === 'p')).toMatchObject({ bucket: 'TODAY', dateBasis: 'PLANNED', days: 0 })
  })
})
```
(`TODAY` is a Tuesday, 2026-09-16; `daysAgo(-1)` is Wednesday the 17th — THIS WEEK.)

In `tests/forecast/query.test.ts` add:

```ts
import { listPlannedRows } from '@/lib/forecast/query'
import { createPlannedOutflow } from '@/lib/planned-outflow/actions'
import { makeUser } from '../helpers/factory'

describe('listPlannedRows', () => {
  async function line(o: { bankCode?: string; companyCode?: string; status?: 'PAID' } = {}) {
    const user = await makeUser()
    const company = await testDb.company.create({ data: { code: o.companyCode ?? `C${Math.random().toString(36).slice(2, 7)}`, name: 'Starkson', legalNames: [] } })
    const bank = await testDb.bank.create({ data: { code: o.bankCode ?? `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
    const l = await createPlannedOutflow(testDb, {
      input: { date: '2026-09-15', amount: '250', bankId: bank.id, companyId: company.id, description: 'SEPT PAYROLL' },
      userId: user.id, now: new Date(),
    })
    if (o.status === 'PAID') await testDb.plannedOutflow.update({ where: { id: l.id }, data: { status: 'PAID', paidAt: new Date(), paidById: user.id } })
    return { l, bank, company }
  }

  it('returns open lines in the forecast row shape, and no closed ones', async () => {
    const { l, bank, company } = await line()
    await line({ status: 'PAID' })
    const rows = await listPlannedRows(testDb)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: l.id, checkNumber: 'PLANNED', payee: 'SEPT PAYROLL', bank: bank.code, company: company.code,
      stage: 'PLANNED', kind: 'PLANNED', currency: 'PHP', amount: '250.00',
      checkDate: new Date('2026-09-15T00:00:00.000Z'), expectedOutflowDate: null,
    })
  })

  it('narrows by bank and company, and is empty under a cheque stage', async () => {
    const { bank, company } = await line({ bankCode: 'BPIX' })
    await line({ bankCode: 'MBTX' })
    expect((await listPlannedRows(testDb, { bankCode: 'BPIX' })).map((r) => r.bank)).toEqual([bank.code])
    expect((await listPlannedRows(testDb, { companyId: company.id }))).toHaveLength(1)
    expect(await listPlannedRows(testDb, { stage: 'SIGNED' })).toHaveLength(0)
    expect(await listPlannedRows(testDb, { stage: 'PLANNED' })).toHaveLength(2)
  })

  it('the cheque query is empty, and the exclusion zero, under the PLANNED stage', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'SIGNED', amount: null })
    expect(await listForecastRows(testDb, { stage: 'PLANNED' })).toHaveLength(0)
    expect(await countExcludedIncomplete(testDb, { stage: 'PLANNED' })).toBe(0)
  })

  it('carries the expected outflow date on a cheque', async () => {
    const c = await makeCheck({ status: 'SIGNED' })
    await testDb.check.update({ where: { id: c.id }, data: { expectedOutflowDate: new Date('2026-09-20T00:00:00.000Z') } })
    const [row] = await listForecastRows(testDb)
    expect(row.kind).toBe('CHEQUE')
    expect(row.expectedOutflowDate).toEqual(new Date('2026-09-20T00:00:00.000Z'))
  })
})
```

In `tests/forecast-view.test.ts`: `STAGE_OPTIONS` expectation becomes `[..., 'SCHEDULED', 'PLANNED']`; add to `parseStageParam`: `expect(parseStageParam('planned')).toBe('PLANNED')`.

In `tests/export/forecast-workbook.test.ts`: `row()` defaults gain `kind: 'CHEQUE', expectedOutflowDate: null,`; `meta` gains `plannedCount: 0, expectedCount: 0`; add:

```ts
  it('writes KIND, EXPECTED OUT and DATE BASIS on DETAIL, for a cheque and a planned line', async () => {
    const wb = await build([
      row({ id: 'a', expectedOutflowDate: daysAgo(-2) }),
      row({ id: 'p', checkNumber: 'PLANNED', payee: 'SEPT PAYROLL', stage: 'PLANNED', kind: 'PLANNED', checkDate: daysAgo(0), amount: '250.00' }),
    ])
    const ws = wb.getWorksheet(DETAIL_SHEET)!
    expect(ws.getRow(1).values).toEqual([undefined, ...DETAIL_HEADERS])
    const cheque = ws.getRow(2).values as unknown[]
    expect(cheque[1]).toBe('CHEQUE')
    expect(cheque[9]).toBe('EXPECTED')
    expect((cheque[8] as Date).toISOString().slice(0, 10)).toBe('2026-09-18')
    const line = ws.getRow(3).values as unknown[]
    expect(line.slice(1, 4)).toEqual(['PLANNED', 'PLANNED', 'SEPT PAYROLL'])
    expect(line[6]).toBe('PLANNED')
    expect(line[9]).toBe('PLANNED')
    expect(line[13]).toBe(250)
  })
```
Row order: `buildMatrices` keeps input order, so the cheque is row 2 and the line row 3.

- [ ] **Step 2: Run to verify failure**

Run: `npx.cmd vitest run tests/forecast/matrix.test.ts tests/forecast-view.test.ts`
Expected: FAIL — `kind` unknown, `PLANNED` refused.

- [ ] **Step 3: The query**

In `lib/forecast/query.ts`:

```ts
export const PLANNED_STAGE = 'PLANNED' as const
export type ForecastStage = CheckStatus | typeof PLANNED_STAGE

export type ForecastFilters = {
  bankCode?: string
  companyId?: string
  /** A live cheque stage, or PLANNED for the non-cheque lines alone. */
  stage?: ForecastStage
}

export type ForecastRow = {
  id: string
  /** The cheque number, or the literal `PLANNED` for a planned line. */
  checkNumber: string
  payee: string | null
  bank: string | null
  company: string
  stage: ForecastStage
  currency: string
  amount: string
  /** The cheque's date; for a planned line, the day it leaves the bank. */
  checkDate: Date | null
  kind: 'CHEQUE' | 'PLANNED'
  /** Typed by Finance (2026-09-12); the forecast buckets on it when set. Always null on a planned line. */
  expectedOutflowDate: Date | null
}
```
`populationWhere`: `status: filters.stage && filters.stage !== PLANNED_STAGE ? filters.stage : { in: [...LIVE_STATUSES] }`.
`listForecastRows`: first line `if (filters.stage === PLANNED_STAGE) return []`; add `expectedOutflowDate: true` to `select`; add `kind: 'CHEQUE', expectedOutflowDate: c.expectedOutflowDate,` to the row.
`countExcludedIncomplete`: first line `if (filters.stage === PLANNED_STAGE) return 0`.
Add:

```ts
/**
 * THE PLANNED LINES, in the same shape, so the matrices and the sheet need no
 * second path. Open lines only — PAID has left, CANCELLED never will. The bank
 * and company filters apply on the line's own bank and company; a cheque
 * stage filter excludes them entirely, and PLANNED alone includes only them.
 */
export async function listPlannedRows(db: Db, filters: ForecastFilters = {}): Promise<ForecastRow[]> {
  if (filters.stage && filters.stage !== PLANNED_STAGE) return []
  const lines = await db.plannedOutflow.findMany({
    where: {
      status: 'PLANNED',
      ...(filters.companyId ? { companyId: filters.companyId } : {}),
      ...(filters.bankCode ? { bank: { code: filters.bankCode } } : {}),
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, date: true, amount: true, currency: true, description: true,
      bank: { select: { code: true } }, company: { select: { code: true } },
    },
  })
  return lines.map((l) => ({
    id: l.id, checkNumber: PLANNED_STAGE, payee: l.description, bank: l.bank.code, company: l.company.code,
    stage: PLANNED_STAGE, kind: 'PLANNED', currency: l.currency, amount: l.amount.toFixed(2),
    checkDate: l.date, expectedOutflowDate: null,
  }))
}
```

- [ ] **Step 4: The matrix**

In `lib/forecast/matrix.ts`:

```ts
export type DateBasis = 'EXPECTED' | 'CHEQUE DATE' | 'PLANNED'
export type BucketedRow = ForecastRow & { bucket: Bucket; days: number | null; dateBasis: DateBasis }

/** The day a row is bucketed on: a planned line's own day; a cheque's expected date when Finance typed one, else its cheque date. */
export function outflowDate(r: ForecastRow): Date | null {
  if (r.kind === 'PLANNED') return r.checkDate
  return r.expectedOutflowDate ?? r.checkDate
}

function basisOf(r: ForecastRow): DateBasis {
  if (r.kind === 'PLANNED') return 'PLANNED'
  return r.expectedOutflowDate ? 'EXPECTED' : 'CHEQUE DATE'
}
```
In `buildMatrices`:
```ts
  const bucketed: BucketedRow[] = rows.map((r) => {
    const on = outflowDate(r)
    return { ...r, bucket: bucketFor(on, today), days: on ? daysPresentable(on, today) : null, dateBasis: basisOf(r) }
  })
  ...
  // Stages: ladder order, only those present, spelled as words — then PLANNED
  // last, only when a line is present. A column for nothing is a column that
  // reads as "no planned outflows" when the truth is "none were typed".
  const present = new Set<string>(bucketed.map((r) => r.stage))
  const stages = LIVE_STATUSES.filter((s) => present.has(s)).map(statusWords)
  if (present.has(PLANNED_STAGE)) stages.push(PLANNED_STAGE)
```
with `import { PLANNED_STAGE } from './query'` and the by-stage `columnOf` unchanged (`statusWords('PLANNED')` is `'PLANNED'`).

- [ ] **Step 5: The view**

In `lib/forecast-view.ts`: import `PLANNED_STAGE, type ForecastStage` from `./forecast/query`;

```ts
export const STAGE_OPTIONS: readonly { value: ForecastStage; label: string }[] = [
  ...LIVE_STATUSES.map((s) => ({ value: s as ForecastStage, label: statusWords(s) })),
  { value: PLANNED_STAGE, label: 'PLANNED' },
]

export function parseStageParam(value: string | undefined): ForecastStage | undefined {
  if (!value) return undefined
  const key = value.trim().toUpperCase().replace(/ /g, '_')
  if (key === PLANNED_STAGE) return PLANNED_STAGE
  return (LIVE_STATUSES as readonly string[]).includes(key) ? (key as CheckStatus) : undefined
}
```
`describeForecastFilters`'s `stage` type becomes `ForecastStage | null`.

- [ ] **Step 6: The workbook**

In `lib/export/forecast-workbook.ts`:

```ts
export const DETAIL_HEADERS = [
  'KIND', 'CHECK NUMBER', 'PAYEE', 'BANK', 'COMPANY', 'STAGE', 'CHECK DATE', 'EXPECTED OUT', 'DATE BASIS',
  'DAYS PRESENTABLE', 'BUCKET', 'CURRENCY', 'AMOUNT',
] as const
```
`ForecastMeta` gains `plannedCount: number` and `expectedCount: number`. The `scope` line: replace `cheque${…}` wording with a helper:

```ts
const population = (meta: ForecastMeta) => {
  const cheques = meta.totalRows - meta.plannedCount
  return `${count(cheques)} cheque${cheques === 1 ? '' : 's'} and ${count(meta.plannedCount)} planned line${meta.plannedCount === 1 ? '' : 's'}`
}
```
used as `DETAIL holds the FIRST ${count(detail.length)} OF ${count(meta.totalRows)} rows` / `${generatedLine(meta)}  ·  ${population(meta)}`. The A4 sentence becomes:
```ts
    `Dates are the cheque's own date — the day from which it can be presented — unless Finance typed an ` +
    `expected outflow date (${count(meta.expectedCount)} here), which then places the cheque. Planned lines sit on their own day. Excludes ` +
    `${count(meta.incompleteCount)} cheque${meta.incompleteCount === 1 ? '' : 's'} with no recorded amount.`
```
DETAIL values per row:
```ts
    const values: (string | number | Date | null)[] = [
      r.kind, r.checkNumber, r.payee, r.bank, r.company, statusWords(r.stage), r.checkDate,
      r.expectedOutflowDate, r.dateBasis, r.days, r.bucket, r.currency, Number(r.amount),
    ]
```
and the two `numFmt` lines move: amount is column 13, days column 10. The `styleHeaderCell` right-alignment test keeps `'AMOUNT' || 'DAYS PRESENTABLE'`.

- [ ] **Step 7: Run the tests and tsc**

Run: `npx.cmd vitest run tests/forecast/matrix.test.ts tests/forecast-view.test.ts tests/export/forecast-workbook.test.ts` then `npx.cmd vitest run tests/forecast/query.test.ts tests/export/forecast-route.test.ts`.
Expected: PASS. Then `npx.cmd tsc --noEmit` — this will FAIL in `app/forecast/page.tsx` and `app/api/export/forecast/route.ts` on the new `ForecastMeta` fields; fix both minimally here by passing `plannedCount: 0, expectedCount: 0` for now (Task 5 replaces them), or — better — do Task 5's page/route wiring for the meta only. Choose the first; Task 5 finishes it. `tsc` clean before commit.

- [ ] **Step 8: Commit**

```bash
git add lib/forecast lib/forecast-view.ts lib/export/forecast-workbook.ts app/forecast/page.tsx app/api/export/forecast/route.ts tests/forecast tests/forecast-view.test.ts tests/export/forecast-workbook.test.ts
git commit -m "feat(forecast): cheques on their expected date; planned lines as their own column

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The screen, the page, the route

**Files:**
- Create: `app/forecast/planned/actions.ts`, `app/forecast/planned/page.tsx`, `components/PlannedOutflowForm.tsx`, `components/PlannedOutflowList.tsx`
- Modify: `app/forecast/page.tsx`, `app/api/export/forecast/route.ts`, `CLAUDE.md`
- Test: `tests/actions/planned-outflow-actions.test.ts`

**Interfaces:**
- From `app/forecast/planned/actions.ts` (all `'use server'`, all `requireUser()` first, all return `PlannedActionResult = { ok: true } | { ok: false; message: string }`):
  `createPlannedOutflowAction(formData)` reads `date, amount, currency, bankId, companyId, description, category`; `updatePlannedOutflowAction(formData)` the same plus `id`; `markPlannedOutflowPaidAction(formData)` reads `id, paidOn`; `cancelPlannedOutflowAction(formData)` reads `id, reason`.

- [ ] **Step 1: Write the failing test**

Create `tests/actions/planned-outflow-actions.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }
vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser, requireAdmin: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(async () => {
  await resetDb()
  currentUser.id = (await makeUser()).id
})

function fd(entries: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

async function refs() {
  const company = await testDb.company.create({ data: { code: `C${Math.random().toString(36).slice(2, 7)}`, name: 'Starkson', legalNames: [] } })
  const bank = await testDb.bank.create({ data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
  return { company, bank }
}

describe('the planned outflow actions', () => {
  it('creates, edits, pays and cancels through the form', async () => {
    const a = await import('@/app/forecast/planned/actions')
    const { company, bank } = await refs()
    const created = await a.createPlannedOutflowAction(fd({
      date: '2026-09-15', amount: '1250000', currency: '', bankId: bank.id, companyId: company.id, description: 'SEPT PAYROLL', category: 'payroll',
    }))
    expect(created).toEqual({ ok: true })
    const line = await testDb.plannedOutflow.findFirstOrThrow()
    expect(line.amount.toFixed(2)).toBe('1250000.00')
    expect(line.currency).toBe('PHP')

    expect(await a.updatePlannedOutflowAction(fd({
      id: line.id, date: '2026-09-16', amount: '1250000', currency: 'PHP', bankId: bank.id, companyId: company.id, description: 'SEPT PAYROLL', category: 'PAYROLL',
    }))).toEqual({ ok: true })

    const second = await testDb.plannedOutflow.create({ data: { date: new Date('2026-09-20T00:00:00Z'), amount: '1.00', bankId: bank.id, companyId: company.id, description: 'X', createdById: currentUser.id } })
    expect(await a.markPlannedOutflowPaidAction(fd({ id: line.id, paidOn: '2026-09-16' }))).toEqual({ ok: true })
    expect(await a.cancelPlannedOutflowAction(fd({ id: second.id, reason: 'Paid by cheque' }))).toEqual({ ok: true })
    expect((await testDb.plannedOutflow.findUniqueOrThrow({ where: { id: line.id } })).status).toBe('PAID')
    expect((await testDb.plannedOutflow.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('CANCELLED')
  })

  it('returns the domain sentence for bad input, writing nothing', async () => {
    const a = await import('@/app/forecast/planned/actions')
    const { company, bank } = await refs()
    const r = await a.createPlannedOutflowAction(fd({ date: '2026-09-15', amount: '1,250,000', bankId: bank.id, companyId: company.id, description: 'X' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/AMOUNT/)
    expect(await testDb.plannedOutflow.count()).toBe(0)
  })

  it('reports an unknown line without throwing', async () => {
    const a = await import('@/app/forecast/planned/actions')
    const r = await a.markPlannedOutflowPaidAction(fd({ id: 'nope', paidOn: '2026-09-16' }))
    expect(r).toEqual({ ok: false, message: 'Planned outflow not found.' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx.cmd vitest run tests/actions/planned-outflow-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: The actions**

Create `app/forecast/planned/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import {
  createPlannedOutflow, updatePlannedOutflow, markPlannedOutflowPaid, cancelPlannedOutflow,
} from '@/lib/planned-outflow/actions'

/**
 * Planned outflow lines, off the form. Any Finance user. Every refusal is the
 * domain's own sentence; anything else is logged and reported as a fixed line.
 */
export type PlannedActionResult = { ok: true } | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

const inputOf = (f: FormData) => ({
  date: str(f, 'date'), amount: str(f, 'amount'), currency: str(f, 'currency'),
  bankId: str(f, 'bankId'), companyId: str(f, 'companyId'),
  description: str(f, 'description'), category: str(f, 'category'),
})

async function run(fn: () => Promise<unknown>): Promise<PlannedActionResult> {
  try {
    await fn()
    revalidatePath('/forecast')
    revalidatePath('/forecast/planned')
    return { ok: true }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    if (isNextControlFlowError(e)) throw e
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}

export async function createPlannedOutflowAction(formData: FormData): Promise<PlannedActionResult> {
  const user = await requireUser()
  return run(() => createPlannedOutflow(prisma, { input: inputOf(formData), userId: user.id, now: new Date() }))
}

export async function updatePlannedOutflowAction(formData: FormData): Promise<PlannedActionResult> {
  const user = await requireUser()
  return run(() => updatePlannedOutflow(prisma, { id: str(formData, 'id'), input: inputOf(formData), userId: user.id, now: new Date() }))
}

export async function markPlannedOutflowPaidAction(formData: FormData): Promise<PlannedActionResult> {
  const user = await requireUser()
  return run(() => markPlannedOutflowPaid(prisma, { id: str(formData, 'id'), paidOn: str(formData, 'paidOn'), userId: user.id, now: new Date() }))
}

export async function cancelPlannedOutflowAction(formData: FormData): Promise<PlannedActionResult> {
  const user = await requireUser()
  return run(() => cancelPlannedOutflow(prisma, { id: str(formData, 'id'), reason: str(formData, 'reason'), userId: user.id, now: new Date() }))
}
```

- [ ] **Step 4: Run the test**

Run: `npx.cmd vitest run tests/actions/planned-outflow-actions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: The components**

Create `components/PlannedOutflowForm.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createPlannedOutflowAction, updatePlannedOutflowAction, type PlannedActionResult } from '@/app/forecast/planned/actions'

export type PlannedOutflowFormValues = {
  date: string; amount: string; currency: string; bankId: string; companyId: string; description: string; category: string
}

const EMPTY: PlannedOutflowFormValues = { date: '', amount: '', currency: 'PHP', bankId: '', companyId: '', description: '', category: '' }

/**
 * One line, typed. Used to add (no `id`) and to edit an open line (with one).
 * The amount is a text box, not a number input: rule 8 — it reaches the server
 * as the string the user typed and is validated as money there.
 */
export function PlannedOutflowForm({
  id, initial, banks, companies, onDone,
}: {
  id?: string
  initial?: PlannedOutflowFormValues
  banks: { id: string; code: string }[]
  companies: { id: string; code: string; name: string }[]
  onDone?: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<PlannedActionResult | null>(null)
  const v = initial ?? EMPTY

  const field = 'h-10 w-full rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const label = 'block text-[11px] font-semibold tracking-widest text-slate-400'
  const p = id ? `edit-${id}` : 'add'

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const form = e.currentTarget
        const formData = new FormData(form)
        if (id) formData.set('id', id)
        startTransition(async () => {
          const r = id ? await updatePlannedOutflowAction(formData) : await createPlannedOutflowAction(formData)
          setResult(r)
          if (r.ok) {
            if (!id) form.reset()
            router.refresh()
            onDone?.()
          }
        })
      }}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <label htmlFor={`${p}-date`} className={label}>DATE — LEAVES THE BANK ON</label>
          <input id={`${p}-date`} name="date" type="date" required defaultValue={v.date} disabled={pending} className={field} />
        </div>
        <div>
          <label htmlFor={`${p}-amount`} className={label}>AMOUNT</label>
          <input id={`${p}-amount`} name="amount" inputMode="decimal" required placeholder="1250000.00" defaultValue={v.amount} disabled={pending} className={`${field} text-right tabular-nums`} />
        </div>
        <div>
          <label htmlFor={`${p}-currency`} className={label}>CURRENCY</label>
          <input id={`${p}-currency`} name="currency" defaultValue={v.currency} disabled={pending} className={field} />
        </div>
        <div>
          <label htmlFor={`${p}-bank`} className={label}>BANK</label>
          <select id={`${p}-bank`} name="bankId" required defaultValue={v.bankId} disabled={pending} className={field}>
            <option value="">—</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${p}-company`} className={label}>COMPANY</label>
          <select id={`${p}-company`} name="companyId" required defaultValue={v.companyId} disabled={pending} className={field}>
            <option value="">—</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${p}-category`} className={label}>CATEGORY</label>
          <input id={`${p}-category`} name="category" placeholder="PAYROLL" defaultValue={v.category} disabled={pending} className={field} />
        </div>
        <div className="md:col-span-3">
          <label htmlFor={`${p}-description`} className={label}>DESCRIPTION</label>
          <input id={`${p}-description`} name="description" required placeholder="September 2nd-half payroll" defaultValue={v.description} disabled={pending} className={field} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90 disabled:opacity-50">
          {pending ? 'SAVING…' : id ? 'SAVE CHANGES' : 'ADD LINE'}
        </button>
        {onDone && (
          <button type="button" onClick={onDone} disabled={pending} className="text-sm text-slate-500 underline underline-offset-2">CANCEL EDIT</button>
        )}
      </div>
      {result && !result.ok && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
      )}
    </form>
  )
}
```

Create `components/PlannedOutflowList.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatMoney } from '@/lib/money'
import type { PlannedOutflowRow } from '@/lib/planned-outflow/query'
import { markPlannedOutflowPaidAction, cancelPlannedOutflowAction, type PlannedActionResult } from '@/app/forecast/planned/actions'
import { PlannedOutflowForm } from './PlannedOutflowForm'

const fmtDay = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const fmtWhen = (d: Date | null) =>
  d ? d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }) : '—'
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Open lines with their three controls; closed lines as facts. `amount`
 * arrives as a decimal string and is formatted here — never parsed.
 */
export function PlannedOutflowList({
  rows, banks, companies, today,
}: {
  rows: PlannedOutflowRow[]
  banks: { id: string; code: string }[]
  companies: { id: string; code: string; name: string }[]
  /** Today's Manila day, YYYY-MM-DD, for the PAID ON default. */
  today: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, PlannedActionResult>>({})

  const submit = (id: string, action: (f: FormData) => Promise<PlannedActionResult>, form: HTMLFormElement) => {
    const f = new FormData(form)
    f.set('id', id)
    startTransition(async () => {
      const r = await action(f)
      setResults((prev) => ({ ...prev, [id]: r }))
      if (r.ok) router.refresh()
    })
  }

  const small = 'h-9 rounded-lg border border-hairline bg-white px-2 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const button = 'h-9 rounded-lg border border-hairline bg-white px-3 text-xs font-medium tracking-wide text-navy hover:bg-ground disabled:opacity-50'

  return (
    <ul className="divide-y divide-hairline">
      {rows.map((r) => {
        const open = r.status === 'PLANNED'
        const result = results[r.id]
        return (
          <li key={r.id} className="space-y-3 px-6 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{r.description}</p>
                <p className="text-xs tracking-wide text-slate-500">
                  {fmtDay(r.date)} · {r.bankCode} · {r.companyCode}{r.category ? ` · ${r.category}` : ''} · added by {r.createdBy}
                </p>
                {r.status === 'PAID' && <p className="text-xs text-success-ink">PAID {fmtDay(r.paidAt)} · recorded by {r.paidBy}</p>}
                {r.status === 'CANCELLED' && <p className="text-xs text-slate-500">CANCELLED {fmtWhen(r.cancelledAt)} by {r.cancelledBy}: {r.cancelReason}</p>}
              </div>
              <p className="text-lg font-semibold tabular-nums text-navy">{formatMoney(r.amount, r.currency)}</p>
            </div>

            {open && editing !== r.id && (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={button} disabled={pending} onClick={() => setEditing(r.id)}>EDIT</button>
                <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit(r.id, markPlannedOutflowPaidAction, e.currentTarget) }}>
                  <label htmlFor={`paid-${r.id}`} className="text-[11px] font-semibold tracking-widest text-slate-400">PAID ON</label>
                  <input id={`paid-${r.id}`} name="paidOn" type="date" defaultValue={today} max={today} required className={small} disabled={pending} />
                  <button type="submit" className={button} disabled={pending}>MARK PAID</button>
                </form>
                <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit(r.id, cancelPlannedOutflowAction, e.currentTarget) }}>
                  <input name="reason" placeholder="Reason — required" required className={`${small} w-56`} disabled={pending} />
                  <button type="submit" className={button} disabled={pending}>CANCEL LINE</button>
                </form>
              </div>
            )}

            {open && editing === r.id && (
              <PlannedOutflowForm
                id={r.id} banks={banks} companies={companies} onDone={() => setEditing(null)}
                initial={{
                  date: isoDay(r.date), amount: r.amount, currency: r.currency, bankId: r.bankId,
                  companyId: r.companyId, description: r.description, category: r.category ?? '',
                }}
              />
            )}

            {result && !result.ok && (
              <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{result.message}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 6: The planned page**

Create `app/forecast/planned/page.tsx`:

```tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { manilaDay } from '@/lib/forecast/buckets'
import { listPlannedOutflows, listBanks } from '@/lib/planned-outflow/query'
import { AppHeader } from '@/components/AppHeader'
import { Panel } from '@/components/Panel'
import { EmptyState } from '@/components/EmptyState'
import { PlannedOutflowForm } from '@/components/PlannedOutflowForm'
import { PlannedOutflowList } from '@/components/PlannedOutflowList'

/**
 * PLANNED OUTFLOWS — the money that leaves the bank and is not a cheque.
 *
 * Payroll, tax, loan amortisation, transfers: typed one line at a time
 * (decided 2026-09-12), each with the day it leaves the bank. An open line is
 * on the forecast until somebody marks it PAID or CANCELLED — a past-dated
 * line still open is overdue, and shows as such rather than vanishing.
 * Nothing here is deleted.
 */
export default async function PlannedOutflowsPage({
  searchParams,
}: {
  searchParams: Promise<{ closed?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const includeClosed = params.closed === '1'
  const [rows, banks, options] = await Promise.all([
    listPlannedOutflows(prisma, { includeClosed }),
    listBanks(prisma),
    getFilterOptions(prisma),
  ])
  const openCount = rows.filter((r) => r.status === 'PLANNED').length

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <AppHeader user={user} title="PLANNED OUTFLOWS" back={{ href: '/forecast', label: '← CASH OUTFLOW' }} showForecastLink={false} />

      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        Outflows that are not cheques — payroll, tax, loan amortisation, transfers — typed with the day
        they leave the bank. An open line stays on the forecast until it is marked PAID or CANCELLED;
        a line whose day has passed is overdue, not gone. Nothing here is deleted.
      </p>

      <Panel title="ADD A LINE">
        <PlannedOutflowForm banks={banks} companies={options.companies} />
      </Panel>

      <Panel
        title={`${openCount.toLocaleString('en-PH')} OPEN LINE${openCount === 1 ? '' : 'S'}`}
        aside={
          <Link href={includeClosed ? '/forecast/planned' : '/forecast/planned?closed=1'} className="text-xs text-slate-500 underline underline-offset-2">
            {includeClosed ? 'HIDE PAID AND CANCELLED' : 'SHOW PAID AND CANCELLED'}
          </Link>
        }
        bodyClassName="p-0"
      >
        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState title="NO PLANNED OUTFLOWS" tone="plain">Add the first one above. It will appear on the forecast at once.</EmptyState>
          </div>
        ) : (
          <PlannedOutflowList rows={rows} banks={banks} companies={options.companies} today={manilaDay(new Date())} />
        )}
      </Panel>
    </main>
  )
}
```

- [ ] **Step 7: The forecast page and the route**

`app/forecast/page.tsx`: import `listPlannedRows` and `PLANNED_STAGE`; after the existing `listForecastRows` / `countExcludedIncomplete` `Promise.all` add `listPlannedRows(prisma, { bankCode: bank, companyId: company?.id, stage })` as a third member (`[cheques, incompleteCount, planned]`); `const rows = [...cheques, ...planned]`; `const expectedCount = cheques.filter((c) => c.expectedOutflowDate !== null).length`. The premise paragraph gains, after the first sentence: `A cheque on which Finance has typed an expected outflow date is placed on that date instead. Planned lines — payroll, tax, transfers — sit on their own day.` The count line becomes:

```tsx
            {cheques.length.toLocaleString('en-PH')} CHEQUE{cheques.length === 1 ? '' : 'S'} WRITTEN AND NOT YET HANDED OVER
            {' AND '}{planned.length.toLocaleString('en-PH')} PLANNED LINE{planned.length === 1 ? '' : 'S'}
            {expectedCount > 0 && ` · ${expectedCount.toLocaleString('en-PH')} PLACED ON AN EXPECTED DATE`}
            {' · '}{describeForecastFilters({ bank, company: company?.code, stage })}
```
Beside EXPORT EXCEL add `<Link href="/forecast/planned" className="rounded-lg border border-hairline bg-white px-4 py-2 text-sm font-medium tracking-wide text-navy transition hover:bg-ground">PLANNED OUTFLOWS</Link>`. The empty state's titles become `'NOTHING MATCHES'` / `'NOTHING IS WAITING TO LEAVE THE BANK'` with bodies `'No live cheque or planned line carries that bank, company and stage together.'` / `'Every cheque has been released, cancelled or voided, and no planned outflow is open.'`.

`app/api/export/forecast/route.ts`: the same three-way `Promise.all`; `rows = [...cheques, ...planned]`; `buildMatrices(rows, now)`; `meta` gains `plannedCount: planned.length, expectedCount: cheques.filter((c) => c.expectedOutflowDate !== null).length`. Remove the placeholder zeros Task 4 left.

- [ ] **Step 8: CLAUDE.md**

In the Layout table's `lib/forecast/` row append: ` Since 2026-09-12 a cheque's typed `expectedOutflowDate` wins over its cheque date, and `PlannedOutflow` lines (`lib/planned-outflow/`, `/forecast/planned`) join the population as their own PLANNED column.`

In "What is missing" item 10, append: ` **Calibrated 2026-09-12:** Finance types the day a cheque is expected to leave the bank (EXPECTED OUT, on the cheque page; the forecast places it there) and planned non-cheque outflows — payroll, tax, loans, transfers — as one-off lines on `/forecast/planned`, open until marked PAID or CANCELLED, never deleted. The daily cash position is no longer cheques only.`

- [ ] **Step 9: tsc, build, commit**

Run: `npx.cmd tsc --noEmit` — clean. Run: `npx.cmd next build` — `/forecast/planned` listed.

```bash
git add app/forecast components/PlannedOutflowForm.tsx components/PlannedOutflowList.tsx app/api/export/forecast/route.ts CLAUDE.md tests/actions/planned-outflow-actions.test.ts
git commit -m "feat: /forecast/planned - planned outflow lines, and the forecast shows both

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** A (column, fifth field, audit as days, never imported, bucketed on it, page count, DETAIL columns) — Tasks 1, 2, 4, 5. B (model, constraint, four writers with guards and audit rows, no delete, screen with add/edit/paid/cancel and the closed toggle, PLANNED link) — Tasks 1, 3, 5. C (`listPlannedRows`, `kind`, PLANNED column last and only when present, stage filter, count line, extract columns, title block) — Tasks 4, 5. D — Task 1. Testing list — every file named appears in a task.

**Deviations, stated.** (1) `cancelledAt` is the action's `now` while `paidAt` is the typed PAID ON day: a cancellation is an act at a moment, a payment is a day on a statement. (2) `updatedAt` orders the closed list (the spec said "newest first" without naming the column). (3) The audit query in the Task 3 test uses Prisma's JSON path filter; a JS fallback is given if the client refuses it.

**Type consistency.** `ForecastStage`, `PLANNED_STAGE`, `ForecastRow.kind`, `expectedOutflowDate` are defined in Task 4 and consumed in Task 5 and by the tests in Task 4; `PlannedOutflowRow` (Task 3) is what `PlannedOutflowList` (Task 5) takes; `isIsoDay`/`dayToDate`/`isoDay` (Task 2) are used by Task 3; `ForecastMeta.plannedCount`/`expectedCount` (Task 4) are passed in Task 5; `PlannedActionResult` (Task 5) is shared by both components.
