# NUMBERING: OUT OF PATTERN — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One task.

**Goal:** Numbers that do not match their cheque book's usual shape leave the MISSING calculation and are listed in an OUT OF PATTERN section (page and Excel).

**Spec:** section F at the end of `docs/superpowers/specs/2026-10-01-cheque-numbering-and-cancel-guard-design.md`.

## Global Constraints

- Nothing is written to the database. Read-only report change.
- BigInt via the existing `ZERO`/`ONE` constants in `lib/numbering/series.ts` — **no `1n`-style literals** (they break `next build`).
- Amounts are decimal strings; `Number(amount)` only in an Excel cell.
- The local `.env` `DATABASE_URL` is PRODUCTION: never run anything under `scripts/`, never start a dev server.
- Tests: `node node_modules/vitest/vitest.mjs run <files>`; types: `node node_modules/typescript/bin/tsc --noEmit` (clean); build: `node node_modules/next/dist/bin/next build` (compiles). No `npx`.
- Commit with explicit paths; end the message with a `Co-Authored-By:` trailer naming your model and `<noreply@anthropic.com>`.

### Task 1: OUT OF PATTERN, end to end

**Files:** `lib/numbering/series.ts`, `components/NumberingTables.tsx`, `app/numbering/page.tsx`, `lib/export/numbering-workbook.ts`, `lib/numbering-view.ts` (scope note), `CLAUDE.md`. Tests: `tests/numbering/series.test.ts`, `tests/export/numbering-workbook.test.ts`, `tests/numbering-view.test.ts` if it pins the scope note.

1. **`lib/numbering/series.ts`** — implement spec §F1 exactly:
   - `export const PATTERN_MIN_CHEQUES = 20`.
   - `export function numberShape(n: string): { digits: number; lead: string }` — strip leading zeros, `digits` = remaining length, `lead` = first two remaining characters.
   - Pattern = the shape held by the most numeric CHEQUES (staged lines do not vote); ties → more `digits`, then `lead` ascending. `null` when fewer than `PATTERN_MIN_CHEQUES` numeric cheques.
   - When a pattern exists, any numeric cheque or qualifying staged line whose shape differs goes to `outOfPattern` (as `SeriesEntry` objects of kind CHEQUE / STAGED, in BigInt-then-order sequence) and is excluded from the gap walk, `first`/`last`, `held`, `duplicates` and `staged`. Out-of-pattern cheques still count toward `voided` / `cancelled` (they are real cheques in the book).
   - `AccountSeries` gains `outOfPattern: SeriesEntry[]` and `pattern: { digits: number; lead: string } | null`; `SeriesSummary` gains `outOfPattern: number`.
   - Update the doc comment (spec §F).
2. **`components/NumberingTables.tsx`:** summary table gains an OUT OF PATTERN column after NOT NUMERIC. Add `OutOfPatternTable({ entries })` rendering CHEQUE entries with the existing `ChequeRow` and STAGED entries with the existing `StagedRow`.
3. **`app/numbering/page.tsx`:** for one book, when `!missingOnly && one.series.outOfPattern.length > 0`, after the NOT NUMERIC section: heading `OUT OF PATTERN — NOT IN THE SEQUENCE`, a line `This cheque book's numbers are {digits} digits starting {lead}; these are not. Usually a mistyped or misfiled number in Acumatica.`, then `OutOfPatternTable`.
4. **`lib/export/numbering-workbook.ts`:** SUMMARY gains `OUT OF PATTERN` after `NOT NUMERIC` (extend values and widths). On each account sheet, when not `missingOnly`, after the NOT NUMERIC rows write the out-of-pattern entries (cheques via `chequeRow`, staged via `stagedRow`) with NOTE `OUT OF PATTERN (expected {digits} digits starting {lead})`. Count them in `totalLines` and the row budget like the NOT NUMERIC rows.
5. **`lib/numbering-view.ts`:** append to `NUMBERING_SCOPE_NOTE`: ` A number that does not match its book's usual length and first digits is listed as OUT OF PATTERN — usually a mistyped or misfiled cheque number in Acumatica — and left out of the gap count.` Update any test pinning the note.
6. **Tests** (`tests/numbering/series.test.ts`; generate fixtures with a loop, e.g. 25 cheques `6000100000`..`6000100024`):
   - fewer than 20 numeric cheques → `pattern` null, `outOfPattern` empty, behaviour unchanged;
   - 25 ten-digit `60…` cheques plus `60000` and `1791361374` → both in `outOfPattern`, `summary.outOfPattern` 2, `last` is the highest `60…` number, no MISSING line reaches 1791… or 60000;
   - six-digit `17…` cheques (25) plus `0000179241` → in pattern, placed at 179241;
   - a staged `1791361374.` in a `60…` book → in `outOfPattern` (kind STAGED), `summary.staged` excludes it;
   - an out-of-pattern VOIDED cheque still counts in `summary.voided`;
   - `numberShape('0000179241')` → `{ digits: 6, lead: '17' }`; `numberShape('0000')` → `{ digits: 0, lead: '' }`.
   - `tests/export/numbering-workbook.test.ts`: an account with 25 in-pattern cheques and one out-of-pattern cheque writes it with the OUT OF PATTERN note; SUMMARY has the column with value 1.
7. **`CLAUDE.md`:** in the NUMBERING paragraph under "Things that will catch you out", add: "A number whose shape (digits without leading zeros, first two digits) differs from its book's usual one is OUT OF PATTERN — listed separately and left out of the gap count — once the book has 20+ numeric cheques (spec §F, 2026-10-05; measured ~100 such Acumatica cheques, e.g. `60003162116`, `17913405552`, `1791…` numbers under BPI books)."
8. Run `tests/numbering/series.test.ts tests/export/numbering-workbook.test.ts tests/numbering-view.test.ts` (pure), `tsc`, `next build`. The DB-backed `tests/numbering/query.test.ts` and `tests/export/numbering-route.test.ts` are run by the controller.
9. Commit: `feat(numbering): OUT OF PATTERN - numbers that break their book's shape leave the gap count`.
