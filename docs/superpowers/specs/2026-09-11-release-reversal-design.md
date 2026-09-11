# Release reversal — design

**What it is.** A FINANCE_ADMIN can undo a release that was ticked by mistake: the cheque goes back
to READY_FOR_RELEASE, the collection that did not happen is cleared, the supplier portal is told the
cheque is available again, and the reason is on the audit trail. It is refused outright when the
supplier's receipt is on record, or when the bank has cleared the cheque.

Designed with the client on 2026-09-10 (CLAUDE.md item 8); the one open point — where the cheque
lands and what the portal is told — was settled on 2026-09-11. Every figure here was measured
against production that day.

## Why

`RELEASED → VOIDED` is today the only edge out of RELEASED, and it means the bank voided the
cheque, not that somebody ticked the wrong row. A release is the one action in this system that
hands money over, and it is the one with no undo. The availability revert (READY_FOR_RELEASE →
SIGNED) has existed since Plan 1 and was wired to the page on 2026-09-10; this is its counterpart
one rung up.

## The client's design, and the one correction

The 10 September design: FINANCE_ADMIN only · mandatory reason · back to READY_FOR_RELEASE ·
pickup fields cleared · portal REVERT queued · **refused outright when a receipt already exists**,
because a recorded OR/CR is the supplier's own paper saying they took the cheque.

One part could not stand as written. The portal's `POST /api/checks/revert` undoes the portal's
*release record* — the cheque becomes `REVERTED_FOR_REUPLOADING`, no longer available to the
supplier (`docs/superpowers/specs/2026-09-04-supplier-portal-api-evidence.md`). A cheque landing at
READY_FOR_RELEASE here while the portal says withdrawn is two systems disagreeing about whether a
supplier may collect. The portal has the right message for this case: `POST /api/checks/:id` with
`status: AVAILABLE_FOR_RELEASE` — the same endpoint `markReleased`'s event already targets with
`status: RELEASED`. **Client ruling 2026-09-11: land at READY_FOR_RELEASE; tell the portal
"available again".** That is a new `PortalEventKind`, `RELEASE_REVERSED`, not `REVERT`.

## Measured

Of 9,594 RELEASED cheques in production, **none** carries a receipt, `releasedAt`, `releasedById`,
a scheduled pickup, a portal trade, a portal event, or any clearing. Every one was released by a
backfill (3,188 `backfilled_released_from_acumatica`, 50 `backfilled_released_dropped_from_approval_list`)
or by the register load; the app's own `markReleased` has never run in production. So today every
reversal is of a backfilled release, and both refusals are forward-looking — they exist for the
releases the app will record from here on. `PortalEvent` is empty; nothing is delivered until
Plan 3, so the new event queues like the other three kinds.

## `reverseRelease` — `lib/domain/actions.ts`

Beside `revertAvailability`, which it mirrors in shape.

```ts
export async function reverseRelease(
  db: Db, args: { checkId: string; userId: string; reason: string; now: Date },
): Promise<Check>
```

**Refusals, in this order, all before anything is written:**

1. Blank reason → `DomainError('REASON_REQUIRED', 'A reason is required to reverse a release.')`.
2. Status not RELEASED → `assertTransition(status, 'READY_FOR_RELEASE')`, i.e. `ILLEGAL_TRANSITION`.
3. A receipt on record (`orNumber` not null, or `receiptType` not null) →
   `DomainError('RECEIPT_ON_RECORD', 'A receipt is recorded: the supplier's own paper says they
   collected this cheque. Settle that with the supplier before reversing the release.')`.
4. Any clearing recorded (`clearingStatus ≠ NONE`, or `crNumber` / `clearedDate` set) →
   `DomainError('CLEARED', 'The bank has cleared this cheque; it cannot be un-released.')`.

Refusal 4 is the one addition to the client's list. A cheque the bank has paid is money that has
moved; reversing its release here would make this system claim it is available for collection while
the funds are gone. Approved 2026-09-11.

**Writes, in one transaction:**

| field | becomes | why |
| --- | --- | --- |
| `status` | `READY_FOR_RELEASE` | the client's landing status |
| `releasedAt`, `releasedById` | null | the release did not happen; the audit row keeps who and when |
| `scheduledPickupDate`, `scheduledPickupTime`, `pickupRep`, `portalConfirmedAt` | null | the collection did not happen |
| `availablePickupDate`, `readyById`, `readyAt` | **kept** | it is still available |
| `remarks` | kept | the reason goes on the audit row, not over Finance's note |
| `portalSyncStatus` | `PENDING` for SUPPLIER/BROKER, else `NOT_APPLICABLE` | as the other three sites |

For a SUPPLIER or BROKER cheque, one `PortalEvent`: `direction OUT`, `kind RELEASE_REVERSED`,
`status PENDING`, `idempotencyKey = portalEventKey(check.id, 'RELEASE_REVERSED', now)`, payload
`{ action: 'RELEASE_REVERSED', checkNumber }`. An INTERNAL cheque produces none — rule 2, asserted
the way `markReleased` and `revertAvailability` assert it, and pinned by test.

One audit row: `action: 'release_reversed'`, `remarks: reason`, `details: { releasedAt, releasedById }`
as they were before clearing — so the trail states what was undone, not just that something was.

## The ladder — `lib/domain/check-status.ts`

`RELEASED: ['VOIDED']` becomes `RELEASED: ['READY_FOR_RELEASE', 'VOIDED']`, with the comment saying
this edge is a correction, not a stage. `RELEASED` stays in `CLOSED_STATUSES`; the dashboard's
scopes do not change, and the compile-time partition proof is untouched.

## The enum — one additive migration

`20260911000100_portal_event_release_reversed`:
`ALTER TYPE "PortalEventKind" ADD VALUE 'RELEASE_REVERSED';` — with the schema comment recording
that it is delivered, when Plan 3 delivers anything, through `POST /api/checks/:id` with
`status: AVAILABLE_FOR_RELEASE`, and that it is deliberately not `REVERT`. Applied to the test
database (`node scripts/migrate.mjs test`) before any test runs; to production
(`node scripts/migrate.mjs prod --confirm`) before the deploy, as `docs/deployment.md` requires.

Postgres cannot use a new enum value inside the transaction that added it, which is why this is its
own migration file and nothing else is in it.

## The server action and the page

`reverseReleaseAction` in `app/checks/actions.ts`, beside `revertAction` and shaped like it:
`requireUser()`, refuse a non-admin with a message, then `run(checkId, () => reverseRelease(...))`.

On `app/checks/[id]/page.tsx`, the `RELEASED` branch currently says *"There is nothing further to
do here."* For a FINANCE_ADMIN it gains, below that line:

- when neither refusal applies — an `ActionForm` with a required REASON field and the button
  **REVERSE RELEASE**, help text: *Returns this cheque to READY FOR RELEASE, clears any pickup that
  was booked, and tells the supplier portal it is available again. The release stays on the audit
  trail with your reason.*
- when a receipt is on record — no form; the refusal sentence from refusal 3.
- when clearing is recorded — no form; the refusal sentence from refusal 4.

A FINANCE_USER sees the page as today. The button is hidden rather than shown-and-refused, but the
server action is what enforces it.

## Testing

Targeted, never the full suite:

- `tests/actions/reverse-release.test.ts` — admin path: status, the cleared fields, the kept fields,
  `remarks` untouched; blank reason refused; receipt refused (with `orNumber` + `receiptType` set);
  clearing refused (`clearingStatus: 'CLEARED'`); a SIGNED cheque refused; SUPPLIER queues exactly
  one `RELEASE_REVERSED` with the right key and payload; INTERNAL queues none and stays
  `NOT_APPLICABLE`; the audit row with `details.releasedAt`; nothing written on any refusal.
- `tests/domain/check-status.test.ts` — the new edge allowed; `RELEASED → SIGNED` still refused.
- `tests/actions/server-actions.test.ts` — a FINANCE_USER is refused by `reverseReleaseAction`.
- `npx tsc --noEmit`; `next build`.

## Not in this design

- **Bulk reversal.** One cheque, one reason — the same reasoning as rule 10's deletion.
- **Reversing a VOIDED cheque.** Acumatica owns that fact.
- **Delivering the portal event.** Plan 3; the event queues with the others.
- **Reversing a receipt.** A recorded receipt is settled with the supplier, then removed by the
  existing receipt form; only then can the release be reversed.
