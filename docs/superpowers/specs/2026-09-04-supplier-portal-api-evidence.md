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

## Open questions a live call must answer

These cannot be settled from source and should be checked **read-only** before any write path is
built:

1. Does the service account exist, and is it at `encoder` tier? (D6 assumes yes; nothing has verified it.)
2. What does `GET /api/checks` actually return per row — is the cheque number present, and in which format? Our register writes bare numbers and Acumatica bank-prefixes 90% of its refs; the portal stores `"checkNo · BANK"`, which is a **third** format.
3. Does a re-`import` of an already-available cheque count as `alreadyAvailable` and stay harmless, or does it re-notify the supplier? This decides whether the outbox may safely retry.
4. What is the session lifetime, and what does an expired session return — 401, or a redirect?

Question 3 is the one that can do damage. **Do not build retry until it is answered**, because a
retrying outbox against a re-notifying endpoint spams suppliers.
