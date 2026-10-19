# PORTAL RELEASES — checks released on the Supplier Portal, read back into Check Monitoring

Date: 2026-10-19. User decision: *"from now on we will start releasing on the portal, we will not
manually recorded checks"*; *"RELEASE MEANS CHECKS ALREADY RELEASE ONLY TO THE VENDOR"*; plan reading
releases (date and OR) back from the Supplier Portal into Check Monitoring, and update rules 5 and 12
to match.

## Why

Finance will hand checks to vendors and record the release **on the Supplier Portal**. Today Check
Monitoring never reads from the portal (rule 12), so a check released there would stay SIGNATURE
PENDING, SIGNED or READY here — the drift that put paid checks on AGING (2026-10-16). The register
file (CHECK MONITORING …xlsx) stops being the source of releases.

## Decisions (user, 2026-10-19)

1. **The portal's release is the record.** A release means the check was handed to the vendor.
2. **Check Monitoring's RELEASE buttons stay, as a backup** (exceptions, e.g. INTERNAL checks the
   portal never sees). Both directions exist; each side ignores its own echo.
3. **A portal release applies to any live check here** — GENERATED, SIGNATURE_PENDING, SIGNED,
   READY_FOR_RELEASE or SCHEDULED all become RELEASED. A check CANCELLED or VOIDED here is **never**
   released automatically; it is listed for Finance.

## Rule changes (CLAUDE.md and code)

- **Rule 5** (was: *The portal may never mark a check RELEASED*) becomes: **A check is released where
  it is handed over: on the Supplier Portal, read back here by the PORTAL RELEASES read; or, as a
  backup, by Finance in this app. The portal's release is the record. Nothing else from the portal
  changes a check.**
- **Rule 12** (was: *The portal client sends only*) becomes: **The portal client sends events. The
  PORTAL RELEASES read is the one thing read back from the portal, and it only ever moves a live check
  to RELEASED — never cancels, voids, un-releases or edits anything else.** `lib/integrations/portal/
  client.ts` keeps its one sending method; the reader is a separate module.

## Supplier Portal side — a read-only endpoint

`GET /api/integrations/check-monitoring/releases?since=<ISO instant>&limit=<n ≤ 1000>`

- **Auth:** `requireServiceToken(pool, { envName: 'CHECK_MONITORING_TOKEN', username:
  'check-monitoring' })`, the guard the existing events endpoint uses. Read-only: no write in the
  handler.
- **Returns** every row of `check_release` (domain `LOCAL`) and `broker_check_release` (domain
  `BROKER`) with `status = 'RELEASED'` and `updated_at > since`, ordered by `updated_at, id`, at most
  `limit`, plus `next` = the last row's `updated_at` (null when the page is not full):
  `{ domain, releaseId, checkNumber, apvNumbers[] (the trade's / transaction's APV), releaseDate
  (date), releasedAt (instant), orNumber, orDate, releasedByName, releasedByService (true when
  released_by is the check-monitoring service user) }`.
- No portal schema change. Built in the Supplier Portal repository; its own tests.

## Check Monitoring side — the PORTAL RELEASES read

`lib/integrations/portal/releases.ts` (the HTTP read, a pure mapper) and `lib/sync/portal-releases.ts`
(the run), with `SyncRun.mode = 'PORTAL_RELEASES'` and its own watermark (the last `next`, minus a
10-minute overlap). Added to `NON_PAYMENT_MODES` so payment readers ignore it.

**When it runs:** after the payment, BILLS and BILL_REFS reads in the 12:00 and 18:00 cron
(`app/api/cron/sync/route.ts`), within the existing time budget (a skipped run records
`SKIPPED_TIME_BUDGET`, like BILL_REFS); and on SYNC NOW. It needs `PORTAL_BASE_URL` / `PORTAL_TOKEN`
(already set for the outbox); unset → recorded as skipped, never an error.

**Per row:**
1. **Skip the echo:** `releasedByService = true` — a release this app itself sent.
2. **Match** on check number (canonical, `canonicalCheckNumber`) **and** APV: the one check here
   whose number matches and whose `apvNumbers` share an APV with the row. None → listed `NOT_FOUND`;
   more than one → listed `AMBIGUOUS`. (Numbers are reused — 1791379613, 2026-10-19 — so the number
   alone is never enough.)
3. **Decide:**
   - already RELEASED here → nothing (counted);
   - CANCELLED or VOIDED here → nothing; listed `DEAD_HERE` for Finance;
   - live (GENERATED, SIGNATURE_PENDING, SIGNED, READY_FOR_RELEASE, SCHEDULED) → **release**.
4. **Release**, one transaction per check, conditional on the status it was read in:
   `status = RELEASED`; `releasedAt` = the portal's `releasedAt` (the hand-over instant); when the
   portal has no instant, `statedReleaseDate` = its `releaseDate`; `releasedById` null (a portal
   user is not a user here); `orNumber` / `orDate` from the portal when present, **only if this
   check has no receipt yet** (rule 11: never overwrite a receipt; a receipt goes to the receipt
   columns, never `crNumber`); `receiptType` null (the portal does not record one). One audit row,
   `released_on_supplier_portal`, with the portal release id, domain, release date/instant, OR, and
   `releasedByName`. **No portal outbox event** — the portal already has it (no echo).
5. **Watermark** held when any row's write failed (re-read next run, idempotent).

**Where it shows:** `/admin/sync` lists PORTAL_RELEASES runs (released / already / dead here /
not found / ambiguous counts in the run message, naming up to 10 check numbers per list).
`/admin/portal` gets a small "PORTAL RELEASES NEEDING A LOOK" list (DEAD_HERE, NOT_FOUND, AMBIGUOUS
from the latest runs). A Finance user can then act on each by hand.

**AGING, the list, exports, the DATE RELEASED filter** need no change: a released check leaves AGING
(population SIGNED/READY), and DATE RELEASED reads `releasedAt`, then `statedReleaseDate`.

## Safety

- INTERNAL checks never reach the portal (rule 2 unchanged), so they are only released here.
- Acumatica untouched (rule 3). The sync still never writes status (rule 4) — this read is not the
  Acumatica sync, and its one status write is the one rule 5 now allows.
- Audit rows append-only (rule 7); one per release.
- A run never releases a check whose status changed since it was read (conditional update).
- First run: no watermark → reads from `2026-10-19T00:00:00+08:00` (the day releasing moved to the
  portal), so older portal history is not replayed onto checks reconciled from the register.

## Testing

- Mapper (pure): fields, domain, missing OR/date/instant, the echo flag.
- Run (TEST database, fake portal client): release from each live status; already RELEASED; CANCELLED
  and VOIDED listed, untouched; NOT_FOUND; AMBIGUOUS (same number, two checks, APV decides); echo
  skipped; an existing receipt kept; no portal event queued; watermark moves and is held on failure;
  idempotent re-run; `NON_PAYMENT_MODES` excludes the mode.
- Cron route: runs after BILL_REFS; skipped on time budget; skipped when portal env is unset.
- Portal endpoint (portal repo): auth refused without token; only RELEASED rows; `since`/`limit`/
  `next` paging; both domains.
- `tsc`, `next build`; one end-to-end check on TEST with a stub portal.

## Not in scope

- Reading anything else from the portal (pickup schedules, cancellations, reversals). A portal
  un-release is not mirrored; it shows up only as a difference for a person.
- Retiring Check Monitoring's RELEASE buttons (kept as backup, decision 2).
- Back-filling releases recorded on the portal before 2026-10-19.
