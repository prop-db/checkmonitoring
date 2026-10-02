# Supplier Receipt Amount + File → Portal RECEIPT Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finance records the supplier's receipt (OR/CR) with its **amount** and a scanned **file** (PDF/JPG/PNG, ≤ 3 MB) in Check Monitoring, and every receipt save queues a portal outbox event `RECEIPT` that delivers type, number, date, amount, file and releaser to the Supplier Portal's Payments page.

**Architecture:** `Check` gains `receiptAmount Decimal(18,2)`; the file lives in a new 1:1 table `CheckReceiptFile` (BYTEA) so ordinary cheque reads never load bytes. `recordReceipt` and `markReleased` accept the amount and file; a new `attachReceiptFile` adds an amount/file to a receipt recorded without one (add-only, like the reference). Each of them queues `RECEIPT` for a routed cheque. The outbox splits each cheque into two lanes — **status** (MARK_AVAILABLE, REVERT, RELEASED, RELEASE_REVERSED, CANCELLED) and **receipt** — supersede happens within a lane only, and a receipt goes out only after its cheque's open status event has been delivered. The portal side (receiving `RECEIPT`) is already built (Supplier Portal plan `2026-10-02-payments-orcr-portal`).

**Tech Stack:** Next.js 15 server actions, Prisma 6, Postgres (real test DB), vitest 4, TypeScript strict.

Portal contract (already live on the portal side — do not change): `POST /api/integrations/check-monitoring/events`, kind `RECEIPT`, body `{ eventId, kind, apvs, poNumbers, checkNo, bank, receiptType: 'OR'|'CR', orNumber, orDate?: 'YYYY-MM-DD', amount?: string, file?: { name, contentType, base64 }, releasedBy? }`; the portal refuses a file over 3 MB or of another type, requires `checkNo`, and treats an identical re-send as `already`.

## Global Constraints

- **Test DB is shared.** "One agent at a time against the test database" (CLAUDE.md 355-358). Before any `vitest` or `scripts/migrate.mjs test` run, the controller confirms the other session's window is over. Never run two vitest processes at once.
- Windows: `npx.cmd` / `npm.cmd`. One file: `npx.cmd vitest run tests/<file>.test.ts`. `npx.cmd tsc --noEmit` is required before claiming done.
- Enum `ADD VALUE` alone in its own migration folder, applied before the migration that uses it. Hand-write SQL matching `schema.prisma`; then `npx.cmd prisma generate`. Apply to the test DB with `node scripts/migrate.mjs test`.
- Amounts are decimal **strings** end to end, never a JS number (CLAUDE.md rule 8). Column `Decimal(18,2)`. Sent to the portal as a string with two decimals.
- Audit rows never contain the file bytes or base64 — name, type, size, sha256 only (rule 7).
- An INTERNAL cheque never produces a portal event (rule 2): queue `RECEIPT` only when `portalRoute(check.eligibility) !== null`.
- A recorded receipt is never overwritten (rule 11, `RECEIPT_ALREADY_RECORDED`). Amount and file are **add-only**: attaching to a receipt that already has an amount or file is refused (`RECEIPT_AMOUNT_ALREADY_RECORDED` / `RECEIPT_FILE_ALREADY_ATTACHED`).
- File: ≤ 3 MB (`MAX_RECEIPT_FILE_BYTES = 3 * 1024 * 1024`), types `application/pdf`, `image/jpeg`, `image/png`, and the leading bytes must match the type (`%PDF`, `FF D8 FF`, `89 50 4E 47`). Reason for 3 MB: the portal receives it base64 inside one request and Vercel caps a request at ~4.5 MB.
- Next server-action body limit raised to `'4mb'`.
- Dated comments: `user request 2026-10-01` (feature), `spec 2026-10-02` (3 MB / lanes).

---

### Task 1: Schema, migrations, test plumbing

**Files:**
- Modify: `prisma/schema.prisma` (`PortalEventKind`, `Check`, new `CheckReceiptFile`, `User` back-relation)
- Create: `prisma/migrations/20261002000100_portal_event_receipt/migration.sql`
- Create: `prisma/migrations/20261002000200_check_receipt_amount_file/migration.sql`
- Modify: `lib/import/upsert.ts` (`IMMUTABLE_ON_UPDATE` gains `'receiptAmount'`)
- Modify: `tests/helpers/db.ts` (`resetDb` deletes `checkReceiptFile` before `check`)
- Test: `tests/import/upsert.test.ts` (existing "accounts for every column" must stay green), `tests/actions/receipt.test.ts` (smoke)

**Interfaces — Produces:** `PortalEventKind.RECEIPT`; `Check.receiptAmount: Prisma.Decimal | null`; model `CheckReceiptFile { checkId (PK, FK Restrict), fileName, contentType, sizeBytes, sha256, bytes, uploadedById, uploadedAt }`; relation `Check.receiptFile CheckReceiptFile?`.

- [ ] **Step 1: Schema** — in `prisma/schema.prisma`:

`PortalEventKind`, after `CANCELLED`:

```prisma
  // The sixth kind (user request 2026-10-01): the supplier's receipt with its
  // amount and file, for the portal's Payments page. Its own outbox lane
  // (spec 2026-10-02): it never supersedes a status event, nor they it.
  RECEIPT
```

`Check`, after `receiptType`:

```prisma
  // What the supplier's receipt says was received (user request 2026-10-01).
  // Add-only like the reference itself; null until Finance records it.
  receiptAmount      Decimal?         @db.Decimal(18, 2)
  receiptFile        CheckReceiptFile?
```

New model (after `Check`):

```prisma
/// The scanned receipt (user request 2026-10-01). Its own table so the bytes
/// are read only when a RECEIPT event is delivered, never by an ordinary
/// cheque query. One per cheque; add-only. Max 3 MB (spec 2026-10-02).
model CheckReceiptFile {
  checkId      String   @id
  fileName     String
  contentType  String
  sizeBytes    Int
  sha256       String
  bytes        Bytes
  uploadedById String
  uploadedAt   DateTime @default(now())

  check      Check @relation(fields: [checkId], references: [id], onDelete: Restrict)
  uploadedBy User  @relation("receiptFileUploadedBy", fields: [uploadedById], references: [id])
}
```

and in `model User` add `receiptFilesUploaded CheckReceiptFile[] @relation("receiptFileUploadedBy")`.

- [ ] **Step 2: Migrations**

```sql
-- prisma/migrations/20261002000100_portal_event_receipt/migration.sql
-- The sixth thing the outbox tells the portal: the supplier's receipt
-- (user request 2026-10-01). Alone on purpose: Postgres refuses to USE a new
-- enum value inside the transaction that added it.
ALTER TYPE "PortalEventKind" ADD VALUE 'RECEIPT';
```

```sql
-- prisma/migrations/20261002000200_check_receipt_amount_file/migration.sql
ALTER TABLE "Check" ADD COLUMN "receiptAmount" DECIMAL(18,2);

CREATE TABLE "CheckReceiptFile" (
    "checkId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CheckReceiptFile_pkey" PRIMARY KEY ("checkId")
);
ALTER TABLE "CheckReceiptFile" ADD CONSTRAINT "CheckReceiptFile_checkId_fkey"
    FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckReceiptFile" ADD CONSTRAINT "CheckReceiptFile_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

Compare with the SQL Prisma would generate: run `npx.cmd prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script --shadow-database-url "<test url>"` only if the repo has a documented way to do so without printing secrets; otherwise check the constraint names against an existing migration's FK (`grep -r "FOREIGN KEY" prisma/migrations | head`). Expected: no diff.

- [ ] **Step 3: Plumbing** — `lib/import/upsert.ts`: add `'receiptAmount'` next to `'orNumber', 'orDate', 'receiptType'` in `IMMUTABLE_ON_UPDATE` with a comment `// Finance-owned (user request 2026-10-01)`. `tests/helpers/db.ts` `resetDb`: add `await tx.checkReceiptFile.deleteMany()` immediately before `tx.check.deleteMany()`. `deleteIncompleteCheck` (lib/domain/actions.ts ~894): if it deletes a check that may have a receipt file, confirm the FK Restrict makes it refuse (a cheque with a receipt is released, so it is never "incomplete"; no change expected — note it in the report).

- [ ] **Step 4: Generate + migrate test DB** (controller confirms the test DB is free first)

Run: `npx.cmd prisma generate` then `node scripts/migrate.mjs test`
Expected: both migrations applied.

- [ ] **Step 5: Run tests**

Run: `npx.cmd vitest run tests/import/upsert.test.ts tests/actions/receipt.test.ts` and `npx.cmd tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add prisma lib/import/upsert.ts tests/helpers/db.ts
git commit -m "feat(schema): receipt amount + file table, RECEIPT outbox kind"
```

---

### Task 2: Domain — validate, record, attach, queue RECEIPT

**Files:**
- Modify: `lib/domain/receipt.ts` (pure: amount + file validation)
- Modify: `lib/domain/actions.ts` (`markReleased`, `recordReceipt`, new `attachReceiptFile`, `queueReceipt`, `writeReceiptAudit`)
- Test: `tests/domain/receipt.test.ts` (extend), `tests/actions/receipt-file.test.ts` (new)
- Check: `tests/actions/actions.test.ts`, `tests/actions/reverse-release.test.ts`, `tests/actions/bulk-actions.test.ts` for exact portal-event counts after a release that carries a receipt — update counts there to include the RECEIPT event and say so in the report.

**Interfaces:**
- Produces (`lib/domain/receipt.ts`):
  - `MAX_RECEIPT_FILE_BYTES = 3 * 1024 * 1024`, `RECEIPT_FILE_TYPES = ['application/pdf','image/jpeg','image/png'] as const`
  - `type ReceiptFileInput = { fileName: string; contentType: string; bytes: Uint8Array }`
  - `checkReceiptAmount(raw: string | null | undefined): GuardResult & { amount?: string | null }` → `{ ok: true, amount: '1000.50' | null }` or `{ ok: false, code: 'RECEIPT_AMOUNT_INVALID', message }` (commas allowed, ≥ 0, ≤ 2 decimals, ≤ 16 integer digits)
  - `checkReceiptFile(file: ReceiptFileInput | null | undefined): GuardResult` — codes `RECEIPT_FILE_TOO_LARGE`, `RECEIPT_FILE_TYPE`, `RECEIPT_FILE_EMPTY`
- Produces (`lib/domain/actions.ts`):
  - `markReleased(db, { ...existing, receiptAmount?: string; receiptFile?: ReceiptFileInput })`
  - `recordReceipt(db, { ...existing, receiptAmount?: string; receiptFile?: ReceiptFileInput })`
  - `attachReceiptFile(db, { checkId, userId, receiptAmount?: string; receiptFile?: ReceiptFileInput; now }) : Promise<Check>`
  - Each queues `PortalEvent { kind: 'RECEIPT', idempotencyKey: portalEventKey(checkId, 'RECEIPT', now), payload: { action: 'RECEIPT', checkNumber, orNumber, hasFile, amount } }` when the cheque is routed and ends up with a receipt reference.

- [ ] **Step 1: Write failing tests**

`tests/domain/receipt.test.ts` — add:

```ts
import { checkReceiptAmount, checkReceiptFile, MAX_RECEIPT_FILE_BYTES } from '@/lib/domain/receipt'

describe('checkReceiptAmount', () => {
  it('normalises commas and two decimals, keeps blank as null', () => {
    expect(checkReceiptAmount('1,000.5')).toEqual({ ok: true, amount: '1000.50' })
    expect(checkReceiptAmount('')).toEqual({ ok: true, amount: null })
    expect(checkReceiptAmount(undefined)).toEqual({ ok: true, amount: null })
  })
  it('refuses negatives, three decimals and words', () => {
    for (const bad of ['-1', '1.005', 'abc', '1e5']) expect(checkReceiptAmount(bad).ok).toBe(false)
  })
})

describe('checkReceiptFile', () => {
  const pdf = (n = 10) => { const b = new Uint8Array(n); b.set([0x25, 0x50, 0x44, 0x46]); return b }
  it('accepts a PDF whose bytes say PDF', () => {
    expect(checkReceiptFile({ fileName: 'or.pdf', contentType: 'application/pdf', bytes: pdf() })).toEqual({ ok: true })
    expect(checkReceiptFile(null)).toEqual({ ok: true })
  })
  it('refuses size, type and a mismatched signature', () => {
    expect(checkReceiptFile({ fileName: 'x', contentType: 'application/pdf', bytes: pdf(MAX_RECEIPT_FILE_BYTES + 1) })).toMatchObject({ ok: false, code: 'RECEIPT_FILE_TOO_LARGE' })
    expect(checkReceiptFile({ fileName: 'x', contentType: 'text/html', bytes: pdf() })).toMatchObject({ ok: false, code: 'RECEIPT_FILE_TYPE' })
    expect(checkReceiptFile({ fileName: 'x.png', contentType: 'image/png', bytes: pdf() })).toMatchObject({ ok: false, code: 'RECEIPT_FILE_TYPE' })
    expect(checkReceiptFile({ fileName: 'x', contentType: 'application/pdf', bytes: new Uint8Array(0) })).toMatchObject({ ok: false, code: 'RECEIPT_FILE_EMPTY' })
  })
})
```

`tests/actions/receipt-file.test.ts` — new:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { markReadyForRelease, markReleased, recordReceipt, attachReceiptFile } from '@/lib/domain/actions'

const NOW = new Date('2026-10-02T10:00:00+08:00')
const LATER = new Date('2026-10-02T11:00:00+08:00')
const PICKUP = new Date('2026-10-02')
const pdf = () => { const b = new Uint8Array(32); b.set([0x25, 0x50, 0x44, 0x46]); return b }
const file = () => ({ fileName: 'OR-1.pdf', contentType: 'application/pdf', bytes: pdf() })

beforeEach(resetDb)

async function released(eligibility: 'SUPPLIER' | 'INTERNAL' = 'SUPPLIER') {
  const user = await makeUser()
  const check = await makeCheck({ status: 'SIGNED', eligibility, apvNumbers: ['AP-1'] })
  await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
  await markReleased(testDb, { checkId: check.id, userId: user.id, now: NOW })
  return { user, check }
}
const receiptEvents = (checkId: string) => testDb.portalEvent.findMany({ where: { checkId, kind: 'RECEIPT' } })

describe('recordReceipt with amount and file', () => {
  it('stores amount + file and queues one RECEIPT', async () => {
    const { user, check } = await released()
    const out = await recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', receiptAmount: '1,000.50', receiptFile: file(), now: LATER })
    expect(out.receiptAmount?.toString()).toBe('1000.5')
    const f = await testDb.checkReceiptFile.findUnique({ where: { checkId: check.id } })
    expect(f?.sizeBytes).toBe(32)
    expect(f?.contentType).toBe('application/pdf')
    const ev = await receiptEvents(check.id)
    expect(ev).toHaveLength(1)
    expect(ev[0].idempotencyKey).toBe(`${check.id}:RECEIPT:${LATER.toISOString()}`)
    const audit = await testDb.auditLog.findMany({ where: { checkId: check.id, action: 'receipt_recorded' } })
    expect(JSON.stringify(audit)).not.toContain('JVBER') // no base64 of "%PDF"
  })
  it('an INTERNAL cheque stores the receipt but queues nothing', async () => {
    const { user, check } = await released('INTERNAL')
    await recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', receiptFile: file(), now: LATER })
    expect(await receiptEvents(check.id)).toHaveLength(0)
  })
  it('a bad file refuses the whole receipt', async () => {
    const { user, check } = await released()
    await expect(recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', receiptFile: { ...file(), contentType: 'image/png' }, now: LATER }))
      .rejects.toMatchObject({ code: 'RECEIPT_FILE_TYPE' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).orNumber).toBeNull()
  })
})

describe('markReleased with a receipt', () => {
  it('queues RELEASED and RECEIPT', async () => {
    const user = await makeUser()
    const check = await makeCheck({ status: 'SIGNED', apvNumbers: ['AP-1'] })
    await markReadyForRelease(testDb, { checkId: check.id, userId: user.id, availablePickupDate: PICKUP, now: NOW })
    await markReleased(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-9', receiptType: 'OR', receiptAmount: '5', now: LATER })
    const kinds = (await testDb.portalEvent.findMany({ where: { checkId: check.id }, orderBy: { createdAt: 'asc' } })).map(e => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['RELEASED', 'RECEIPT']))
  })
  it('a release without a receipt queues no RECEIPT', async () => {
    const { check } = await released()
    expect(await receiptEvents(check.id)).toHaveLength(0)
  })
})

describe('attachReceiptFile', () => {
  it('adds a file and amount to a receipt recorded without them, then refuses a second', async () => {
    const { user, check } = await released()
    await recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', now: LATER })
    await attachReceiptFile(testDb, { checkId: check.id, userId: user.id, receiptAmount: '10', receiptFile: file(), now: new Date(LATER.getTime() + 1000) })
    expect(await receiptEvents(check.id)).toHaveLength(2)
    await expect(attachReceiptFile(testDb, { checkId: check.id, userId: user.id, receiptFile: file(), now: new Date(LATER.getTime() + 2000) }))
      .rejects.toMatchObject({ code: 'RECEIPT_FILE_ALREADY_ATTACHED' })
    await expect(attachReceiptFile(testDb, { checkId: check.id, userId: user.id, receiptAmount: '11', now: new Date(LATER.getTime() + 3000) }))
      .rejects.toMatchObject({ code: 'RECEIPT_AMOUNT_ALREADY_RECORDED' })
  })
  it('refuses when no receipt reference is recorded, or nothing is given', async () => {
    const { user, check } = await released()
    await expect(attachReceiptFile(testDb, { checkId: check.id, userId: user.id, receiptFile: file(), now: LATER }))
      .rejects.toMatchObject({ code: 'RECEIPT_REQUIRED' })
    await recordReceipt(testDb, { checkId: check.id, userId: user.id, orNumber: 'OR-1', receiptType: 'OR', now: LATER })
    await expect(attachReceiptFile(testDb, { checkId: check.id, userId: user.id, now: new Date(LATER.getTime() + 1000) }))
      .rejects.toMatchObject({ code: 'RECEIPT_NOTHING_TO_ATTACH' })
  })
})
```

Check `DomainError` exposes `.code` (see `lib/domain/errors.ts`); adjust the matcher field if it is named differently.

- [ ] **Step 2: Run to fail** — `npx.cmd vitest run tests/domain/receipt.test.ts tests/actions/receipt-file.test.ts` → FAIL (missing exports).

- [ ] **Step 3: `lib/domain/receipt.ts`** — append:

```ts
/**
 * The receipt's amount and scanned file (user request 2026-10-01). Pure, like
 * the rest of this module. The file is capped at 3 MB (spec 2026-10-02): the
 * portal receives it base64 inside one request and Vercel caps a request at
 * ~4.5 MB. The leading bytes must agree with the stated type, so a renamed
 * file is refused rather than stored under a type it is not.
 */
export const MAX_RECEIPT_FILE_BYTES = 3 * 1024 * 1024
export const RECEIPT_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type ReceiptFileInput = { fileName: string; contentType: string; bytes: Uint8Array }

const SIGNATURES: Record<(typeof RECEIPT_FILE_TYPES)[number], number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
}

export function checkReceiptAmount(raw: string | null | undefined): GuardResult & { amount?: string | null } {
  const s = String(raw ?? '').replace(/,/g, '').trim()
  if (s === '') return { ok: true, amount: null }
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(s)) {
    return { ok: false, code: 'RECEIPT_AMOUNT_INVALID', message: 'Enter the receipt amount as a number, for example 12,500.00.' }
  }
  const [whole, frac = ''] = s.split('.')
  return { ok: true, amount: `${String(Number(whole))}.${frac.padEnd(2, '0')}` }
}

export function checkReceiptFile(file: ReceiptFileInput | null | undefined): GuardResult {
  if (!file) return { ok: true }
  if (file.bytes.length === 0) return { ok: false, code: 'RECEIPT_FILE_EMPTY', message: 'The receipt file is empty.' }
  if (file.bytes.length > MAX_RECEIPT_FILE_BYTES) {
    return { ok: false, code: 'RECEIPT_FILE_TOO_LARGE', message: 'The receipt file is larger than 3 MB. Scan it at a lower resolution or save it as a smaller PDF.' }
  }
  const sig = SIGNATURES[file.contentType as keyof typeof SIGNATURES]
  if (!sig || !sig.every((b, i) => file.bytes[i] === b)) {
    return { ok: false, code: 'RECEIPT_FILE_TYPE', message: 'The receipt file must be a PDF, JPG or PNG.' }
  }
  return { ok: true }
}
```

`String(Number(whole))` is safe for ≤ 16 digits? No — `Number` loses precision above 2^53 (~9e15, 16 digits). Use `whole.replace(/^0+(?=\d)/, '')` instead of `String(Number(whole))`.

- [ ] **Step 4: `lib/domain/actions.ts`**

Imports: add `checkReceiptAmount, checkReceiptFile, type ReceiptFileInput` from `./receipt`, and `createHash` from `node:crypto`.

Helpers (near `queueCancelled`):

```ts
/** Validates amount + file together; throws the first refusal. */
function receiptExtras(args: { receiptAmount?: string; receiptFile?: ReceiptFileInput }): { amount: string | null; file: ReceiptFileInput | null } {
  const a = checkReceiptAmount(args.receiptAmount)
  if (!a.ok) throw new DomainError(a.code, a.message)
  const f = checkReceiptFile(args.receiptFile)
  if (!f.ok) throw new DomainError(f.code, f.message)
  return { amount: a.amount ?? null, file: args.receiptFile ?? null }
}

async function storeReceiptFile(tx: Prisma.TransactionClient, checkId: string, userId: string, file: ReceiptFileInput, now: Date) {
  const bytes = Buffer.from(file.bytes)
  await tx.checkReceiptFile.create({
    data: {
      checkId, fileName: file.fileName.slice(0, 200) || 'receipt', contentType: file.contentType,
      sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes,
      uploadedById: userId, uploadedAt: now,
    },
  })
}

/**
 * The sixth kind (user request 2026-10-01). The body is rebuilt from the
 * cheque at delivery, so the payload is a record only: never the file.
 */
async function queueReceipt(tx: Prisma.TransactionClient, check: { id: string; checkNumber: string }, args: { orNumber: string | null; amount: string | null; hasFile: boolean; now: Date }) {
  await tx.portalEvent.create({
    data: {
      checkId: check.id, direction: 'OUT', kind: 'RECEIPT', status: 'PENDING',
      idempotencyKey: portalEventKey(check.id, 'RECEIPT', args.now),
      payload: { action: 'RECEIPT', checkNumber: check.checkNumber, orNumber: args.orNumber, amount: args.amount, hasFile: args.hasFile },
    },
  })
}
```

`writeReceiptAudit`: add optional `extras?: { amount: string | null; file: { fileName: string; contentType: string; sizeBytes: number; sha256: string } | null }` and put them in `details` as `amount` and `file` (metadata only). Callers pass it.

`recordReceipt`: add `receiptAmount?: string; receiptFile?: ReceiptFileInput` to args; call `const extras = receiptExtras(args)` right after the existing guard; inside the transaction, extend the `tx.check.update` data with `receiptAmount: extras.amount`, then `if (extras.file) await storeReceiptFile(tx, check.id, args.userId, extras.file, args.now)`, then `if (portalRoute(check.eligibility as Eligibility) !== null) await queueReceipt(tx, check, { orNumber: receipt.orNumber, amount: extras.amount, hasFile: !!extras.file, now: args.now })`. Rewrite the stale doc paragraph "**It queues no portal event.** …" to: "**It queues RECEIPT** (user request 2026-10-01) for a routed cheque, so the late receipt reaches the portal's Payments page; amount and file are add-only like the reference."

`markReleased`: same `receiptAmount` / `receiptFile` args and `receiptExtras` call before the transaction; amount/file are written only in the branch where the receipt columns are written (`alreadyHasReceipt` false and `hasReceipt(receipt)`); if amount/file are given while `alreadyHasReceipt` or without a reference, throw `RECEIPT_REQUIRED` ("An amount or file needs the receipt reference it belongs to."). Inside `if (pushes)`, after the RELEASED create, `if (!alreadyHasReceipt && hasReceipt(receipt)) await queueReceipt(tx, check, { …, now: args.now })` — RELEASED and RECEIPT share `now` but have distinct keys (kind is in the key).

New action:

```ts
/**
 * Adds the amount and/or scanned file to a receipt recorded without them
 * (user request 2026-10-01: "allow the OR/CR to be uploaded after payment").
 * Add-only, like the reference: an amount or file already on record is
 * refused, never replaced. Queues RECEIPT for a routed cheque.
 */
export async function attachReceiptFile(
  db: Db,
  args: { checkId: string; userId: string; receiptAmount?: string; receiptFile?: ReceiptFileInput; now: Date },
): Promise<Check> {
  const extras = receiptExtras(args)
  if (extras.amount === null && !extras.file) {
    throw new DomainError('RECEIPT_NOTHING_TO_ATTACH', 'Choose the receipt file or enter its amount.')
  }
  return inTx(db, async (tx) => {
    const check = await load(tx, args.checkId)
    if (check.orNumber === null) {
      throw new DomainError('RECEIPT_REQUIRED', 'Record the receipt reference first; the file and amount belong to it.')
    }
    if (extras.amount !== null && check.receiptAmount !== null) {
      throw new DomainError('RECEIPT_AMOUNT_ALREADY_RECORDED', `This receipt already records ${check.receiptAmount.toFixed(2)}. A recorded amount is not overwritten from here — if it is wrong, raise it with a Finance Admin.`)
    }
    if (extras.file && await tx.checkReceiptFile.findUnique({ where: { checkId: check.id }, select: { checkId: true } })) {
      throw new DomainError('RECEIPT_FILE_ALREADY_ATTACHED', 'This receipt already has its file. A recorded file is not replaced from here — if it is wrong, raise it with a Finance Admin.')
    }
    const updated = extras.amount !== null
      ? await tx.check.update({ where: { id: check.id }, data: { receiptAmount: extras.amount } })
      : check
    if (extras.file) await storeReceiptFile(tx, check.id, args.userId, extras.file, args.now)
    if (portalRoute(check.eligibility as Eligibility) !== null) {
      await queueReceipt(tx, check, { orNumber: check.orNumber, amount: extras.amount ?? check.receiptAmount?.toFixed(2) ?? null, hasFile: true, now: args.now })
    }
    await writeAudit(tx, {
      checkId: check.id, actorType: 'USER', userId: args.userId, action: 'receipt_attached',
      details: { amount: extras.amount, file: extras.file ? { fileName: extras.file.fileName, contentType: extras.file.contentType, sizeBytes: extras.file.bytes.length } : null },
      remarks: `Receipt ${check.orNumber}: ${[extras.amount !== null ? 'amount' : null, extras.file ? 'file' : null].filter(Boolean).join(' and ')} added`,
    })
    return updated as Check
  })
}
```

`hasFile` in that payload is only a record — compute it as `extras.file ? true : !!(await tx.checkReceiptFile.findUnique(...))` if you want it exact; a plain `true` when a file was just added and the existing state otherwise is fine.

A 3 MB BYTEA insert inside the interactive transaction can exceed Prisma's 5 s default (CLAUDE.md 360-366): pass `{ timeout: 30_000, maxWait: 10_000 }` — extend `inTx` with an optional options argument and use it in these three actions only.

- [ ] **Step 5: Run** — `npx.cmd vitest run tests/domain/receipt.test.ts tests/actions/receipt-file.test.ts tests/actions/receipt.test.ts tests/actions/actions.test.ts tests/actions/reverse-release.test.ts tests/actions/bulk-actions.test.ts` and `npx.cmd tsc --noEmit` → PASS. Fix exact-count assertions in the existing files only where a receipt-carrying release now also queues RECEIPT.

- [ ] **Step 6: Commit**

```bash
git add lib/domain tests/domain tests/actions
git commit -m "feat(receipts): amount + file on the supplier receipt, queued as RECEIPT"
```

---

### Task 3: Outbox lanes + RECEIPT body

**Files:**
- Modify: `lib/sync/portal-outbox.ts` (`kindMatchesStatus`, lanes in `deliverPortalEvents`, include the file only for RECEIPT, longer timeout for RECEIPT)
- Modify: `lib/integrations/portal/client.ts` (`CheckForPortal`, `PortalEventBody`, RECEIPT branch)
- Test: `tests/integrations/portal-client.test.ts`, `tests/sync/portal-outbox.test.ts`

**Interfaces:**
- Consumes: `Check.receiptAmount`, `CheckReceiptFile` (Task 1); RECEIPT events (Task 2).
- Produces: RECEIPT body `{ ...base, receiptType, orNumber, orDate?, amount?, file?: { name, contentType, base64 }, releasedBy? }`.

- [ ] **Step 1: Failing tests**

`tests/integrations/portal-client.test.ts` — add `receiptType: null, receiptAmount: null, receiptFile: null` to the fixture default, then:

```ts
  it('RECEIPT carries type, number, date, amount string, base64 file and releaser', () => {
    const body = buildPortalEventBody({ id: 'r1', kind: 'RECEIPT' }, check({
      releasedAt: new Date('2026-10-02T02:00:00Z'), orNumber: 'OR-9', orDate: new Date('2026-10-02T00:00:00Z'),
      receiptType: 'OR', receiptAmount: new Prisma.Decimal('1000.5'), releasedBy: { name: 'Ana Cruz' },
      receiptFile: { fileName: 'or.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF') },
    }))
    expect(body).toMatchObject({ kind: 'RECEIPT', receiptType: 'OR', orNumber: 'OR-9', orDate: '2026-10-02', amount: '1000.50', releasedBy: 'Ana Cruz',
      file: { name: 'or.pdf', contentType: 'application/pdf', base64: Buffer.from('%PDF').toString('base64') } })
  })
  it('RECEIPT without a reference or type is a payload defect', () => {
    expect(() => buildPortalEventBody({ id: 'r', kind: 'RECEIPT' }, check({ orNumber: null })))
      .toThrow(PortalPayloadError)
  })
```

(`import { Prisma } from '@prisma/client'`.)

`tests/sync/portal-outbox.test.ts` — extend the `queue()` helper's kind union with `'RECEIPT'`, and add:

```ts
  it('RELEASED then RECEIPT for one cheque: both delivered, status first, neither superseded', async () => {
    const check = await releasedCheck('AP-1')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-1', receiptType: 'OR' } })
    await queue(check.id, 'RELEASED', NOW)
    await queue(check.id, 'RECEIPT', new Date(NOW.getTime() + 1))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent.map(b => b.kind)).toEqual(['RELEASED', 'RECEIPT'])
    expect(out).toMatchObject({ synced: 2, superseded: 0 })
  })
  it('a newer RECEIPT supersedes an older RECEIPT only', async () => {
    const check = await releasedCheck('AP-2')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-2', receiptType: 'OR' } })
    await queue(check.id, 'RECEIPT', NOW)
    await queue(check.id, 'RECEIPT', new Date(NOW.getTime() + 1))
    const client = fakeClient(() => ok())
    const out = await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(out).toMatchObject({ synced: 1, superseded: 1 })
  })
  it('RECEIPT waits while its cheque has a status event that failed this run', async () => {
    const check = await releasedCheck('AP-3')
    await testDb.check.update({ where: { id: check.id }, data: { orNumber: 'OR-3', receiptType: 'OR' } })
    await queue(check.id, 'RELEASED', NOW)
    await queue(check.id, 'RECEIPT', new Date(NOW.getTime() + 1))
    const client = fakeClient((b) => (b.kind === 'RELEASED' ? new Error('network down') : ok()))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(client.sent.map(b => b.kind)).toEqual(['RELEASED'])
    expect((await testDb.portalEvent.findFirst({ where: { checkId: check.id, kind: 'RECEIPT' } }))?.status).toBe('PENDING')
  })
  it('kindMatchesStatus: RECEIPT only for a RELEASED cheque', () => {
    expect(kindMatchesStatus('RECEIPT', 'RELEASED')).toBe(true)
    expect(kindMatchesStatus('RECEIPT', 'READY_FOR_RELEASE')).toBe(false)
  })
```

- [ ] **Step 2: Run to fail** — `npx.cmd vitest run tests/integrations/portal-client.test.ts tests/sync/portal-outbox.test.ts` → FAIL.

- [ ] **Step 3: Client** — `lib/integrations/portal/client.ts`:

```ts
export type CheckForPortal = Pick<
  Check, 'id' | 'checkNumber' | 'apvNumbers' | 'eligibility' | 'availablePickupDate' | 'releasedAt' | 'orNumber' | 'orDate'
> & {
  cashAccount: { bank: { code: string } } | null
  checkBook: { bank: { code: string } } | null
  bills: { apvNumber: string; poNumber: string | null }[]
  releasedBy?: { name: string } | null
  // RECEIPT only (user request 2026-10-01); optional so other kinds' literals compile.
  receiptType?: Check['receiptType']
  receiptAmount?: Check['receiptAmount']
  receiptFile?: { fileName: string; contentType: string; bytes: Uint8Array } | null
}
```

`PortalEventBody` gains `receiptType?: 'OR' | 'CR'; amount?: string; file?: { name: string; contentType: string; base64: string }`. In `buildPortalEventBody`, after the RELEASED branch:

```ts
  if (event.kind === 'RECEIPT') {
    if (!check.orNumber || !check.receiptType) {
      throw new PortalPayloadError('INVALID_PAYLOAD', `RECEIPT cheque ${check.id} has no receipt reference and type`)
    }
    body.receiptType = check.receiptType
    body.orNumber = check.orNumber
    if (check.orDate) body.orDate = manilaDay(check.orDate)
    if (check.receiptAmount) body.amount = check.receiptAmount.toFixed(2)
    if (check.receiptFile) {
      body.file = {
        name: check.receiptFile.fileName, contentType: check.receiptFile.contentType,
        base64: Buffer.from(check.receiptFile.bytes).toString('base64'),
      }
    }
    if (check.releasedBy?.name) body.releasedBy = check.releasedBy.name
  }
```

- [ ] **Step 4: Outbox** — `lib/sync/portal-outbox.ts`:

`kindMatchesStatus` gains `case 'RECEIPT': return status === 'RELEASED'`.

Replace the single `newest` map with lanes:

```ts
  // Two lanes per cheque (spec 2026-10-02): the status lane (MARK_AVAILABLE,
  // REVERT, RELEASED, RELEASE_REVERSED, CANCELLED) and the receipt lane.
  // Latest-wins runs inside a lane only: a RECEIPT must never close the
  // RELEASED it accompanies, and a later status event must not drop a receipt.
  const laneOf = (ev: PortalEvent) => `${ev.checkId}|${ev.kind === 'RECEIPT' ? 'receipt' : 'status'}`
  const newest = new Map<string, PortalEvent>()
  for (const ev of open) if (!frozen.has(ev.checkId)) newest.set(laneOf(ev), ev)
```

In the supersede loop use `newest.get(laneOf(ev))!` for `winner`. For delivery, order the winners status-first per cheque and hold a receipt while its cheque's status winner did not synchronise in this run:

```ts
  const winners = [...newest.values()].sort((a, b) =>
    (a.kind === 'RECEIPT' ? 1 : 0) - (b.kind === 'RECEIPT' ? 1 : 0))
  // A cheque whose status-lane event is still open after its turn holds its
  // receipt back (spec 2026-10-02): the portal must hear RELEASED first.
  const statusOpen = new Set([...newest.values()].filter(e => e.kind !== 'RECEIPT').map(e => e.checkId))
  for (const ev of winners) {
    if (frozen.has(ev.checkId)) continue
    if (ev.kind === 'RECEIPT' && statusOpen.has(ev.checkId)) continue
    ...existing body...
```

and, where the existing code learns the settle status, `if (ev.kind !== 'RECEIPT' && status === 'SYNCED') statusOpen.delete(ev.checkId)` (also delete on a stale close of a status event, since it no longer blocks). Keep every other path (`continue` on not-due, claim lost, etc.) leaving the cheque in `statusOpen`.

Load the file only for RECEIPT, and give it more time:

```ts
      const check = await db.check.findUnique({
        where: { id: ev.checkId },
        include: {
          cashAccount: { include: { bank: true } }, checkBook: { include: { bank: true } }, bills: true,
          releasedBy: { select: { name: true } },
          ...(ev.kind === 'RECEIPT' ? { receiptFile: { select: { fileName: true, contentType: true, bytes: true } } } : {}),
        },
      })
```

and `const cap = ev.kind === 'RECEIPT' ? RECEIPT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS` with `export const RECEIPT_REQUEST_TIMEOUT_MS = 30_000` (a ~4 MB body from Manila), used in the existing `Math.min(remaining, …)`.

- [ ] **Step 5: Run** — `npx.cmd vitest run tests/integrations/portal-client.test.ts tests/sync/portal-outbox.test.ts tests/sync/portal-kick.test.ts` (and any other `tests/sync/portal-*.test.ts`) and `npx.cmd tsc --noEmit` → PASS; existing supersede tests must still pass unchanged (they use status kinds only).

- [ ] **Step 6: Commit**

```bash
git add lib/sync/portal-outbox.ts lib/integrations/portal/client.ts tests/integrations tests/sync
git commit -m "feat(portal): RECEIPT lane in the outbox and its event body"
```

---

### Task 4: Forms and actions

**Files:**
- Modify: `next.config.ts` (`experimental.serverActions.bodySizeLimit: '4mb'`)
- Modify: `lib/receipt-form.ts` (`readReceiptFields` reads `receiptAmount` and `receiptFile`)
- Modify: `app/checks/actions.ts` (`recordReceiptAction` passes amount/file; new `attachReceiptFileAction`)
- Modify: `components/ReceiptFields.tsx` (amount input), `components/ReceiptForm.tsx` (file input + client size/type check)
- Create: `components/AttachReceiptFileForm.tsx`
- Modify: `app/receipts/[id]/page.tsx` (shows amount + file status; draws `AttachReceiptFileForm` when a receipt is recorded and the amount or file is missing)
- Test: `tests/receipt-form.test.ts` (extend)

**Interfaces:** `readReceiptFields(formData)` result gains `receiptAmount: string | undefined` and `receiptFile: ReceiptFileInput | undefined` (it becomes `async` because reading a `File` is async — update every caller: `releaseAction`, `recordReceiptAction`). `attachReceiptFileAction(formData): Promise<ActionResult>`.

- [ ] **Step 1: Failing test** — `tests/receipt-form.test.ts` add:

```ts
  it('reads the amount and the receipt file', async () => {
    const fd = new FormData()
    fd.set('orNumber', 'OR-1'); fd.set('receiptType', 'OR'); fd.set('receiptAmount', '1,000.50')
    fd.set('receiptFile', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'or.pdf', { type: 'application/pdf' }))
    const r = await readReceiptFields(fd)
    expect(r).toMatchObject({ ok: true, receiptAmount: '1,000.50' })
    if (r.ok) { expect(r.receiptFile?.fileName).toBe('or.pdf'); expect(r.receiptFile?.bytes.length).toBe(4) }
  })
  it('an empty file input is no file', async () => {
    const fd = new FormData(); fd.set('receiptFile', new File([], ''))
    const r = await readReceiptFields(fd)
    if (r.ok) expect(r.receiptFile).toBeUndefined()
  })
```

Make the existing tests in that file `await` the now-async function.

- [ ] **Step 2: Run to fail**, then implement:

`lib/receipt-form.ts`:

```ts
export type ReceiptFormFields = {
  orNumber: string | undefined; orDate: Date | undefined; receiptType: ReceiptType | null
  receiptAmount: string | undefined; receiptFile: ReceiptFileInput | undefined
}

async function file(f: FormData, k: string): Promise<ReceiptFileInput | undefined> {
  const v = f.get(k)
  if (!(v instanceof File) || v.size === 0) return undefined
  return { fileName: v.name, contentType: v.type, bytes: new Uint8Array(await v.arrayBuffer()) }
}

export async function readReceiptFields(formData: FormData): Promise<ReceiptFormResult> {
  // …existing receiptType parsing…
  return {
    ok: true, orNumber: str(formData, 'orNumber') || undefined, orDate: date(formData, 'orDate'), receiptType,
    receiptAmount: str(formData, 'receiptAmount') || undefined, receiptFile: await file(formData, 'receiptFile'),
  }
}
```

`app/checks/actions.ts`: `await readReceiptFields(...)` in `releaseAction` and `recordReceiptAction`; pass `receiptAmount` / `receiptFile` through to `markReleased` / `recordReceipt`. New:

```ts
export async function attachReceiptFileAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  const receipt = await readReceiptFields(formData)
  if (!receipt.ok) return { ok: false, message: receipt.message }
  return run(checkId, () => attachReceiptFile(prisma, {
    checkId, userId: user.id, receiptAmount: receipt.receiptAmount, receiptFile: receipt.receiptFile, now: new Date(),
  }))
}
```

`next.config.ts`:

```ts
const nextConfig: NextConfig = {
  // A supplier receipt file is up to 3 MB (spec 2026-10-02); the 1 MB default
  // would refuse it before the action runs.
  experimental: { serverActions: { bodySizeLimit: '4mb' } },
}
```

`components/ReceiptFields.tsx`: `ReceiptValue` gains `receiptAmount: string`, `EMPTY_RECEIPT` gains `receiptAmount: ''`; add a third labelled input after RECEIPT DATE using the same classes:

```tsx
        <label className="block text-xs font-medium tracking-wide text-slate-600" htmlFor={`${idPrefix}-amount`}>
          AMOUNT
          <input id={`${idPrefix}-amount`} name="receiptAmount" inputMode="decimal" value={value.receiptAmount}
            disabled={disabled} placeholder="Optional" onChange={(e) => onChange({ ...value, receiptAmount: e.target.value })}
            className="mt-1 w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
```

`components/ReceiptForm.tsx`: add, after `<ReceiptFields …/>`:

```tsx
      <label className="block text-xs font-medium tracking-wide text-slate-600" htmlFor="record-receipt-file">
        RECEIPT FILE (PDF, JPG OR PNG, UP TO 3 MB)
        <input id="record-receipt-file" name="receiptFile" type="file" accept="application/pdf,image/jpeg,image/png"
          disabled={pending}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0]
            setFileError(f && f.size > 3 * 1024 * 1024 ? 'That file is larger than 3 MB.' : null)
          }}
          className="mt-1 block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-navy-bg file:px-4 file:py-2 file:text-sm file:font-medium file:tracking-wide file:text-navy hover:file:bg-navy-bg/70" />
      </label>
      {fileError && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{fileError}</p>}
```

with `const [fileError, setFileError] = useState<string | null>(null)` and `fileError !== null` added to the submit button's `disabled`.

`components/AttachReceiptFileForm.tsx` (client) — same shape as `ReceiptForm` (useRouter, useTransition, result state), props `{ checkId: string; needsAmount: boolean; needsFile: boolean }`, rendering the AMOUNT input (when `needsAmount`) and the file input (when `needsFile`), submit button `ATTACH TO RECEIPT`, calling `attachReceiptFileAction(formData)`, `router.refresh()` on success, the amber message on failure.

`app/receipts/[id]/page.tsx`: include `receiptFile: { select: { fileName: true, sizeBytes: true } }` in the cheque query; in the recorded-receipt block show `AMOUNT` (`check.receiptAmount?.toFixed(2) ?? '—'`) and `FILE` (`check.receiptFile ? `${fileName} (${Math.ceil(sizeBytes / 1024)} KB)` : 'Not attached'`); when `recorded && (check.receiptAmount === null || !check.receiptFile)` render `<AttachReceiptFileForm checkId={check.id} needsAmount={check.receiptAmount === null} needsFile={!check.receiptFile} />`.

- [ ] **Step 3: Run** — `npx.cmd vitest run tests/receipt-form.test.ts tests/actions/receipt-file.test.ts` and `npx.cmd tsc --noEmit` → PASS. Then the controller does a browser check of `/receipts/<id>` on a dev server against the TEST database.

- [ ] **Step 4: Commit**

```bash
git add next.config.ts lib/receipt-form.ts app/checks/actions.ts components app/receipts tests/receipt-form.test.ts
git commit -m "feat(receipts): amount and file on the receipt page; attach later"
```

---

### Task 5: Docs

**Files:** `CLAUDE.md` (rule 11 text: amount + file are add-only and travel as RECEIPT; outbox lanes), `docs/superpowers/specs/2026-09-26-check-monitoring-integration-design.md` (a dated addendum: the RECEIPT kind and lanes).

- [ ] Write the two short additions; `git commit -m "docs: RECEIPT kind, receipt amount + file, outbox lanes"`.

## Rollout (with the user's go-ahead)

1. Portal first (already built; deploy before or with this): it must accept `RECEIPT`.
2. `node scripts/migrate.mjs prod --confirm` (both migrations, enum first), then deploy (`npx vercel --prod` per CLAUDE.md, or the master push if Vercel is Git-linked — confirm which before pushing).
3. Smoke: record a receipt with a small PDF on a released supplier cheque; the outbox delivers RELEASED/RECEIPT; the portal Payments row shows Uploaded and the file opens.
