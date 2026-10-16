# Acumatica Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A register (WORKBOOK) row can no longer overwrite Acumatica-owned fields on a check Acumatica holds; each refused value is audited and counted.

**Architecture:** Two new field lists in `lib/import/upsert.ts` partition `IMPORT_WRITABLE`. A pure function in `lib/import/acumatica-wins.ts` compares the stored and offered values. `upsertCheck`'s update branch deletes the owned keys from its update data when the row is a register row and the check has `acumaticaPaymentId`, skips the company-refile audit, and writes one `register_value_refused` audit row. `importRows` counts rows with refusals; `/admin/import` and `scripts/import-workbook.ts` show the count.

**Tech Stack:** TypeScript strict, Prisma 6, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-acumatica-wins-design.md`

## Global Constraints

- Held = `existing.acumaticaPaymentId !== null`. Guard applies only to `row.source === 'WORKBOOK'` UPDATES.
- Amounts are compared and recorded as decimal strings (`Prisma.Decimal`), never JS numbers (rule 8).
- Nothing throws on a disagreement.
- No migration.
- Tests: `node node_modules/vitest/vitest.mjs run tests/import/upsert.test.ts tests/import/acumatica-wins.test.ts` from Git Bash; the TEST database is shared, so tell other sessions before running. Typecheck `node node_modules/typescript/bin/tsc --noEmit`; build `node node_modules/next/dist/bin/next build`.
- Spell "check".

---

### Task 1: Field lists and the pure comparison

**Files:** Create `lib/import/acumatica-wins.ts`, `tests/import/acumatica-wins.test.ts`. Modify `lib/import/upsert.ts` (after `IMPORT_WRITABLE`).

**Produces:**
- `ACUMATICA_OWNED`, `REGISTER_MAY_WRITE_ON_HELD` (readonly tuples of `IMPORT_WRITABLE` members), `ACUMATICA_WINS_BASIS` — in `upsert.ts`.
- `type HeldValues = { amount: string | null; checkDate: Date | null; payeeName: string | null; currency: string | null; cvNumber: string | null; isCheque: boolean; companyCode: string | null; cashAccountCode: string | null; checkBookCode: string | null }`
- `type Refused = Partial<Record<'amount' | 'checkDate' | 'payeeName' | 'currency' | 'cvNumber' | 'isCheque' | 'companyId' | 'cashAccountId' | 'checkBookId', { kept: string | null; offered: string }>>`
- `refusedRegisterValues(kept: HeldValues, offered: HeldValues): Refused` — an offered null is not a disagreement; amounts compared as decimals; dates as ISO days; booleans as 'true'/'false'.

- [ ] Write `tests/import/acumatica-wins.test.ts` (pure: equal values → `{}`; null offered → nothing; differing amount `197715.42` vs `27037.94` → `{ amount: { kept: '197715.42', offered: '27037.94' } }`; `100.5` vs `100.50` → equal; date compared by day; company/account/book by code; `isCheque`), run it red, implement, run green.
- [ ] Add the two lists and the basis to `upsert.ts`; extend the exhaustiveness test in `tests/import/upsert.test.ts` with: `ACUMATICA_OWNED` ∪ `REGISTER_MAY_WRITE_ON_HELD` equals `IMPORT_WRITABLE` and they are disjoint.
- [ ] Commit.

### Task 2: The guard in `upsertCheck`

**Files:** Modify `lib/import/upsert.ts` (update branch), `tests/import/upsert.test.ts`.

- [ ] Tests (new `describe('upsertCheck — Acumatica wins over the register')`), each seeding an Acumatica-held check by upserting `row({ source: 'ACUMATICA', acumaticaPaymentId: 'CV-ST-004112', apvNumbers: [], sourceSheet: null, sourceRow: null, receiptRef: null })` first:
  1. register row with amount `27037.94`, check date `2026-02-01`, payee `SOMEONE ELSE`, company `A1` (seeded second company): stored amount, date, payee, company unchanged; `apvNumbers` contains `APV-ST-009911`; one `register_value_refused` audit with `refused` keys `amount, checkDate, payeeName, companyId` and `basis = ACUMATICA_WINS_BASIS`; no `check_company_corrected` row; result `{ outcome: 'UPDATED', refusedFields: 4 }`.
  2. register row with `amount: null` and every other value equal: no `register_value_refused` row, `refusedFields: 0`.
  3. register row on a register-only check (no Acumatica seed, create by register then update amount): amount changes.
  4. Acumatica row updating amount on the held check: amount changes.
  5. register row whose payee would classify INTERNAL (`payeeName: 'STARKSON PACKAGING INC.'`): `eligibility` unchanged.
- [ ] Implement: `const held = row.source === 'WORKBOOK' && existing.acumaticaPaymentId !== null`; when held, load the stored codes (`tx.check.findUniqueOrThrow({ where: { id: existing.id }, select: { company: { select: { code: true } }, cashAccount: { select: { code: true } }, checkBook: { select: { code: true } } } })`) and compute `refused`; skip the `misfiled` audit when held; build the update data as a `Prisma.CheckUncheckedUpdateInput` const and `delete data[f]` for each `f` of `ACUMATICA_OWNED` when held; record `eligibility` in `import_updated` as `existing.eligibility` when held; after the update, write `register_value_refused` when `refused` is non-empty; return `{ outcome: 'UPDATED', checkId, refusedFields }`. `UpsertResult`'s UPDATED gains `refusedFields: number`.
- [ ] Run the whole `upsert.test.ts`; existing tests that rely on a register row overwriting an Acumatica-held check's owned fields now fail BY DESIGN — rewrite each to state the new rule, and list them in the commit message. Commit.

### Task 3: The count

**Files:** `lib/import/upsert.ts` (`ImportSummary`, `importRows`), `components/ImportWorkbookForm.tsx`, `scripts/import-workbook.ts`, `tests/import/upsert.test.ts` (summary `toEqual`s gain `keptAcumatica: 0`; one new case counts 1).

- [ ] `ImportSummary.keptAcumatica: number`; `importRows` increments it when `result.outcome === 'UPDATED' && result.refusedFields > 0`.
- [ ] `ImportWorkbookForm`: under UPDATED in the register summary, when `keptAcumatica > 0`, a line "kept Acumatica's values on N check(s)".
- [ ] `import-workbook.ts`: `line('kept Acumatica values', summary.keptAcumatica)` after `updated`.
- [ ] Tests, commit.

### Task 4: Verify and document

- [ ] Run both test files, tsc, build.
- [ ] CLAUDE.md: "What is missing" item 6 becomes "**Acumatica wins is enforced** (2026-10-16, spec `2026-10-16-acumatica-wins-design.md`): a register row cannot change `ACUMATICA_OWNED` on a check with `acumaticaPaymentId`; refusals are `register_value_refused` audit rows and the import summary's `keptAcumatica`." Commit.
