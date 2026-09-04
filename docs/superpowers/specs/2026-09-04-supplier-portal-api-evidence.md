# Supplier Portal API — evidence base for Plan 3

Read from the portal's own source at `RCL PROJECTS/Supplier Portal` on 2026-09-04. **Nothing here is
inferred**; every claim cites the file it came from. No live call has been made to the portal yet.

This exists because Tasks 8 and 9 were built against assumed Acumatica behaviour, passed 355 tests,
and still carried four money-affecting defects that only surfaced on first contact with the live
feed. The portal is the same risk, and this is the cheap half of avoiding it.

## The endpoints

All under `src/server.js`. Every one is `auth`-gated; the write paths additionally require
`requireTier(req, res, 'encoder')`.

| method | path | tier | purpose |
| --- | --- | --- | --- |
| GET | `/api/checks` | auth | list releases; takes `q`, `status` |
| GET | `/api/checks/untracked` | auth | search trades with no release record |
| POST | `/api/checks/mark-available` | **encoder** | `{ tradeIds, pickupDate }` |
| POST | `/api/checks/import` | **encoder** | `{ rows, pickupDate }` — matches server-side |
| POST | `/api/checks/revert` | **encoder** | `{ tradeReleaseIds, brokerReleaseIds }`, max 500 each |
| POST | `/api/checks/:id/confirm-pickup` | **supplier/broker only** | admin is refused 403 |
| GET | `/api/checks/:id/history` | auth | per-check history |
| POST | `/api/broker-checks/mark-available` | **encoder** | `{ transactionIds, pickupDate }` |

> **Correction, same day.** An earlier version of this file said no broker endpoint existed. That
> was wrong — it does, at `src/server.js:2626` — and the error was mine: I grepped for
> `'/api/checks` and a broker route does not match that prefix. The design spec §7 was right all
> along. Note the parameter is `transactionIds`, not `tradeIds`; the two stores key on different
> tables (`trade` vs `broker_transaction`).

## What `GET /api/checks` returns per row

From `listCheckReleases` in `src/checks/store.js`. This is the polling surface for pickup
confirmations, and it carries our match key:

```
id, tradeId, checkNumber, checkDate, status,
pickupDate, pickupTime, pickupRep, confirmedAt,      <- the confirmation we poll for
releaseDate, releaseTime, releaseLocation,
orNumber, orDate, remarks, releasedAt, updatedAt,
poAmount, apvNumber, poNumber, siNumber,             <- apvNumber is how we match back
supplierName, companyName
```

Two consequences:

- **`apvNumber` comes back**, so a polled row maps to our cheque through the same identifier we
  pushed on. No portal id has to be stored for polling to work.
- **`tradeId` also comes back.** So `Check.portalTradeId` can be *learned and cached* after the
  first successful match rather than being a prerequisite — useful later if the direct
  `mark-available` path is ever preferred over `import`.

## The finding that matters most: we do not need the portal's internal IDs

`mark-available` takes `tradeIds` — the portal's own primary keys, which this system has no way to
know. That is what `Check.portalTradeId` in our schema anticipated.

**`/api/checks/import` removes the need.** It matches server-side on business identifiers we already
carry. From `src/checks/import.js`:

- `ref` → matched against `trade.apv_number`, then `broker_transaction.apv_number`
- `vendorRef` → matched against `trade.acu_po_number`, `trade.manual_po_number`, then
  `broker_transaction.po_number`
- **Trade wins over broker on a double match** — the portal's comment calls this "deterministic,
  spec'd", so our `PortalDomain` routing must agree with it rather than fight it
- Matching is `upper(trim())` on both sides
- Rows are deduped by `ref`, because a multi-line bill repeats its ref per line

So the payload is built from `NormalisedRow.apvNumbers` and `poNumbers`, which the workbook path
already collects. **`ref` is the APV number, not the cheque number** — worth stating plainly,
because "ref" reads like a payment reference and using `acumaticaPaymentId` there would match
nothing.

`checkNo` and `bank` are optional and stored by the portal as the single string `"checkNo · BANK"`.

Constraints: `MAX_ROWS = 5000`; `pickupDate` must match `^\d{4}-\d{2}-\d{2}$` (rejected with 400
otherwise); `ref` and `vendorRef` are truncated to 200 characters, `checkNo` and `bank` to 100.

Returns `{ marked, alreadyAvailable, unmatched[], unmatchedTotal, revertCandidates }`.
**`unmatched` is capped at 50 entries while `unmatchedTotal` is the true count** — read the total,
not the array length. This response is the natural source for the unmatched queue in the design.

## Pickup confirmation must be polled, not received

`POST /api/checks/:id/confirm-pickup` opens with:

```js
if (req.session.role === 'admin') return res.status(403).json({ error: 'suppliers and brokers only' });
```

An admin or encoder session **cannot** call it. So this system can never write a pickup
confirmation; it can only observe one. Polling is not a design preference here, it is the only
option the portal allows — which also confirms the spec's read-only posture toward supplier actions.

## Authentication is a session, not a bearer token

The `auth` middleware reads `req.session` (`req.session.userId`, `req.session.role`). The client
must log in and carry a session cookie, then re-authenticate when it expires. This is a real
difference from the Acumatica client, which sets a Basic header per request, and the portal client
must not be written by analogy to it.

`requireTier(req, res, 'encoder')` gates every write, matching design decision **D6** — a dedicated
service account at `encoder` tier, so portal-side audit rows attribute actions to this system.

## Trade and broker are separate stores throughout

`checksStore` and `brokerChecksStore` are distinct modules with parallel functions
(`revertChecks` / `revertBrokerChecks`), and `revert` takes two separate id arrays. Our
`portalRoute()` already returns `LOCAL` or `BROKER`; that split must survive into the client rather
than being flattened.

## ANSWERED 2026-09-04 — the three blocking questions

### 1. The `encoder` service account does NOT exist

Read-only aggregate query against the portal's `app_user` (no usernames retrieved, no personal data):

| role | tier | count |
| --- | --- | ---: |
| admin | encoder | 7 |
| admin | procurement | 12 |
| admin | super | 2 |
| admin | viewer | 4 |
| broker | — | 3 |
| supplier | — | 12 |

**Encoder accounts whose username looks like a service account: 0.** All seven encoders are people.

Design decision **D6 is therefore unsatisfied**. Someone with portal admin rights must create a
dedicated account at `encoder` tier before any write path runs. Do not proceed by borrowing a
person's login: every automated action would be attributed to them in the portal's audit log, which
defeats the reason D6 exists.

### 2. Re-importing an already-available cheque does NOT re-notify — retry is safe

Answered from source rather than by experiment. `src/checks/store.js` carries an explicit
application-level latch, and its own comment states the design:

> "A re-mark after Undo transitions the row back to AVAILABLE but does NOT re-notify: the notify
> latch is one-way by design (spec: Undo does not un-send). 'marked' therefore means 'transitioned',
> not 'notified'."

The latch is what "guarantees notify exactly once per check". **So Task 5's outbox may retry**, and
the succeed-or-park fallback the plan held in reserve is not needed.

**One caveat, and it runs the other way.** The same comments record that the claim commits *before*
`notify()` runs, so a won claim followed by a failed notify latches the record as notified anyway.
The risk is therefore **under**-notification, not spam: a supplier could be marked notified without
receiving anything. That is portal-side and outside this system's control, but it is why the
unmatched/failed queue in Task 7 matters — it is the only place such a cheque would become visible.

Related: `markAvailable` passes `suppressEmail: true` per row and aggregates **one email per distinct
supplier**, because a per-row email would exceed the mail provider's rate limit on a bulk import.
In-app portal notification still fires per row.

### 3. A release CAN be pushed — `POST /api/checks/:id`

The plan and an earlier reading of this file both assumed no endpoint accepted a release
instruction. **Wrong.** `POST /api/checks/:id` (encoder tier) accepts:

```
checkNumber, checkDate, status, releaseDate, releaseTime,
releaseLocation, orNumber, orDate, remarks
```

Valid `status` values are the portal's own vocabulary, **not ours**:

```
FOR_PROCESSING, FOR_APPROVAL, FOR_CHECK_PRINTING, READY_FOR_SIGNATURE,
AVAILABLE_FOR_RELEASE, RELEASED, REVERTED_FOR_REUPLOADING
```

It takes the portal's `check_release.id` — the `id` field `GET /api/checks` returns, distinct from
`tradeId`. So the `RELEASED` portal event this system already queues **is deliverable**, and the
plan's two-value `PortalEventKind` was drafted against two of the three call sites that exist.

## Open questions a live call must answer

These cannot be settled from source and should be checked **read-only** before any write path is
built:

1. Does the service account exist, and is it at `encoder` tier? (D6 assumes yes; nothing has verified it.)
2. What does `GET /api/checks` actually return per row — is the cheque number present, and in which format? Our register writes bare numbers and Acumatica bank-prefixes 90% of its refs; the portal stores `"checkNo · BANK"`, which is a **third** format.
3. Does a re-`import` of an already-available cheque count as `alreadyAvailable` and stay harmless, or does it re-notify the supplier? This decides whether the outbox may safely retry.
4. What is the session lifetime, and what does an expired session return — 401, or a redirect?

Question 3 is the one that can do damage. **Do not build retry until it is answered**, because a
retrying outbox against a re-notifying endpoint spams suppliers.
