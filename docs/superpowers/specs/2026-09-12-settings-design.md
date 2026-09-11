# Settings — design

**What it is.** `/admin/settings`: the ten knobs this system has, changeable by a Finance Admin
on screen instead of by a deploy, each within bounds the code sets. One of them is the category
list, which becomes the only source of a category on a cheque or a planned line.

Sub-project 3 of the "manageable reports" programme decided 2026-09-11. Designed with the client
2026-09-12: all four groups (sync thresholds, caps, categories, login throttle) are settings; a
category not on the list is **refused**, not accepted as free text.

## Why

The `Setting` table has existed since Plan 1 with no readers and no rows. Every threshold that
governs a screen — when the dashboard calls Acumatica stale, how many cheques one click may
release, how many rows an extract holds, how many wrong passwords lock an account — is a constant
with a paragraph of reasoning beside it and no way to change it short of a commit. Each was set on
one measured day; the days move on. And the category, now typeable on the cheque page and on
planned lines, is free text: `PAYROLL` and `PAY ROLL` are two categories for one thing.

## A. The registry — `lib/settings/registry.ts`, pure

Every setting is declared once, with its default taken from the constant the code already
exports, so the reasoning stays where it was written and the table holds only overrides.

| key | group | label | default | bounds |
| --- | --- | --- | ---: | --- |
| `sync.staleAfterHours` | SYNC | Acumatica read is stale after | `STALE_AFTER_HOURS` 30 | 1–168 h |
| `sync.abandonedAfterMinutes` | SYNC | A running sync is abandoned after | `ABANDONED_AFTER_MINUTES` 90 | 10–1,440 min |
| `sync.inProgressMinutes` | SYNC | SYNC NOW refuses to overlap a run younger than | `SYNC_IN_PROGRESS_MINUTES` 10 | 1–120 min |
| `caps.bulkSelection` | CAPS | Cheques per bulk action, and lines per clearing paste | `MAX_BULK_SELECTION` 50 | 1–500 |
| `caps.exportRows` | CAPS | Rows per Excel extract | `EXPORT_ROW_LIMIT` 10,000 | 100–100,000 |
| `caps.voucherScreenRows` | CAPS | Rows on the vouchers screen | `VOUCHER_SCREEN_ROW_LIMIT` 200 | 50–2,000 |
| `login.windowMinutes` | LOGIN | Failed sign-ins count for | `WINDOW_MINUTES` 15 | 5–60 min |
| `login.emailFreeFailures` | LOGIN | Free failures per email before a lock | `EMAIL_FREE_FAILURES` 4 | 3–10 |
| `login.ipFreeFailures` | LOGIN | Free failures per address before a lock | `IP_FREE_FAILURES` 20 | 10–100 |
| `categories` | CATEGORIES | The categories a cheque or planned line may carry | the importer's nine | ≥ 1 entry, each non-blank, upper-cased, unique |

```ts
export type SettingDef =
  | { key: IntKey; group; label; help; unit: string; kind: 'int'; default: number; min: number; max: number }
  | { key: 'categories'; group; label; help; kind: 'list'; default: readonly string[] }
export const SETTINGS: readonly SettingDef[]
export type SettingsValues = { [K in IntKey]: number } & { categories: readonly string[] }
export const DEFAULTS: SettingsValues
export function parseSettingText(def: SettingDef, text: string): { ok: true; value } | { ok: false; message: string }
export function formatSettingText(def: SettingDef, value): string     // what the table stores and the form shows
export function isCategory(list: readonly string[], value: string): boolean
```

The login group's bounds are the guardrail the client accepted on 2026-09-12: the throttle can be
tightened freely and loosened only to the floor. The screen states it beside those three rows.
`BACKOFF_MINUTES`, `RETENTION_DAYS` and `SYNC_OVERLAP_MINUTES` are deliberately not settings — the
first two are the shape of the throttle, the third is the sync's correctness margin.

## B. Reads — `lib/settings/read.ts`

`loadSettings(db): Promise<SettingsValues>` — one `setting.findMany`, defaults filled where no row
exists. A stored value that no longer parses (a bound tightened in code after it was saved) falls
back to the default and is reported on the screen as OUT OF BOUNDS, not silently honoured. Called
once per request by each page, route or action that needs a value; there is no process-wide
cache, because a serverless instance that cached a setting would keep it until it died.

**Every consumer takes the value as a parameter.** The pure functions already shaped that way
(`describeStaleness`) are unchanged; the others gain a parameter with the registry default as its
default, so every existing test still passes unchanged and the constants keep their meaning:

| consumer | today | becomes |
| --- | --- | --- |
| `describeStaleness(reads, now, hours)` | default | dashboard passes `settings.sync.staleAfterHours` |
| `getSyncOverview(db, now)` | constant | `getSyncOverview(db, now, abandonedAfterMinutes)` |
| `runSync(...)` in-progress guard | constant | `inProgressMinutes` in its options; cron route and SYNC NOW load settings first |
| `parseSelection(raw)`, `chunkSelection(raw)` | constant | `(raw, cap)`; bulk actions load settings; `BulkActionBar` gets `cap` from the page |
| `MAX_CLEARING_LINES` | constant | the clearing actions load `caps.bulkSelection`; `ClearingPaste` gets `maxLines` |
| export routes `EXPORT_ROW_LIMIT` | constant | the three routes load `caps.exportRows` |
| `/vouchers` slice | constant | loads `caps.voucherScreenRows` |
| `loginLockout`, `loginFailureSummary` | constants | `limits: { windowMinutes, emailFreeFailures, ipFreeFailures }` in args; `auth.config.ts` and `listUsers` load them |
| `normaliseDetails(input, current)` | free text | `(input, current, { categories })`: an unknown category → `DomainError('UNKNOWN_CATEGORY', …)` |
| `checkPlannedOutflowInput(input)` | free text | `(input, { categories })`: same refusal |

The importer's own category set in `field-sniffer.ts` stays a constant: it classifies register
cells on a retired path and is the registry's default list.

## C. Writes — `lib/settings/actions.ts`

FINANCE_ADMIN only, enforced in the server action (returning a refusal, never redirecting) and
again in the function. `updateSetting(db, { key, text, userId, now })`: parse against the
registry, refuse with the registry's message, upsert the row, one `setting_changed` audit row
(`checkId` null, `details: { key, from, to }`, both as stored text). `resetSetting(db, { key,
userId, now })`: delete the row, `setting_reset` with the same details. Saving a value equal to
what is in force writes nothing.

Removing a category that a cheque or a planned line still carries is **allowed**: the list governs
what may be typed from now on, not what was recorded; the screen shows how many cheques and lines
carry each category so the admin knows.

## D. The screen — `app/admin/settings/page.tsx`

A sixth admin tab, SETTINGS. One card per group. Each row: label, help, the field (a number input
with `min`/`max` for an int; a textarea one-per-line for the list), DEFAULT n beside it, SAVE, and
RESET TO DEFAULT only when a row exists. A row whose stored value is out of bounds says so. The
LOGIN card carries one sentence: *These can be tightened freely; they cannot be loosened past the
floor shown.* The CATEGORIES card lists each category with its cheque and planned-line counts.

## E. Categories on the two forms

`DetailsForm` and `PlannedOutflowForm` render CATEGORY as a `<select>` from `settings.categories`
(the cheque's with an empty "—" option, since a cheque may have none). A cheque whose recorded
category is no longer on the list shows it as a disabled first option so the form does not
silently blank it on the next save.

## F. One migration, data only

`20260912000200_settings_seed_categories`: inserts the `categories` row from the distinct
categories on every cheque and planned line, unioned with the importer's nine, upper-cased and
trimmed, `ON CONFLICT DO NOTHING`. Nothing already recorded becomes invalid. No schema change.

## Plumbing

| file | responsibility |
| --- | --- |
| `lib/settings/registry.ts` | **Pure.** The ten definitions, parsing, formatting, `isCategory` |
| `lib/settings/read.ts` | `loadSettings`, `loadSetting`, `categoryUsage` |
| `lib/settings/actions.ts` | `updateSetting`, `resetSetting` |
| `lib/sync/staleness.ts`, `lib/admin/sync-overview.ts`, `lib/sync/run.ts`, `lib/bulk.ts`, `lib/clearing-paste.ts`, `lib/login-throttle.ts`, `lib/domain/details.ts`, `lib/domain/planned-outflow.ts` | the parameters |
| `app/page.tsx`, `app/admin/sync/page.tsx`, `app/admin/actions.ts`, `app/api/cron/sync/route.ts`, `app/checks/bulk-actions.ts`, `app/clearing/actions.ts`, `app/clearing/page.tsx`, `app/api/export/{route,audit/route,forecast/route}.ts`, `app/vouchers/page.tsx`, `auth.config.ts`, `lib/admin/users.ts`, `app/admin/users/page.tsx`, `lib/domain/actions.ts`, `lib/planned-outflow/actions.ts`, `app/checks/[id]/page.tsx`, `app/forecast/planned/page.tsx` | load and pass |
| `components/BulkActionBar.tsx`, `ClearingPaste.tsx`, `DetailsForm.tsx`, `PlannedOutflowForm.tsx` | props instead of constants |
| `app/admin/settings/page.tsx`, `app/admin/settings/actions.ts`, `components/SettingsForm.tsx`, `app/admin/layout.tsx` | the screen |
| `prisma/migrations/20260912000200_settings_seed_categories/migration.sql` | F |

## Testing

Targeted: `tests/settings/registry.test.ts` (bounds, list parsing, formatting, `isCategory`),
`tests/settings/read.test.ts` (defaults, an override, an out-of-bounds row falls back and is
flagged), `tests/settings/actions.test.ts` (save, refuse, reset, audit rows, no-op), each consumer's
existing test file extended by one case passing a non-default value (`sync/staleness`,
`admin/sync-overview` if present else `sync/run`, `actions/bulk-selection`, `clearing-paste`,
`auth/login-throttle`, `domain/details`, `domain/planned-outflow`), `tests/actions/settings-actions.test.ts`
(a FINANCE_USER refused). `npx tsc --noEmit`; `next build`.

## Not in this design

- **Per-user preferences.** These are the system's settings.
- **Forecast bucket edges, the back-off schedule, retention, the sync overlap.**
- **Editing the importer's category set.** Retired path.
