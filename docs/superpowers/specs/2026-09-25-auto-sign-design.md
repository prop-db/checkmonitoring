# Auto-sign: an Acumatica cheque becomes SIGNED three days after it arrives

**Status:** approved in conversation 2026-09-24/25, awaiting review of this document.

## The rule, as the client stated it

> "all checks generated from acumatica, it will automatically transfer to signed checks 3 days from
> the creation date"

Three decisions settled what that means, all made by the user in conversation:

| Question | Decision |
| --- | --- |
| Which date starts the clock? | **The day the cheque reached the app** — `Check.createdAt`, stamped when the sync first wrote it. Acumatica publishes no creation timestamp; its only date is `PaymentDate` (our `checkDate`), which is post-dated on some cheques. A cheque is physically signed before its date, so the clock runs from generation, not from the printed date. |
| Calendar or working days? | **Calendar days.** Generated Monday, SIGNED Thursday; generated Friday, SIGNED Monday. No holiday list. |
| The cheques already waiting? | **Signed all at once** when the rule goes live — measured 2026-09-24: 373 Acumatica cheques past three days at SIGNATURE_PENDING. |

## What qualifies

A cheque is signed automatically when **all** hold:

1. `status = SIGNATURE_PENDING`. Nothing further up the ladder is touched, and nothing moves down.
2. `acumaticaPaymentId IS NOT NULL` — Acumatica knows it. A cheque only the register ever held is
   not "generated from Acumatica" and waits for a person.
3. `isCheque = true`. DEBIT ADV and CASH are not signed by anyone and never offer a SIGN button;
   `assertReleasable` already refuses them in `markSigned`.
4. `acumaticaStatus` is not `Voided`. A voided payment waits for the sync or a person to settle it.
5. The cheque's Manila calendar day is at or before today's Manila calendar day minus N, N being
   the setting below (default 3). **Manila calendar days, not elapsed time.** A cheque first read a
   few minutes into Monday's 18:00 run is not yet 72 hours old at Thursday's 18:00 run — Vercel fires
   the cron anywhere within the hour, not at the exact minute — so counting elapsed hours would slip
   it to Friday. "Generated Monday, SIGNED Thursday" is a statement about calendar days in a fixed
   timezone (the Philippines, UTC+8, no daylight saving), and `dueBefore` in
   `lib/domain/auto-sign.ts` computes it that way: the first instant (UTC) of the Manila day AFTER
   the one `N` days before today — so a cheque is due when `createdAt` falls strictly before it,
   i.e. its Manila day is today minus `N` or earlier (on 25 Sep with 3 days: 23 Sep 00:00 Manila,
   so 22 Sep and earlier are due).

Pure predicate in `lib/domain/auto-sign.ts` — `isDueForAutoSign(check, now, days)` — no database,
no clock; the caller passes `now`.

## What it writes

Through a new `autoSign(db, { checkId, now, days })` in `lib/domain/actions.ts`, beside `markSigned`,
because that module is the only one that changes a status. Per cheque, in one transaction:

- Re-checks the predicate on the row as loaded; a cheque someone signed or cancelled since the
  candidates were listed is skipped, not overwritten.
- `status = SIGNED`, `signedAt = now` (the moment the system recorded it), **`signedById` null** —
  no person signed it here, and a name on a signature that nobody gave is worse than none.
- One audit row: `actorType SYSTEM`, action **`auto_signed`**, details
  `{ from: 'SIGNATURE_PENDING', to: 'SIGNED', inAppSince: createdAt, afterDays: N }`, remarks stating
  the rule in words.
- **No portal event.** `markSigned` queues none either; the portal learns of a cheque at
  READY_FOR_RELEASE.

Rule 4 is unchanged: `upsertCheck` still never writes `status`. Auto-sign is a separate step that
runs after the sync, not part of it.

## The setting

`autoSign.afterDays` in `lib/settings/registry.ts`, a new group `WORKFLOW`:

- Label **AUTO-SIGN ACUMATICA CHEQUES AFTER**, unit `days`, default **3**, min **0**, max **30**.
- **0 turns auto-signing off.** The run still happens and records that it signed nothing because the
  setting is 0 — a pause needs no deploy.
- Read through `loadSettings` at run time and passed in, like every other threshold. The default
  constant lives in `lib/settings/defaults.ts` as `DEFAULT_AUTO_SIGN_AFTER_DAYS`.

## When it runs

**In the existing daily job**, `/api/cron/sync` at 10:00 UTC (18:00 Manila), **after** both
tenants' syncs:

- It runs **whether or not a sync failed.** Cheques already in the app keep ageing; a failed read
  delays new ones, not old ones.
- `runAutoSign(db, { now, days })` in `lib/sync/auto-sign.ts` lists the candidates in one query, then
  calls `autoSign` for each. `TX_OPTIONS` as elsewhere (30s / 15s).
- The route's JSON gains `autoSign: { outcome, signed, skipped, days, error? }`. **A failed auto-sign
  makes the response 500**, as a failed sync does, so the Vercel cron log shows red.
- No second cron job: the Hobby plan allows it, but it would be a second thing to watch and would not
  run more often.
- **A 50-second time budget**, inside the route's 60-second ceiling (`maxDuration`). `runAutoSign`
  takes an optional `deadline`; the route passes `now + 50s`. Checked before each cheque: past the
  deadline, the run stops, is recorded `FAILED` with an error naming how many cheques are still due,
  and leaves what it already signed standing. The next scheduled run picks up where it left off —
  the candidates are listed fresh every time — so a run cut short by the platform is a delay, not a
  loss.

Expected daily volume is the sync's intake — 110–140 cheques on the GOLIVE tenant on 21–22 September.
From `sin1` to Neon's ap-southeast-1 that fits comfortably inside the function's time limit.

## The record of each run

Each run writes **one audit row with no `checkId`**: action **`auto_sign_run`**, details
`{ outcome: 'OK' | 'DISABLED' | 'FAILED', signed, skipped, days, error? }`. No migration — `AuditLog.checkId`
is already nullable — and a failure is recorded where an auditor looks rather than only in a Vercel
log. `writeAudit` stays the only writer.

`/admin/sync` shows **LAST AUTO-SIGN** under the tenant rows: when, how many signed, and the
outcome, read from the latest `auto_sign_run` row; a FAILED outcome is shown the way a failed sync
run is.

## The backlog, once

`scripts/auto-sign-backlog.ts`, following `scripts/repair-cr-receipts.ts`:

- Dry run by default: counts by `createdAt` month, by company, and the cheques excluded and why.
- `--apply` writes `snapshots/auto-sign-backlog-<ts>.json` (every affected row as it stands), then
  calls the same `runAutoSign` the cron calls — one code path, not two.
- Run by the user before the deploy, so the first scheduled run signs a day's intake rather than
  ~370 at once. If it is skipped, the cron still does the right thing; it is just slower.

## Out of scope

- Working days and holidays.
- Changing who may sign by hand — the SIGN button stays as it is for cheques not yet due.
- Auto-promoting SIGNED to READY_FOR_RELEASE — that remains the for-release list's and Finance's act.
- Register-only cheques (no `acumaticaPaymentId`).

## Tests

- `tests/domain/auto-sign.test.ts` (pure): due at exactly N days, not due one minute before; weekend
  counts; each exclusion (status, no Acumatica id, not a cheque, Voided); N = 0 is never due.
- `tests/actions/auto-sign.test.ts`: moves a due cheque with `signedById` null and one `auto_signed`
  row; refuses a cheque that changed after listing; no `PortalEvent`.
- `tests/sync/auto-sign.test.ts`: `runAutoSign` signs only the due, writes one `auto_sign_run` row,
  records DISABLED at 0, records FAILED and rethrows nothing on error.
- `tests/sync/cron-route.test.ts` (+): auto-sign runs after the syncs, runs when a sync failed, and a
  failed auto-sign turns the response 500.
- `tests/settings/registry.test.ts` (+): the new key, its bounds, its default.
- `tests/import/upsert.test.ts` needs no change: rule 4 still pins that the sync never writes status.
