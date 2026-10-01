# Cheque numbering report, and no CANCELLED event the portal cannot match

**Date:** 2026-10-01
**Request:** two CANCELLED events parked on `/admin/portal` (`6000354350`, `1791259553`) with
*"has no APV numbers; the portal requires at least one"*. Asked why, then: "for the voided checks
can we also import them for recording purposes? Because we are checking the check consecutives."
Then: "yes, do both — the numbering report and the guard".
**Status:** design approved in conversation, 2026-10-01. Gap rule chosen by the user: **every
number counts**. Placement chosen: **a new top tab**.

Two independent parts, built and shipped in this order: **A. the guard**, **B. the report**.
Neither depends on the other.

## Why

- **Voided cheques are already imported.** The payment feed carries `Payment` rows with status
  `Voided` and their `Voided Payment` reversals (`IMPORTED_DOC_TYPES`,
  `lib/integrations/acumatica/map.ts`); the pair is folded into one cheque keeping its original
  amount, and a cheque new to this system is created and then voided in the same transaction
  (`applyVoid`, `lib/import/upsert.ts`). Scope is the sync's: `PaymentDate >= 2026` and
  `PaymentMethod = CHK`. Nothing about ingestion changes here.
- **What Finance cannot do is check the consecutives.** No screen orders cheques by number within
  an account. NEEDS ACTION hides VOIDED; ALL CHECKS mixes every account, and hides a voided cheque
  with no amount behind `?incomplete=1`.
- **The same path parks portal events nobody can deliver.** `voidCheck` and `cancelCheck` queue a
  CANCELLED `PortalEvent` for every portal-routed cheque. The delivery client refuses an event
  with no APV before sending it (`lib/integrations/portal/client.ts`) because the portal matches on
  APV — and every cheque generated since 9 September carries no APV until it is linked. A cheque
  the sync creates already voided is the plainest case: the portal was never told it existed and
  cannot be told it is gone. RETRY rebuilds the body from the cheque and parks it again.

---

## A. The guard

### A1. The rule

`voidCheck` and `cancelCheck` (`lib/domain/actions.ts`) queue a CANCELLED event only when the
cheque is **portal-routed and has at least one APV**. Without an APV:

- no `PortalEvent` is written;
- `portalSyncStatus = NOT_APPLICABLE` (it is `PENDING` today on a routed cheque);
- `portalDomain` is still written from the route, exactly as now, so the eligibility record is
  unchanged;
- the existing `voided` / `cancelled` (and `voided_after_release`) audit row gains
  `portalNotified: false, portalSkipReason: 'no APV numbers'` in `details`. A routed cheque that
  did queue gets `portalNotified: true`. An INTERNAL cheque gets neither key — nothing was
  skipped.

"Has an APV" means what the delivery client means: `apvNumbers` if non-empty, else the cheque's
`CheckBill.apvNumber`s. That fallback moves into one exported helper,
`portalApvs(check: { apvNumbers: string[]; bills: { apvNumber: string }[] }): string[]` in
`lib/integrations/portal/apvs.ts`, used by the client's body builder and by both actions, so the
guard and the delivery check cannot disagree. `load()` in `actions.ts` therefore needs the bills'
`apvNumber` for these two actions.

The other event kinds (MARK_AVAILABLE, RELEASED, REVERT, RELEASE_REVERSED) are **not** guarded
here. A parked MARK_AVAILABLE is a cheque Finance is about to hand over and someone should see it;
a CANCELLED for a cheque the portal cannot match is noise.

**Why not later linking:** spec `2026-10-01-signing-schedule-apv-and-table-design.md` B1 links
vouchers only to **live** cheques (`judgeLink` ignores voided), so a cheque voided with no APV
does not acquire one afterwards; there is no event to send late. A cheque *cancelled* without an
APV is likewise terminal. If it ever matters, the outbox can be fed by a later step; nothing here
prevents it.

### A2. The two already parked

`scripts/close-unmatchable-cancelled.ts` (logic in `lib/admin/unmatchable-cancelled.ts`):

- **Selects** `PortalEvent` rows with `kind = CANCELLED`, `status = PARKED`, whose cheque has no
  APV by `portalApvs`. Nothing else — a parked CANCELLED that does carry an APV parked for some
  other reason and is left for a human.
- **Dry run by default**: prints cheque number, payee, event id, attempts, last error.
- **`--apply`**: writes a JSON snapshot of every selected event and its cheque's
  `portalSyncStatus` to `snapshots/` first; then, per event, in one transaction, conditional on
  the row still being PARKED: `status = SYNCED`, `lastError = 'unmatchable: no APV numbers'` —
  closed unsent, the same convention as `superseded by …` and `stale: …` — the cheque's
  `portalSyncStatus = NOT_APPLICABLE`, and one `portal_event_closed_unmatchable` audit row
  (`details: { eventId, kind, attempts, lastError }`). Idempotent: a second run selects nothing.
- `/admin/portal`'s outbox line (`lib/admin/portal-overview.ts`) counts `unmatchable: …` as its
  own figure, **N closed as unmatchable**, subtracted from delivered the same way superseded and
  stale are.

### A tests

- `actions` (void and cancel): routed with APV → event queued, `PENDING`, `portalNotified: true`;
  routed with no APV and no bills → no event, `NOT_APPLICABLE`, `portalNotified: false`; routed
  with no `apvNumbers` but a bill → event queued; INTERNAL → unchanged.
- `import/upsert`: a cheque created already voided with no APV queues nothing.
- `integrations/portal-client`: still uses `portalApvs` (existing cases stay green).
- `admin/unmatchable-cancelled`: selects only PARKED CANCELLED with no APV; apply closes,
  audits, sets the cheque; second run is a no-op; a row no longer PARKED is not touched.
- `admin/portal-overview`: the unmatchable count.

---

## B. The numbering report

### B1. Population

Every `Check` with `isCheque = true` and a `cashAccountId`, **of every status** — VOIDED,
CANCELLED, RELEASED, and cheques with no amount (`isIncomplete`) included, because the number was
used whatever happened to it.

- **The series key is the cash account.** Acumatica publishes no cheque book (`checkBookCode` is
  always null from the sync); the cash account is the one per-account fact every synced cheque
  carries. A register-only cheque with no cash account is not in any series; the page states how
  many there are, as a count with no link (the dashboard has no "no cash account" filter, and
  adding one is out of scope).
- **Numeric only.** `checkNumber` is canonical (`canonicalCheckNumber`), so a bank prefix is
  already gone. A number that is all digits is placed in the sequence, compared as `BigInt` (they
  run to ten digits and beyond; string order would put `999` after `1000`). Anything else is
  listed under **NOT NUMERIC** for that account and is not in the sequence.
- **Company filter**: the existing company dropdown values; narrows which accounts are listed.

### B2. The rule — every number counts

Within one cash account, sort the numeric cheques ascending. Every whole number strictly between
the lowest and the highest held number that no cheque holds is **MISSING**. Consecutive missing
numbers are reported as **one line** — first, last, count — never one row each, because a jump
between booklets can be millions of numbers.

- Two cheques on the same number within one account (possible: `@@unique` is
  `[companyId, checkNumber]`, and a cheque's `companyId` is not constrained to its cash account's
  company) are both shown, flagged **DUPLICATE NUMBER**, and count once as held. Not an error; a
  fact to look at.
- Before the lowest held number and after the highest, nothing is inferred.
- **The scope boundary is printed on the page and in the file**: the sync reads payments from
  2026 onward, so the first number of an account may sit partway through a booklet and earlier
  numbers are not known here. Likewise a cheque Acumatica holds with a memo instead of a number
  is on `/admin/staged`, not here — its number may be one of the MISSING.

Pure function, no database: `buildSeries(cheques: SeriesCheque[]): AccountSeries` in
`lib/numbering/series.ts`, returning ordered entries
`{ kind: 'CHEQUE', cheque } | { kind: 'MISSING', from, to, count }`, plus `notNumeric`,
`duplicates`, and a summary `{ first, last, held, voided, cancelled, missingNumbers, missingRuns,
notNumeric }`. Arithmetic is `BigInt` inside the function; every number and count leaves it as a
decimal string, so nothing downstream does arithmetic on a JS number.

Query: `lib/numbering/query.ts` — one `findMany` per request selecting `id, checkNumber,
checkDate, payeeName, amount, status, cashAccount { id, code, bank.code, company.code }`, ordered
by cash account. ~12,000 rows; loaded whole, grouped in memory.

### B3. Screen — `/numbering`

A new module in `lib/module-nav.ts`, **NUMBERING**, between RECON and ADMINISTRATION,
`adminOnly: false`. Page guarded by `requireUser()` like `/recon`.

- **Summary (no `account`)**: one row per cash account — ACCOUNT, BANK, COMPANY, FIRST, LAST,
  HELD, VOIDED, CANCELLED, **MISSING** (numbers, and runs in brackets), NOT NUMERIC. The account
  links to its detail. Above it the company filter and the count of cheques with no cash account.
  Sorted by account code.
- **One account (`?account=<cashAccountId>`)**: every entry in number order — NUMBER, DATE,
  PAYEE, AMOUNT, STATUS (the existing `StatusPill`), each cheque linked to `/checks/[id]` — with
  each MISSING run as a full-width highlighted line `6000354301 – 6000354349 · MISSING · 49`.
  A **MISSING ONLY** toggle (`?missing=1`) shows just the gaps. NOT NUMERIC and DUPLICATE NUMBER
  sections follow the table when non-empty. BACK TO ALL ACCOUNTS keeps the company filter.
- An unknown `account` id is a 404 text state on the page, not a widened view.
- Amounts are rendered from the decimal string; no total is shown (the report is about numbers,
  and a total over VOIDED and CANCELLED cheques would be read as money).

### B4. Export — `/api/export/numbering`

Same parameters (`company`, `account`, `missing`), session-guarded like `/api/export/recon`.

- **SUMMARY** sheet: the summary table plus the scope note.
- **One sheet per account** (only the open account when `account` is set; all listed accounts
  otherwise), named by account code (sanitised to Excel's 31-character, no-`[]:*?/\` rule; a
  collision gets a numeric suffix): the entries as on screen, MISSING lines with FROM, TO, COUNT
  in their own columns and the row styled, so a filter on STATUS = MISSING works.
- Cheque numbers written as **text** cells (ten-digit numbers lose nothing, but a leading zero
  would). Amounts as the existing decimal handling in `lib/export/sheet-style.ts` /
  `recon-workbook.ts` does.
- Filename `CHEQUE NUMBERING <Manila date>.xlsx`.

### B tests

- `numbering/series` (pure): consecutive run; one gap; a large gap is one line with the right
  count; adjacent gaps around a single cheque; duplicate number; non-numeric excluded; ten-digit
  and mixed-length numbers ordered numerically; single cheque (no gaps); empty account.
- `numbering/query`: includes VOIDED, CANCELLED, incomplete; excludes `isCheque = false` and no
  cash account (counted); company filter.
- `numbering-view` (URL → state): `account`, `missing`, company; unknown account.
- `export/numbering-workbook`: sheets, names sanitised and de-duplicated, MISSING row columns,
  numbers as text.
- `export/numbering-route`: unauthenticated refused; parameters honoured.
- `module-nav` +1.

---

## Out of scope

- Ingesting anything new. Pre-2026 cheques, non-CHK payments and memo-numbered cheques stay as
  they are; the report states the boundary instead.
- Booklet ranges typed by Finance, or a booklet-size heuristic. Rejected in conversation for
  "every number counts"; either can be added later as a narrowing of the MISSING lines.
- Guarding event kinds other than CANCELLED.
- Recording an explanation against a MISSING number (spoiled form, etc.). Worth having once
  Finance has worked the list once and knows what the explanations are.
