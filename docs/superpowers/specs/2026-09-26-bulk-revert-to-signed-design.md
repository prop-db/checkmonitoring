# Revert to SIGNED from the list — design

**Date:** 2026-09-26 · **Asked by:** client ("From Checks Available, have a button to revert it back to signed checks")

## Why

On 2026-09-25 several cheques had to come off the release list (the four BROKERS cheques dropped
from `FOR RELEASE 9_1.25.2026v2.xlsx`, the 428 `Detail1` cheques). Every one was done by a script,
because the only way back from READY FOR RELEASE in the app is **REVERT TO SIGNED** on a single
cheque's page, and only a Finance Admin sees it. Finance works from the list, a batch at a time.

## What

A **REVERT TO SIGNED** button in the tick-box action bar (`components/BulkActionBar.tsx`), beside
SIGN, READY FOR RELEASE and RELEASE.

- **Who:** every signed-in Finance user (client ruling 2026-09-26). The single-cheque button on the
  cheque page opens to every Finance user as well, so the two paths agree: `revertAction` loses its
  FINANCE_ADMIN guard and the page stops gating the form on role. RELEASE, reverse release and
  delete-incomplete stay FINANCE_ADMIN.
- **Which cheques:** only ticked rows at READY_FOR_RELEASE or SCHEDULED. The button is enabled when
  at least one such row is ticked and reads `REVERT TO SIGNED (n)`; other ticked rows are not sent.
- **Reason:** one text field in the bar, required, shared by the batch. The button stays disabled
  while it is empty, and the server refuses a blank one before anything is written (one message,
  not one refusal per cheque).
- **Limit:** the same `caps.bulkSelection` setting as the other bulk buttons (`parseSelection`).

## How

- `bulkRevertToSignedAction(formData)` in `app/checks/bulk-actions.ts`: `requireUser`, the
  selection cap, the reason check, one `now` for the batch, then `runEach` calling the existing
  `revertAvailability(prisma, { checkId, userId, reason, now })` once per cheque.
- No new write path. `revertAvailability` already does everything in one transaction: asserts the
  transition to SIGNED, clears `availablePickupDate`, the scheduled pickup, `pickupRep`,
  `portalConfirmedAt`, `readyAt`, `readyById`, queues a `REVERT` portal event for a portal-eligible
  cheque, and writes one `reverted_availability` audit row carrying the user and the reason.
- A cheque that moved on in the meantime (released, voided) is refused by the domain's own
  transition check, and `runEach` reports it by cheque number with the domain's wording; the rest
  of the batch still reverts.

## Tests

- `tests/actions/bulk-actions.test.ts`: a FINANCE_USER can revert; a blank reason is refused with
  nothing written; only READY/SCHEDULED cheques move, each with a `reverted_availability` row
  holding the reason; a ticked RELEASED cheque is reported as refused while the others revert; an
  over-cap selection is refused.
- `tests/actions/server-actions.test.ts`: `revertAction` succeeds for a FINANCE_USER (it was
  refused before).
- `npx tsc --noEmit`.

## Not in scope

No change to what READY FOR RELEASE means, to the portal event, or to any admin-only action.
