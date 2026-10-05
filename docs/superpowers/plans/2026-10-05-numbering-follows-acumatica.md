# NUMBERING Follows Acumatica — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Realign cheque books to Acumatica's (repair), show only Acumatica cheques on NUMBERING, and add a TO FIX IN ACUMATICA sheet to its Excel export.

**Spec:** section G at the end of `docs/superpowers/specs/2026-10-01-cheque-numbering-and-cancel-guard-design.md` — the exact rules, names and copy.

## Global Constraints

- Rule 4: no status writes. Acumatica read-only. `writeAudit` is the only audit writer.
- The local `.env` `DATABASE_URL` is PRODUCTION: never run anything under `scripts/` (write them only), never start a dev server.
- Long write loops use `TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 }`. Snapshot before the first write.
- Scripts print counts and codes only — never amounts or payees.
- Amounts are decimal strings; BigInt via `ZERO`/`ONE`, no `1n` literals.
- Tests: `node node_modules/vitest/vitest.mjs run <files>`; `node node_modules/typescript/bin/tsc --noEmit` clean; `node node_modules/next/dist/bin/next build` compiles. No `npx`.
- Commit with explicit paths; `Co-Authored-By:` trailer naming your model and `<noreply@anthropic.com>`.

### Task 1: realign cheque books to Acumatica (spec §G1)

**Files:** `lib/admin/check-books.ts`, `scripts/backfill-check-books.ts`, `tests/admin/check-books.test.ts`.

- `CheckBookPlan` gains `realign: CheckBookRealign[]` and `clear: CheckBookRealign[]`, where `CheckBookRealign = { checkId; checkNumber; acumaticaPaymentId; fromCheckBookId: string; fromCode: string; toCheckBookId: string | null; code: string }`. The plan's cheque query also selects cheques with a book (`checkBookId` not null) for the tenant and payment id; when the feed's code differs from the cheque's book code → `realign` (code is a book) or `clear` (code is not a book). A feed row with no CashAccount, or a payment not in the feed, leaves a booked cheque alone.
- Export `CHECK_BOOK_REALIGN_ACTION = 'check_book_realigned_to_acumatica'` and `applyCheckBookRealign(db, rows): Promise<number>`: per row, one `$transaction` with `TX_OPTIONS`; `updateMany({ where: { id, checkBookId: fromCheckBookId }, data: { checkBookId: toCheckBookId } })`; when it hit, one SYSTEM audit row `{ from: fromCode, to: toCheckBookId ? code : null, code, acumaticaPaymentId }`.
- Script: print `would realign: N` (by `fromCode -> code`) and `would clear: N` (by code); with `--apply`, the snapshot JSON gains `realign` and `clear`, then fill, realign, clear; print each count set.
- Tests: realign moves the book and writes the audit row; a non-book code clears it; a cheque whose book changed after planning is untouched; an agreeing cheque is in neither list; the existing fill cases still pass; status unchanged.
- Commit: `feat(admin): backfill-check-books realigns cheque books to Acumatica's`.

### Task 2: NUMBERING shows only Acumatica cheques; TO FIX IN ACUMATICA (spec §G2, §G3)

**Files:** `lib/numbering/series.ts`, `lib/numbering/query.ts`, `lib/numbering-view.ts`, `lib/export/numbering-workbook.ts`, `app/numbering/page.tsx`, `app/api/export/numbering/route.ts`, `CLAUDE.md`; tests `tests/numbering/series.test.ts`, `tests/numbering/query.test.ts`, `tests/export/numbering-workbook.test.ts`, `tests/export/numbering-route.test.ts`.

- `SeriesCheque` gains `cv: string | null`; the query fills it from `acumaticaPaymentId`. Update every fixture that builds a `SeriesCheque`.
- `lib/numbering/series.ts`: `export const STRAY_GAP = BigInt(10000)` (no literal suffix) and `export function strayEnds(series: AccountSeries): { cheque: SeriesCheque | null; staged: SeriesStaged | null; reason: string }[]` per §G3 (in-pattern CHEQUE and STAGED entries only, from each end inward while the gap to the next in-pattern number exceeds `STRAY_GAP`, at most 3 per end; reason strings exactly as §G3 with the gap as a decimal string).
- `lib/numbering/query.ts`: every cheque query and the company book-selection add `acumaticaPaymentId: { not: null }`; `countChequesWithoutCheckBook` adds it too; new `countRegisterOnlyCheques(db, { companyId? })`.
- Page (summary view) and route: load `countRegisterOnlyCheques` (with the scoped company, as the no-book count) and show `N REGISTER-ONLY CHEQUE(S) (NOT IN ACUMATICA) ARE NOT SHOWN.` beneath the no-book line. `NumberingMeta` gains `registerOnlyCount: number | null` (null in the one-book export), printed on SUMMARY A4 after the no-book sentence.
- `NUMBERING_SCOPE_NOTE`: replace "Each series is one cheque book — the bank account Acumatica names in its CashAccount column (e.g. BPI-S-4636)." with "Each series is one cheque book, built from Acumatica's own cheque numbers and cash accounts (e.g. BPI-S-4636); cheques that exist only in the old register are not shown."
- Workbook: sheet `TO FIX IN ACUMATICA` right after SUMMARY with header CHEQUE BOOK, CHECK NUMBER, CV, CHEQUE DATE, PAYEE, STATUS, REASON; rows = for each account, every `outOfPattern` entry (reason `OUT OF PATTERN — expected {digits} digits starting {lead}`) then `strayEnds`; cheque numbers as text; staged rows use `statedCheckRef`, their CV, status `STAGED`; auto-filter over the rows; sheet name reserved in the de-duplication set. Not limited by `rowLimit` (it is a short list) and written even under MISSING ONLY.
- Tests: `strayEnds` (first and last beyond 10,000; inward up to 3; none when gaps are small; ignores out-of-pattern); query excludes and counts register-only cheques, and company book selection ignores them; workbook TO FIX sheet rows/reasons/CV and the A4 register-only sentence; route test fixtures give cheques an `acumaticaPaymentId` (and tenant) so they still appear.
- `CLAUDE.md` NUMBERING paragraph: add "Since 2026-10-05 (spec §G) only Acumatica cheques are shown (register-only cheques are a stated count), every Acumatica cheque's book is Acumatica's (`backfill-check-books.ts` realigns), and the Excel has a TO FIX IN ACUMATICA sheet — the OUT OF PATTERN cheques and each book's stray ends (> 10,000 from the next number) with their CV."
- Commit: `feat(numbering): Acumatica cheques only; TO FIX IN ACUMATICA sheet`.
