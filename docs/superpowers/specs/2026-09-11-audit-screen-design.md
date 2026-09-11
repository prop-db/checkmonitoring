# Audit screen — design

**What it is.** `/admin/audit`: the first screen in this system that can read its own audit trail.
It opens on what people did — signed, released, reversed, cancelled, user changes — newest first,
with who, when, which cheque and why; a toggle brings in the system's own rows; filters narrow by
action, user, cheque number and date; an Excel extract carries the filtered range out.

Every figure here was measured against production on 2026-09-11.

## Why

CLAUDE.md item 3: *the audit trail is write-only.* `writeAudit` is the only writer, a database
trigger makes rows append-only, and 2,052 rows were written on 10 September alone — and no screen
in the application can read any of it except one cheque's own trail on its detail page. The
release reversal built today writes a `release_reversed` row whose `details` say what was undone;
nobody can see it without a database client.

## Measured — what the trail actually holds

| | |
| --- | --- |
| rows | 65,269, from 2026-09-04 to today |
| by a person (`actorType = USER`) | **4**, all one user |
| by the system | 65,265 — imports, backfills, merges, sync |
| detached (`checkId` null) | 17,087 — the cheque was later deleted, or removed as out of scope |
| distinct actions | 21; `imported` (26,432) and `import_updated` (24,404) are 78% of the table |
| busiest day | 27,483 rows on 4 September |
| indexes | one, `(checkId, createdAt)` — serves a cheque's own trail and nothing else |

Two screens hide in "the audit screen" and want different defaults. The one an admin reaches for
is *what did people do* — four rows this week, and every future signature, release, reversal and
user change. The one an auditor reaches for is *what did the system do to this cheque on 10
September* — the 1,958 `company_restored_to_acumatica` rows and the 94 `amount_restored_to_acumatica`
rows are SYSTEM rows, and hiding them for good would hide the day's most important record. Client
ruling 2026-09-11: **people's actions by default, the system's on request.**

## The page — `app/admin/audit/page.tsx`

A fifth admin tab, `AUDIT`, after `STAGED QUEUE`. `requireAdmin()` first, as every admin page.
Server-rendered; a plain `GET` form.

**Default view:** `actorType = USER`, newest first, 100 rows a page.

**Each row:** WHEN (Manila, with the year) · WHO (the user's name; `SYSTEM` for system rows) · ACTION
(as words — `RELEASE REVERSED`) · CHECK (the cheque number, linked to `/checks/[id]`) · REMARKS ·
DETAILS. A detached row shows the cheque number its `details` carry (`details.checkNumber`, which
most import and backfill rows record) or `(cheque removed)`, unlinked. DETAILS is a `<details>`
disclosure rendering the JSON as key/value lines — server-rendered, no script — so `from → to` on
a backfill or `releasedAt` on a reversal is one click away and never in the way.

**Filters:**

| control | parameter | |
| --- | --- | --- |
| SYSTEM ROWS | `system=1` | off by default; on, the actor filter is dropped and everything shows |
| ACTION | `action` | a select built from `SELECT DISTINCT action` — never a hard-coded list |
| USER | `user` | a select of users, by id |
| CHECK NUMBER | `check` | exact match on `Check.checkNumber` through the join; detached rows cannot match, and the count line says so when this filter is set |
| FROM · TO | `from`, `to` | Manila calendar days, inclusive |

RESET when any is set. The count line states the true total for the filters in force and the
filters in words, as every other screen does.

**Pagination:** keyset, never offset. Rows are ordered `(createdAt desc, id desc)`; `?before=` carries
the last row's `createdAt` (ISO) and `id` joined by `|`, and the next page is `WHERE (createdAt, id)
< (…)`. `NEXT PAGE` at the foot when the page is full; `NEWEST` returns to the top. An offset over
65,269 rows is a sequential scan on every page; a keyset is an index seek.

## Indexes — one migration

`20260911000200_audit_log_indexes`, additive:

| index | serves |
| --- | --- |
| `(createdAt, id)` | the keyset and the unfiltered newest-first view |
| `(actorType, createdAt)` | the default view |
| `(action, createdAt)` | the ACTION filter |
| `(userId, createdAt)` | the USER filter |

`(checkId, createdAt)` already exists and serves the CHECK filter's join. Applied to the test
database before any test, and to production before the deploy. No data changes; the append-only
trigger is untouched.

## The extract — `/api/export/audit`

The filtered range, as the page shows it: same parameters, same guard shape as the other export
routes (`getSessionUser()` first, **and** `FINANCE_ADMIN` required, because the page is), 401 not a
redirect. One sheet, `AUDIT`: WHEN · WHO · ACTION · CHECK NUMBER · REMARKS · DETAILS (the JSON as
text). Newest first, capped at `EXPORT_ROW_LIMIT` (10,000) with the cap and the filters stated in
the title block, dated filename `audit-<manila day>.xlsx`. Built on `sheet-style.ts`.

## Plumbing

| file | responsibility |
| --- | --- |
| `lib/audit-view.ts` | **Pure.** Parameter parsing (dates as Manila days, the cursor), `encodeCursor` / `decodeCursor`, hrefs, `describeAuditFilters`, the filename, `actionWords`. |
| `lib/audit-query.ts` | The reads: `listAuditRows(db, filters, cursor)` returning up to 101 rows (the 101st says there is a next page), `countAuditRows`, `listAuditActions`, `listAuditUsers`. |
| `lib/export/audit-workbook.ts` | ExcelJS rendering. |
| `components/AuditTable.tsx` | Server component: the table and the DETAILS disclosure. |
| `app/admin/audit/page.tsx`, `app/api/export/audit/route.ts` | Guard, params, read, render / respond. |
| `app/admin/layout.tsx` | The tab. |

`writeAudit` in `lib/audit.ts` remains the only writer. Nothing here writes.

## Testing

Targeted: `tests/audit-view.test.ts` (pure — cursor round-trip, the Manila day bounds, hrefs,
filter words, filename), `tests/admin/audit-query.test.ts` (default view excludes SYSTEM, the toggle
includes it, each filter, the keyset page boundary with two rows sharing a `createdAt`, detached
rows present), `tests/export/audit-workbook.test.ts` (cells read back), `tests/export/audit-route.test.ts`
(401 unauthenticated; 401 for a FINANCE_USER; no database touch on either; filename). `npx tsc
--noEmit`; `next build`.

## Not in this design

- **Editing or annotating rows.** Rule 7; append-only.
- **Changing what is audited.** The 21 actions are what they are.
- **A per-user activity page.** The USER filter is that, for now.
