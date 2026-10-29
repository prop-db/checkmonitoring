# A cancelled check is detached from the AP it was applied to

**Date:** 2026-10-29
**Request:** four notifications — *"Portal event RELEASED for check 6000354974 parked: refused
AP-ST039907: cancelled in the portal; a super must resolve"* (and 6000354975/76/77 on
AP-ST039910/12/00), 26 October 18:39–18:41. Asked what they meant, the user explained: *"The AP
alone are not cancelled. Its the check applied to them before the new payment. They were voided and
replace a new one."* Then the ruling: **"Once the check is cancelled, it should not be connected to
the AP it was applied so we will no longer encounter problem."**
**Status:** built 2026-10-29 on `claude/new-session-63z5ih`. Database tests not run from the
build container (no test database there); `tsc` clean.

## Why

- **The two systems key the same fact differently.** The Supplier Portal keeps ONE release row per
  bill, keyed by APV (`getOrCreateCheckRelease`, spec 2026-09-26 §1.3). This system keeps one
  check per payment and one outbox event per check. A void and re-issue is two checks on one bill.
- **What happened.** Finance voided the old checks in Acumatica and issued 6000354974..77 on the
  same bills. The sync voided the old checks here; `voidCheck` queued a CANCELLED event for each,
  matched on the APV, and the portal's handler (`cancelDirect`) cancelled the BILL's row. The new
  checks' RELEASED events then arrived at a cancelled row and were refused — the portal treats its
  cancellation as terminal and asks for a human. The bill was never cancelled; it moved.
- **Nothing in the code looked at the sibling.** `voidCheck` / `cancelCheck` queued CANCELLED for
  any routed check with an APV (guard of 2026-10-01); the outbox closed an event unsent only when
  its kind contradicted the check's own status (`kindMatchesStatus`).

## The rule

A cancel or void **cuts the check loose from its bills**:

- `detachFromBills` (`lib/domain/actions.ts`), called first by `voidCheck` and `cancelCheck`:
  `apvNumbers` emptied, every `CheckBill` row of the check deleted. **No portal event is queued** —
  there is no APV left to match it on, and the bill now belongs to whichever live check pays it.
  `portalSyncStatus = NOT_APPLICABLE`; `portalDomain` still records the route.
- **The audit row keeps everything.** The `cancelled` / `voided` / `voided_after_release` row
  carries `apvNumbersDetached` and `billsDetached` (the deleted `CheckBill` rows whole, amount as a
  string), plus for a routed check `portalNotified: false, portalSkipReason: 'detached from its AP
  bills on cancel'` (`DETACHED_SKIP_REASON`). Its remark ends *"Detached from AP-…, AP-… (user ruling
  2026-10-29)."* so the trail on the check page says it in words. An INTERNAL check with nothing to
  detach writes no details, as before.
- **Nothing re-links a dead check**, so the detachment holds:
  - the BILLS read (`lib/sync/bills.ts`) skips a CANCELLED or VOIDED check in the unlocked read AND
    under the row lock (a cancel can commit in between). Acumatica still lists a voided payment's
    applications, so without this the next run would put the dead check back on the bill. Counted
    as `cancelledHere` on `BillsRunResult`, printed by `scripts/sync.ts --bills`, and named in the
    run message. Not an error; the watermark moves.
  - `upsertCheck` (`lib/import/upsert.ts`) merges no voucher onto a CANCELLED or VOIDED check (the
    register import is retired, but a seed or re-import must not undo the rule).
  - `matchBills` (`lib/import/bills.ts`, the approval workbook) never matches a CANCELLED or VOIDED
    check, by number or by voucher. A voucher naming a voided check and its live re-issue now
    resolves to the re-issue; a number naming only a dead check stages as `NO_MATCHING_CHECK`.
  - the ready-list upload and `voucher-links.ts` already resolved to live checks only.
- `restoreCancelled` (CANCELLED → SIGNED) re-attaches the vouchers its `cancelled` row says were
  detached, minus any a live or RELEASED check of the company carries now (the bill moved; two live
  checks on one bill is the conflict `/vouchers` refuses). The deleted `CheckBill` rows are not
  rebuilt: the audit row has them, and the workbook and the BILLS read are the live sources.
  `apvNumbersReattached` goes on the `cancellation_restored` row. An Acumatica check with no APV is
  in any case re-linked by the BILLS read's direct lookup on the next run.

## Consequence, accepted with the ruling

**The portal is no longer told about any cancellation**, re-issue or not — including the quiet
INTERNAL CANCELLED of the 2026-10-19 ruling. A bill whose check was cancelled with no replacement
keeps whatever state the portal had for it (available, or released) until somebody there changes
it, which is how the portal worked before the integration. The RELEASED / RELEASE_REVERSED /
MARK_AVAILABLE / REVERT / RECEIPT events are unchanged. `PortalEventKind.CANCELLED` stays in the
enum for the rows already written; `queueCancelledForStale` (`scripts/portal-backlog.ts
--queue-cancelled`) is superseded and must not be run again.

## The checks cancelled before the rule

`scripts/detach-cancelled-apvs.ts` (`lib/admin/detach-cancelled-apvs.ts`): every CANCELLED or VOIDED
check still connected to an AP bill through `apvNumbers` or a `CheckBill` row. Dry run lists them
(check number, status, APVs, open CANCELLED events; no amounts). `--apply` snapshots them to
`snapshots/detach-cancelled-apvs-<timestamp>.json` (checks with their bills, and the open events),
then per check in one transaction: `detachFromBills`, open CANCELLED events (PENDING / FAILED /
PARKED) closed SYNCED with `lastError = 'unmatchable: detached from its AP bills on cancel'` (the
prefix `/admin/portal` counts), `portalSyncStatus = NOT_APPLICABLE`, one `apv_detached_on_cancel`
SYSTEM audit row carrying what was detached. A check no longer cancelled when its turn comes is left
alone. Status is never touched. **Run 2026-10-29 by the user from a Mac, in two passes:** the
first apply was interrupted after a few checks (the script prints nothing while it works, which
read as a hang); the second dry run found 23 left, all VOIDED, and the apply detached 23 of 23,
closed 0 open CANCELLED events, 0 still connected. Snapshots
`snapshots/detach-cancelled-apvs-2026-10-29T08-06-47-676Z.json` and `…T08-14-04-455Z.json`.
Lesson for the next one-off: print a line per row, or at least the count, before the loop.

## The four checks of 26 October

Unchanged by this build. Their RELEASED events stay PARKED until a portal super re-opens the rows
for AP-ST039900, 039907, 039910 and 039912; then RETRY on `/admin/portal` re-sends RELEASED and the
portal applies it. Any receipt typed with those releases is held behind the parked event and follows
on its own. The old voided checks will be detached by the script above.

## Tests

`tests/actions/portal-cancel.test.ts` rewritten (detachment, no event, audit shape, the re-issue
keeps the bill); `tests/admin/detach-cancelled-apvs.test.ts` new; `tests/import/upsert.test.ts`
(void queues nothing, a re-import does not re-link, every test asserts zero portal events);
`tests/sync/bills.test.ts` (a dead check is never linked, counted, named in the message);
`tests/import/bills.test.ts` (voucher resolves to the live re-issue; a number naming only a dead
check stages); `tests/actions/restore-cancelled.test.ts` (re-attach, minus a voucher a live check
took). All hit the test database and were not run from the build container; `npx tsc --noEmit` is
clean. **Run the suite before merging.**
