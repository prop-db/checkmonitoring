# Cheque Books from Acumatica — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Acumatica cheque carries its cheque book (Acumatica's `CashAccount` value, e.g. `BPI-S-4636`), existing cheques get theirs by a targeted repair, and NUMBERING groups by cheque book so it covers the whole population and its STAGED lines appear.

**Architecture:** `mapPayment` passes `CashAccount` through as `checkBookCode`, which `upsertCheck` already resolves. A dry-run-first repair (`lib/admin/check-books.ts`, `scripts/backfill-check-books.ts`) fills the existing rows, one audit row each. `lib/numbering/query.ts` regroups on `checkBookId`; page, route and file follow.

**Tech Stack:** Next.js 15, Prisma 6 / PostgreSQL, Vitest, ExcelJS, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-01-cheque-numbering-and-cancel-guard-design.md`, section D.

## Global Constraints

- **Rule 4: no status is ever written.** The repair writes `checkBookId` only.
- **Acumatica is read-only**: only `fetchAll` / `fetchPage`.
- **A cheque book is set only when its company is the cheque's company**; a mismatch is reported, never written. A code that is no cheque book is never invented into one.
- **The local `.env` `DATABASE_URL` is PRODUCTION.** Write the script; never run it (with or without `--apply`); no dev server.
- **Long write loops use `TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 }`.**
- **Snapshot before the first write** (`snapshots/`, JSON of every candidate).
- **Scripts print counts and codes only — never amounts, never payees.**
- **Amounts are decimal strings**; BigInt via the existing `ZERO`/`ONE` constants, no `1n` literals.
- **One agent at a time against the shared test database**; the controller clears it before each database-backed task.
- Tests: `node node_modules/vitest/vitest.mjs run <files>`; types: `node node_modules/typescript/bin/tsc --noEmit` (clean at the end of every task); build: `node node_modules/next/dist/bin/next build`. No `npx`.
- Commit with explicit paths only; messages end with a `Co-Authored-By:` trailer naming your model and `<noreply@anthropic.com>`.

---

### Task 1: the sync records the cheque book

**Files:** Modify `lib/integrations/acumatica/map.ts` (header comment, line ~184); Test `tests/integrations/acumatica-map.test.ts`, `tests/import/upsert.test.ts`.

**Interfaces:** Produces `NormalisedRow.checkBookCode` = trimmed `CashAccount` (or null) for Acumatica rows.

- [ ] **Step 1: Failing tests**

In `tests/integrations/acumatica-map.test.ts`, in 'fills the fields the feed knows and nulls the ones it does not', replace

```ts
    // The generic inquiry exposes no checkbook and no payment category. A
    // guess from PaymentMethod or Description would invent both.
    expect(r.checkBookCode).toBeNull()
```
with
```ts
    // The inquiry's CashAccount IS the cheque book (spec §D): Acumatica states
    // `BPI-S-4636` where the register wrote the cheque book. Passed through
    // verbatim; upsertCheck resolves it or leaves it null.
    expect(r.checkBookCode).toBe('BPI STK')
```
and add, in the same describe:
```ts
  it('passes CashAccount through as the cheque book, trimmed, and null when absent', () => {
    expect(mapPayment({ ...paymentRow, CashAccount: '  BPI-S-4636 ' }, 'GOLIVE')!.checkBookCode).toBe('BPI-S-4636')
    expect(mapPayment({ ...paymentRow, CashAccount: null }, 'GOLIVE')!.checkBookCode).toBeNull()
  })
```
Find every other assertion on `checkBookCode` for an Acumatica row in that file (`grep -n checkBookCode`) and update it the same way.

In `tests/import/upsert.test.ts`, near the other ACUMATICA-source cases, add (read `seedCompany` and `row()` in that file first; `seedCompany('STK', …)` creates company STK; create the book with the same company):
```ts
  it('an Acumatica row whose CashAccount is a cheque book gets that book; a non-book code gets none (spec §D)', async () => {
    const company = await seedCompany()
    const bank = await testDb.bank.findFirst() ?? await testDb.bank.create({ data: { code: 'BPI', name: 'BPI' } })
    const book = await testDb.checkBook.create({ data: { code: 'BPI-S-4636', bankId: bank.id, companyId: company.id } })
    await upsert(row({ source: 'ACUMATICA', sourceSheet: null, sourceRow: null, acumaticaPaymentId: 'CV-ST-1', checkNumber: '6000400001', checkBookCode: 'BPI-S-4636', cashAccountCode: 'BPI-S-4636' }))
    await upsert(row({ source: 'ACUMATICA', sourceSheet: null, sourceRow: null, acumaticaPaymentId: 'CV-ST-2', checkNumber: '6000400002', checkBookCode: 'PCF-SITIO', cashAccountCode: 'PCF-SITIO' }))
    const a = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000400001' } })
    const b = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000400002' } })
    expect(a.checkBookId).toBe(book.id)
    expect(b.checkBookId).toBeNull()
  })
```
Adapt to `seedCompany`'s actual return value and to how that file creates banks; keep both assertions.

- [ ] **Step 2: Run to verify failure**

Run: `node node_modules/vitest/vitest.mjs run tests/integrations/acumatica-map.test.ts` — expected: FAIL (`checkBookCode` is null).

- [ ] **Step 3: Implement**

In `lib/integrations/acumatica/map.ts` replace `checkBookCode: null,` (and its comment line above, "The generic inquiry publishes neither…") with:
```ts
    // The inquiry's CashAccount IS the cheque book: Acumatica states the same
    // code the register wrote as the cheque book (`BPI-S-4636`). Measured
    // 2026-10-02, spec §D. Passed through; upsertCheck resolves it against
    // CheckBook.code and leaves it null for a code that is no cheque book
    // (`PAYROLL`, `PCF-SITIO`). cashAccountCode keeps the same value.
    checkBookCode: orNull(r.CashAccount),
```
In the file header comment, replace "there is no checkbook and no payment category in it" with "there is no payment category in it (its CashAccount column is the cheque book — spec §D)", and keep the rest of the paragraph's warning about deriving values.

- [ ] **Step 4: Verify and commit**

Controller clears the test database. Run: `node node_modules/vitest/vitest.mjs run tests/integrations/acumatica-map.test.ts tests/import/upsert.test.ts tests/sync/run.test.ts` — expected: PASS. If a `sync/run` assertion expected `checkBookId` null for a feed row, it encoded the old assumption: update it and say so in the report. `tsc --noEmit` clean.

```bash
git add lib/integrations/acumatica/map.ts tests/integrations/acumatica-map.test.ts tests/import/upsert.test.ts
git commit -m "fix(sync): Acumatica's CashAccount is the cheque book - record it"
```
(Add `tests/sync/run.test.ts` to the `git add` only if you changed it.)

---

### Task 2: the repair — `backfill-check-books`

**Files:** Create `lib/admin/check-books.ts`, `scripts/backfill-check-books.ts`; Test `tests/admin/check-books.test.ts`.

**Interfaces:**
```ts
export type CheckBookCandidate = { checkId: string; checkNumber: string; acumaticaPaymentId: string; checkBookId: string; checkBookCode: string }
export type CheckBookPlan = {
  scanned: number
  candidates: CheckBookCandidate[]
  notInFeed: number
  notABook: Record<string, number>
  companyMismatch: { checkNumber: string; checkBookCode: string }[]
}
export async function planCheckBookBackfill(db: PrismaClient, client: AcumaticaClient, tenant: AcumaticaTenant): Promise<CheckBookPlan>
export async function applyCheckBookBackfill(db: PrismaClient, candidates: readonly CheckBookCandidate[]): Promise<number>
export const CHECK_BOOK_BACKFILL_ACTION = 'check_book_backfilled_from_acumatica'
```

- [ ] **Step 1: Failing tests**

```ts
// tests/admin/check-books.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import type { AcumaticaClient, AcumaticaRow } from '@/lib/integrations/acumatica/client'
import { planCheckBookBackfill, applyCheckBookBackfill, CHECK_BOOK_BACKFILL_ACTION } from '@/lib/admin/check-books'

beforeEach(resetDb)

const fake = (rows: AcumaticaRow[]): AcumaticaClient => ({ fetchPage: async () => rows, fetchAll: async () => rows })
const pay = (ref: string, cash: string, type = 'Payment'): AcumaticaRow => ({ Type: type, ReferenceNbr: ref, CashAccount: cash })

/** A cheque the sync created (tenant + payment id), and a cheque book under the same company and bank. */
async function acumaticaCheque(ref: string, checkNumber: string) {
  const c = await makeCheck({ checkNumber, status: 'SIGNED' })
  return testDb.check.update({ where: { id: c.id }, data: { acumaticaTenant: 'GOLIVE', acumaticaPaymentId: ref } })
}
async function bookFor(c: { companyId: string; cashAccountId: string | null }, code: string) {
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  return testDb.checkBook.create({ data: { code, bankId: acc.bankId, companyId: c.companyId } })
}

describe('planCheckBookBackfill', () => {
  it('matches each cheque to the book its payment states, and reports what it cannot set', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    const b = await acumaticaCheque('CV-2', '6000000002')
    const c = await acumaticaCheque('CV-3', '6000000003')
    const d = await acumaticaCheque('CV-4', '6000000004')
    const bookA = await bookFor(a, 'BPI-S-4636')
    const other = await makeCheck({ checkNumber: '1' })
    await bookFor(other, 'MBT-A-4155') // a book under ANOTHER company
    const plan = await planCheckBookBackfill(testDb, fake([
      pay('CV-1', 'BPI-S-4636'), pay('CV-1', 'BPI-S-4636', 'Voided Payment'),
      pay('CV-2', 'PCF-SITIO'),
      pay('CV-3', 'MBT-A-4155'),
    ]), 'GOLIVE')
    expect(plan.scanned).toBe(4)
    expect(plan.candidates).toEqual([{ checkId: a.id, checkNumber: '6000000001', acumaticaPaymentId: 'CV-1', checkBookId: bookA.id, checkBookCode: 'BPI-S-4636' }])
    expect(plan.notABook).toEqual({ 'PCF-SITIO': 1 })
    expect(plan.companyMismatch).toEqual([{ checkNumber: '6000000003', checkBookCode: 'MBT-A-4155' }])
    expect(plan.notInFeed).toBe(1) // CV-4
    void b; void c; void d
  })

  it('ignores cheques that already have a book, have no payment id, or belong to the other tenant', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    const book = await bookFor(a, 'BPI-S-4636')
    await testDb.check.update({ where: { id: a.id }, data: { checkBookId: book.id } })
    await makeCheck({ checkNumber: '6000000002' }) // register-only: no payment id
    const m = await acumaticaCheque('CV-9', '6000000009')
    await testDb.check.update({ where: { id: m.id }, data: { acumaticaTenant: 'MANUFACTURING' } })
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636'), pay('CV-9', 'BPI-S-4636')]), 'GOLIVE')
    expect(plan.scanned).toBe(0)
    expect(plan.candidates).toEqual([])
  })
})

describe('applyCheckBookBackfill', () => {
  it('sets the book and writes one audit row each; status untouched; a second run is a no-op', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    await bookFor(a, 'BPI-S-4636')
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636')]), 'GOLIVE')
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(after.checkBookId).toBe(plan.candidates[0].checkBookId)
    expect(after.status).toBe('SIGNED')
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: a.id, action: CHECK_BOOK_BACKFILL_ACTION } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.details).toMatchObject({ checkBookCode: 'BPI-S-4636', acumaticaPaymentId: 'CV-1' })
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(0)
    expect(await testDb.auditLog.count({ where: { action: CHECK_BOOK_BACKFILL_ACTION } })).toBe(1)
  })

  it('leaves a cheque that gained a book after planning', async () => {
    const a = await acumaticaCheque('CV-1', '6000000001')
    const book = await bookFor(a, 'BPI-S-4636')
    const plan = await planCheckBookBackfill(testDb, fake([pay('CV-1', 'BPI-S-4636')]), 'GOLIVE')
    const other = await testDb.checkBook.create({ data: { code: 'BPI-S-0000', bankId: book.bankId, companyId: book.companyId } })
    await testDb.check.update({ where: { id: a.id }, data: { checkBookId: other.id } })
    expect(await applyCheckBookBackfill(testDb, plan.candidates)).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).checkBookId).toBe(other.id)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Controller clears the test database. Run: `node node_modules/vitest/vitest.mjs run tests/admin/check-books.test.ts` — expected: FAIL (module not found).

- [ ] **Step 3: Implement the library**

```ts
// lib/admin/check-books.ts
import type { PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { PAYMENTS_FEED, type AcumaticaClient } from '@/lib/integrations/acumatica/client'
import type { AcumaticaTenant } from '@/lib/integrations/acumatica/companies'
import { paymentsInScopeFilter } from '@/lib/sync/run'

/**
 * The cheque book of every Acumatica cheque that has none (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §D2). Acumatica's
 * `CashAccount` column states the cheque-book code (`BPI-S-4636`), but until
 * 2026-10-02 the sync dropped it, so 3,844 cheques carry no book. This reads
 * the payments feed (read-only), maps each cheque's payment to a CheckBook by
 * code, and sets `checkBookId` — only when the book's company is the cheque's
 * company. Nothing else is written; status never (rule 4).
 */
export const CHECK_BOOK_BACKFILL_ACTION = 'check_book_backfilled_from_acumatica'
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export type CheckBookCandidate = { checkId: string; checkNumber: string; acumaticaPaymentId: string; checkBookId: string; checkBookCode: string }
export type CheckBookPlan = {
  scanned: number
  candidates: CheckBookCandidate[]
  notInFeed: number
  notABook: Record<string, number>
  companyMismatch: { checkNumber: string; checkBookCode: string }[]
}

export async function planCheckBookBackfill(db: PrismaClient, client: AcumaticaClient, tenant: AcumaticaTenant): Promise<CheckBookPlan> {
  const rows = await client.fetchAll(PAYMENTS_FEED, {
    select: ['Type', 'ReferenceNbr', 'CashAccount'],
    filter: paymentsInScopeFilter(),
    orderby: 'LastModifiedOn asc',
    pageSize: 2000,
  })
  // A voided cheque is two rows under one reference; the original Payment row wins.
  const codeByRef = new Map<string, string>()
  for (const r of rows) {
    const ref = text(r.ReferenceNbr)
    const code = text(r.CashAccount)
    if (!ref || !code) continue
    if (!codeByRef.has(ref) || text(r.Type) === 'Payment') codeByRef.set(ref, code)
  }

  const books = await db.checkBook.findMany({ select: { id: true, code: true, companyId: true } })
  const bookByCode = new Map(books.map((b) => [b.code, b]))
  const cheques = await db.check.findMany({
    where: { acumaticaTenant: tenant, acumaticaPaymentId: { not: null }, checkBookId: null },
    select: { id: true, checkNumber: true, acumaticaPaymentId: true, companyId: true },
    orderBy: [{ checkNumber: 'asc' }, { id: 'asc' }],
  })

  const plan: CheckBookPlan = { scanned: cheques.length, candidates: [], notInFeed: 0, notABook: {}, companyMismatch: [] }
  for (const c of cheques) {
    const code = codeByRef.get(c.acumaticaPaymentId!)
    if (!code) { plan.notInFeed++; continue }
    const book = bookByCode.get(code)
    if (!book) { plan.notABook[code] = (plan.notABook[code] ?? 0) + 1; continue }
    if (book.companyId !== c.companyId) { plan.companyMismatch.push({ checkNumber: c.checkNumber, checkBookCode: code }); continue }
    plan.candidates.push({ checkId: c.id, checkNumber: c.checkNumber, acumaticaPaymentId: c.acumaticaPaymentId!, checkBookId: book.id, checkBookCode: code })
  }
  return plan
}

/** One transaction per cheque, conditional on it still having no book. Returns how many were set. */
export async function applyCheckBookBackfill(db: PrismaClient, candidates: readonly CheckBookCandidate[]): Promise<number> {
  let set = 0
  for (const c of candidates) {
    const done = await db.$transaction(async (tx) => {
      const r = await tx.check.updateMany({ where: { id: c.checkId, checkBookId: null }, data: { checkBookId: c.checkBookId } })
      if (!r.count) return false
      await writeAudit(tx, {
        checkId: c.checkId, actorType: 'SYSTEM', action: CHECK_BOOK_BACKFILL_ACTION,
        details: { checkBookCode: c.checkBookCode, acumaticaPaymentId: c.acumaticaPaymentId },
        remarks: `Cheque book ${c.checkBookCode} recorded from Acumatica's CashAccount for payment ${c.acumaticaPaymentId}. Status unchanged.`,
      })
      return true
    }, TX_OPTIONS)
    if (done) set++
  }
  return set
}
```

Run the test — expected: PASS.

- [ ] **Step 4: Write the script (never run it)**

```ts
// scripts/backfill-check-books.ts
/**
 * Record the cheque book of every Acumatica cheque that has none (spec §D2).
 *
 *   npx.cmd tsx scripts/backfill-check-books.ts GOLIVE            # dry run
 *   npx.cmd tsx scripts/backfill-check-books.ts GOLIVE --apply    # snapshot, then set checkBookId, one audit row each
 *   (likewise MANUFACTURING)
 *
 * Reads Acumatica (read-only). Writes checkBookId only, never status. Prints
 * counts and codes only. DATABASE_URL is PRODUCTION.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { createClientForTenant } from '../lib/integrations/acumatica/from-env'
import type { AcumaticaTenant } from '../lib/integrations/acumatica/companies'
import { planCheckBookBackfill, applyCheckBookBackfill } from '../lib/admin/check-books'

const args = process.argv.slice(2)
const tenant = args.find((a) => !a.startsWith('--')) as AcumaticaTenant | undefined
const APPLY = args.includes('--apply')

async function main(): Promise<void> {
  if (tenant !== 'GOLIVE' && tenant !== 'MANUFACTURING') throw new Error('Name a tenant: GOLIVE or MANUFACTURING')
  const db = new PrismaClient()
  try {
    const plan = await planCheckBookBackfill(db, createClientForTenant(tenant), tenant)
    console.log(`\nTENANT ${tenant}`)
    console.log(`cheques with a payment id and no cheque book: ${plan.scanned}`)
    console.log(`  would set:              ${plan.candidates.length}`)
    const byBook: Record<string, number> = {}
    for (const c of plan.candidates) byBook[c.checkBookCode] = (byBook[c.checkBookCode] ?? 0) + 1
    for (const [code, n] of Object.entries(byBook).sort((a, b) => b[1] - a[1])) console.log(`    ${code.padEnd(14)} ${n}`)
    console.log(`  not a cheque book:      ${Object.values(plan.notABook).reduce((a, b) => a + b, 0)}`, plan.notABook)
    console.log(`  company mismatch (left): ${plan.companyMismatch.length}`)
    for (const m of plan.companyMismatch.slice(0, 20)) console.log(`    ${m.checkNumber} -> ${m.checkBookCode}`)
    console.log(`  payment not in the feed: ${plan.notInFeed}`)
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (plan.candidates.length === 0) { console.log('\nNothing to set.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `check-books-${tenant}-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), tenant, candidates: plan.candidates }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)
    const set = await applyCheckBookBackfill(db, plan.candidates)
    console.log(`\nDONE  set ${set} of ${plan.candidates.length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
```

- [ ] **Step 5: Verify and commit**

Run the test file again (PASS) and `tsc --noEmit` (clean).
```bash
git add lib/admin/check-books.ts scripts/backfill-check-books.ts tests/admin/check-books.test.ts
git commit -m "feat(admin): backfill-check-books - record each Acumatica cheque's cheque book, company-checked"
```

---

### Task 3: NUMBERING groups by cheque book

**Files:** Modify `lib/numbering/query.ts`, `app/numbering/page.tsx`, `app/api/export/numbering/route.ts`, `components/NumberingTables.tsx`, `lib/numbering-view.ts`, `lib/export/numbering-workbook.ts`; Test `tests/numbering/query.test.ts`, `tests/export/numbering-route.test.ts`, `tests/export/numbering-workbook.test.ts` (text assertions only).

**Interfaces:**
```ts
export type NumberingFilters = { companyId?: string; checkBookId?: string }      // was cashAccountId
export type NumberingAccount = { accountId: string; account: string; bank: string; company: string; series: AccountSeries } // unchanged shape; now a cheque book
export async function listNumberingAccounts(db: Db, f: NumberingFilters): Promise<NumberingAccount[]>
export async function countChequesWithoutCheckBook(db: Db, f: { companyId?: string }): Promise<number>   // replaces countChequesWithoutAccount
export async function listCheckBookOptions(db: Db): Promise<{ id: string; code: string; bankCode: string }[]>
```

- [ ] **Step 1: Rewrite the query**

In `lib/numbering/query.ts`:
- `NumberingFilters` becomes `{ companyId?: string; checkBookId?: string }`.
- The cheque `findMany` becomes `where: { isCheque: true, checkBookId: f.checkBookId ?? { not: null }, ...(f.companyId ? { checkBook: { companyId: f.companyId } } : {}) }` and selects `checkBook: { select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } } }` instead of `cashAccount`; grouping uses `r.checkBook`.
- The staged join resolves `cashAccountCode` against `db.checkBook.findMany({ where: { code: { in: codes }, ...(f.checkBookId ? { id: f.checkBookId } : {}), ...(f.companyId ? { companyId: f.companyId } : {}) }, select: { id, code, bank: { select: { code } }, company: { select: { code } } } })`.
- Rename `countChequesWithoutAccount` → `countChequesWithoutCheckBook`: `db.check.count({ where: { isCheque: true, checkBookId: null, ...(f.companyId ? { companyId: f.companyId } : {}) } })`.
- Add:
```ts
/** The cheque books, by code — the series the NUMBERING page and export accept as `account`. */
export async function listCheckBookOptions(db: Db): Promise<{ id: string; code: string; bankCode: string }[]> {
  const books = await db.checkBook.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, bank: { select: { code: true } } } })
  return books.map((b) => ({ id: b.id, code: b.code, bankCode: b.bank.code }))
}
```
- Update the doc comments: the series key is the cheque book (`CheckBook`), Acumatica's `CashAccount` value (spec §D).

- [ ] **Step 2: Page and route**

In both `app/numbering/page.tsx` and `app/api/export/numbering/route.ts`:
- Load `const books = await listCheckBookOptions(prisma)` (alongside `getFilterOptions`, which stays for companies) and resolve `account` with `books.find((b) => b.id === accountParam)` instead of `options.cashAccounts.find`.
- Pass `checkBookId: account?.id` instead of `cashAccountId`; call `countChequesWithoutCheckBook`.
- Page copy: `NO SUCH CASH ACCOUNT` → `NO SUCH CHEQUE BOOK` ("That cheque book is not on record. Choose one from the list."); `N CASH ACCOUNT(S)` → `N CHEQUE BOOK(S)`; `WITH NO CASH ACCOUNT` → `WITH NO CHEQUE BOOK`; `NO CHEQUES IN ANY CASH ACCOUNT` → `NO CHEQUES IN ANY CHEQUE BOOK` (and its body text: "No cheque book of this company holds a cheque." / "No cheque carries a cheque book yet."); `NO CHEQUES ON THIS ACCOUNT` → `NO CHEQUES IN THIS CHEQUE BOOK` ("No cheque on record carries this cheque book."); the page doc comment "per cash account" → "per cheque book".
- Route: the 404 body `UNKNOWN ACCOUNT` → `UNKNOWN CHEQUE BOOK`.

- [ ] **Step 3: Table, file and note copy**

- `components/NumberingTables.tsx`: summary header `ACCOUNT` → `CHEQUE BOOK`; the doc comment "One row per cash account" → "One row per cheque book".
- `lib/export/numbering-workbook.ts`: SUMMARY header `'ACCOUNT'` → `'CHEQUE BOOK'`; A4 "with no cash account." → "with no cheque book."
- `lib/numbering-view.ts` `NUMBERING_SCOPE_NOTE`: add, after its first sentence, "Each series is one cheque book — the bank account Acumatica names in its CashAccount column (e.g. BPI-S-4636)." Leave the rest.
- Update any test asserting the old strings (`grep -rn "cash account\|CASH ACCOUNT\|UNKNOWN ACCOUNT\|'ACCOUNT'" tests/export/numbering-*.test.ts tests/numbering*`).

- [ ] **Step 4: Rework the query and route tests**

`makeCheck` (tests/helpers/factory.ts) creates a cash account but no cheque book. In `tests/numbering/query.test.ts`, replace `onAccountOf` with helpers that put cheques in a cheque book:
```ts
/** A cheque book under the cheque's own company and bank, and the cheque in it. */
async function bookFor(c: { id: string; companyId: string; cashAccountId: string | null }, code = `BPI-S-${Math.random().toString(36).slice(2, 6)}`) {
  const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: c.cashAccountId! } })
  const book = await testDb.checkBook.create({ data: { code, bankId: acc.bankId, companyId: c.companyId } })
  await testDb.check.update({ where: { id: c.id }, data: { checkBookId: book.id } })
  return book
}
async function inBook(book: { id: string }, overrides: Parameters<typeof makeCheck>[0]) {
  const c = await makeCheck(overrides)
  return testDb.check.update({ where: { id: c.id }, data: { checkBookId: book.id } })
}
```
Then convert every existing case to the same meaning under cheque books: where a test grouped cheques with `onAccountOf(first, …)`, create `const book = await bookFor(first)` and use `inBook(book, …)`; where it renamed cash-account codes to order them, create the books with those codes (`bookFor(a, 'ZZZ')`, `bookFor(b, 'AAA')`); `accountId` assertions compare with `book.id`; `cashAccountId:` filters become `checkBookId:`; staged rows' `cashAccountCode` is the book's code; the staged-only account case creates a `CheckBook` (`EMPTY-BOOK`) instead of a `CashAccount`; `countChequesWithoutAccount` cases become `countChequesWithoutCheckBook` (a cheque with no book counts; one with a book does not). Add one case: a cheque with a cash account but NO cheque book is not in any series and is counted by `countChequesWithoutCheckBook`. Keep every assertion's intent.

In `tests/export/numbering-route.test.ts`, give the cheques cheque books the same way and pass `account=<book id>`; the company-plus-account case uses `b`'s book; expect `UNKNOWN CHEQUE BOOK`-style 404 unchanged in status.

- [ ] **Step 5: Verify and commit**

Controller clears the test database. Run: `node node_modules/vitest/vitest.mjs run tests/numbering/query.test.ts tests/export/numbering-route.test.ts tests/export/numbering-workbook.test.ts tests/numbering/series.test.ts tests/numbering-view.test.ts` — PASS. `tsc --noEmit` clean. `next build` compiles.
```bash
git add lib/numbering/query.ts app/numbering/page.tsx app/api/export/numbering/route.ts components/NumberingTables.tsx lib/numbering-view.ts lib/export/numbering-workbook.ts tests/numbering/query.test.ts tests/export/numbering-route.test.ts tests/export/numbering-workbook.test.ts
git commit -m "feat(numbering): group by cheque book - the bank account Acumatica names"
```

---

### Task 4: record it

**Files:** Modify `CLAUDE.md`.

- [ ] Add to the commands block, after the `close-unmatchable-cancelled` line:
```
npx tsx scripts/backfill-check-books.ts GOLIVE [--apply]       # Acumatica cheques with no cheque book: record it from CashAccount (MANUFACTURING likewise)
```
- [ ] In "Data facts", add a bullet after the `PaymentMethod decides isCheque` bullet:
```
- **Acumatica's `CashAccount` column is the CHEQUE BOOK, not this system's cash account.** It states
  `BPI-S-4636`, `MBT-A-4155`, `BDO-A-3838` — the eight `CheckBook` codes the register used — while
  `CashAccount` here holds six register labels (`BPI STK`, `MBTC A1+`, …). Until 2026-10-02 `map.ts`
  dropped it (`checkBookCode: null`) and looked it up as a cash account, which never matches: 3,844
  Acumatica cheques had no cheque book and 3,501 cheques neither, 1,091 of them dated since the register
  stopped. The sync now records it; `scripts/backfill-check-books.ts` fills the rest (company-checked:
  a book under another company is reported, never set). NUMBERING groups by cheque book. **The dashboard
  BANK filter/column and RECON still key on the cash-account label and so see only ~1,342 cheques** —
  an open follow-up. `PCF-SITIO`, `PAYROLL`, `PCF-SILANG`, `RSB-S-0869`, `MBTC-S-988` are no cheque book.
```
- [ ] In the NUMBERING paragraph under "Things that will catch you out", change "checks cheque consecutives per cash account" to "per cheque book" and "The cash account is the series key because the sync publishes no cheque book." to "The cheque book is the series key — Acumatica's CashAccount value (spec §D)."
- [ ] `git add CLAUDE.md` and commit `docs: Acumatica's CashAccount is the cheque book; NUMBERING by book; backfill-check-books`.
