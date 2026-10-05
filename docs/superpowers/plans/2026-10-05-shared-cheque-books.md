# Shared Cheque Books — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One task.

**Goal:** Remove the cheque-book company check (sync and repair) and make NUMBERING treat a book as shared across companies.

**Spec:** section E of `docs/superpowers/specs/2026-10-01-cheque-numbering-and-cancel-guard-design.md`.

## Global Constraints

- Rule 4: no status writes. Acumatica read-only. `writeAudit` is the only audit writer.
- The local `.env` `DATABASE_URL` is PRODUCTION: never run anything under `scripts/`, never start a dev server.
- Amounts are decimal strings; BigInt via the existing `ZERO`/`ONE` constants, no `1n` literals.
- Tests: `node node_modules/vitest/vitest.mjs run <files>`; types: `node node_modules/typescript/bin/tsc --noEmit` (clean); build: `node node_modules/next/dist/bin/next build` (compiles). No `npx`.
- Commit with explicit paths; end the message with a `Co-Authored-By:` trailer naming your model and `<noreply@anthropic.com>`.

### Task 1: drop the company check; NUMBERING over shared books

**Files:** `lib/import/upsert.ts` (~262-277, ~447, ~601), `lib/admin/check-books.ts`, `scripts/backfill-check-books.ts`, `lib/numbering/query.ts`, `CLAUDE.md`. Tests: `tests/import/upsert.test.ts`, `tests/admin/check-books.test.ts`, `tests/numbering/query.test.ts`, plus any test found by `grep -rn "companyMismatch\|checkBookRefused" lib scripts tests`.

1. **`upsertCheck`:** `const checkBook = foundBook` (any company). Delete `checkBookRefused` and its two audit spreads; keep `checkBookChanged`. Rewrite the comment: a cheque book is a bank account shared across companies (spec §E, measured 2026-10-05); Acumatica's CashAccount is the fact.
2. **`lib/admin/check-books.ts`:** remove `companyMismatch` from `CheckBookPlan` and the mismatch branch; drop `companyId` from the selects if now unused. Update the doc comment (no company check; spec §E). **Script:** remove the two mismatch output lines.
3. **`lib/numbering/query.ts`:**
   - The company filter selects BOOKS, not cheques. When `f.companyId` is set and `f.checkBookId` is not, first find the books that company's cheques use:
     ```ts
     const used = await db.check.findMany({
       where: { isCheque: true, companyId: f.companyId, checkBookId: { not: null } },
       select: { checkBookId: true }, distinct: ['checkBookId'],
     })
     const bookIds = used.map((r) => r.checkBookId!)
     ```
     then load cheques with `checkBookId: { in: bookIds }` — all companies. With `f.checkBookId`, load that book whole (company ignored for the cheque query). With neither, all books. Staged rows join books by code restricted to the same book set (`id: { in: bookIds }`, or `id: f.checkBookId`).
   - Select each cheque's `company: { select: { code: true } }`. `NumberingAccount.company` = the distinct cheque company codes in the series, ordered by cheque count descending then code, joined `", "`; `""` when the series has no cheques. Drop the book's own company from selects and groups if no longer used.
   - Keep the result order (book code, then id).
4. **`CLAUDE.md`:**
   - In the data-facts bullet "Acumatica's `CashAccount` column is the CHEQUE BOOK…", replace "(company-checked: a book under another company is reported, never set)" and the sentence "The sync applies the same company check as the repair: … in the import audit row." with: "A cheque book is a bank account shared across companies — the register itself filed STK, A1+, HAMFI and IND cheques under one book — so neither the sync nor the repair checks the book's company (user ruling 2026-10-05, spec §E)."
   - Replace "What is missing" item 11 with: "11. **Closed 2026-10-05:** cheque books are shared across companies (spec §E); `CheckBook.companyId` is reference data nothing decides on."
   - In the NUMBERING paragraph under "Things that will catch you out", add: "A series holds every company's cheques in that book; the company filter selects the books a company uses and shows them whole."
5. **Tests:**
   - `tests/import/upsert.test.ts`: the cross-company cases now expect the book set on create and moved on update (with `checkBookChanged`, without any `checkBookRefused` key).
   - `tests/admin/check-books.test.ts`: the former mismatch cheque is a candidate (the expected `candidates` list grows; no `companyMismatch` field).
   - `tests/numbering/query.test.ts`: add (a) one book holding cheques of company X (2 cheques) and Y (1) gives one series whose `company` is `"X, Y"`; (b) `{ companyId: Y }` returns that whole book with all 3 cheques, and no MISSING line between consecutive numbers held by X and Y; (c) a book holding only X's cheques is absent under `{ companyId: Y }`. Update existing cases whose `company` expectation was the book's own company.
6. Run the pure tests (`tests/integrations/acumatica-map.test.ts tests/export/numbering-workbook.test.ts tests/numbering/series.test.ts tests/numbering-view.test.ts`), `tsc`, and the build. **The DB-backed tests (upsert, check-books, numbering query and route) are run by the controller** once the shared test database is free.
7. Commit: `fix(books): a cheque book is shared across companies - drop the company check; NUMBERING over shared books`.
