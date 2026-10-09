# Self-Registration with Admin Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/signup` page creates an inactive, pending Finance account; a FINANCE_ADMIN approves it with a role (or rejects it) on `/admin/users`.

**Architecture:** One nullable column `User.pendingSince` marks a self-registered account awaiting approval; "pending" is `active = false AND pendingSince IS NOT NULL`, defined once in `lib/admin/users.ts`. Registering with an inactive account's address re-opens that account instead of being refused. A per-IP registration throttle lives in Postgres (`RegistrationAttempt`), modelled on the login throttle, with its allowance as a setting. The sign-in gate is untouched: an inactive account is refused exactly as before.

**Tech Stack:** Next.js 15 App Router (server actions), Prisma 6 / PostgreSQL (Neon), NextAuth v5, argon2id, Vitest, TypeScript strict. Spec: `docs/superpowers/specs/2026-10-09-self-registration-design.md`.

## Global Constraints

- Spell **check**, never "cheque", in every visible string and in new comments (user ruling 2026-10-06).
- **No delete-user path.** Rule 6. The export-shape test in `tests/admin/users.test.ts` must keep asserting no export matches `/delete|remove|destroy|purge/i`.
- **Rule 4 untouched**: nothing here writes `Check.status`.
- **Audit rows only through `writeAudit`** (`lib/audit.ts`). Never the password or the hash in `details` or `remarks`.
- **A server action refuses a FINANCE_USER by RETURNING `{ ok: false, message }`**, never by redirecting: `requireUser()` outside any try, then an explicit role test that returns.
- **The password field is read untrimmed**; every other field is trimmed.
- **No shape returned to the browser may carry `passwordHash`.** `registerUser` returns `void`.
- **Settings are read at request time** through `loadSettings(prisma)`; a constant is only a default.
- **The counter is in Postgres**, never process memory (Vercel is serverless).
- **Windows:** run tests with `node node_modules/vitest/vitest.mjs run <file>` and tsc with `node node_modules/typescript/bin/tsc --noEmit` from Git Bash (`npx.cmd` mis-tokenises; PowerShell blocks `npx.ps1`).
- **One agent at a time against the test database.** Narrow test runs only; the full suite is ~20 minutes and is run before merge, not per task.
- **`node node_modules/typescript/bin/tsc --noEmit` must pass before any task is called done.** Vitest erases types.
- **Migrations reach the TEST database before the suite** (`node scripts/migrate.mjs test`) and **PRODUCTION before the deploy** (`node scripts/migrate.mjs prod --confirm`). The local `.env` names PRODUCTION; never run the dev server or a script against it casually.
- Work on branch `feature/self-registration` cut from `master`. Commit after every task. Do NOT commit `docs/deployment.md` (another session's uncommitted change) or the `For fun/` folder.

---

## File map

| Path | Change | Responsibility |
| --- | --- | --- |
| `prisma/schema.prisma` | modify | `User.pendingSince`, `model RegistrationAttempt` |
| `prisma/migrations/20261009000000_self_registration/migration.sql` | create | the DDL |
| `tests/helpers/db.ts` | modify | truncate `registrationAttempt` in `resetDb` |
| `lib/settings/defaults.ts` | modify | `DEFAULT_SIGNUP_IP_PER_HOUR = 5` |
| `lib/settings/registry.ts` | modify | `signup.ipPerHour` in `IntKey` and `SETTINGS` |
| `tests/settings/registry.test.ts` | modify | count 11 → 12, pin the new key |
| `lib/registration-throttle.ts` | create | `registrationLockout`, `recordRegistrationAttempt`, `pruneRegistrationAttempts` |
| `tests/auth/registration-throttle.test.ts` | create | the throttle's rules |
| `lib/admin/users.ts` | modify | `isPending`, `registerUser`, `approveUser`, `rejectUser`, pending guard in `setUserActive`, `AdminUserRow` additions |
| `tests/admin/users.test.ts` | modify | shape test + the new behaviours |
| `lib/public-paths.ts` | modify | `/signup` public |
| `tests/public-paths.test.ts` | modify | pin it |
| `app/signup/actions.ts` | create | `registerAction` |
| `tests/actions/signup.test.ts` | create | the action's rules |
| `app/signup/page.tsx` | create | the page (server) |
| `components/SignupForm.tsx` | create | the form (client) |
| `app/login/page.tsx`, `app/welcome/page.tsx` | modify | links to `/signup` |
| `app/admin/users/actions.ts` | modify | `approveUserAction`, `rejectUserAction` |
| `tests/admin/user-actions.test.ts` | modify | the two actions refuse a FINANCE_USER by returning; happy paths |
| `components/PendingUserActions.tsx` | create | APPROVE (with role) and REJECT per pending row |
| `app/admin/users/page.tsx` | modify | PENDING APPROVAL section; table excludes pending; count line |
| `components/AdminTabs.tsx`, `app/admin/layout.tsx` | modify | pending badge on USERS |
| `CLAUDE.md` | modify | a short entry; "eleven settings" → twelve |

---

### Task 1: Branch, schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (the `User` model at ~line 792; after `model LoginAttempt` at ~line 878)
- Create: `prisma/migrations/20261009000000_self_registration/migration.sql`
- Modify: `tests/helpers/db.ts` (`resetDb`, the line `await tx.loginAttempt.deleteMany()`)

**Interfaces:**
- Produces: `User.pendingSince: Date | null`; Prisma model `registrationAttempt` with `{ id, ip, email, createdAt }`.

- [ ] **Step 1: Create the branch**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git status --short && git checkout -b feature/self-registration
```

Expected: only ` M docs/deployment.md` and `?? "For fun/"` are dirty; both stay uncommitted throughout.

- [ ] **Step 2: Add the column and the model to the schema**

In `prisma/schema.prisma`, inside `model User`, after `lastLoginAt  DateTime?`:

```prisma
  /// Set when the account was created, or re-opened, by self-registration
  /// (`/signup`) and no admin has yet approved or rejected it; cleared by
  /// both. An account is PENDING when `active = false AND pendingSince IS NOT
  /// NULL`. An inactive account with this null is DEACTIVATED, as before.
  /// `isPending` in lib/admin/users.ts is the one definition.
  pendingSince DateTime?
```

After the closing `}` of `model LoginAttempt`:

```prisma
/// The self-registration throttle's counter (lib/registration-throttle.ts).
/// One row per submission of `/signup`, whether it created an account, was
/// refused by the throttle or was refused by the domain. A table, not a
/// process-local map, for the reason `LoginAttempt` is one: Vercel is
/// serverless. No foreign key to `User`: most refused submissions name no
/// account.
model RegistrationAttempt {
  id        String   @id @default(cuid())
  /// As `clientIp()` derived it, or the literal 'unknown'. Never null — a
  /// shared 'unknown' bucket over-throttles, which is the right way to be wrong.
  ip        String
  email     String
  createdAt DateTime @default(now())

  @@index([ip, createdAt])
  @@index([createdAt])
}
```

- [ ] **Step 3: Write the migration**

Create `prisma/migrations/20261009000000_self_registration/migration.sql`:

```sql
-- Self-registration with admin approval (spec 2026-10-09-self-registration-design.md).
--
-- `pendingSince` marks an account created or re-opened from /signup that no
-- admin has approved or rejected yet. Pending = inactive AND pendingSince set.
-- An inactive account with it null is deactivated, exactly as before, so no
-- existing row changes meaning.
ALTER TABLE "User" ADD COLUMN "pendingSince" TIMESTAMP(3);

-- The registration throttle's counter. A table for the same reason
-- "LoginAttempt" is one: Vercel is serverless, a module-scope Map is
-- per-instance and starts at zero on every cold start. No FK to "User" —
-- a refused submission names no account.
CREATE TABLE "RegistrationAttempt" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationAttempt_pkey" PRIMARY KEY ("id")
);

-- The throttle read is (ip, createdAt) inside a rolling hour.
CREATE INDEX "RegistrationAttempt_ip_createdAt_idx" ON "RegistrationAttempt"("ip", "createdAt");
-- The retention prune runs on every write; without this it is a sequential scan.
CREATE INDEX "RegistrationAttempt_createdAt_idx" ON "RegistrationAttempt"("createdAt");
```

- [ ] **Step 4: Truncate the new table in `resetDb`**

In `tests/helpers/db.ts`, directly after `await tx.loginAttempt.deleteMany()`:

```ts
    // The registration throttle's counter, likewise no child of User and
    // likewise truncated so one file's submissions cannot lock another file's
    // sign-up test out of its own address bucket.
    await tx.registrationAttempt.deleteMany()
```

- [ ] **Step 5: Generate the client and apply the migration to the TEST database**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && npx.cmd prisma generate && node scripts/migrate.mjs test
```

Expected: `prisma generate` succeeds; the migrate script prints the test host/database and applies `20261009000000_self_registration`. (Run from Git Bash; `npx.cmd` is fine when no `|` is in the arguments.)

- [ ] **Step 6: Typecheck and run the smoke test**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/typescript/bin/tsc --noEmit && node node_modules/vitest/vitest.mjs run tests/smoke.test.ts
```

Expected: tsc silent; smoke test passes.

- [ ] **Step 7: Commit**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add prisma/schema.prisma prisma/migrations/20261009000000_self_registration/migration.sql tests/helpers/db.ts && git commit -m "feat(schema): User.pendingSince and RegistrationAttempt for self-registration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The `signup.ipPerHour` setting

**Files:**
- Modify: `lib/settings/defaults.ts`
- Modify: `lib/settings/registry.ts` (imports at top; `IntKey` ~line 40; `SETTINGS` after the `login.ipFreeFailures` entry ~line 84)
- Test: `tests/settings/registry.test.ts` (~line 35)

**Interfaces:**
- Produces: `DEFAULT_SIGNUP_IP_PER_HOUR` (number, 5); setting key `'signup.ipPerHour'` readable as `settings.values['signup.ipPerHour']`.

- [ ] **Step 1: Write the failing tests**

In `tests/settings/registry.test.ts`, change the count test and add a pin:

```ts
  it('declares twelve settings, each key once', () => {
    expect(SETTINGS).toHaveLength(12)
    expect(new Set(SETTING_KEYS).size).toBe(12)
  })

  it('declares the registration allowance as a LOGIN setting, five an hour by default', () => {
    const def = settingDef('signup.ipPerHour')
    expect(def).toMatchObject({ kind: 'int', group: 'LOGIN', default: 5, min: 1, max: 100 })
    expect(DEFAULTS['signup.ipPerHour']).toBe(5)
    expect(parseSettingText(def!, '0').ok).toBe(false)
    expect(parseSettingText(def!, '101').ok).toBe(false)
  })
```

- [ ] **Step 2: Run to verify failure**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/settings/registry.test.ts
```

Expected: FAIL — length 11 ≠ 12, `settingDef('signup.ipPerHour')` undefined.

- [ ] **Step 3: Add the default**

Append to `lib/settings/defaults.ts`:

```ts
/**
 * Registrations one client address may submit on /signup per rolling hour.
 * Five covers a Finance office behind one NAT signing up on the same morning
 * with room for a mistyped form; a bot exhausts it in seconds and waits.
 */
export const DEFAULT_SIGNUP_IP_PER_HOUR = 5
```

Also change the file's first comment line `THE NINE NUMBERS, AS A LEAF.` to `THE NUMBERS, AS A LEAF.`

- [ ] **Step 4: Register the key**

In `lib/settings/registry.ts`:

Add to the import list from `./defaults`:
```ts
  DEFAULT_SIGNUP_IP_PER_HOUR as SIGNUP_IP_PER_HOUR,
```

Extend `IntKey`:
```ts
export type IntKey =
  | 'sync.staleAfterHours' | 'sync.abandonedAfterMinutes' | 'sync.inProgressMinutes'
  | 'caps.bulkSelection' | 'caps.exportRows' | 'caps.voucherScreenRows'
  | 'login.windowMinutes' | 'login.emailFreeFailures' | 'login.ipFreeFailures'
  | 'signup.ipPerHour'
  | 'autoSign.mondayEnabled'
```
(Keep whatever the existing last line of the union is; only insert `'signup.ipPerHour'`.)

Insert into `SETTINGS` after the `login.ipFreeFailures` entry:
```ts
  { kind: 'int', key: 'signup.ipPerHour', group: 'LOGIN', label: 'REGISTRATIONS PER ADDRESS PER HOUR', unit: 'accounts',
    help: 'How many accounts one client address may create on the sign-up page in a rolling hour. Every submission counts, accepted or refused.',
    default: SIGNUP_IP_PER_HOUR, min: 1, max: 100 },
```

Change the comment `THE ELEVEN KNOBS, DECLARED ONCE.` to `THE TWELVE KNOBS, DECLARED ONCE.` and in `app/admin/settings/page.tsx` line 10 `Eleven knobs` to `Twelve knobs`.

- [ ] **Step 5: Run to verify pass**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/settings && node node_modules/typescript/bin/tsc --noEmit
```

Expected: all settings tests pass (`read`, `actions` included — they iterate `SETTINGS`); tsc silent.

- [ ] **Step 6: Commit**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add lib/settings/defaults.ts lib/settings/registry.ts app/admin/settings/page.tsx tests/settings/registry.test.ts && git commit -m "feat(settings): signup.ipPerHour - registrations per address per hour, default 5

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The registration throttle

**Files:**
- Create: `lib/registration-throttle.ts`
- Test: `tests/auth/registration-throttle.test.ts`

**Interfaces:**
- Consumes: `clientIp`, `UNKNOWN_IP`, `RETENTION_DAYS` from `@/lib/login-throttle` (existing).
- Produces:
  - `REGISTRATION_WINDOW_MINUTES = 60`
  - `registrationLockout(db: PrismaClient, args: { ip: string; now: Date; limit: number }): Promise<{ locked: boolean; recent: number }>`
  - `recordRegistrationAttempt(db: PrismaClient, args: { ip: string; email: string; now: Date }): Promise<void>`
  - `pruneRegistrationAttempts(db: PrismaClient, args: { now: Date }): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Create `tests/auth/registration-throttle.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { RETENTION_DAYS, UNKNOWN_IP } from '@/lib/login-throttle'
import {
  REGISTRATION_WINDOW_MINUTES,
  pruneRegistrationAttempts, recordRegistrationAttempt, registrationLockout,
} from '@/lib/registration-throttle'

beforeEach(resetDb)

const NOW = new Date('2026-10-09T08:00:00.000Z')
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000)
const IP = '203.0.113.9'
const LIMIT = 5

async function attempt(o: { ip?: string; email?: string; at?: Date } = {}) {
  return testDb.registrationAttempt.create({
    data: { ip: o.ip ?? IP, email: o.email ?? 'someone@example.com', createdAt: o.at ?? minutesBefore(1) },
  })
}

describe('registrationLockout', () => {
  it('admits an address under the limit', async () => {
    for (let i = 0; i < LIMIT - 1; i++) await attempt()
    expect(await registrationLockout(testDb, { ip: IP, now: NOW, limit: LIMIT })).toEqual({ locked: false, recent: LIMIT - 1 })
  })

  it('refuses an address at the limit', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt()
    expect(await registrationLockout(testDb, { ip: IP, now: NOW, limit: LIMIT })).toEqual({ locked: true, recent: LIMIT })
  })

  it('does not count submissions older than the hour', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt({ at: minutesBefore(REGISTRATION_WINDOW_MINUTES + 1) })
    expect((await registrationLockout(testDb, { ip: IP, now: NOW, limit: LIMIT })).locked).toBe(false)
  })

  it('counts only the asking address', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt({ ip: '198.51.100.7' })
    expect((await registrationLockout(testDb, { ip: IP, now: NOW, limit: LIMIT })).locked).toBe(false)
  })

  // The shared bucket over-throttles rather than under-throttles. Deliberate.
  it('throttles the unknown-address bucket like any other', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt({ ip: UNKNOWN_IP })
    expect((await registrationLockout(testDb, { ip: UNKNOWN_IP, now: NOW, limit: LIMIT })).locked).toBe(true)
  })
})

describe('recordRegistrationAttempt', () => {
  it('writes the row and prunes rows past retention in the same call', async () => {
    await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60_000) })
    await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })
    const rows = await testDb.registrationAttempt.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ip: IP, email: 'new@example.com', createdAt: NOW })
  })
})

describe('pruneRegistrationAttempts', () => {
  it('drops only rows past retention and says how many', async () => {
    await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60_000) })
    await attempt({ at: minutesBefore(5) })
    expect(await pruneRegistrationAttempts(testDb, { now: NOW })).toBe(1)
    expect(await testDb.registrationAttempt.count()).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/auth/registration-throttle.test.ts
```

Expected: FAIL — cannot resolve `@/lib/registration-throttle`.

- [ ] **Step 3: Write the module**

Create `lib/registration-throttle.ts`:

```ts
import type { PrismaClient } from '@prisma/client'
import { RETENTION_DAYS } from '@/lib/login-throttle'

/**
 * The self-registration throttle (`/signup`, `RegistrationAttempt`).
 *
 * `/signup` is public by definition, and every submission creates a row an
 * admin then has to look at. This bounds how many one client address can
 * create in an hour. It is the login throttle's shape with one bucket: there
 * is no per-email bucket because an email is the thing being created here,
 * not a thing being guessed.
 *
 * **The counter is in Postgres and must stay there.** Same reason as
 * `lib/login-throttle.ts`: Vercel is serverless, a module-scope Map is
 * per-instance and starts at zero on every cold start. `clientIp` from the
 * login throttle supplies the address, with the same rightmost-entry rule and
 * the same shared `unknown` bucket, which is deliberately NOT exempt.
 *
 * The allowance is the setting `signup.ipPerHour`; callers read it through
 * `loadSettings` at request time and pass it in. Nothing here reads a
 * constant as the limit.
 */

export const REGISTRATION_WINDOW_MINUTES = 60

const MINUTE = 60_000

function windowStart(now: Date): Date {
  return new Date(now.getTime() - REGISTRATION_WINDOW_MINUTES * MINUTE)
}

function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * MINUTE)
}

/**
 * Whether this address has used up its hour. `recent` is the count the
 * decision was taken on, for a log line or a test.
 */
export async function registrationLockout(
  db: PrismaClient,
  args: { ip: string; now: Date; limit: number },
): Promise<{ locked: boolean; recent: number }> {
  const recent = await db.registrationAttempt.count({
    where: { ip: args.ip, createdAt: { gte: windowStart(args.now) } },
  })
  return { locked: recent >= args.limit, recent }
}

/**
 * Record one submission — accepted, refused by this throttle, or refused by
 * the domain — and prune the table as we go. Every submission counts, so
 * hammering a refused form extends the wait rather than resetting it. The
 * prune rides in the write path because this project has no cron for it, as
 * `recordLoginAttempt` does.
 */
export async function recordRegistrationAttempt(
  db: PrismaClient,
  args: { ip: string; email: string; now: Date },
): Promise<void> {
  await db.$transaction([
    db.registrationAttempt.create({
      data: { ip: args.ip, email: args.email, createdAt: args.now },
    }),
    db.registrationAttempt.deleteMany({ where: { createdAt: { lt: retentionCutoff(args.now) } } }),
  ])
}

/** A one-off clear-out, so nobody invents a raw DELETE against this table. */
export async function pruneRegistrationAttempts(
  db: PrismaClient,
  args: { now: Date },
): Promise<number> {
  const { count } = await db.registrationAttempt.deleteMany({
    where: { createdAt: { lt: retentionCutoff(args.now) } },
  })
  return count
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/auth/registration-throttle.test.ts && node node_modules/typescript/bin/tsc --noEmit
```

Expected: 7 tests pass; tsc silent.

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add lib/registration-throttle.ts tests/auth/registration-throttle.test.ts && git commit -m "feat(signup): per-address registration throttle in Postgres

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Domain — `isPending`, `registerUser`, `approveUser`, `rejectUser`

**Files:**
- Modify: `lib/admin/users.ts`
- Test: `tests/admin/users.test.ts`

**Interfaces:**
- Produces (all exported from `@/lib/admin/users`):
  - `isPending(u: { active: boolean; pendingSince: Date | null }): boolean`
  - `registerUser(db: PrismaClient, args: { email: string; name: string; password: string }): Promise<void>`
  - `approveUser(db: PrismaClient, args: { userId: string; role: Role; actorId: string }): Promise<AdminUserRow>`
  - `rejectUser(db: PrismaClient, args: { userId: string; actorId: string }): Promise<AdminUserRow>`
  - `AdminUserRow` gains `pendingSince: Date | null` and `previouslyDeactivated: boolean`.
- Audit action names: `user_registered`, `user_reregistered`, `user_approved`, `user_rejected`.
- `DomainError` codes: `EMAIL_TAKEN` (short wording for a stranger), `NOT_PENDING`, `PENDING`.

- [ ] **Step 1: Write the failing tests**

In `tests/admin/users.test.ts`:

Extend the import:
```ts
import {
  SEEDED_TEST_ACCOUNT_EMAILS,
  approveUser, changeUserRole, createUser, isPending, listUsers, registerUser, rejectUser,
  setUserActive, setUserPassword,
} from '@/lib/admin/users'
```

Replace the expected export list in `offers no delete of any kind`:
```ts
    expect(exported).toEqual([
      'SEEDED_TEST_ACCOUNT_EMAILS',
      'approveUser',
      'changeUserRole',
      'createUser',
      'isPending',
      'listUsers',
      'registerUser',
      'rejectUser',
      'setUserActive',
      'setUserPassword',
    ])
```

Append at the end of the file:

```ts
describe('isPending', () => {
  it('is inactive with pendingSince set, and nothing else', () => {
    const t = new Date()
    expect(isPending({ active: false, pendingSince: t })).toBe(true)
    expect(isPending({ active: false, pendingSince: null })).toBe(false)
    expect(isPending({ active: true, pendingSince: t })).toBe(false)
    expect(isPending({ active: true, pendingSince: null })).toBe(false)
  })
})

describe('registerUser', () => {
  it('creates an inactive pending account, hashed, with a SYSTEM audit row and no return value', async () => {
    const result = await registerUser(testDb, { email: ' New.Person@RCL.com.ph ', name: ' New Person ', password: STRONG })
    expect(result).toBeUndefined()

    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'new.person@rcl.com.ph' } })
    expect(u).toMatchObject({ name: 'New Person', active: false, role: 'FINANCE_USER' })
    expect(u.pendingSince).not.toBeNull()
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)

    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ checkId: null, actorType: 'SYSTEM', userId: null, action: 'user_registered', remarks: 'new.person@rcl.com.ph' })
    expect(row.details).toMatchObject({ targetUserId: u.id, email: 'new.person@rcl.com.ph', name: 'New Person' })
    const trail = await auditText()
    expect(trail).not.toContain(STRONG)
    expect(trail).not.toContain(u.passwordHash)
  })

  it('enforces the password policy and requires a name', async () => {
    await expect(registerUser(testDb, { email: 'x@rcl.com.ph', name: 'X', password: 'short' }))
      .rejects.toMatchObject({ code: 'WEAK_PASSWORD' })
    await expect(registerUser(testDb, { email: 'x@rcl.com.ph', name: '  ', password: STRONG }))
      .rejects.toMatchObject({ code: 'NAME_REQUIRED' })
    expect(await testDb.user.count()).toBe(0)
  })

  it('refuses an ACTIVE account\'s address with a sentence that gives nothing away', async () => {
    await makeFinanceUser({ email: 'taken@rcl.com.ph' })
    const err = await registerUser(testDb, { email: 'taken@rcl.com.ph', name: 'Someone', password: STRONG }).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('EMAIL_TAKEN')
    expect(err.message).toBe('An account for that address already exists.')
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('re-opens a DEACTIVATED account: same id, new name and password, pending, still inactive', async () => {
    const old = await testDb.user.create({
      data: { email: 'ayessa@rcl.com.ph', name: 'Old Name', passwordHash: 'x', role: 'FINANCE_ADMIN', active: false },
    })
    await registerUser(testDb, { email: 'ayessa@rcl.com.ph', name: 'Ayessa Morinne', password: STRONG })

    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'ayessa@rcl.com.ph' } })
    expect(u.id).toBe(old.id)
    expect(u).toMatchObject({ name: 'Ayessa Morinne', active: false, role: 'FINANCE_ADMIN' })
    expect(u.pendingSince).not.toBeNull()
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)
    expect(await testDb.user.count()).toBe(1)

    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ actorType: 'SYSTEM', userId: null, action: 'user_reregistered' })
    expect(row.details).toMatchObject({ targetUserId: old.id, email: 'ayessa@rcl.com.ph', name: 'Ayessa Morinne' })
  })

  it('re-opens an account that is already pending (a forgotten password before approval)', async () => {
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'First Try', password: STRONG })
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Second Try', password: STRONG_TWO })
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    expect(u.name).toBe('Second Try')
    expect(await verifyPassword(u.passwordHash, STRONG_TWO)).toBe(true)
    expect(isPending(u)).toBe(true)
    const actions = (await testDb.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map((r) => r.action)
    expect(actions).toEqual(['user_registered', 'user_reregistered'])
  })
})

describe('approveUser', () => {
  it('activates a pending account with the chosen role and records who approved it', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending Person', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })

    const row = await approveUser(testDb, { userId: pending.id, role: 'FINANCE_ADMIN', actorId: actor.id })
    expect(row).toMatchObject({ id: pending.id, role: 'FINANCE_ADMIN', active: true, pendingSince: null })
    expect(Object.keys(row)).not.toContain('passwordHash')

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'user_approved' } })
    expect(audit).toMatchObject({ actorType: 'USER', userId: actor.id, remarks: 'p@rcl.com.ph' })
    expect(audit.details).toMatchObject({ targetUserId: pending.id, email: 'p@rcl.com.ph', role: 'FINANCE_ADMIN' })
  })

  it('refuses an account that is not pending', async () => {
    const actor = await makeAdmin()
    const deactivated = await makeFinanceUser({ active: false })
    const active = await makeFinanceUser()
    for (const t of [deactivated, active]) {
      await expect(approveUser(testDb, { userId: t.id, role: 'FINANCE_USER', actorId: actor.id }))
        .rejects.toMatchObject({ code: 'NOT_PENDING' })
    }
  })
})

describe('rejectUser', () => {
  it('clears the flag and leaves the account deactivated', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending Person', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })

    const row = await rejectUser(testDb, { userId: pending.id, actorId: actor.id })
    expect(row).toMatchObject({ id: pending.id, active: false, pendingSince: null })

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'user_rejected' } })
    expect(audit).toMatchObject({ actorType: 'USER', userId: actor.id })
    expect(audit.details).toMatchObject({ targetUserId: pending.id, email: 'p@rcl.com.ph' })

    // A rejected account is an ordinary deactivated one: REACTIVATE works on it.
    await setUserActive(testDb, { userId: pending.id, active: true, actorId: actor.id })
    expect((await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })).active).toBe(true)
  })

  it('refuses an account that is not pending', async () => {
    const actor = await makeAdmin()
    const t = await makeFinanceUser({ active: false })
    await expect(rejectUser(testDb, { userId: t.id, actorId: actor.id })).rejects.toMatchObject({ code: 'NOT_PENDING' })
  })
})

describe('a pending account on the existing controls', () => {
  it('cannot be REACTIVATED past the approval step', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending Person', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const err = await setUserActive(testDb, { userId: pending.id, active: true, actorId: actor.id }).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('PENDING')
    expect(err.message).toMatch(/PENDING APPROVAL/)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })).active).toBe(false)
  })

  it('is listed with pendingSince and whether it was previously deactivated', async () => {
    await registerUser(testDb, { email: 'fresh@rcl.com.ph', name: 'Fresh', password: STRONG })
    await testDb.user.create({
      data: { email: 'back@rcl.com.ph', name: 'Was Here', passwordHash: 'x', role: 'FINANCE_USER', active: false },
    })
    await registerUser(testDb, { email: 'back@rcl.com.ph', name: 'Back Again', password: STRONG })
    await makeFinanceUser({ email: 'z.active@rcl.com.ph' })

    const rows = await listUsers(testDb)
    const fresh = rows.find((r) => r.email === 'fresh@rcl.com.ph')!
    const back = rows.find((r) => r.email === 'back@rcl.com.ph')!
    const active = rows.find((r) => r.email === 'z.active@rcl.com.ph')!
    expect(fresh.pendingSince).not.toBeNull()
    expect(fresh.previouslyDeactivated).toBe(false)
    expect(back.pendingSince).not.toBeNull()
    expect(back.previouslyDeactivated).toBe(true)
    expect(active.pendingSince).toBeNull()
    expect(active.previouslyDeactivated).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/admin/users.test.ts
```

Expected: FAIL — `registerUser`/`approveUser`/`rejectUser`/`isPending` are not exported; the shape test fails.

- [ ] **Step 3: Implement in `lib/admin/users.ts`**

(a) Extend the row type and select. Replace the `AdminUserRow` fields block's tail and `ROW_SELECT` / `SelectedUser`:

```ts
export type AdminUserRow = {
  id: string
  name: string
  email: string
  role: Role
  active: boolean
  lastLoginAt: Date | null
  createdAt: Date
  /**
   * Set while a self-registered account waits for an admin. PENDING is
   * `!active && pendingSince !== null` — `isPending` — and is neither ACTIVE
   * nor DEACTIVATED on the screen.
   */
  pendingSince: Date | null
  /**
   * True when the most recent registration of this account re-opened a row
   * that already existed (`user_reregistered`). The admin's one defence
   * against somebody re-registering a deactivated colleague's address with
   * their own password: the PENDING list says so against the row.
   */
  previouslyDeactivated: boolean
  /** Seeded by `prisma/seed.ts` with a password anyone can read in git. */
  isSeededTestAccount: boolean
  recentFailedLogins: number
  lockedUntil: Date | null
}

const ROW_SELECT = {
  id: true, name: true, email: true, role: true,
  active: true, lastLoginAt: true, createdAt: true, pendingSince: true,
} as const

type SelectedUser = {
  id: string; name: string; email: string; role: Role
  active: boolean; lastLoginAt: Date | null; createdAt: Date; pendingSince: Date | null
}
```

Keep the existing doc comments on `recentFailedLogins` / `lockedUntil` where they are; only the new fields and `pendingSince` in the select/type are added.

(b) `toRow` takes the flag:

```ts
function toRow(
  u: SelectedUser,
  failures: LoginFailureState = NO_FAILURES,
  previouslyDeactivated = false,
): AdminUserRow {
  return {
    ...u,
    isSeededTestAccount: SEEDED.has(u.email),
    recentFailedLogins: failures.recentFailures,
    lockedUntil: failures.lockedUntil,
    previouslyDeactivated,
  }
}
```

(c) The one definition of pending, exported, placed after `normaliseEmail`:

```ts
/**
 * THE definition of a pending account. Inactive, with the registration flag
 * set. An inactive account with the flag clear is DEACTIVATED, as it always
 * was; approving or rejecting clears the flag. Every screen reads this, not
 * the columns.
 */
export function isPending(u: { active: boolean; pendingSince: Date | null }): boolean {
  return !u.active && u.pendingSince !== null
}
```

(d) `listUsers` reads the re-registration flag for pending rows:

```ts
export async function listUsers(
  db: PrismaClient,
  now: Date = new Date(),
  limits?: ThrottleLimits,
): Promise<AdminUserRow[]> {
  const rows = await db.user.findMany({
    select: ROW_SELECT,
    orderBy: [{ active: 'desc' }, { email: 'asc' }],
  })
  const failures = await loginFailureSummary(db, { emails: rows.map((r) => r.email), now, limits })
  const reopened = await reopenedPendingIds(db, rows.filter(isPending).map((r) => r.id))
  return rows.map((u) => toRow(u, failures.get(u.email), reopened.has(u.id)))
}

/**
 * Of these pending accounts, which were RE-OPENED by their latest
 * registration rather than created by it. The latest `user_registered` /
 * `user_reregistered` row per account decides; a pending account always has
 * one, because only `registerUser` sets the flag.
 */
async function reopenedPendingIds(db: PrismaClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db.auditLog.findMany({
    where: { action: { in: ['user_registered', 'user_reregistered'] } },
    orderBy: { createdAt: 'desc' },
    select: { action: true, details: true },
  })
  const wanted = new Set(ids)
  const latest = new Map<string, string>()
  for (const r of rows) {
    const target = (r.details as { targetUserId?: unknown } | null)?.targetUserId
    if (typeof target !== 'string' || !wanted.has(target) || latest.has(target)) continue
    latest.set(target, r.action)
  }
  return new Set([...latest].filter(([, action]) => action === 'user_reregistered').map(([id]) => id))
}
```

(e) `registerUser`, placed after `createUser`:

```ts
/**
 * Self-registration from `/signup` (spec 2026-10-09).
 *
 * Creates an INACTIVE, PENDING account, or re-opens an inactive one under the
 * same address. Nothing here can produce a signed-in account: `active` is
 * never set true, and `authorize` refuses an inactive account at sign-in. An
 * admin's `approveUser` is the only way in.
 *
 * **An inactive account's address re-registers; an active one's is refused.**
 * The three accounts this was built for had been deactivated and their
 * owners wanted to register again under the same email (user ruling
 * 2026-10-09). The row keeps its id and every attribution it carries; its
 * name and password are replaced with what was just typed. The PENDING list
 * states that the account was re-opened, which is the admin's cue to check
 * it is the colleague they think it is before approving.
 *
 * Returns nothing. There is no shape in which the hash can reach a browser.
 * The audit row is SYSTEM: nobody is signed in.
 */
export async function registerUser(
  db: PrismaClient,
  args: { email: string; name: string; password: string },
): Promise<void> {
  const email = normaliseEmail(args.email)
  const name = args.name.trim()
  if (!email) throw new DomainError('EMAIL_REQUIRED', 'An email address is required.')
  if (!name) throw new DomainError('NAME_REQUIRED', 'A name is required — it is shown against every action this account takes.')
  requirePassword(args.password)

  const passwordHash = await hashPassword(args.password)
  const now = new Date()
  const taken = new DomainError('EMAIL_TAKEN', 'An account for that address already exists.')

  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email }, select: ROW_SELECT })
      if (existing && existing.active) throw taken

      if (existing) {
        await tx.user.update({
          where: { id: existing.id },
          data: { name, passwordHash, pendingSince: now },
        })
        await writeAudit(tx, {
          actorType: 'SYSTEM',
          action: 'user_reregistered',
          details: { targetUserId: existing.id, email, name },
          remarks: email,
        })
        return
      }

      const created = await tx.user.create({
        data: { email, name, passwordHash, active: false, pendingSince: now },
        select: { id: true },
      })
      await writeAudit(tx, {
        actorType: 'SYSTEM',
        action: 'user_registered',
        details: { targetUserId: created.id, email, name },
        remarks: email,
      })
    })
  } catch (e) {
    // Two registrations racing on one new address: the loser's create trips
    // the unique index. Reported with the same sentence — the address exists.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw taken
    throw e
  }
}

/**
 * Approve a pending account: the role the admin chose, active, flag cleared.
 * No last-admin guard applies — this can only add an active account.
 */
export async function approveUser(
  db: PrismaClient,
  args: { userId: string; role: Role; actorId: string },
): Promise<AdminUserRow> {
  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    if (!isPending(target)) {
      throw new DomainError('NOT_PENDING', `${target.name} is not waiting for approval.`)
    }
    const updated = await tx.user.update({
      where: { id: target.id },
      data: { role: args.role, active: true, pendingSince: null },
      select: ROW_SELECT,
    })
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: 'user_approved',
      details: { targetUserId: target.id, email: target.email, role: args.role },
      remarks: `${target.email}: ${args.role}`,
    })
    return toRow(updated)
  })
}

/**
 * Reject a pending account: flag cleared, still inactive. The row stays — an
 * ordinary DEACTIVATED account from here on — so the address cannot re-land on
 * the list silently, and REACTIVATE is there if the rejection was a mistake.
 */
export async function rejectUser(
  db: PrismaClient,
  args: { userId: string; actorId: string },
): Promise<AdminUserRow> {
  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    if (!isPending(target)) {
      throw new DomainError('NOT_PENDING', `${target.name} is not waiting for approval.`)
    }
    const updated = await tx.user.update({
      where: { id: target.id },
      data: { pendingSince: null },
      select: ROW_SELECT,
    })
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: 'user_rejected',
      details: { targetUserId: target.id, email: target.email },
      remarks: target.email,
    })
    return toRow(updated)
  })
}
```

(f) The guard in `setUserActive`. Inside its transaction, after `if (target.active === args.active) return toRow(target)`:

```ts
    // A pending account is activated by APPROVE, which chooses its role.
    // REACTIVATE would let it in under the schema default without anybody
    // having decided that.
    if (args.active && isPending(target)) {
      throw new DomainError(
        'PENDING',
        `${target.name} is waiting for approval. Approve them with a role from the PENDING APPROVAL list instead.`,
      )
    }
```

(g) `createUser`'s `writeAudit` call and `toRow(created)` are unchanged; `created` now carries `pendingSince: null` through `ROW_SELECT`.

- [ ] **Step 4: Run to verify pass**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/admin/users.test.ts && node node_modules/typescript/bin/tsc --noEmit
```

Expected: all pass, including the export-shape test with the 10-name list; tsc silent. If `tsc` complains that `toRow` is called with `previouslyDeactivated` in a place that passes only two arguments, that is fine — the third defaults.

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add lib/admin/users.ts tests/admin/users.test.ts && git commit -m "feat(users): registerUser, approveUser, rejectUser - pending accounts, re-registration of inactive ones

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `/signup` is public

**Files:**
- Modify: `lib/public-paths.ts`
- Test: `tests/public-paths.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/public-paths.test.ts` add:

```ts
  it('lets the sign-up page through, and only exactly it', () => {
    expect(isPublicPath('/signup')).toBe(true)
    expect(isPublicPath('/signupx')).toBe(false)
    expect(isPublicPath('/signup/')).toBe(false)
    expect(isPublicPath('/signup/anything')).toBe(false)
  })
```

- [ ] **Step 2: Run to verify failure**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/public-paths.test.ts
```

Expected: FAIL on `isPublicPath('/signup')`.

- [ ] **Step 3: Add the path**

In `lib/public-paths.ts`, after the `/welcome` line:

```ts
    // Self-registration (2026-10-09). Creates an INACTIVE account only; the
    // page guards itself (a signed-in visitor is redirected) and reads no
    // data. Exact match for the same reason as `/login`.
    pathname === '/signup' ||
```

- [ ] **Step 4: Run to verify pass**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/public-paths.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add lib/public-paths.ts tests/public-paths.test.ts && git commit -m "feat(signup): /signup is public by name

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The `registerAction` server action

**Files:**
- Create: `app/signup/actions.ts`
- Test: `tests/actions/signup.test.ts`

**Interfaces:**
- Consumes: `registerUser` (Task 4), `registrationLockout` / `recordRegistrationAttempt` (Task 3), `clientIp` from `@/lib/login-throttle`, `loadSettings`, `prisma`, `DomainError`, `isNextControlFlowError`.
- Produces: `registerAction(formData: FormData): Promise<SignupResult>` where `export type SignupResult = { ok: true; email: string } | { ok: false; message: string }`. Fields read: `name`, `email`, `password`, `confirm`.
- Next 15: `headers()` from `next/headers` is async — `await headers()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/actions/signup.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { verifyPassword } from '@/lib/password'

// The request headers the action reads the client address from. Mutable so
// one file can play two addresses.
const requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.9' })

vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }))

const STRONG = 'Zq7!vantablack-Ledger'

const fd = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}
const good = (over: Record<string, string> = {}) =>
  fd({ name: 'New Person', email: 'new@rcl.com.ph', password: STRONG, confirm: STRONG, ...over })

beforeEach(async () => {
  await resetDb()
  requestHeaders.set('x-forwarded-for', '203.0.113.9')
})

describe('registerAction', () => {
  it('creates a pending account and reports the address only', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good())
    expect(result).toEqual({ ok: true, email: 'new@rcl.com.ph' })
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'new@rcl.com.ph' } })
    expect(u.active).toBe(false)
    expect(u.pendingSince).not.toBeNull()
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(STRONG)
    expect(await testDb.registrationAttempt.count()).toBe(1)
  })

  it('refuses mismatched passwords before touching the database', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good({ confirm: 'Different-1!Password' }))
    expect(result).toEqual({ ok: false, message: 'The two passwords do not match.' })
    expect(await testDb.user.count()).toBe(0)
    expect(await testDb.registrationAttempt.count()).toBe(0)
  })

  it('does not trim the password', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const spaced = ` ${STRONG} `
    expect((await registerAction(good({ password: spaced, confirm: spaced }))).ok).toBe(true)
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'new@rcl.com.ph' } })
    expect(await verifyPassword(u.passwordHash, spaced)).toBe(true)
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(false)
  })

  it('passes a domain refusal through in its own words, and still records the attempt', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good({ password: 'short', confirm: 'short' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/at least 12 characters/)
    expect(await testDb.registrationAttempt.count()).toBe(1)
  })

  it('refuses an address past its hourly allowance and still records the attempt', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const now = new Date()
    for (let i = 0; i < 5; i++) {
      await testDb.registrationAttempt.create({ data: { ip: '203.0.113.9', email: `bot${i}@x.com`, createdAt: now } })
    }
    const result = await registerAction(good())
    expect(result).toEqual({ ok: false, message: 'Too many accounts have been created from this connection. Try again later.' })
    expect(await testDb.user.count()).toBe(0)
    expect(await testDb.registrationAttempt.count()).toBe(6)

    // Another address is unaffected.
    requestHeaders.set('x-forwarded-for', '198.51.100.7')
    expect((await registerAction(good())).ok).toBe(true)
  })

  it('honours the allowance setting', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    await testDb.setting.create({ data: { key: 'signup.ipPerHour', value: '1' } })
    expect((await registerAction(good())).ok).toBe(true)
    expect((await registerAction(good({ email: 'second@rcl.com.ph' }))).ok).toBe(false)
  })
})
```

Note: check `prisma/schema.prisma`'s `model Setting` for the column names (`key`, `value`) before running; `lib/settings/read.ts` reads `r.key` and `r.value`, so those are the names.

- [ ] **Step 2: Run to verify failure**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/actions/signup.test.ts
```

Expected: FAIL — cannot resolve `@/app/signup/actions`.

- [ ] **Step 3: Write the action**

Create `app/signup/actions.ts`:

```ts
'use server'

import { headers } from 'next/headers'
import { prisma } from '@/lib/db'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import { clientIp } from '@/lib/login-throttle'
import { recordRegistrationAttempt, registrationLockout } from '@/lib/registration-throttle'
import { registerUser } from '@/lib/admin/users'
import { loadSettings } from '@/lib/settings/read'

/**
 * Self-registration (spec 2026-10-09). PUBLIC: no session is required and
 * none is created. The account it makes is inactive and pending; an admin's
 * APPROVE on /admin/users is the only way it becomes usable.
 *
 * Order: passwords match → throttle → domain → record the attempt. The
 * attempt is recorded whether the registration was accepted, refused by the
 * throttle or refused by the domain, so hammering a refused form extends the
 * wait. A mismatched pair is refused before any database work and is not an
 * attempt against anything.
 *
 * On success the result carries the address and nothing else; on failure a
 * sentence. A domain error's wording is for the person at the form (the
 * password policy, "already exists"); anything else is logged — the thrown
 * error only, never the form — and the person gets a fixed sentence.
 */

export type SignupResult = { ok: true; email: string } | { ok: false; message: string }

const THROTTLED = 'Too many accounts have been created from this connection. Try again later.'

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()
/** Untrimmed: a leading or trailing space is a legitimate password character, and sign-in does not trim. */
const raw = (f: FormData, k: string) => String(f.get(k) ?? '')

export async function registerAction(formData: FormData): Promise<SignupResult> {
  const name = str(formData, 'name')
  const email = str(formData, 'email').toLowerCase()
  const password = raw(formData, 'password')
  const confirm = raw(formData, 'confirm')

  if (password !== confirm) return { ok: false, message: 'The two passwords do not match.' }

  const now = new Date()
  const ip = clientIp(await headers())
  const settings = await loadSettings(prisma)
  const limit = settings.values['signup.ipPerHour']

  try {
    const { locked } = await registrationLockout(prisma, { ip, now, limit })
    if (locked) return { ok: false, message: THROTTLED }

    try {
      await registerUser(prisma, { email, name, password })
      return { ok: true, email }
    } catch (e) {
      if (e instanceof DomainError) return { ok: false, message: e.message }
      if (isNextControlFlowError(e)) throw e
      console.error(e)
      return { ok: false, message: 'Something went wrong. Please try again.' }
    }
  } finally {
    await recordRegistrationAttempt(prisma, { ip, email, now })
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/actions/signup.test.ts && node node_modules/typescript/bin/tsc --noEmit
```

Expected: 6 tests pass; tsc silent.

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add app/signup/actions.ts tests/actions/signup.test.ts && git commit -m "feat(signup): registerAction - match, throttle, register, record

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The `/signup` page and its links

**Files:**
- Create: `components/SignupForm.tsx`
- Create: `app/signup/page.tsx`
- Modify: `app/login/page.tsx` (the two `<p>` lines after the throttle note, ~line 150)
- Modify: `app/welcome/page.tsx` (the header SIGN IN link ~line 39 and the SIGN IN TO CONTINUE link ~line 66)

**Interfaces:**
- Consumes: `registerAction`, `SignupResult` (Task 6), `MoneyMachines`, `getSessionUser`.

No unit test: pages and client components are not covered by this suite (none of `app/login/page.tsx` or `CreateUserForm.tsx` has one). Verification is `tsc`, `next build`, and the browser check in Task 10.

- [ ] **Step 1: The client form**

Create `components/SignupForm.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { registerAction, type SignupResult } from '@/app/signup/actions'

/**
 * CREATE ACCOUNT. The public half of self-registration (spec 2026-10-09).
 *
 * The password goes one way: into the action, into argon2id, into the column.
 * The result on success carries the address only, and the card is replaced
 * by the waiting message, which also clears the password out of the DOM. No
 * session is created here and nothing here reads data.
 */
export function SignupForm() {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<SignupResult | null>(null)

  const field =
    'h-11 w-full rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 ' +
    'placeholder:text-slate-400 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'
  const label = 'mb-1.5 block text-[11px] font-semibold tracking-widest text-slate-400'

  if (result?.ok) {
    return (
      <div className="rounded-2xl bg-white p-8 shadow-md ring-1 ring-hairline">
        <h2 className="text-sm font-semibold tracking-wide text-navy">ACCOUNT CREATED — WAITING FOR APPROVAL</h2>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          The account for <span className="font-medium text-slate-900">{result.email}</span> has been
          created and is waiting for a Finance Admin to approve it and assign a role. You cannot sign in
          until then; your admin will tell you when you can.
        </p>
        <p className="mt-5 text-center text-xs text-slate-400">
          <Link href="/login" className="underline underline-offset-2 hover:text-navy">Go to sign in</Link>
        </p>
      </div>
    )
  }

  return (
    <form
      className="rounded-2xl bg-white p-8 shadow-md ring-1 ring-hairline"
      onSubmit={(e) => {
        e.preventDefault()
        const formData = new FormData(e.currentTarget)
        startTransition(async () => setResult(await registerAction(formData)))
      }}
    >
      <p className="mb-5 text-sm text-slate-500">
        Create your Finance account. A Finance Admin approves it and assigns your role before you can sign in.
      </p>

      {result && !result.ok && (
        <p className="mb-5 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger-ink">{result.message}</p>
      )}

      <label htmlFor="signup-name" className={label}>NAME</label>
      <input id="signup-name" name="name" required autoComplete="name" className={`${field} mb-4`} />

      <label htmlFor="signup-email" className={label}>EMAIL</label>
      <input id="signup-email" name="email" type="email" required autoComplete="username" className={`${field} mb-4`} />

      <label htmlFor="signup-password" className={label}>PASSWORD</label>
      <input id="signup-password" name="password" type="password" required autoComplete="new-password" className={`${field} mb-1.5`} />
      <p className="mb-4 text-xs text-slate-500">
        At least 12 characters with a lowercase letter, an uppercase letter, a digit and a symbol.
      </p>

      <label htmlFor="signup-confirm" className={label}>CONFIRM PASSWORD</label>
      <input id="signup-confirm" name="confirm" type="password" required autoComplete="new-password" className={`${field} mb-6`} />

      <button
        type="submit" disabled={pending}
        className="h-11 w-full rounded-lg bg-navy text-sm font-medium tracking-wide text-white shadow-sm transition hover:bg-navy/90 disabled:opacity-50"
      >
        {pending ? 'CREATING…' : 'CREATE ACCOUNT'}
      </button>
    </form>
  )
}
```

- [ ] **Step 2: The page**

Create `app/signup/page.tsx`:

```tsx
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import { MoneyMachines } from '@/components/MoneyMachines'
import { SignupForm } from '@/components/SignupForm'

/**
 * THE SIGN-UP PAGE (spec 2026-10-09-self-registration-design.md).
 *
 * Public by name (`isPublicPath`), so like `/welcome` it reads no data and
 * shows no figure. A signed-in visitor is sent to the dashboard, as `/login`
 * does. The same two panels as the sign-in page so it reads as the same
 * system; the form is `components/SignupForm.tsx`.
 */
export default async function SignupPage() {
  if (await getSessionUser()) redirect('/')

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="hidden flex-col justify-between bg-gradient-to-br from-navy-bg via-lavender-bg to-sky-bg p-10 lg:flex xl:p-14">
        <Link href="/welcome" className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 min-w-[2.5rem] items-center justify-center rounded-xl bg-navy px-2 text-xs font-semibold tracking-widest text-white shadow-sm"
          >
            CRM
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold tracking-wide text-navy">CHECK RELEASE MONITORING</span>
            <span className="block text-[10px] font-semibold tracking-widest text-slate-500">RCL FINANCE · INTERNAL</span>
          </span>
        </Link>

        <MoneyMachines className="mx-auto w-full max-w-xl" />

        <div className="max-w-md">
          <p className="text-lg font-semibold tracking-tight text-navy">One account, approved by Finance.</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Create your account here. A Finance Admin approves it and assigns your role; until then it
            cannot sign in.
          </p>
        </div>
      </aside>

      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm space-y-5">
          <div className="text-center">
            <span
              aria-hidden="true"
              className="mx-auto flex h-12 min-w-[3rem] items-center justify-center rounded-2xl bg-navy px-2 text-sm font-semibold tracking-widest text-white shadow-sm"
            >
              CRM
            </span>
            <h1 className="mt-4 text-lg font-semibold tracking-wide text-navy">CREATE ACCOUNT</h1>
            <p className="mt-1 text-[11px] font-semibold tracking-widest text-slate-400">FINANCE USERS ONLY</p>
          </div>

          <MoneyMachines className="mx-auto w-full max-w-xs lg:hidden" />

          <SignupForm />

          <p className="px-2 text-center text-xs text-slate-400">
            Already have an account?{' '}
            <Link href="/login" className="underline underline-offset-2 hover:text-navy">Sign in</Link>
            {' · '}
            <Link href="/welcome" className="underline underline-offset-2 hover:text-navy">Back to the front page</Link>
          </p>
        </div>
      </section>
    </main>
  )
}
```

- [ ] **Step 3: Links from the login and welcome pages**

In `app/login/page.tsx`, replace the final `<p className="px-2 text-center text-xs text-slate-400">` block with:

```tsx
          <p className="px-2 text-center text-xs text-slate-400">
            Need an account?{' '}
            <Link href="/signup" className="underline underline-offset-2 hover:text-navy">Create one</Link>
            {' · '}
            <Link href="/welcome" className="underline underline-offset-2 hover:text-navy">Back to the front page</Link>
          </p>
```

In `app/welcome/page.tsx`, wrap the header's SIGN IN link so a second one sits beside it:

```tsx
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/signup"
            className="whitespace-nowrap rounded-lg bg-white px-5 py-2.5 text-sm font-medium tracking-wide text-navy shadow-sm ring-1 ring-hairline transition hover:bg-navy-bg"
          >
            CREATE ACCOUNT
          </Link>
          <Link
            href="/login"
            className="whitespace-nowrap rounded-lg bg-navy px-5 py-2.5 text-sm font-medium tracking-wide text-white shadow-sm transition hover:bg-navy/90"
          >
            SIGN IN
          </Link>
        </div>
```

(The existing `<Link href="/login" … SIGN IN</Link>` in the header is replaced by this `div`; the SIGN IN TO CONTINUE button lower down is left as is.)

- [ ] **Step 4: Typecheck and build**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/typescript/bin/tsc --noEmit && npx.cmd next build 2>&1 | tail -30
```

Expected: tsc silent; the build lists `/signup` among the routes and finishes without error.

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add app/signup/page.tsx components/SignupForm.tsx app/login/page.tsx app/welcome/page.tsx && git commit -m "feat(signup): the CREATE ACCOUNT page, linked from sign-in and the front page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Admin actions — approve and reject

**Files:**
- Modify: `app/admin/users/actions.ts`
- Test: `tests/admin/user-actions.test.ts`

**Interfaces:**
- Consumes: `approveUser`, `rejectUser` (Task 4).
- Produces: `approveUserAction(formData)` reading `userId`, `role`; `rejectUserAction(formData)` reading `userId`. Both return `AdminActionResult`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/admin/user-actions.test.ts`:

```ts
describe('approveUserAction and rejectUserAction', () => {
  async function pendingAccount(email = 'p@rcl.com.ph') {
    const { registerUser } = await import('@/lib/admin/users')
    await registerUser(testDb, { email, name: 'Pending Person', password: STRONG })
    return testDb.user.findUniqueOrThrow({ where: { email } })
  }

  it('both refuse a Finance user with a result rather than a redirect', async () => {
    const { approveUserAction, rejectUserAction } = await import('@/app/admin/users/actions')
    const p = await pendingAccount()
    currentUser.role = 'FINANCE_USER'
    for (const result of [
      await approveUserAction(fd({ userId: p.id, role: 'FINANCE_USER' })),
      await rejectUserAction(fd({ userId: p.id })),
    ]) {
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/Finance Admin/)
    }
    const after = await testDb.user.findUniqueOrThrow({ where: { id: p.id } })
    expect(after.active).toBe(false)
    expect(after.pendingSince).not.toBeNull()
  })

  it('approve needs a role', async () => {
    const { approveUserAction } = await import('@/app/admin/users/actions')
    const p = await pendingAccount()
    const result = await approveUserAction(fd({ userId: p.id, role: 'OWNER' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/Choose a role/)
  })

  it('approve activates with the chosen role; reject leaves it deactivated', async () => {
    const { approveUserAction, rejectUserAction } = await import('@/app/admin/users/actions')
    const a = await pendingAccount('a@rcl.com.ph')
    const b = await pendingAccount('b@rcl.com.ph')

    expect(await approveUserAction(fd({ userId: a.id, role: 'FINANCE_ADMIN' }))).toEqual({ ok: true })
    expect(await rejectUserAction(fd({ userId: b.id }))).toEqual({ ok: true })

    expect(await testDb.user.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ active: true, role: 'FINANCE_ADMIN', pendingSince: null })
    expect(await testDb.user.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ active: false, pendingSince: null })
  })

  it('reports a domain refusal in its own words', async () => {
    const { approveUserAction } = await import('@/app/admin/users/actions')
    const notPending = await testDb.user.create({
      data: { email: 'n@rcl.com.ph', name: 'Not Pending', passwordHash: 'x', role: 'FINANCE_USER', active: false },
    })
    const result = await approveUserAction(fd({ userId: notPending.id, role: 'FINANCE_USER' }))
    expect(result).toEqual({ ok: false, message: 'Not Pending is not waiting for approval.' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/admin/user-actions.test.ts
```

Expected: FAIL — `approveUserAction` is not a function.

- [ ] **Step 3: Add the actions**

In `app/admin/users/actions.ts`:

Extend the import from `@/lib/admin/users`:
```ts
import { approveUser, changeUserRole, createUser, rejectUser, setUserActive, setUserPassword } from '@/lib/admin/users'
```

Change `run()` so the admin layout's badge revalidates too:
```ts
async function run(fn: () => Promise<unknown>): Promise<AdminActionResult> {
  try {
    await fn()
    revalidatePath('/admin/users')
    // The USERS tab badge (pending count) lives in the admin layout.
    revalidatePath('/admin', 'layout')
    return { ok: true }
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, message: e.message }
    if (isNextControlFlowError(e)) throw e
    console.error(e)
    return { ok: false, message: 'Something went wrong. Please try again.' }
  }
}
```

Append:
```ts
/**
 * The two halves of self-registration's approval step (spec 2026-10-09).
 * Same contract as the four above: a Finance user gets a RESULT, the role is
 * parsed before anything runs, and nothing but `{ ok: true }` comes back.
 */
export async function approveUserAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }

  const role = roleSchema.safeParse(str(formData, 'role'))
  if (!role.success) return { ok: false, message: 'Choose a role: Finance User or Finance Admin.' }

  return run(() => approveUser(prisma, { userId: str(formData, 'userId'), role: role.data, actorId: user.id }))
}

export async function rejectUserAction(formData: FormData): Promise<AdminActionResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY }

  return run(() => rejectUser(prisma, { userId: str(formData, 'userId'), actorId: user.id }))
}
```

Update the module comment's first line from "The four user-administration actions" to "The six user-administration actions".

- [ ] **Step 4: Run to verify pass**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run tests/admin/user-actions.test.ts && node node_modules/typescript/bin/tsc --noEmit
```

Expected: PASS; tsc silent.

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add app/admin/users/actions.ts tests/admin/user-actions.test.ts && git commit -m "feat(admin): approveUserAction and rejectUserAction

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The PENDING APPROVAL section and the tab badge

**Files:**
- Create: `components/PendingUserActions.tsx`
- Modify: `app/admin/users/page.tsx`
- Modify: `components/AdminTabs.tsx`
- Modify: `app/admin/layout.tsx`

**Interfaces:**
- Consumes: `approveUserAction`, `rejectUserAction` (Task 8); `isPending`, `AdminUserRow.pendingSince`, `.previouslyDeactivated` (Task 4).
- `AdminTabs` tabs tuple becomes `readonly (readonly [string, string] | readonly [string, string, number])[]`.

No unit test (pages/components are not covered by this suite); verified by `tsc`, `next build` and Task 10's browser check.

- [ ] **Step 1: The per-row controls**

Create `components/PendingUserActions.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AdminActionResult } from '@/app/admin/actions'
import { approveUserAction, rejectUserAction } from '@/app/admin/users/actions'

/**
 * APPROVE (with a role) and REJECT for one pending registration. The pattern
 * is `UserRowActions`: the server decides, this shows the result in the row.
 * Takes plain fields, not the row, so nothing it does not need crosses into
 * the browser.
 */
export function PendingUserActions({ userId, name }: { userId: string; name: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<AdminActionResult | null>(null)
  const [role, setRole] = useState<'FINANCE_USER' | 'FINANCE_ADMIN'>('FINANCE_USER')

  const submit = (action: (f: FormData) => Promise<AdminActionResult>, extra: Record<string, string> = {}) => {
    const f = new FormData()
    f.append('userId', userId)
    for (const [k, v] of Object.entries(extra)) f.append(k, v)
    startTransition(async () => {
      const r = await action(f)
      setResult(r)
      if (r.ok) router.refresh()
    })
  }

  const button = 'rounded-lg px-3 py-1.5 text-xs font-medium tracking-wide transition disabled:opacity-50'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`pending-role-${userId}`}>Role for {name}</label>
        <select
          id={`pending-role-${userId}`}
          value={role}
          onChange={(e) => setRole(e.target.value as 'FINANCE_USER' | 'FINANCE_ADMIN')}
          className="h-9 rounded-lg border border-hairline bg-white px-2 text-xs text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
        >
          <option value="FINANCE_USER">FINANCE USER</option>
          <option value="FINANCE_ADMIN">FINANCE ADMIN</option>
        </select>
        <button
          type="button" disabled={pending}
          onClick={() => submit(approveUserAction, { role })}
          className={`${button} bg-navy text-white hover:bg-navy/90`}
        >
          APPROVE
        </button>
        <button
          type="button" disabled={pending}
          onClick={() => submit(rejectUserAction)}
          className={`${button} bg-white text-danger-ink ring-1 ring-danger-ink/30 hover:bg-danger-bg`}
        >
          REJECT
        </button>
      </div>
      {result && !result.ok && (
        <p className="rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning-ink">{result.message}</p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: The page**

In `app/admin/users/page.tsx`:

Add imports:
```ts
import { isPending, listUsers } from '@/lib/admin/users'
import { PendingUserActions } from '@/components/PendingUserActions'
```
(replacing the existing `import { listUsers } from '@/lib/admin/users'`).

After `const users = await listUsers(prisma, new Date(), limits)` add:
```ts
  const pendingUsers = users
    .filter(isPending)
    .sort((a, b) => (b.pendingSince?.getTime() ?? 0) - (a.pendingSince?.getTime() ?? 0))
  // Pending accounts are neither ACTIVE nor DEACTIVATED and have their own
  // section; in the table they would carry a REACTIVATE button that refuses.
  const tableUsers = users.filter((u) => !isPending(u))
```

Insert the section immediately BEFORE `<CreateUserForm />`:
```tsx
      {pendingUsers.length > 0 && (
        <section className="overflow-x-auto rounded-2xl bg-white ring-1 ring-warning-ink/30">
          <div className="flex flex-wrap items-baseline justify-between gap-3 px-6 pb-4 pt-6">
            <h2 className="text-[11px] font-semibold tracking-widest text-warning-ink">
              PENDING APPROVAL — {pendingUsers.length} ACCOUNT{pendingUsers.length === 1 ? '' : 'S'} WAITING
            </h2>
            <p className="text-xs text-slate-500">
              Created on the sign-up page. Nothing can sign in until you approve it with a role.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-hairline text-left text-[11px] font-semibold tracking-widest text-slate-400">
              <tr>
                <th className="px-4 py-3">NAME</th>
                <th className="px-4 py-3">EMAIL</th>
                <th className="px-4 py-3">REGISTERED</th>
                <th className="px-4 py-3">ORIGIN</th>
                <th className="px-4 py-3">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {pendingUsers.map((u) => (
                <tr key={u.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-medium">{u.name}</td>
                  <td className="px-4 py-3 text-slate-600">{u.email}</td>
                  <td className="px-4 py-3 text-slate-600">{fmtDateTime(u.pendingSince)}</td>
                  <td className="px-4 py-3">
                    {u.previouslyDeactivated ? (
                      <span className="rounded bg-warning-bg px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-warning-ink">
                        RE-REGISTERED — PREVIOUSLY DEACTIVATED
                      </span>
                    ) : (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600">
                        NEW ACCOUNT
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <PendingUserActions userId={u.id} name={u.name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-6 pb-5 text-xs leading-relaxed text-slate-500">
            A re-registered account kept its history and had its name and password replaced by whoever
            filled in the form — check it is the colleague you expect before approving. REJECT leaves the
            account deactivated; it can be reactivated from the table later.
          </p>
        </section>
      )}
```

Change the table's `{users.map((u) => (` to `{tableUsers.map((u) => (`.

- [ ] **Step 3: The badge**

In `components/AdminTabs.tsx`, change the signature and the render:

```tsx
export function AdminTabs({
  tabs,
}: {
  tabs: readonly (readonly [string, string] | readonly [string, string, number])[]
}) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-wrap gap-2" aria-label="Administration">
      {tabs.map(([href, label, badge]) => {
        const active = pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium tracking-wide transition ${
              active
                ? 'bg-navy text-white shadow-sm'
                : 'bg-white text-slate-600 ring-1 ring-hairline hover:bg-navy-bg hover:text-navy hover:ring-navy/40'
            }`}
          >
            {label}
            {badge !== undefined && badge > 0 && (
              // Pending registrations waiting on USERS. A count, not a
              // permission: the gate is still requireAdmin() in the layout.
              <span
                aria-label={`${badge} waiting for approval`}
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  active ? 'bg-white text-navy' : 'bg-warning-bg text-warning-ink'
                }`}
              >
                {badge}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
```

In `app/admin/layout.tsx`:

```ts
import { prisma } from '@/lib/db'
```
and after `const user = await requireAdmin()`:
```ts
  // The one definition of pending, in SQL: inactive with the flag set
  // (`isPending`, lib/admin/users.ts). One count per admin page load.
  const pendingCount = await prisma.user.count({ where: { active: false, pendingSince: { not: null } } })

  const tabs = [
    ['/admin/users', 'USERS', pendingCount],
    ['/admin/sync', 'SYNC'],
    ['/admin/portal', 'PORTAL'],
    ['/admin/import', 'IMPORT'],
    ['/admin/staged', 'STAGED QUEUE'],
    ['/admin/audit', 'AUDIT'],
    ['/admin/settings', 'SETTINGS'],
  ] as const
```

- [ ] **Step 4: Typecheck and build**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/typescript/bin/tsc --noEmit && npx.cmd next build 2>&1 | tail -20
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add components/PendingUserActions.tsx app/admin/users/page.tsx components/AdminTabs.tsx app/admin/layout.tsx && git commit -m "feat(admin): PENDING APPROVAL section on /admin/users and a pending badge on the USERS tab

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Browser check, docs, and the pre-merge run

**Files:**
- Modify: `CLAUDE.md` (the `lib/settings/` row in Layout; a new entry under "Things that will catch you out")

**The dev server points at PRODUCTION** (local `.env`). For the browser check, start it with the TEST database URL so a test registration does not land in production. `.claude/launch.json` may need a configuration; create or confirm one shaped like:

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "dev-test-db", "runtimeExecutable": "npm.cmd", "runtimeArgs": ["run", "dev"], "port": 3000 }
  ]
}
```

and before starting it export `DATABASE_URL` to the value of `DATABASE_URL_TEST` for that process only (e.g. a `scripts/dev-test-db.mjs` wrapper that reads `.env`, swaps the two and spawns `next dev` with `shell: false`, following `scripts/migrate.mjs`). If that is more than a few lines, skip the browser check, say so in the report, and rely on the build and tests.

- [ ] **Step 1: Browser check (if the test-database dev server is available)**

Use `preview_start`, then:
1. Open `/signup` anonymously: the form renders, no redirect to `/login`.
2. Submit mismatched passwords: "The two passwords do not match."
3. Submit a valid form with a test address: the waiting message shows the address.
4. Open `/login`, sign in with the seeded admin (`admin@rcl.test`, the seed's password): on `/admin/users` the PENDING APPROVAL section lists the account as NEW ACCOUNT and the USERS tab shows `1`.
5. APPROVE as FINANCE USER: the row leaves the section, the badge disappears, the account is in the table as ACTIVE.
6. Sign out, sign in as the new account: the dashboard loads.
7. Deactivate it as admin, then register again on `/signup` with the same address: the section shows RE-REGISTERED — PREVIOUSLY DEACTIVATED.
8. Screenshot steps 4 and 7 for the report.

- [ ] **Step 2: Docs**

In `CLAUDE.md`:

Layout table row for `lib/settings/`: change "The eleven settings" to "The twelve settings".

Add under "Things that will catch you out", before the `/welcome` entry:

```markdown
**`/signup` is public and creates INACTIVE accounts only** (2026-10-09, spec
`2026-10-09-self-registration-design.md`). A registration sets `User.pendingSince`; PENDING is
`!active && pendingSince !== null` (`isPending`, `lib/admin/users.ts`, the one definition) and is
shown on `/admin/users` under PENDING APPROVAL, where APPROVE picks the role and REJECT leaves it
deactivated. **Registering with an INACTIVE account's address re-opens it** (same id, new name and
password, `user_reregistered`) — user ruling 2026-10-09, so the three deactivated accounts Finance
asked to delete could register again; the list says RE-REGISTERED so the admin checks before
approving. An ACTIVE address is refused. REACTIVATE refuses a pending account (approve instead).
Throttle: `signup.ipPerHour` (default 5) over `RegistrationAttempt`, in Postgres
(`lib/registration-throttle.ts`); every submission counts. The sign-in error stays generic. No
mail path, no domain restriction, no delete (rule 6).
```

- [ ] **Step 3: The pre-merge full run**

Only once, in the background, and only if no other agent is using the test database:

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && node node_modules/vitest/vitest.mjs run 2>&1 | tail -40
```

Expected: 0 failures; the count rises from 1,918 across 130 by this plan's additions (roughly +35 across 2 new files). Record the measured figures in `CLAUDE.md`'s State paragraph in the existing style ("N tests across M files (measured, full run 2026-10-09, …)").

- [ ] **Step 4: Commit the docs**

```bash
cd "/c/Users/User/Desktop/RCL PROJECTS/Check Monitoring" && git add CLAUDE.md && git commit -m "docs: self-registration - /signup, pending approval, re-registration; twelve settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand back**

Report: the branch name, the test figures, whether the browser check ran, and the deploy order — `node scripts/migrate.mjs prod --confirm` BEFORE `npx vercel --prod` (the page queries `pendingSince` on every admin layout load). The user merges and deploys; the plan does not.

---

## Self-review against the spec

- §2 data model → Task 1. §3 domain (`isPending`, register, approve, reject, REACTIVATE guard, `AdminUserRow` additions, shape test) → Task 4. §4 page, links, action order, success message, generic sign-in error untouched → Tasks 5, 6, 7. §5 throttle and setting → Tasks 2, 3, 6. §6 admin section, table exclusion, count line, badge, actions → Tasks 8, 9. §7 audit names → Task 4 (`user_registered`, `user_reregistered`, `user_approved`, `user_rejected`). §8 not-built list → nothing in the plan builds any of it. §9 tests → Tasks 2–6, 8 (`schema.test.ts` enumerates no tables, so no change there). §10 deployment order → Task 10 step 5.
- The header's "· N PENDING APPROVAL" count line from §6 is covered by the section heading "PENDING APPROVAL — N ACCOUNTS WAITING" in Task 9; the USERS table header is left as is.
- Names are consistent across tasks: `registerUser` / `approveUser` / `rejectUser` / `isPending` (Task 4) are what Tasks 6, 8, 9 import; `registrationLockout` / `recordRegistrationAttempt` (Task 3) are what Task 6 imports; `SignupResult` (Task 6) is what Task 7 imports; `signup.ipPerHour` (Task 2) is what Task 6 reads.
