# Deploying to `checkmonitoring.rclcompanies.com`

Target: Vercel, region `sin1` (Singapore) — the closest region to the Neon database in
`ap-southeast-1`, which matters because every page render makes several database round trips.

## DNS is already done

`checkmonitoring.rclcompanies.com` resolves to `216.198.79.1` / `216.198.79.65` — Vercel's anycast
addresses, the same ones `www.` and `supplier.` use. The hostname currently returns
`X-Vercel-Error: DEPLOYMENT_NOT_FOUND`, meaning it points at Vercel but has no project attached.

**So no DNS record needs creating.** Adding the domain to the Vercel project is the whole job.
(`portal.rclcompanies.com` returns the same error, so the Supplier Portal is served from somewhere
else — worth knowing before anyone assumes that subdomain is live.)

## Before the first deploy — three blockers

### 1. Deactivate the seeded accounts

`admin@rcl.test` and `finance@rcl.test` are **still active** in the application database, and their
passwords are committed in `prisma/seed.ts`. On a public URL that is an open door.

They cannot be deleted — a `User` row is referenced by `AuditLog` and five `Check` relations, so
deleting one would orphan the record of who released real money. **Deactivate them** from
ADMINISTRATION → USERS, signed in as a real admin. The screen carries a banner until this is done.

### 2. Login rate limiting must be in place

Its absence was accepted **on the explicit basis that deployment would be internal-only**. A public
URL removes that basis. Do not deploy publicly until this has landed.

### 3. A second admin account

Only one account currently holds `FINANCE_ADMIN`. The last-admin guard means a forgotten password on
that one account leaves nobody able to administer the system, and there is no delete-and-reseed
path. Promote the second real account.

## Environment variables to set in Vercel

Set for **Production** (and Preview, if previews are enabled — a preview deployment pointed at the
production database is a real hazard; prefer giving Preview the test database or disabling it).

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The Neon **pooled** endpoint (`-pooler`). Serverless opens many short-lived connections; the direct endpoint will exhaust its limit. |
| `DIRECT_DATABASE_URL` | The Neon **direct** endpoint. Used only by migrations. |
| `AUTH_SECRET` | **Generate a NEW one for production.** Do not reuse the development value — it exists in a local `.env` and anyone holding it can forge a session cookie. `openssl rand -base64 32`. |
| `AUTH_URL` | `https://checkmonitoring.rclcompanies.com` |
| `AUTH_TRUST_HOST` | `true` — required behind Vercel's proxy, or NextAuth will not trust the forwarded host and callbacks break. |
| `ACUMATICA_ODATA_URL` | as in local `.env` |
| `ACUMATICA_ODATA_URL_MFG` | as in local `.env` |
| `ACUMATICA_ODATA_USER` | as in local `.env` |
| `ACUMATICA_ODATA_PASSWORD` | as in local `.env` |
| `ACUMATICA_GI_NAME` | as in local `.env` |
| `CRON_SECRET` | `openssl rand -base64 32`. Vercel presents it as a bearer when it calls `/api/cron/sync` daily at 18:00 Manila; the route refuses to run while it is unset. |

**Do not set `DATABASE_URL_TEST` or `DIRECT_DATABASE_URL_TEST` in Vercel.** Nothing in production
should be able to reach the test database, and the test-database guard in `tests/helpers/db.ts`
refuses to run when they are absent — which is the correct failure.

## Deploy

```bash
npx vercel link          # once, to associate this directory with a Vercel project
npx vercel --prod
```

Then in the Vercel dashboard: **Project → Settings → Domains → Add** `checkmonitoring.rclcompanies.com`.
Because DNS already points at Vercel, verification should complete without a record change.

## Migrations

Vercel does not run migrations. Run them yourself, from a machine that has the direct URL:

```bash
node scripts/migrate.mjs prod --confirm
```

The connection string contains `&`, which breaks shell invocations of the Prisma CLI; the script
passes the URL in `argv` with no shell, and prints the host and database it is about to touch.
`node scripts/migrate.mjs test` does the same to the test database, which every migration must
reach before the suite is run.

**Run this before `npx vercel --prod`, not after.** `app/page.tsx` now calls `getSyncOverview`,
which selects every `SyncRun` column including `trigger`. Deploy the new code against an
unmigrated database and the dashboard's Prisma client asks for a column that is not there — every
user gets a broken home page, not a degraded one. The reverse order is harmless: the old client
running a moment longer against a migrated database simply never asks for `trigger`, and the
column has a default for the rows it doesn't yet know about. Order is not a preference here; it is
the difference between "nothing changed yet" and "the app is down".

## After the first deploy — verify, do not assume

1. `https://checkmonitoring.rclcompanies.com/` redirects to `/login`.
2. `/admin/users` **while signed out** redirects to `/login`. This is the guard that actually
   protects the app — see the note on middleware below.
3. Sign in as a real admin; the dashboard renders with the seeded reference data.
4. Confirm the seeded accounts show as DEACTIVATED.
5. Trigger a sync from `/admin/sync` and confirm a `SyncRun` row appears with its tenant.
6. Press SYNC NOW once more for EACH tenant on `/admin/sync` before the cron ever fires. The route
   reads both tenants inside one 60-second function, and on the very first scheduled run the
   incremental window is as wide as it will ever get — GOLIVE roughly 33 hours behind,
   MANUFACTURING roughly 3.4 days — with no floor under it: a run the timeout kills never advances
   its watermark, so the next day's window only gets wider. A manual SYNC NOW per tenant is its own
   function invocation with its own 60 seconds, so both watermarks are minutes old by the time the
   schedule first runs, and the first scheduled run has an ordinary window to read.
7. Vercel dashboard → Project → Settings → Cron Jobs lists `/api/cron/sync` at `0 10 * * *`.
   Trigger it once from there. `/admin/sync` then shows a run per tenant with trigger SCHEDULED.
   The next evening at 18:00 Manila, two more appear unprompted — and the dashboard's
   ACUMATICA LAST READ line moves.

## Known issue: `middleware.ts` does not run

The middleware manifest is empty after a clean build — Node-runtime middleware
(`export const runtime = 'nodejs'`) is not supported in Next 15.5.25, and the file is silently never
registered.

**The application is protected regardless**, by the page-level `requireUser()` / `requireAdmin()`
guards that Plan 1 introduced specifically so "a bad matcher edit cannot silently expose pages".
That decision is now the only thing holding, and it holds.

**Every request-time control must therefore live in the request path** — a page guard, a server
action, or the `authorize` callback — never in middleware. A control placed in `middleware.ts` will
pass tests that import it directly and protect nothing in production.

Decide deliberately: delete the file as dead code, or make it Edge-compatible. Leaving it is the
worst option, because it reads as protection that is not there.

## The historical load

The 12,227-row register import has been proven twice against the **test** database
(run 1: 9,247 created / 214 updated; run 2: 0 created / 9,461 updated — idempotent). It has **not**
been run against production. It takes roughly 50 minutes.

Use the dry run first — it predicts the outcome exactly — so Finance can see the 2,766 staged rows
before anything is written:

```bash
npx tsx scripts/import-workbook.ts "CHECK MONITORING 9.1.2026.xlsx" --dry-run
```
