# NUMBERING: Dotted Re-uses Count as Used — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cheque number that Acumatica re-used with a trailing dot (`6000146879.`) and that sits on the staged queue counts as used on `/numbering` — shown as a STAGED line, never as MISSING — with no change to the import.

**Architecture:** `buildSeries` gains an optional second argument of staged rows and a third entry kind, `STAGED`; `stagedSeriesNumber` is the one rule deciding which staged references qualify. The screen table and workbook render the new kind; `listNumberingAccounts` reads the qualifying staged rows and joins them to their cash account.

**Tech Stack:** Next.js 15, Prisma 6 / PostgreSQL, Vitest, ExcelJS, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-01-cheque-numbering-and-cancel-guard-design.md`, section C (addendum 2026-10-02).

## Global Constraints

- **Nothing is written to the database.** The staged queue, `StagedCheck` rows and import keying are unchanged.
- **Amounts are decimal strings end to end** (`toFixed(2)`); `Number(amount)` only when writing an Excel cell.
- **Cheque numbers are compared as BigInt, never as JS numbers.** Use the existing `ZERO` / `ONE` constants in `lib/numbering/series.ts` — **no `1n`-style literals** (Next's file tracer fails `next build` on them).
- **The qualifying rule is `stagedSeriesNumber` and nowhere else**: trimmed reference ends with at least one `.`; with only trailing dots removed it passes `canonicalCheckNumber` then `isBareCheckNumber` (`lib/import/normalise.ts`). Do not loosen it.
- **The local `.env` `DATABASE_URL` is PRODUCTION.** Run no script, no dev server.
- **One agent at a time against the shared test database.** Before any database-backed test, the controller confirms the other session has released it.
- Run tests as `node node_modules/vitest/vitest.mjs run <files>`; types as `node node_modules/typescript/bin/tsc --noEmit` (must be clean at the end of every task); no `npx`.
- Commit with explicit paths only; messages end with a `Co-Authored-By:` trailer naming your model and `<noreply@anthropic.com>`.

---

### Task 1: the STAGED entry kind, end to end (pure)

**Files:**
- Modify: `lib/numbering/series.ts`, `components/NumberingTables.tsx`, `lib/export/numbering-workbook.ts`, `lib/numbering-view.ts` (scope note)
- Test: `tests/numbering/series.test.ts`, `tests/export/numbering-workbook.test.ts`

**Interfaces:**
- Produces:

```ts
export type SeriesStaged = {
  acumaticaRef: string; statedCheckRef: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string | null
}
export type SeriesEntry =
  | { kind: 'CHEQUE'; cheque: SeriesCheque; duplicate: boolean }
  | { kind: 'STAGED'; staged: SeriesStaged; number: string }
  | { kind: 'MISSING'; from: string; to: string; count: string }
// SeriesSummary gains:  staged: number
export function stagedSeriesNumber(statedCheckRef: string | null | undefined): string | null
export function buildSeries(cheques: readonly SeriesCheque[], staged?: readonly SeriesStaged[]): AccountSeries
```

- [ ] **Step 1: Update the series test helpers and add the failing cases**

In `tests/numbering/series.test.ts`:

Change the import to:
```ts
import { buildSeries, stagedSeriesNumber, type SeriesCheque, type SeriesEntry, type SeriesStaged } from '@/lib/numbering/series'
```

Replace the `shape` helper with one that knows all three kinds:
```ts
const shape = (entries: SeriesEntry[]) =>
  entries.map((e) => (e.kind === 'CHEQUE' ? e.cheque.checkNumber
    : e.kind === 'STAGED' ? `STAGED ${e.number}`
    : `MISSING ${e.from}-${e.to} (${e.count})`))
```

Add a staged fixture beside `c`:
```ts
const st = (statedCheckRef: string, acumaticaRef = `CV-${statedCheckRef}`): SeriesStaged =>
  ({ acumaticaRef, statedCheckRef, checkDate: null, payeeName: null, amount: '1.00', currency: 'PHP' })
```

In the existing empty-account test, add `staged: 0` to the expected `summary` object (it uses `toEqual`).

Append:
```ts
describe('stagedSeriesNumber', () => {
  it('reads a number that Acumatica re-used with trailing dots', () => {
    expect(stagedSeriesNumber('6000146879.')).toBe('6000146879')
    expect(stagedSeriesNumber('1791361883..')).toBe('1791361883')
    expect(stagedSeriesNumber(' 6000146879. ')).toBe('6000146879')
    expect(stagedSeriesNumber('BPI 6000146879.')).toBe('6000146879')
  })
  it('ignores anything else', () => {
    expect(stagedSeriesNumber('6000146879')).toBeNull()      // no dot: not a re-use
    expect(stagedSeriesNumber('PCF26-00001.')).toBeNull()    // not a number once the dots go
    expect(stagedSeriesNumber('AP-IND000469')).toBeNull()
    expect(stagedSeriesNumber('6000146879.5')).toBeNull()    // a dot inside is not a trailer
    expect(stagedSeriesNumber('.')).toBeNull()
    expect(stagedSeriesNumber(null)).toBeNull()
  })
})

describe('buildSeries with staged re-uses', () => {
  it('a number used only by a staged payment is STAGED, not MISSING', () => {
    const s = buildSeries([c('101'), c('104')], [st('102.')])
    expect(shape(s.entries)).toEqual(['101', 'STAGED 102', 'MISSING 103-103 (1)', '104'])
    expect(s.summary).toMatchObject({ held: 2, staged: 1, missingNumbers: '1', missingRuns: 1 })
  })

  it('a cheque and its dotted re-use: the cheque row first, never a duplicate', () => {
    const s = buildSeries([c('7')], [st('7.'), st('7..', 'CV-second')])
    expect(shape(s.entries)).toEqual(['7', 'STAGED 7', 'STAGED 7'])
    expect(s.summary).toMatchObject({ held: 1, staged: 2, duplicates: 0, missingNumbers: '0' })
    expect(s.entries[0]).toMatchObject({ kind: 'CHEQUE', duplicate: false })
  })

  it('a staged number extends the range', () => {
    const s = buildSeries([c('5')], [st('9.')])
    expect(shape(s.entries)).toEqual(['5', 'MISSING 6-8 (3)', 'STAGED 9'])
    expect(s.summary).toMatchObject({ first: '5', last: '9' })
  })

  it('an account with only staged numbers still has a series', () => {
    const s = buildSeries([], [st('20.'), st('22.')])
    expect(shape(s.entries)).toEqual(['STAGED 20', 'MISSING 21-21 (1)', 'STAGED 22'])
    expect(s.summary).toMatchObject({ first: '20', last: '22', held: 0, staged: 2 })
  })

  it('a staged row that does not qualify is ignored entirely', () => {
    const s = buildSeries([c('1'), c('3')], [st('PCF26-00001.'), st('2')])
    expect(shape(s.entries)).toEqual(['1', 'MISSING 2-2 (1)', '3'])
    expect(s.summary.staged).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/numbering/series.test.ts`
Expected: FAIL — `stagedSeriesNumber` is not exported; staged cases produce no STAGED lines.

- [ ] **Step 3: Implement the series change**

Replace `lib/numbering/series.ts` with:

```ts
import type { CheckStatus } from '@prisma/client'
import { canonicalCheckNumber, isBareCheckNumber } from '@/lib/import/normalise'

/**
 * One cash account's cheques in number order, with every unused number between
 * the lowest and the highest reported as MISSING — the user's rule, "every
 * number counts" (spec 2026-10-01-cheque-numbering-and-cancel-guard-design §B2).
 *
 * Pure. Numbers are compared as BigInt (they run to ten digits; text order puts
 * 999 after 1000). A gap is one line, never one row per number: the jump between
 * two booklets on one account can be billions. Every number and count leaves
 * this function as a decimal string.
 *
 * Staged re-uses (spec §C, 2026-10-02): Acumatica refuses a duplicate cheque
 * reference on a cash account, so a second payment document on the same cheque
 * number is entered with a dot appended. Such payments sit on the staged queue
 * (NO_CHECK_NUMBER); their number is USED, so it is a STAGED line, never MISSING.
 */
export type SeriesCheque = {
  id: string; checkNumber: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string; status: CheckStatus
}
export type SeriesStaged = {
  acumaticaRef: string; statedCheckRef: string; checkDate: Date | null; payeeName: string | null
  amount: string | null; currency: string | null
}
export type SeriesEntry =
  | { kind: 'CHEQUE'; cheque: SeriesCheque; duplicate: boolean }
  | { kind: 'STAGED'; staged: SeriesStaged; number: string }
  | { kind: 'MISSING'; from: string; to: string; count: string }
export type SeriesSummary = {
  first: string | null; last: string | null
  /** Distinct numbers held by CHEQUES — a duplicate counts once; staged lines do not count. */
  held: number
  voided: number; cancelled: number
  /** STAGED lines: numbers Acumatica re-used with a trailing dot. */
  staged: number
  missingNumbers: string; missingRuns: number
  notNumeric: number
  /** Cheques sharing a number with another cheque in the account. */
  duplicates: number
}
export type AccountSeries = { entries: SeriesEntry[]; notNumeric: SeriesCheque[]; summary: SeriesSummary }

const NUMERIC = /^\d+$/
// Not `0n` / `1n` literals: Next's file tracer (nft) evaluates BinaryExpressions
// statically and throws "Cannot mix BigInt and other types" on them, failing the build.
const ZERO = BigInt(0)
const ONE = BigInt(1)

/**
 * The cheque number a staged dotted re-use stands for, or null. The ONLY rule:
 * the trimmed reference must end with at least one dot, and with only those
 * trailing dots removed it must pass the import's own cheque-number rule. A
 * reference without a dot is not a re-use; a memo (`PCF26-00001.`) is not a
 * number. Nothing else is loosened.
 */
export function stagedSeriesNumber(statedCheckRef: string | null | undefined): string | null {
  const raw = (statedCheckRef ?? '').trim()
  if (!raw.endsWith('.')) return null
  const canonical = canonicalCheckNumber(raw.replace(/\.+$/, ''))
  return isBareCheckNumber(canonical) ? canonical : null
}

type Item =
  | { n: bigint; text: string; order: string; cheque: SeriesCheque; staged?: undefined }
  | { n: bigint; text: string; order: string; staged: SeriesStaged; cheque?: undefined }

export function buildSeries(cheques: readonly SeriesCheque[], staged: readonly SeriesStaged[] = []): AccountSeries {
  const items: Item[] = []
  const notNumeric: SeriesCheque[] = []
  for (const cheque of cheques) {
    const text = cheque.checkNumber.trim()
    // '0' sorts a cheque before any staged line on the same number.
    if (NUMERIC.test(text)) items.push({ n: BigInt(text), text, order: `0${cheque.id}`, cheque })
    else notNumeric.push(cheque)
  }
  for (const s of staged) {
    const number = stagedSeriesNumber(s.statedCheckRef)
    if (number !== null) items.push({ n: BigInt(number), text: number, order: `1${s.acumaticaRef}`, staged: s })
  }
  items.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  notNumeric.sort((a, b) => a.checkNumber.localeCompare(b.checkNumber) || a.id.localeCompare(b.id))

  const perNumber = new Map<bigint, number>()
  for (const x of items) if (x.cheque) perNumber.set(x.n, (perNumber.get(x.n) ?? 0) + 1)
  const isDuplicate = (n: bigint) => (perNumber.get(n) ?? 0) > 1

  const entries: SeriesEntry[] = []
  let missing = ZERO
  let runs = 0
  let prev: { n: bigint; text: string } | null = null
  for (const x of items) {
    if (prev && x.n > prev.n + ONE) {
      const from = prev.n + ONE
      const to = x.n - ONE
      const count = to - from + ONE
      // A leading-zero number keeps its width on the MISSING bounds.
      entries.push({
        kind: 'MISSING',
        from: from.toString().padStart(prev.text.length, '0'),
        to: to.toString().padStart(prev.text.length, '0'),
        count: count.toString(),
      })
      missing += count
      runs += 1
    }
    entries.push(x.cheque
      ? { kind: 'CHEQUE', cheque: x.cheque, duplicate: isDuplicate(x.n) }
      : { kind: 'STAGED', staged: x.staged, number: x.text })
    prev = { n: x.n, text: x.text }
  }

  const chequeItems = items.filter((x) => x.cheque)
  const every = [...chequeItems.map((x) => x.cheque!), ...notNumeric]
  return {
    entries,
    notNumeric,
    summary: {
      first: items.length ? items[0].text : null,
      last: items.length ? items[items.length - 1].text : null,
      held: perNumber.size,
      voided: every.filter((x) => x.status === 'VOIDED').length,
      cancelled: every.filter((x) => x.status === 'CANCELLED').length,
      staged: items.length - chequeItems.length,
      missingNumbers: missing.toString(),
      missingRuns: runs,
      notNumeric: notNumeric.length,
      duplicates: chequeItems.filter((x) => isDuplicate(x.n)).length,
    },
  }
}
```

Check `lib/import/normalise.ts` imports nothing impure (database, filesystem); if it does, stop and report — the series must stay pure.

Run: `node node_modules/vitest/vitest.mjs run tests/numbering/series.test.ts` — expected: PASS.

- [ ] **Step 4: Failing workbook tests**

In `tests/export/numbering-workbook.test.ts`, add a staged fixture and append:

```ts
import type { SeriesStaged } from '@/lib/numbering/series'

const stg = (ref: string, cv: string): SeriesStaged =>
  ({ acumaticaRef: cv, statedCheckRef: ref, checkDate: new Date('2026-09-02T00:00:00Z'), payeeName: 'HENKEL', amount: '500.00', currency: 'PHP' })

describe('STAGED lines', () => {
  it('writes a STAGED row with the stated reference verbatim and the CV in NOTE', async () => {
    const acc = { accountId: 'acc-X', account: 'BPI STK', bank: 'BPI', company: 'STK', series: buildSeries([ch('101'), ch('103')], [stg('102.', 'CV-ST000102')]) }
    const wb = await load(await buildNumberingWorkbook({ accounts: [acc], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    const row = ws.getRow(3)
    expect(row.getCell(1).value).toBe('102.')
    expect(row.getCell(4).value).toBe('STAGED')
    expect(row.getCell(6).value).toBe(500)
    expect(String(row.getCell(10).value)).toContain('CV-ST000102')
    expect(ws.rowCount).toBe(4) // header, 101, STAGED 102, 103 — no MISSING line
  })

  it('SUMMARY carries a STAGED column', async () => {
    const acc = { accountId: 'acc-X', account: 'BPI STK', bank: 'BPI', company: 'STK', series: buildSeries([ch('101')], [stg('102.', 'CV-1'), stg('102..', 'CV-2')]) }
    const wb = await load(await buildNumberingWorkbook({ accounts: [acc], meta: META }))
    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const header = summary.getRow(6)
    const labels = Array.from({ length: 12 }, (_, i) => header.getCell(i + 1).value)
    const col = labels.indexOf('STAGED') + 1
    expect(col).toBeGreaterThan(0)
    expect(summary.getRow(7).getCell(col).value).toBe(2)
  })
})
```

(`ch`, `buildSeries`, `load`, `META`, `NUMBERING_SUMMARY_SHEET` already exist in this file — reuse them; adjust the import lines rather than duplicating.)

Run: `node node_modules/vitest/vitest.mjs run tests/export/numbering-workbook.test.ts` — expected: FAIL (no STAGED row; no STAGED column).

- [ ] **Step 5: Implement the workbook change**

In `lib/export/numbering-workbook.ts`:

1. `SUMMARY_HEADERS` becomes:
```ts
const SUMMARY_HEADERS = ['ACCOUNT', 'BANK', 'COMPANY', 'FIRST', 'LAST', 'HELD', 'VOIDED', 'CANCELLED', 'STAGED', 'MISSING NUMBERS', 'MISSING RUNS', 'NOT NUMERIC'] as const
```
2. The summary `values` array becomes:
```ts
      a.account, a.bank, a.company, s.first, s.last, s.held, s.voided, s.cancelled, s.staged,
      countCell(s.missingNumbers), s.missingRuns, s.notNumeric,
```
3. The summary widths become `[22, 10, 10, 14, 14, 10, 10, 12, 10, 18, 14, 14]`.
4. Import `SeriesStaged` beside `SeriesCheque`, and in the account loop, after the `if (e.kind === 'CHEQUE') { … continue }` line, add:
```ts
      if (e.kind === 'STAGED') { stagedRow(e.staged); continue }
```
   with `stagedRow` defined beside `chequeRow`:
```ts
    const stagedRow = (s: SeriesStaged) => {
      const row = sheet.getRow(r++)
      row.getCell(1).value = s.statedCheckRef
      row.getCell(2).value = s.checkDate
      if (s.checkDate) row.getCell(2).numFmt = DATE_FORMAT
      row.getCell(3).value = s.payeeName
      row.getCell(4).value = 'STAGED'
      row.getCell(5).value = s.currency
      row.getCell(6).value = s.amount === null ? null : Number(s.amount)
      if (s.currency) row.getCell(6).numFmt = currencyNumberFormat(s.currency)
      row.getCell(10).value = `Acumatica ${s.acumaticaRef}: the same cheque number used again (staged)`
    }
```
5. Update the file's doc comment: "…each MISSING run as one row…, and each number Acumatica re-used with a trailing dot as a STAGED row (spec §C)".

Run the workbook test — expected: PASS.

- [ ] **Step 6: Screen table and scope note**

In `components/NumberingTables.tsx`:
- Import `SeriesStaged` beside `SeriesCheque`.
- Summary table: add `<th className={`${th} text-right`}>STAGED</th>` after CANCELLED, and the matching cell `<td className={`${th} text-right tabular-nums`}>{s.staged.toLocaleString('en-PH')}</td>` after the CANCELLED cell.
- Add, beside `ChequeRow`:
```tsx
function StagedRow({ s }: { s: SeriesStaged }) {
  return (
    <tr className="border-b border-slate-100 bg-slate-50 text-slate-600">
      <td className={`${th} tabular-nums`}>{s.statedCheckRef}</td>
      <td className={th}>{fmtDay(s.checkDate)}</td>
      <td className={th}>{s.payeeName ?? '—'}</td>
      <td className={`${th} text-right tabular-nums`}>{s.currency ? formatMoney(s.amount, s.currency) : '—'}</td>
      <td className={th}>
        <span className="inline-block whitespace-nowrap rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold tracking-wide text-slate-700">STAGED</span>
        <span className="ml-2 text-xs text-slate-500">Acumatica {s.acumaticaRef}</span>
      </td>
    </tr>
  )
}
```
- In `NumberingEntriesTable`, render the three kinds:
```tsx
          {entries.map((e) => e.kind === 'MISSING'
            ? (
              <tr key={`m-${e.from}`} className="border-b border-amber-200 bg-amber-50">
                <td colSpan={5} className={`${th} font-semibold tabular-nums text-amber-800`}>{missingLabel(e)}</td>
              </tr>
            )
            : e.kind === 'STAGED'
            ? <StagedRow key={`s-${e.staged.acumaticaRef}`} s={e.staged} />
            : <ChequeRow key={e.cheque.id} c={e.cheque} note={e.duplicate ? 'DUPLICATE NUMBER' : undefined} />)}
```
- Update the table's doc comment to mention STAGED lines.

In `lib/numbering-view.ts`, replace `NUMBERING_SCOPE_NOTE` with:
```ts
export const NUMBERING_SCOPE_NOTE =
  'MISSING means no cheque in this system holds the number. The Acumatica sync reads payments dated 2026 ' +
  'onward, so an account\'s first number may sit partway through a booklet and earlier numbers are not known ' +
  'here. A number Acumatica re-used with a trailing dot (a second payment on the same cheque number) counts as ' +
  'used and is listed as STAGED. A cheque Acumatica holds with a memo in place of its number is on /admin/staged, ' +
  'not here — its number may still be one of the MISSING.'
```
If any test pins the old text, update it to the new text.

- [ ] **Step 7: Verify and commit**

Run: `node node_modules/vitest/vitest.mjs run tests/numbering/series.test.ts tests/export/numbering-workbook.test.ts tests/numbering-view.test.ts` — expected: PASS.
Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.
Run: `node node_modules/next/dist/bin/next build` — expected: compiles.

```bash
git add lib/numbering/series.ts components/NumberingTables.tsx lib/export/numbering-workbook.ts lib/numbering-view.ts tests/numbering/series.test.ts tests/export/numbering-workbook.test.ts
git commit -m "feat(numbering): STAGED lines - a number Acumatica re-used with a trailing dot counts as used"
```

---

### Task 2: the query reads the qualifying staged rows

**Files:**
- Modify: `lib/numbering/query.ts`
- Test: `tests/numbering/query.test.ts`

**Interfaces:**
- Consumes: `buildSeries(cheques, staged)`, `stagedSeriesNumber`, `SeriesStaged` (Task 1).
- Produces: `listNumberingAccounts` unchanged in signature; its series now include STAGED entries.

- [ ] **Step 1: Failing tests**

Append to `tests/numbering/query.test.ts` (read `model StagedCheck` in `prisma/schema.prisma` first and supply any other required column; the `staged_check_one_source_identity` CHECK constraint needs exactly one of `acumaticaRef`+`acumaticaTenant` or `sourceSheet`+`sourceRow`):

```ts
async function stage(cashAccountCode: string | null, statedCheckRef: string, extra: Record<string, unknown> = {}) {
  const workbook = extra.source === 'WORKBOOK'
  return testDb.stagedCheck.create({
    data: {
      source: workbook ? 'WORKBOOK' : 'ACUMATICA',
      ...(workbook
        ? { sourceSheet: 'BPI RELEASED', sourceRow: Math.floor(Math.random() * 1e6) }
        : { acumaticaRef: `CV-T${Math.random().toString(36).slice(2, 9)}`, acumaticaTenant: 'GOLIVE' }),
      reason: 'NO_CHECK_NUMBER', impliedStatus: 'SIGNATURE_PENDING',
      statedCheckRef, cashAccountCode, amount: '500.00', currency: 'PHP', payeeName: 'HENKEL',
      apvNumbers: [], poNumbers: [], conflictingCompanies: [],
      ...(extra.promotedCheckId ? { promotedCheckId: extra.promotedCheckId as string } : {}),
    },
  })
}

describe('listNumberingAccounts — staged dotted re-uses', () => {
  it('joins a dotted staged payment to its cash account as a STAGED line', async () => {
    const first = await makeCheck({ checkNumber: '1000' })
    await onAccountOf(first, { checkNumber: '1003' })
    const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: first.cashAccountId! } })
    await stage(acc.code, '1001.')
    const [a] = await listNumberingAccounts(testDb, {})
    const kinds = a.series.entries.map((e) => (e.kind === 'MISSING' ? `M${e.from}` : e.kind === 'STAGED' ? `S${e.number}` : e.cheque.checkNumber))
    expect(kinds).toEqual(['1000', 'S1001', 'M1002', '1003'])
    expect(a.series.summary.staged).toBe(1)
    const s = a.series.entries.find((e) => e.kind === 'STAGED')
    expect(s?.kind === 'STAGED' && s.staged.amount).toBe('500.00')
  })

  it('ignores a promoted row, a row without a dot, a WORKBOOK row and an unknown cash account', async () => {
    const first = await makeCheck({ checkNumber: '2000' })
    await onAccountOf(first, { checkNumber: '2005' })
    const acc = await testDb.cashAccount.findUniqueOrThrow({ where: { id: first.cashAccountId! } })
    await stage(acc.code, '2001.', { promotedCheckId: first.id })
    await stage(acc.code, '2002')
    await stage(acc.code, '2003.', { source: 'WORKBOOK' })
    await stage('NO SUCH ACCOUNT', '2004.')
    const [a] = await listNumberingAccounts(testDb, {})
    expect(a.series.summary.staged).toBe(0)
    expect(a.series.summary.missingNumbers).toBe('4')
  })

  it('an account with only staged numbers still appears', async () => {
    const other = await makeCheck({ checkNumber: '1' })
    const bank = await testDb.bank.create({ data: { code: `B${Math.random().toString(36).slice(2, 7)}`, name: 'BPI' } })
    const empty = await testDb.cashAccount.create({ data: { code: 'EMPTY ACC', bankId: bank.id, companyId: other.companyId } })
    await stage('EMPTY ACC', '30.')
    const out = await listNumberingAccounts(testDb, {})
    const e = out.find((x) => x.accountId === empty.id)
    expect(e?.series.summary).toMatchObject({ first: '30', last: '30', held: 0, staged: 1 })
  })

  it('honours the company and account filters for staged rows', async () => {
    const a = await makeCheck({ checkNumber: '10' })
    const b = await makeCheck({ checkNumber: '20' })
    const accA = await testDb.cashAccount.findUniqueOrThrow({ where: { id: a.cashAccountId! } })
    await stage(accA.code, '11.')
    const onlyB = await listNumberingAccounts(testDb, { companyId: b.companyId })
    expect(onlyB.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(false)
    const onlyAccB = await listNumberingAccounts(testDb, { cashAccountId: b.cashAccountId! })
    expect(onlyAccB.flatMap((x) => x.series.entries).some((e) => e.kind === 'STAGED')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

The controller confirms the test database is free. Run: `node node_modules/vitest/vitest.mjs run tests/numbering/query.test.ts` — expected: the new cases FAIL (no STAGED entries).

- [ ] **Step 3: Implement**

Replace the body of `listNumberingAccounts` in `lib/numbering/query.ts` (keep `countChequesWithoutAccount` unchanged), and import `stagedSeriesNumber` and `SeriesStaged` from `./series`:

```ts
type Group = { account: string; bank: string; company: string; cheques: SeriesCheque[]; staged: SeriesStaged[] }
type AccountRef = { id: string; code: string; bank: { code: string }; company: { code: string } }

/**
 * Every cheque that holds a number in a cash account's series: `isCheque`, a
 * cash account, and EVERY status — VOIDED, CANCELLED and no-amount cheques
 * included, because the number was used whatever happened to it (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §B1). The cash account is
 * the series key: the sync publishes no cheque book. One query, grouped here;
 * ~12,000 rows.
 *
 * Plus the staged Acumatica payments that re-used a cheque number with a
 * trailing dot (spec §C): not promoted, joined to their account by
 * `cashAccountCode`, qualifying by `stagedSeriesNumber`. Read only.
 */
export async function listNumberingAccounts(db: Db, f: NumberingFilters): Promise<NumberingAccount[]> {
  const rows = await db.check.findMany({
    where: {
      isCheque: true,
      cashAccountId: f.cashAccountId ?? { not: null },
      ...(f.companyId ? { cashAccount: { companyId: f.companyId } } : {}),
    },
    select: {
      id: true, checkNumber: true, checkDate: true, payeeName: true, amount: true, currency: true, status: true,
      cashAccount: { select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } } },
    },
  })

  const byAccount = new Map<string, Group>()
  const groupFor = (a: AccountRef): Group => {
    let g = byAccount.get(a.id)
    if (!g) {
      g = { account: a.code, bank: a.bank.code, company: a.company.code, cheques: [], staged: [] }
      byAccount.set(a.id, g)
    }
    return g
  }
  for (const r of rows) {
    if (!r.cashAccount) continue
    groupFor(r.cashAccount).cheques.push({
      id: r.id, checkNumber: r.checkNumber, checkDate: r.checkDate, payeeName: r.payeeName,
      amount: r.amount?.toFixed(2) ?? null, currency: r.currency, status: r.status,
    })
  }

  const stagedRows = await db.stagedCheck.findMany({
    where: { source: 'ACUMATICA', reason: 'NO_CHECK_NUMBER', promotedCheckId: null, cashAccountCode: { not: null } },
    select: { acumaticaRef: true, statedCheckRef: true, checkDate: true, payeeName: true, amount: true, currency: true, cashAccountCode: true },
  })
  const dotted = stagedRows.filter((s) => s.acumaticaRef && stagedSeriesNumber(s.statedCheckRef) !== null)
  const codes = [...new Set(dotted.map((s) => s.cashAccountCode!))]
  const accounts = codes.length
    ? await db.cashAccount.findMany({
      where: {
        code: { in: codes },
        ...(f.cashAccountId ? { id: f.cashAccountId } : {}),
        ...(f.companyId ? { companyId: f.companyId } : {}),
      },
      select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } },
    })
    : []
  const accountByCode = new Map(accounts.map((a) => [a.code, a]))
  for (const s of dotted) {
    const a = accountByCode.get(s.cashAccountCode!)
    if (!a) continue
    groupFor(a).staged.push({
      acumaticaRef: s.acumaticaRef!, statedCheckRef: s.statedCheckRef!, checkDate: s.checkDate, payeeName: s.payeeName,
      amount: s.amount?.toFixed(2) ?? null, currency: s.currency,
    })
  }

  return [...byAccount.entries()]
    .map(([accountId, g]) => ({ accountId, account: g.account, bank: g.bank, company: g.company, series: buildSeries(g.cheques, g.staged) }))
    .sort((a, b) => a.account.localeCompare(b.account) || a.company.localeCompare(b.company) || a.accountId.localeCompare(b.accountId))
}
```

- [ ] **Step 4: Verify and commit**

Run: `node node_modules/vitest/vitest.mjs run tests/numbering/query.test.ts tests/export/numbering-route.test.ts` — expected: PASS.
Run: `node node_modules/typescript/bin/tsc --noEmit` — expected: no output.

```bash
git add lib/numbering/query.ts tests/numbering/query.test.ts
git commit -m "feat(numbering): the query joins staged dotted re-uses to their cash account"
```

---

### Task 3: record it

**Files:** Modify `CLAUDE.md`.

- [ ] **Step 1:** In the **NUMBERING** paragraph under "Things that will catch you out", replace the sentence beginning "MISSING is bounded by the sync's scope" with:

```
MISSING is bounded by the sync's scope (2026 onward, CHK only). A number Acumatica re-used with a
trailing dot — a second payment document on the same cheque number, which Acumatica will not accept
twice on one cash account — sits on `/admin/staged` as NO_CHECK_NUMBER and is shown as a **STAGED**
line, never MISSING (`stagedSeriesNumber`, spec §C, 2026-10-02). Measured that day: 169 staged
payments end in dots, 66 of them on a number a different payment already holds here under the same
company — **do not strip the dot at import**; it would collapse two payments onto one
`(companyId, checkNumber)` cheque. Memo-numbered cheques (`PCF26-00001`) still hide behind MISSING.
```

- [ ] **Step 2:** Commit: `git add CLAUDE.md` then `git commit -m "docs: NUMBERING counts dotted re-uses as STAGED; never strip the dot at import"`.
