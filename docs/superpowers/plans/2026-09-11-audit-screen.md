# Audit Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/audit` — the first screen that reads the audit trail: people's actions by default, the system's on request, filtered by action / user / cheque / date, keyset-paginated, with an Excel extract of the filtered range.

**Architecture:** A pure view module (`lib/audit-view.ts`) owns parameters, the cursor and the Manila-day bounds; one read module (`lib/audit-query.ts`) owns the four queries; a server component draws the table; a page and an export route sit on them, guarded like their neighbours. One additive index migration. Nothing writes.

**Tech Stack:** Next 15 App Router · Prisma 6 query API (keyset via `OR`) · ExcelJS · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-audit-screen-design.md`. Read it before Task 1.

## Global Constraints

- **`npx tsc --noEmit` must pass before any task is called done.** Vitest transpiles with esbuild, which erases types.
- **On Windows use `npx.cmd` / `npm.cmd`.**
- **Run ONLY the test files named in the task. Never the full suite.** Database tests share one Neon database that `resetDb()` truncates — never two test processes at once.
- **The index migration reaches the TEST database before any test runs:** `node scripts/migrate.mjs test`, then `npx.cmd prisma generate`. Production gets it by hand before deploy.
- **Rule 7: audit rows are append-only.** `writeAudit` in `lib/audit.ts` stays the only writer; nothing in this plan writes to `AuditLog`. `app.allow_audit_purge` appears nowhere new.
- **FINANCE_ADMIN only** — the page via `requireAdmin()` first; the route via `getSessionUser()` first AND a role check, 401 not a redirect. Neither path is added to `lib/public-paths.ts`.
- **Default view is `actorType = USER`**; `system=1` drops the actor filter entirely.
- **Keyset pagination, never offset.** Order `(createdAt desc, id desc)`; page size 100; the read fetches 101 to know whether a next page exists.
- **The ACTION select is built from `SELECT DISTINCT action` — never a hard-coded list.**
- **Dates are Manila calendar days**, inclusive, converted to UTC instants once in the pure layer.
- **Rule 8: nothing here touches an amount.** `details` JSON is rendered as text, never parsed for money.
- **British spelling in prose. Never commit or print `.env`, credentials or any `.xlsx`. No raw control characters.**
- **Commit messages end with:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | **Modify.** Three `@@index` lines on `AuditLog`. |
| `prisma/migrations/20260911000200_audit_log_indexes/migration.sql` | **Create.** Four `CREATE INDEX` statements. |
| `lib/audit-view.ts` | **Create.** Pure: filters type, `parseAuditParams`, cursor encode/decode, Manila-day bounds, `auditHref`, `describeAuditFilters`, `actionWords`, `auditFilename`, `AUDIT_PAGE_SIZE`. |
| `lib/audit-query.ts` | **Create.** `listAuditRows`, `countAuditRows`, `listAuditActions`, `listAuditUsers`. |
| `lib/export/audit-workbook.ts` | **Create.** One sheet, `AUDIT`. |
| `components/AuditTable.tsx` | **Create.** Server component with the DETAILS disclosure. |
| `app/admin/audit/page.tsx` | **Create.** |
| `app/api/export/audit/route.ts` | **Create.** |
| `app/admin/layout.tsx` | **Modify.** The `AUDIT` tab. |
| `CLAUDE.md` | **Modify.** Item 3 becomes built. |
| `tests/audit-view.test.ts`, `tests/admin/audit-query.test.ts`, `tests/export/audit-workbook.test.ts`, `tests/export/audit-route.test.ts` | **Create.** |

---

### Task 1: The indexes and the pure view module

**Files:**
- Modify: `prisma/schema.prisma` (model `AuditLog`)
- Create: `prisma/migrations/20260911000200_audit_log_indexes/migration.sql`, `lib/audit-view.ts`
- Test: `tests/audit-view.test.ts`

**Interfaces:**
- Produces, from `lib/audit-view.ts`:
  ```ts
  export const AUDIT_PATH = '/admin/audit'
  export const AUDIT_EXPORT_PATH = '/api/export/audit'
  export const AUDIT_PAGE_SIZE = 100
  export type AuditFilters = { system: boolean; action?: string; userId?: string; checkNumber?: string; from?: Date; to?: Date }
  export type AuditCursor = { createdAt: Date; id: string }
  export type AuditParams = { system?: string; action?: string; user?: string; check?: string; from?: string; to?: string; before?: string }
  export function parseAuditParams(p: AuditParams): { filters: AuditFilters; cursor: AuditCursor | null; raw: { from?: string; to?: string } }
  export function encodeCursor(c: AuditCursor): string
  export function decodeCursor(s: string | undefined): AuditCursor | null
  export function manilaDayStart(day: string): Date          // 'YYYY-MM-DD' → 00:00 Manila as a UTC instant
  export function manilaDayEnd(day: string): Date            // 23:59:59.999 Manila
  export function auditHref(p: AuditParams, path?: string): string
  export function describeAuditFilters(f: AuditFilters, names: { user?: string }): string
  export function actionWords(action: string): string       // 'release_reversed' → 'RELEASE REVERSED'
  export function auditFilename(generatedAt: Date): string   // 'audit-<manila day>.xlsx'
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/audit-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  AUDIT_PATH, AUDIT_EXPORT_PATH, AUDIT_PAGE_SIZE,
  parseAuditParams, encodeCursor, decodeCursor, manilaDayStart, manilaDayEnd,
  auditHref, describeAuditFilters, actionWords, auditFilename,
} from '@/lib/audit-view'

/** Pure. The page reads these and decides nothing itself. */
describe('the cursor', () => {
  it('round-trips a (createdAt, id) pair', () => {
    const c = { createdAt: new Date('2026-09-11T02:18:51.275Z'), id: 'clx0001' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('refuses anything malformed rather than paging from garbage', () => {
    expect(decodeCursor(undefined)).toBeNull()
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-a-date|x')).toBeNull()
    expect(decodeCursor('2026-09-11T02:18:51.275Z')).toBeNull()
  })
})

describe('Manila day bounds', () => {
  it('start and end of a Manila day, as UTC instants', () => {
    expect(manilaDayStart('2026-09-11').toISOString()).toBe('2026-09-10T16:00:00.000Z')
    expect(manilaDayEnd('2026-09-11').toISOString()).toBe('2026-09-11T15:59:59.999Z')
  })
})

describe('parseAuditParams', () => {
  it('defaults to people only, no filters, first page', () => {
    const { filters, cursor } = parseAuditParams({})
    expect(filters).toEqual({ system: false })
    expect(cursor).toBeNull()
  })

  it('reads every filter, and widens to the system on request', () => {
    const { filters } = parseAuditParams({
      system: '1', action: 'release_reversed', user: 'u1', check: ' 6000353106 ', from: '2026-09-01', to: '2026-09-11',
    })
    expect(filters.system).toBe(true)
    expect(filters.action).toBe('release_reversed')
    expect(filters.userId).toBe('u1')
    expect(filters.checkNumber).toBe('6000353106')
    expect(filters.from?.toISOString()).toBe('2026-08-31T16:00:00.000Z')
    expect(filters.to?.toISOString()).toBe('2026-09-11T15:59:59.999Z')
  })

  it('ignores a date it cannot read rather than filtering to nothing', () => {
    const { filters } = parseAuditParams({ from: '11/09/2026', to: '' })
    expect(filters.from).toBeUndefined()
    expect(filters.to).toBeUndefined()
  })
})

describe('auditHref', () => {
  it('is the bare path with nothing set', () => {
    expect(auditHref({})).toBe(AUDIT_PATH)
  })

  it('carries filters and the cursor, drops empties, and can point at the export without the cursor', () => {
    expect(auditHref({ system: '1', action: 'imported', before: 'x' })).toBe('/admin/audit?system=1&action=imported&before=x')
    expect(auditHref({ system: '1', action: 'imported', before: 'x' }, AUDIT_EXPORT_PATH)).toBe('/api/export/audit?system=1&action=imported')
  })
})

describe('describeAuditFilters', () => {
  it('names each filter in force, with the user by name', () => {
    expect(describeAuditFilters(
      { system: true, action: 'release_reversed', userId: 'u1', checkNumber: '6000353106', from: manilaDayStart('2026-09-01'), to: manilaDayEnd('2026-09-11') },
      { user: 'Paolo Parcon' },
    )).toBe('INCLUDING SYSTEM ROWS  ·  ACTION: RELEASE REVERSED  ·  USER: Paolo Parcon  ·  CHECK: 6000353106  ·  FROM 2026-09-01  ·  TO 2026-09-11')
  })

  it('says what the default is', () => {
    expect(describeAuditFilters({ system: false }, {})).toBe("PEOPLE'S ACTIONS ONLY")
  })
})

describe('words and names', () => {
  it('spells an action as words', () => {
    expect(actionWords('release_reversed')).toBe('RELEASE REVERSED')
  })

  it('dates the filename on the Manila day', () => {
    expect(auditFilename(new Date('2026-09-10T16:30:00Z'))).toBe('audit-2026-09-11.xlsx')
  })

  it('pages by 100', () => {
    expect(AUDIT_PAGE_SIZE).toBe(100)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/audit-view.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/audit-view"`.

- [ ] **Step 3: The indexes**

In `prisma/schema.prisma`, inside `model AuditLog`, after the existing `@@index([checkId, createdAt])`, add:

```prisma
  // The audit SCREEN (2026-09-11). Until then the only reader was a cheque's
  // own trail, served by the index above. A newest-first page over 65,269 rows
  // is a keyset on (createdAt, id); "what did people do" is the actorType
  // index; the ACTION and USER filters get their own. Offset pagination was
  // rejected because every page would be a sequential scan.
  @@index([createdAt, id])
  @@index([actorType, createdAt])
  @@index([action, createdAt])
  @@index([userId, createdAt])
```

Create `prisma/migrations/20260911000200_audit_log_indexes/migration.sql`:

```sql
-- Indexes for the audit screen. Additive; no data changes; the append-only
-- trigger is untouched. See the comment on the AuditLog model.
CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt", "id");
CREATE INDEX "AuditLog_actorType_createdAt_idx" ON "AuditLog"("actorType", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");
```

Apply and regenerate:

```bash
node scripts/migrate.mjs test
npx.cmd prisma generate
```

Expected: `Migrating TEST: <host>/check_monitoring_test`, one migration applied.

- [ ] **Step 4: The pure module**

Create `lib/audit-view.ts`:

```ts
/**
 * The audit screen's arithmetic — parameters, the cursor, the Manila-day
 * bounds, hrefs, the filter line, the filename. Pure, like `vouchers-view.ts`
 * and `forecast-view.ts`: the page reads these and decides nothing itself.
 */

export const AUDIT_PATH = '/admin/audit'
export const AUDIT_EXPORT_PATH = '/api/export/audit'

/** Rows per page. A keyset page, so the number is about reading, not cost. */
export const AUDIT_PAGE_SIZE = 100

export type AuditFilters = {
  /** True widens to every row; false (the default) is people's actions only. */
  system: boolean
  action?: string
  userId?: string
  checkNumber?: string
  from?: Date
  to?: Date
}

/** Where the previous page ended. Rows are ordered (createdAt desc, id desc). */
export type AuditCursor = { createdAt: Date; id: string }

export type AuditParams = {
  system?: string; action?: string; user?: string; check?: string; from?: string; to?: string; before?: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A Manila calendar day's first and last instants, as UTC. The Philippines is
 * UTC+8 with no daylight saving, so the offset is a constant rather than a
 * timezone lookup — the same reasoning as `MANILA_OFFSET_MS` in the voucher
 * workbook.
 */
export function manilaDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000+08:00`)
}
export function manilaDayEnd(day: string): Date {
  return new Date(`${day}T23:59:59.999+08:00`)
}

function readDay(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v && DAY.test(v) && !Number.isNaN(manilaDayStart(v).getTime()) ? v : undefined
}

/** `<createdAt ISO>|<id>`. Both halves are needed: two rows can share an instant. */
export function encodeCursor(c: AuditCursor): string {
  return `${c.createdAt.toISOString()}|${c.id}`
}

export function decodeCursor(s: string | undefined): AuditCursor | null {
  if (!s) return null
  const bar = s.indexOf('|')
  if (bar <= 0 || bar === s.length - 1) return null
  const createdAt = new Date(s.slice(0, bar))
  if (Number.isNaN(createdAt.getTime())) return null
  return { createdAt, id: s.slice(bar + 1) }
}

export function parseAuditParams(p: AuditParams): {
  filters: AuditFilters
  cursor: AuditCursor | null
  raw: { from?: string; to?: string }
} {
  const from = readDay(p.from)
  const to = readDay(p.to)
  const filters: AuditFilters = { system: p.system === '1' }
  const action = p.action?.trim()
  if (action) filters.action = action
  const user = p.user?.trim()
  if (user) filters.userId = user
  const check = p.check?.trim()
  if (check) filters.checkNumber = check
  if (from) filters.from = manilaDayStart(from)
  if (to) filters.to = manilaDayEnd(to)
  return { filters, cursor: decodeCursor(p.before), raw: { from, to } }
}

/** The URL a filled-in form means. The export never carries the cursor: a file is the whole range. */
export function auditHref(p: AuditParams, path: string = AUDIT_PATH): string {
  const qs = new URLSearchParams()
  const keys: (keyof AuditParams)[] = ['system', 'action', 'user', 'check', 'from', 'to', 'before']
  for (const key of keys) {
    if (key === 'before' && path !== AUDIT_PATH) continue
    const v = p[key]?.trim()
    if (v) qs.set(key, v)
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export function actionWords(action: string): string {
  return action.replace(/_/g, ' ').toUpperCase()
}

/** The Manila day of an instant, for the filter line and the filename. */
function manilaDay(d: Date): string {
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function describeAuditFilters(f: AuditFilters, names: { user?: string }): string {
  const parts: string[] = []
  if (f.system) parts.push('INCLUDING SYSTEM ROWS')
  if (f.action) parts.push(`ACTION: ${actionWords(f.action)}`)
  if (f.userId) parts.push(`USER: ${names.user ?? f.userId}`)
  if (f.checkNumber) parts.push(`CHECK: ${f.checkNumber}`)
  if (f.from) parts.push(`FROM ${manilaDay(f.from)}`)
  if (f.to) parts.push(`TO ${manilaDay(f.to)}`)
  return parts.length ? parts.join('  ·  ') : "PEOPLE'S ACTIONS ONLY"
}

export function auditFilename(generatedAt: Date): string {
  return `audit-${manilaDay(generatedAt)}.xlsx`
}
```

- [ ] **Step 5: Run the test and the type-checker**

```bash
npx.cmd vitest run tests/audit-view.test.ts
```

Expected: PASS, 13 tests.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260911000200_audit_log_indexes/migration.sql lib/audit-view.ts tests/audit-view.test.ts
git commit -m "feat: the audit screen's arithmetic, and the indexes it will read through

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The reads

**Files:**
- Create: `lib/audit-query.ts`
- Test: `tests/admin/audit-query.test.ts`

**Interfaces:**
- Consumes: `AuditFilters`, `AuditCursor`, `AUDIT_PAGE_SIZE` (Task 1).
- Produces:
  ```ts
  export type AuditRow = {
    id: string; createdAt: Date; actorType: string; action: string; remarks: string | null
    details: unknown
    userName: string | null
    checkId: string | null; checkNumber: string | null   // checkNumber from the cheque, else details.checkNumber, else null
  }
  export function listAuditRows(db: Db, filters: AuditFilters, cursor: AuditCursor | null): Promise<{ rows: AuditRow[]; hasMore: boolean }>
  export function countAuditRows(db: Db, filters: AuditFilters): Promise<number>
  export function listAuditActions(db: Db): Promise<string[]>
  export function listAuditUsers(db: Db): Promise<{ id: string; name: string }[]>
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/admin/audit-query.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { Prisma } from '@prisma/client'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { writeAudit } from '@/lib/audit'
import { listAuditRows, countAuditRows, listAuditActions, listAuditUsers } from '@/lib/audit-query'
import { AUDIT_PAGE_SIZE } from '@/lib/audit-view'

beforeEach(resetDb)

const at = (iso: string) => new Date(iso)

/** Rows are created through `writeAudit` — the only writer — then dated by hand. */
async function row(o: { action: string; actor?: 'USER' | 'SYSTEM'; userId?: string; checkId?: string; createdAt: string; details?: Prisma.InputJsonValue; remarks?: string }) {
  await writeAudit(testDb, {
    action: o.action, actorType: o.actor ?? 'USER', userId: o.userId, checkId: o.checkId,
    details: o.details, remarks: o.remarks,
  })
  const created = await testDb.auditLog.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
  return testDb.auditLog.update({ where: { id: created.id }, data: { createdAt: at(o.createdAt) } })
}

describe('listAuditRows — the population', () => {
  it("shows people's actions by default and hides the system's", async () => {
    const u = await makeUser()
    await row({ action: 'released', userId: u.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T03:00:00Z' })
    const { rows } = await listAuditRows(testDb, { system: false }, null)
    expect(rows.map((r) => r.action)).toEqual(['released'])
    expect(rows[0].userName).toBe(u.name)
  })

  it('widens to everything on request, newest first', async () => {
    const u = await makeUser()
    await row({ action: 'released', userId: u.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T03:00:00Z' })
    const { rows } = await listAuditRows(testDb, { system: true }, null)
    expect(rows.map((r) => r.action)).toEqual(['imported', 'released'])
  })

  it('carries the cheque number from the cheque, or from details when the cheque is gone', async () => {
    const u = await makeUser()
    const check = await makeCheck({ checkNumber: '6000353106' })
    await row({ action: 'released', userId: u.id, checkId: check.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'bulk_removed_out_of_scope', actor: 'SYSTEM', createdAt: '2026-09-11T01:00:00Z', details: { checkNumber: '6000000001' } })
    const { rows } = await listAuditRows(testDb, { system: true }, null)
    expect(rows[0].checkNumber).toBe('6000353106')
    expect(rows[0].checkId).toBe(check.id)
    expect(rows[1].checkNumber).toBe('6000000001')
    expect(rows[1].checkId).toBeNull()
  })
})

describe('listAuditRows — the filters', () => {
  it('narrows by action, user, cheque number and date', async () => {
    const a = await makeUser()
    const b = await makeUser()
    const check = await makeCheck({ checkNumber: '6000353106' })
    await row({ action: 'released', userId: a.id, checkId: check.id, createdAt: '2026-09-10T02:00:00Z' })
    await row({ action: 'marked_signed', userId: b.id, createdAt: '2026-09-11T02:00:00Z' })

    expect((await listAuditRows(testDb, { system: false, action: 'released' }, null)).rows).toHaveLength(1)
    expect((await listAuditRows(testDb, { system: false, userId: b.id }, null)).rows.map((r) => r.action)).toEqual(['marked_signed'])
    expect((await listAuditRows(testDb, { system: false, checkNumber: '6000353106' }, null)).rows.map((r) => r.action)).toEqual(['released'])
    expect((await listAuditRows(testDb, {
      system: false, from: at('2026-09-10T16:00:00Z'), to: at('2026-09-11T15:59:59.999Z'),
    }, null)).rows.map((r) => r.action)).toEqual(['marked_signed'])
  })

  it('counts the same population the list shows', async () => {
    const u = await makeUser()
    await row({ action: 'released', userId: u.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T03:00:00Z' })
    expect(await countAuditRows(testDb, { system: false })).toBe(1)
    expect(await countAuditRows(testDb, { system: true })).toBe(2)
  })
})

describe('listAuditRows — the keyset', () => {
  it('pages without repeating or skipping a row, even when two share an instant', async () => {
    const u = await makeUser()
    // 101 rows: 99 distinct instants and two sharing the boundary instant.
    for (let i = 0; i < 99; i++) {
      await row({ action: `a${i}`, userId: u.id, createdAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.${String(Math.floor(i / 60))}00Z` })
    }
    await row({ action: 'twin-1', userId: u.id, createdAt: '2026-08-31T00:00:00Z' })
    await row({ action: 'twin-2', userId: u.id, createdAt: '2026-08-31T00:00:00Z' })

    const first = await listAuditRows(testDb, { system: false }, null)
    expect(first.rows).toHaveLength(AUDIT_PAGE_SIZE)
    expect(first.hasMore).toBe(true)
    const last = first.rows[first.rows.length - 1]
    const second = await listAuditRows(testDb, { system: false }, { createdAt: last.createdAt, id: last.id })
    expect(second.rows).toHaveLength(1)
    expect(second.hasMore).toBe(false)
    const seen = new Set([...first.rows, ...second.rows].map((r) => r.id))
    expect(seen.size).toBe(101)
  })
})

describe('the selects', () => {
  it('lists distinct actions, sorted, and users by name', async () => {
    const u = await makeUser()
    await row({ action: 'released', userId: u.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T03:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T04:00:00Z' })
    expect(await listAuditActions(testDb)).toEqual(['imported', 'released'])
    expect((await listAuditUsers(testDb)).map((x) => x.id)).toContain(u.id)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx.cmd vitest run tests/admin/audit-query.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/audit-query"`.

- [ ] **Step 3: The reads**

Create `lib/audit-query.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client'
import { AUDIT_PAGE_SIZE, type AuditFilters, type AuditCursor } from './audit-view'

type Db = PrismaClient | Prisma.TransactionClient

export type AuditRow = {
  id: string
  createdAt: Date
  actorType: string
  action: string
  remarks: string | null
  details: unknown
  userName: string | null
  checkId: string | null
  /** The cheque's number; for a detached row, the number its details recorded; else null. */
  checkNumber: string | null
}

/**
 * The audit screen's reads. READ ONLY — `writeAudit` in lib/audit.ts is the
 * only writer and the database trigger makes rows append-only.
 *
 * The default population is people's actions (`actorType = USER`): measured
 * 2026-09-11, 4 of 65,269 rows. `system: true` drops that clause and shows
 * everything, which is where the 1,958 company restorations of 10 September
 * live. The CHECK filter goes through the join, so a detached row (cheque
 * since deleted) cannot match it — the page says so.
 */
function whereFor(filters: AuditFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {}
  if (!filters.system) where.actorType = 'USER'
  if (filters.action) where.action = filters.action
  if (filters.userId) where.userId = filters.userId
  if (filters.checkNumber) where.check = { checkNumber: filters.checkNumber }
  if (filters.from || filters.to) where.createdAt = { gte: filters.from, lte: filters.to }
  return where
}

function detailsCheckNumber(details: unknown): string | null {
  if (details && typeof details === 'object' && 'checkNumber' in details) {
    const v = (details as { checkNumber?: unknown }).checkNumber
    return typeof v === 'string' ? v : null
  }
  return null
}

/**
 * One page, newest first, by KEYSET. `cursor` is the last row of the previous
 * page; the next page is everything strictly before it in (createdAt, id)
 * order. Prisma has no tuple comparison, so the two-column "less than" is
 * spelled out as an OR. 101 rows are fetched so `hasMore` is a fact, not a
 * guess from a full page.
 */
export async function listAuditRows(
  db: Db, filters: AuditFilters, cursor: AuditCursor | null,
): Promise<{ rows: AuditRow[]; hasMore: boolean }> {
  const where = whereFor(filters)
  const keyset: Prisma.AuditLogWhereInput | undefined = cursor
    ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
    : undefined

  const found = await db.auditLog.findMany({
    where: keyset ? { AND: [where, keyset] } : where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: AUDIT_PAGE_SIZE + 1,
    select: {
      id: true, createdAt: true, actorType: true, action: true, remarks: true, details: true, checkId: true,
      user: { select: { name: true } },
      check: { select: { checkNumber: true } },
    },
  })

  const rows = found.slice(0, AUDIT_PAGE_SIZE).map((r) => ({
    id: r.id, createdAt: r.createdAt, actorType: r.actorType, action: r.action, remarks: r.remarks,
    details: r.details, userName: r.user?.name ?? null, checkId: r.checkId,
    checkNumber: r.check?.checkNumber ?? detailsCheckNumber(r.details),
  }))
  return { rows, hasMore: found.length > AUDIT_PAGE_SIZE }
}

export async function countAuditRows(db: Db, filters: AuditFilters): Promise<number> {
  return db.auditLog.count({ where: whereFor(filters) })
}

/** Every action the trail has ever recorded, sorted. Never hard-coded: 21 today, and the next is a code change away. */
export async function listAuditActions(db: Db): Promise<string[]> {
  const rows = await db.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } })
  return rows.map((r) => r.action)
}

export async function listAuditUsers(db: Db): Promise<{ id: string; name: string }[]> {
  return db.user.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } })
}
```

- [ ] **Step 4: Run the test file and the type-checker**

```bash
npx.cmd vitest run tests/admin/audit-query.test.ts
```

Expected: PASS, 7 tests. (The keyset test creates 101 rows across the network — allow it a minute.)

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/audit-query.ts tests/admin/audit-query.test.ts
git commit -m "feat: read the audit trail - people by default, everything on request, by keyset

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The workbook and the route

**Files:**
- Create: `lib/export/audit-workbook.ts`, `app/api/export/audit/route.ts`
- Test: `tests/export/audit-workbook.test.ts`, `tests/export/audit-route.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `sheet-style.ts`; `fitColumnWidth`, `EXPORT_ROW_LIMIT` from `lib/export/report.ts`; `getSessionUser`, `prisma`.
- Produces:
  ```ts
  export const AUDIT_SHEET = 'AUDIT'
  export const AUDIT_HEADERS = ['WHEN','WHO','ACTION','CHECK NUMBER','REMARKS','DETAILS'] as const
  export const AUDIT_HEADER_ROW = 6; export const AUDIT_FIRST_DATA_ROW = 7
  export type AuditMeta = { generatedAt: Date; generatedBy: string; filterDescription: string; totalRows: number }
  export function buildAuditWorkbook(input: { rows: readonly AuditRow[]; meta: AuditMeta }): Promise<ArrayBuffer>
  ```
  The route reads up to `EXPORT_ROW_LIMIT` rows newest first by paging `listAuditRows` (100 at a time) until the cap or the end.

- [ ] **Step 1: Write the failing tests**

Create `tests/export/audit-workbook.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildAuditWorkbook, AUDIT_SHEET, AUDIT_HEADER_ROW, AUDIT_FIRST_DATA_ROW, AUDIT_HEADERS } from '@/lib/export/audit-workbook'
import type { AuditRow } from '@/lib/audit-query'

const AT = new Date('2026-09-11T02:18:51.275Z')

function row(o: Partial<AuditRow> & { id: string }): AuditRow {
  return {
    createdAt: AT, actorType: 'USER', action: 'release_reversed', remarks: 'Ticked the wrong row',
    details: { releasedAt: '2026-09-10T01:00:00.000Z' }, userName: 'Paolo Parcon',
    checkId: 'chk1', checkNumber: '6000353106', ...o,
  }
}

async function build(rows: AuditRow[], totalRows = rows.length) {
  const buffer = await buildAuditWorkbook({
    rows, meta: { generatedAt: AT, generatedBy: 'Paolo Parcon', filterDescription: "PEOPLE'S ACTIONS ONLY", totalRows },
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb.getWorksheet(AUDIT_SHEET)!
}

describe('buildAuditWorkbook', () => {
  it('writes the header on row 6 and the first row on row 7', async () => {
    const ws = await build([row({ id: 'a' })])
    expect((ws.getRow(AUDIT_HEADER_ROW).values as string[]).slice(1)).toEqual([...AUDIT_HEADERS])
    const r = ws.getRow(AUDIT_FIRST_DATA_ROW).values as unknown[]
    expect(r[2]).toBe('Paolo Parcon')
    expect(r[3]).toBe('RELEASE REVERSED')
    expect(r[4]).toBe('6000353106')
    expect(r[6]).toBe('{"releasedAt":"2026-09-10T01:00:00.000Z"}')
  })

  it('writes SYSTEM for a system row and the detached marker for a row with no cheque', async () => {
    const ws = await build([row({ id: 'a', actorType: 'SYSTEM', userName: null, checkId: null, checkNumber: null })])
    const r = ws.getRow(AUDIT_FIRST_DATA_ROW).values as unknown[]
    expect(r[2]).toBe('SYSTEM')
    expect(r[4]).toBe('(cheque removed)')
  })

  it('states the filters and the cap in the title block', async () => {
    const ws = await build([row({ id: 'a' })], 20_000)
    expect(String(ws.getCell('A2').value)).toContain("PEOPLE'S ACTIONS ONLY")
    expect(String(ws.getCell('A3').value)).toContain('FIRST 1 OF 20,000')
  })
})
```

Create `tests/export/audit-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetDb, testDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { writeAudit } from '@/lib/audit'

/**
 * Guarded like every export: `getSessionUser()` first, 401 not a redirect —
 * and, because the page is admin-only, a FINANCE_USER is refused too. The
 * counting Proxy proves a refused request never asks the database for anything.
 */
const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => state.user }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: new Proxy(testDb, { get(t, p, r) { state.dbTouches += 1; return Reflect.get(t, p, r) } }) }
})

async function get(url: string) {
  const { GET } = await import('@/app/api/export/audit/route')
  return GET(new Request(url))
}

beforeEach(async () => {
  await resetDb()
  state.user = { id: 'u1', email: 'a@rcl.test', name: 'Admin', role: 'FINANCE_ADMIN' }
  state.dbTouches = 0
})

describe('GET /api/export/audit — the guard', () => {
  it('refuses an unauthenticated request with 401 and touches nothing', async () => {
    state.user = null
    const res = await get('http://localhost/api/export/audit')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('refuses a FINANCE_USER with 401 and touches nothing', async () => {
    state.user = { id: 'u2', email: 'f@rcl.test', name: 'Finance', role: 'FINANCE_USER' }
    const res = await get('http://localhost/api/export/audit')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })
})

describe('GET /api/export/audit — the file', () => {
  it('serves the filtered range under a dated filename, never cached', async () => {
    const u = await makeUser()
    await writeAudit(testDb, { action: 'released', actorType: 'USER', userId: u.id })
    await writeAudit(testDb, { action: 'imported', actorType: 'SYSTEM' })
    const res = await get('http://localhost/api/export/audit')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="audit-\d{4}-\d{2}-\d{2}\.xlsx"/)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx.cmd vitest run tests/export/audit-workbook.test.ts tests/export/audit-route.test.ts
```

Expected: FAIL on both unresolved imports.

- [ ] **Step 3: The workbook**

Create `lib/export/audit-workbook.ts`:

```ts
import ExcelJS from 'exceljs'
import { fitColumnWidth } from './report'
import { BAND_FILL, styleHeaderCell } from './sheet-style'
import type { AuditRow } from '@/lib/audit-query'
import { actionWords } from '@/lib/audit-view'

/**
 * The audit trail, filtered, as one sheet. The file IS the view: the filters
 * in force are in the title block. `details` is written as JSON text — a
 * reader who wants a field out of it has the whole record; a column per key
 * would be 21 actions' worth of columns, mostly empty.
 */
export const AUDIT_SHEET = 'AUDIT'
export const AUDIT_HEADERS = ['WHEN', 'WHO', 'ACTION', 'CHECK NUMBER', 'REMARKS', 'DETAILS'] as const
export const AUDIT_HEADER_ROW = 6
export const AUDIT_FIRST_DATA_ROW = AUDIT_HEADER_ROW + 1

export type AuditMeta = { generatedAt: Date; generatedBy: string; filterDescription: string; totalRows: number }

const TITLE_INK = 'FF0F172A'
const MUTED_INK = 'FF475569'
const count = (n: number) => n.toLocaleString('en-PH')
const TIMESTAMP_FORMAT = 'dd mmm yyyy hh:mm:ss AM/PM'
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000

export async function buildAuditWorkbook({ rows, meta }: { rows: readonly AuditRow[]; meta: AuditMeta }): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  wb.created = meta.generatedAt
  const ws = wb.addWorksheet(AUDIT_SHEET, { views: [{ state: 'frozen', ySplit: AUDIT_HEADER_ROW }] })

  ws.getCell('A1').value = 'AUDIT TRAIL — CHECK RELEASE MONITORING'
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE_INK } }
  ws.getRow(1).height = 24
  ws.getCell('A2').value = meta.filterDescription
  ws.getCell('A2').font = { bold: true, size: 12, color: { argb: TITLE_INK } }
  const stamp = meta.generatedAt.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })
  ws.getCell('A3').value = rows.length < meta.totalRows
    ? `Generated ${stamp} by ${meta.generatedBy}  ·  FIRST ${count(rows.length)} OF ${count(meta.totalRows)} ROWS, newest first`
    : `Generated ${stamp} by ${meta.generatedBy}  ·  ${count(meta.totalRows)} ROW${meta.totalRows === 1 ? '' : 'S'}, newest first`
  ws.getCell('A3').font = { size: 10, color: { argb: MUTED_INK } }
  ws.getCell('A4').value = 'Every row is append-only: nothing here can be edited or removed. WHEN is Manila time.'
  ws.getCell('A4').font = { size: 10, color: { argb: MUTED_INK } }

  const header = ws.getRow(AUDIT_HEADER_ROW)
  AUDIT_HEADERS.forEach((label, i) => styleHeaderCell(header.getCell(i + 1), label))
  header.height = 20
  const samples: string[][] = AUDIT_HEADERS.map(() => [])

  rows.forEach((r, i) => {
    const excelRow = ws.getRow(AUDIT_FIRST_DATA_ROW + i)
    const values: (string | Date | null)[] = [
      // Shifted by the Manila offset so Excel's zone-less serial shows Manila digits — as voucher-workbook.ts does.
      new Date(r.createdAt.getTime() + MANILA_OFFSET_MS),
      r.actorType === 'SYSTEM' ? 'SYSTEM' : r.userName ?? 'UNKNOWN USER',
      actionWords(r.action),
      r.checkNumber ?? '(cheque removed)',
      r.remarks,
      r.details === null || r.details === undefined ? null : JSON.stringify(r.details),
    ]
    values.forEach((v, col) => {
      const cell = excelRow.getCell(col + 1)
      cell.value = v
      if (v instanceof Date) cell.numFmt = TIMESTAMP_FORMAT
      samples[col].push(v === null ? '' : v instanceof Date ? '11 Sep 2026 10:18:51 AM' : v)
    })
    if (i % 2 === 1) excelRow.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } } })
  })
  AUDIT_HEADERS.forEach((label, i) => { ws.getColumn(i + 1).width = fitColumnWidth(label, samples[i]) })
  ws.autoFilter = { from: { row: AUDIT_HEADER_ROW, column: 1 }, to: { row: AUDIT_HEADER_ROW + rows.length, column: AUDIT_HEADERS.length } }
  return wb.xlsx.writeBuffer()
}
```

- [ ] **Step 4: The route**

Create `app/api/export/audit/route.ts`:

```ts
import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { EXPORT_ROW_LIMIT } from '@/lib/export/report'
import { listAuditRows, countAuditRows, listAuditUsers, type AuditRow } from '@/lib/audit-query'
import { parseAuditParams, describeAuditFilters, auditFilename } from '@/lib/audit-view'
import { buildAuditWorkbook } from '@/lib/export/audit-workbook'

/**
 * EXPORT THE AUDIT TRAIL — the filtered range the admin is looking at.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` runs on Vercel and not locally; this route leans on neither.
 * It authenticates on its first line, and — because the page it mirrors is
 * admin-only — refuses a FINANCE_USER as well. 401, not a redirect: a
 * download that redirects arrives as a login page saved under an .xlsx name.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const refuse = () => new Response('UNAUTHORISED', {
  status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
})

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user || user.role !== 'FINANCE_ADMIN') return refuse()

  const params = new URL(request.url).searchParams
  const read = (k: string) => params.get(k) ?? undefined
  const { filters } = parseAuditParams({
    system: read('system'), action: read('action'), user: read('user'), check: read('check'), from: read('from'), to: read('to'),
  })

  // Newest first, page by page through the same keyset the screen uses, up to
  // the cap. The cap is stated in the title block, as every export states it.
  const rows: AuditRow[] = []
  let cursor = null as { createdAt: Date; id: string } | null
  while (rows.length < EXPORT_ROW_LIMIT) {
    const page = await listAuditRows(prisma, filters, cursor)
    rows.push(...page.rows)
    if (!page.hasMore) break
    const last = page.rows[page.rows.length - 1]
    cursor = { createdAt: last.createdAt, id: last.id }
  }
  const [total, users] = await Promise.all([countAuditRows(prisma, filters), listAuditUsers(prisma)])
  const now = new Date()

  const workbook = await buildAuditWorkbook({
    rows: rows.slice(0, EXPORT_ROW_LIMIT),
    meta: {
      generatedAt: now, generatedBy: user.name, totalRows: total,
      filterDescription: describeAuditFilters(filters, { user: users.find((u) => u.id === filters.userId)?.name }),
    },
  })
  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${auditFilename(now)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
```

- [ ] **Step 5: Run the two test files and the type-checker**

```bash
npx.cmd vitest run tests/export/audit-workbook.test.ts tests/export/audit-route.test.ts
```

Expected: PASS — 3 and 3.

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/export/audit-workbook.ts app/api/export/audit/route.ts tests/export/audit-workbook.test.ts tests/export/audit-route.test.ts
git commit -m "feat: the audit trail as a workbook, and the admin-only route that serves it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The page, the table, the tab, and CLAUDE.md

**Files:**
- Create: `components/AuditTable.tsx`, `app/admin/audit/page.tsx`
- Modify: `app/admin/layout.tsx`, `CLAUDE.md`

**Interfaces:**
- Consumes: Tasks 1–3; `requireAdmin`; `EmptyState`.
- Produces: `AuditTable({ rows }: { rows: readonly AuditRow[] })`.

No new unit test — no page in this repository has one. Verification is `tsc` and `next build` listing `/admin/audit` and `/api/export/audit`.

- [ ] **Step 1: The table**

Create `components/AuditTable.tsx`:

```tsx
import Link from 'next/link'
import { actionWords } from '@/lib/audit-view'
import type { AuditRow } from '@/lib/audit-query'

const fmt = (d: Date) =>
  d.toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Manila',
  })

/** The JSON, as key/value lines. Nothing is parsed for meaning — least of all an amount. */
function Details({ details }: { details: unknown }) {
  if (details === null || details === undefined) return <span className="text-slate-300">—</span>
  const entries = typeof details === 'object' && !Array.isArray(details)
    ? Object.entries(details as Record<string, unknown>)
    : [['value', details] as const]
  return (
    // A native disclosure: server-rendered, no script, and it keeps a 300-row
    // page readable while leaving every field one click away.
    <details className="text-xs">
      <summary className="cursor-pointer text-slate-500">{entries.length} field{entries.length === 1 ? '' : 's'}</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {entries.map(([k, v]) => (
          <div key={String(k)} className="contents">
            <dt className="font-mono text-slate-400">{String(k)}</dt>
            <dd className="break-all font-mono text-slate-700">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

/**
 * The trail, newest first. Filled navy dot for a person, hollow for SYSTEM —
 * the same signal the per-cheque trail uses, and never the only one: the WHO
 * column says SYSTEM in words. The year is in every timestamp deliberately.
 */
export function AuditTable({ rows }: { rows: readonly AuditRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-hairline">
      <table className="w-full text-sm">
        <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
          <tr>
            <th className="px-4 py-3">WHEN</th>
            <th className="px-4 py-3">WHO</th>
            <th className="px-4 py-3">ACTION</th>
            <th className="px-4 py-3">CHECK</th>
            <th className="px-4 py-3">REMARKS</th>
            <th className="px-4 py-3">DETAILS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const system = r.actorType === 'SYSTEM'
            return (
              <tr key={r.id} className="border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground">
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600">{fmt(r.createdAt)}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span aria-hidden="true" className={`mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle ${system ? 'bg-white ring-2 ring-hairline' : 'bg-navy'}`} />
                  {system ? <span className="tracking-wide text-slate-400">SYSTEM</span> : <span className="font-medium">{r.userName ?? 'UNKNOWN USER'}</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-semibold text-navy">{actionWords(r.action)}</td>
                <td className="whitespace-nowrap px-4 py-3">
                  {r.checkId && r.checkNumber
                    ? <Link href={`/checks/${r.checkId}`} className="underline underline-offset-2">{r.checkNumber}</Link>
                    : r.checkNumber
                      ? <span className="text-slate-500" title="This cheque has since been removed; the number is what the row recorded.">{r.checkNumber}</span>
                      : <span className="text-slate-400">(cheque removed)</span>}
                </td>
                <td className="min-w-[16rem] px-4 py-3 text-slate-700">{r.remarks ?? <span className="text-slate-300">—</span>}</td>
                <td className="min-w-[14rem] px-4 py-3"><Details details={r.details} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: The page**

Create `app/admin/audit/page.tsx`:

```tsx
import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { EmptyState } from '@/components/EmptyState'
import { AuditTable } from '@/components/AuditTable'
import { listAuditRows, countAuditRows, listAuditActions, listAuditUsers } from '@/lib/audit-query'
import {
  AUDIT_PATH, AUDIT_EXPORT_PATH, AUDIT_PAGE_SIZE,
  parseAuditParams, encodeCursor, auditHref, describeAuditFilters, actionWords, type AuditParams,
} from '@/lib/audit-view'

/**
 * THE AUDIT TRAIL, READ. Until 2026-09-11 it was write-only: 65,269 rows and
 * no screen that could show one except a cheque's own trail.
 *
 * It opens on what PEOPLE did — 4 rows of 65,269 on the day it was built, and
 * every signature, release, reversal and user change from here on. The system's
 * rows are one toggle away, because the day's most important record (the 1,958
 * company restorations of 10 September) is a SYSTEM row.
 *
 * Nothing here writes. `writeAudit` is the only writer and the trigger keeps
 * every row as written.
 */
const FIELD = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

export default async function AuditPage({ searchParams }: { searchParams: Promise<AuditParams> }) {
  await requireAdmin()
  const params = await searchParams
  const { filters, cursor, raw } = parseAuditParams(params)

  const [page, total, actions, users] = await Promise.all([
    listAuditRows(prisma, filters, cursor),
    countAuditRows(prisma, filters),
    listAuditActions(prisma),
    listAuditUsers(prisma),
  ])

  // A hand-edited URL naming an action or user that does not exist narrows to
  // nothing; the selects simply show it unselected and the count says 0.
  const current: AuditParams = {
    system: filters.system ? '1' : undefined, action: filters.action, user: filters.userId,
    check: filters.checkNumber, from: raw.from, to: raw.to,
  }
  const anyFilter = Boolean(filters.system || filters.action || filters.userId || filters.checkNumber || filters.from || filters.to)
  const last = page.rows[page.rows.length - 1]

  return (
    <div className="space-y-6">
      <form className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline" method="get">
        <label className="flex h-10 items-center gap-2 rounded-lg border border-hairline bg-white px-3 text-sm">
          <input type="checkbox" name="system" value="1" defaultChecked={filters.system} />
          SYSTEM ROWS
        </label>
        <select name="action" defaultValue={filters.action ?? ''} className={FIELD}>
          <option value="">ANY ACTION</option>
          {actions.map((a) => <option key={a} value={a}>{actionWords(a)}</option>)}
        </select>
        <select name="user" defaultValue={filters.userId ?? ''} className={FIELD}>
          <option value="">ANY USER</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input name="check" defaultValue={filters.checkNumber ?? ''} placeholder="CHECK NUMBER (exact)" className={`${FIELD} w-48`} />
        <input name="from" type="date" defaultValue={raw.from ?? ''} className={FIELD} />
        <input name="to" type="date" defaultValue={raw.to ?? ''} className={FIELD} />
        <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">APPLY</button>
        {anyFilter && <Link href={AUDIT_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            {total.toLocaleString('en-PH')} ROW{total === 1 ? '' : 'S'} · {describeAuditFilters(filters, { user: users.find((u) => u.id === filters.userId)?.name })}
            {cursor ? ' · CONTINUED' : ''}
          </p>
          {/* The CHECK filter goes through the join, and 17,087 rows belong to
              cheques that were later removed. They cannot match a number, and
              a count that quietly excluded them would read as the whole. */}
          {filters.checkNumber && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              Rows whose cheque has since been removed cannot match a cheque number; clear this filter and
              show SYSTEM ROWS to see them.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-500">The file holds this filtered range, newest first.</span>
          <a href={auditHref(current, AUDIT_EXPORT_PATH)} className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">
            EXPORT EXCEL
          </a>
        </div>
      </div>

      {page.rows.length === 0 ? (
        <EmptyState title={anyFilter ? 'NO ROWS MATCH' : 'NOBODY HAS DONE ANYTHING YET'}>
          {anyFilter
            ? 'Nothing in the trail carries these filters together.'
            : "No signature, release, reversal or user change has been recorded by a person. Tick SYSTEM ROWS to see what the imports and the sync have done."}
        </EmptyState>
      ) : (
        <AuditTable rows={page.rows} />
      )}

      <div className="flex items-center justify-between text-sm">
        {cursor
          ? <Link href={auditHref({ ...current })} className="underline underline-offset-2">← NEWEST</Link>
          : <span />}
        {page.hasMore && last && (
          <Link href={auditHref({ ...current, before: encodeCursor({ createdAt: last.createdAt, id: last.id }) })} className="underline underline-offset-2">
            NEXT {AUDIT_PAGE_SIZE} →
          </Link>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: The tab**

In `app/admin/layout.tsx`, add to the `tabs` array after `['/admin/staged', 'STAGED QUEUE'],`:

```ts
    ['/admin/audit', 'AUDIT'],
```

- [ ] **Step 4: CLAUDE.md**

In "What is missing", replace item 3 — the paragraph beginning `3. **The audit trail is write-only.**` — with:

```markdown
3. **The audit trail can be read** (built 2026-09-11): `/admin/audit`, FINANCE_ADMIN only. It opens
   on people's actions — measured that day, 4 of 65,269 rows; the rest are imports, backfills and
   the sync — with SYSTEM ROWS one toggle away, because the 10 September restorations are SYSTEM
   rows and are the record an auditor asks for. Filters: action (from `SELECT DISTINCT`, never a
   list), user, cheque number (through the join, so the 17,087 detached rows cannot match it and
   the page says so), Manila dates. Keyset pagination on `(createdAt, id)`; four indexes in
   `20260911000200_audit_log_indexes`, which must reach production before the deploy. Excel extract
   of the filtered range at `/api/export/audit`. `writeAudit` remains the only writer.
```

- [ ] **Step 5: Type-check and build**

```bash
npx.cmd tsc --noEmit
```

Expected: no output.

```bash
npx.cmd next build
```

Expected: build succeeds; `/admin/audit` and `/api/export/audit` are listed as dynamic routes.

- [ ] **Step 6: Commit**

```bash
git add components/AuditTable.tsx app/admin/audit/page.tsx app/admin/layout.tsx CLAUDE.md
git commit -m "feat: /admin/audit - the trail, read: people by default, the system on request

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Not in this plan

- **Editing or annotating rows.** Rule 7.
- **Changing what is audited.**
- **A page test.** The pure module and the reads carry the decisions.
- **Deploying.** `node scripts/migrate.mjs prod --confirm`, then `npx vercel --prod` — the user's actions.
