import { Prisma, type PrismaClient, type Role } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { loginFailureSummary, type LoginFailureState, type ThrottleLimits } from '@/lib/login-throttle'
import { hashPassword, validatePasswordStrength } from '@/lib/password'

/**
 * User administration (spec §13, `/admin/users`).
 *
 * **There is no delete here, and there must never be one.** A `User` is
 * referenced by `AuditLog` and by five `Check` relations — `signedBy`,
 * `readyBy`, `releasedBy`, `cancelledBy`, `eligibilityOverriddenBy` — every one
 * of them an optional relation, which Prisma gives `onDelete: SetNull` by
 * default. Deleting one row would therefore not fail loudly; it would quietly
 * blank out *who released real money* on every cheque that person ever touched,
 * in the audit trail this system exists to preserve. Removal is deactivation:
 * `authorize` in auth.config.ts refuses an inactive account at sign-in, so a
 * deactivated user cannot do anything, while every attribution stays intact.
 * The export-shape test in `tests/admin/users.test.ts` pins the module's surface
 * so a delete helper cannot be added without deleting a test to make room.
 *
 * These functions take a `PrismaClient` rather than the `Db` union used
 * elsewhere in `lib/`, because each of them opens its own transaction and the
 * last-active-admin guard below is only sound inside one.
 */

/**
 * The accounts `prisma/seed.ts` creates with passwords committed to the
 * repository. `seed.ts` derives its own account list from this constant — see
 * `SEED_ACCOUNTS` there — so the two cannot drift and a third seeded account
 * cannot be added without appearing on this screen flagged.
 *
 * They are flagged, not blocked and certainly not deleted: the real admin
 * accounts may not exist yet when this code first runs, and refusing to sign
 * them in from here would lock the client out of their own system. Retiring
 * them is a deliberate human act — deactivate each one from `/admin/users`
 * after a real Finance Admin exists.
 */
export const SEEDED_TEST_ACCOUNT_EMAILS = ['admin@rcl.test', 'finance@rcl.test'] as const

export type SeededTestAccountEmail = (typeof SEEDED_TEST_ACCOUNT_EMAILS)[number]

/**
 * What the screen shows. Deliberately NOT `User`: that carries `passwordHash`,
 * and this row is handed to a client component, which means everything on it is
 * serialised into the page the browser receives. An argon2 hash is nothing a
 * browser needs, and one that reaches a browser is one an attacker can grind
 * offline at their leisure.
 */
export type AdminUserRow = {
  id: string
  name: string
  email: string
  role: Role
  active: boolean
  lastLoginAt: Date | null
  createdAt: Date
  /** Seeded by `prisma/seed.ts` with a password anyone can read in git. */
  isSeededTestAccount: boolean
  /**
   * Failed sign-ins against this address inside the throttle's counting window,
   * cleared by the account's own last successful sign-in. Zero for a quiet
   * account; a number that climbs is what an attack looks like from here.
   */
  recentFailedLogins: number
  /**
   * When the login throttle will admit this address again, or null if it is
   * not currently refusing it. Never a time in the past — see
   * `loginFailureSummary`.
   */
  lockedUntil: Date | null
}

// Stated once, as a Prisma select, so no query in this module can accidentally
// widen itself to the whole row.
const ROW_SELECT = {
  id: true, name: true, email: true, role: true,
  active: true, lastLoginAt: true, createdAt: true,
} as const

type SelectedUser = {
  id: string; name: string; email: string; role: Role
  active: boolean; lastLoginAt: Date | null; createdAt: Date
}

const SEEDED = new Set<string>(SEEDED_TEST_ACCOUNT_EMAILS)

/**
 * The throttle state for a row that was not read alongside a listing.
 *
 * Every mutating function here returns the row it just wrote, and none of them
 * touches `LoginAttempt` — creating a user or changing a role says nothing
 * about failed sign-ins. Rather than issue a throttle query none of those call
 * sites needs, they report the quiet state, and `listUsers` — the one that
 * feeds the screen — is where the real counts are read.
 */
const NO_FAILURES: LoginFailureState = { recentFailures: 0, lockedUntil: null }

function toRow(u: SelectedUser, failures: LoginFailureState = NO_FAILURES): AdminUserRow {
  return {
    ...u,
    isSeededTestAccount: SEEDED.has(u.email),
    recentFailedLogins: failures.recentFailures,
    lockedUntil: failures.lockedUntil,
  }
}

/**
 * The address sign-in will look this account up by.
 *
 * `authorize` lowercases and trims what is typed before its `findUnique`, so an
 * account stored as `J.Cruz@RCL.com.ph` could never be signed into at all — and
 * would present as a permanently wrong password rather than as anything a user
 * could diagnose. Normalise on the way in, once, here.
 */
function normaliseEmail(raw: string): string {
  return raw.toLowerCase().trim()
}

function requirePassword(plain: string): void {
  const strength = validatePasswordStrength(plain)
  // The policy's own wording, passed through verbatim: it names which class of
  // character is missing, which is the only part of it a user can act on.
  if (!strength.ok) throw new DomainError('WEAK_PASSWORD', strength.message)
}

/**
 * The guard that matters most: the last active Finance Admin can be neither
 * deactivated nor demoted, **including by themselves**.
 *
 * Without it one click locks everybody out of administration, and because there
 * is no delete-and-reseed path (see the module note above) there is no easy
 * recovery — the client would need someone with database access to flip a
 * column by hand.
 *
 * `SELECT … FOR UPDATE`, not `count()`. A bare count is read-committed and
 * would let two concurrent transactions each demote a different one of the last
 * two admins: each sees the other still standing, each allows its own change,
 * and the system ends with zero. Locking every active admin row serialises
 * those transactions, and Postgres re-evaluates the WHERE clause against the
 * updated row once the lock is released, so the second transaction correctly
 * sees only itself left. Do not "simplify" this back to a count.
 *
 * It counts **active** admins, never admins. A deactivated admin is refused at
 * sign-in and so cannot administer anything; counting them would leave the door
 * looking open while it was in fact locked.
 */
async function assertNotLastActiveAdmin(
  tx: Prisma.TransactionClient,
  targetId: string,
  attempt: 'DEACTIVATE' | 'DEMOTE',
): Promise<void> {
  const activeAdmins = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT "id", "name" FROM "User"
    WHERE "role" = 'FINANCE_ADMIN' AND "active" = true
    FOR UPDATE
  `
  const target = activeAdmins.find((a) => a.id === targetId)
  // Not an active admin, so this change cannot close the door behind anyone.
  if (!target) return
  if (activeAdmins.length > 1) return

  const what = attempt === 'DEACTIVATE' ? 'Deactivating them' : 'Changing their role'
  throw new DomainError(
    'LAST_ACTIVE_ADMIN',
    `${target.name} is the last active Finance Admin. ${what} would leave nobody able to ` +
    'administer this system, and there is no way back without one — create another Finance ' +
    'Admin, or reactivate an existing one, first.',
  )
}

async function loadTarget(tx: Prisma.TransactionClient, userId: string): Promise<SelectedUser> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: ROW_SELECT })
  if (!user) throw new DomainError('NOT_FOUND', 'That user account no longer exists.')
  return user
}

/**
 * Active accounts first, then by email.
 *
 * Not ordered by `role`: Prisma sorts an enum by its DECLARATION order in the
 * schema, which today puts FINANCE_USER before FINANCE_ADMIN — an accident of
 * how the enum was typed rather than anything meaningful, and one a future
 * reordering would silently reverse. `lib/admin/staged-queue.ts` carries the
 * same warning about `CheckStatus`.
 */
export async function listUsers(
  db: PrismaClient,
  now: Date = new Date(),
  limits?: ThrottleLimits,
): Promise<AdminUserRow[]> {
  const rows = await db.user.findMany({
    select: ROW_SELECT,
    orderBy: [{ active: 'desc' }, { email: 'asc' }],
  })
  // `now` is a parameter so a test can pin a lockout deadline exactly rather
  // than racing the clock across a Neon round trip. `limits` is the throttle's
  // own settings, read by the page and passed here so this screen agrees with
  // the gate about who is locked; a test that passes neither gets the default.
  const failures = await loginFailureSummary(db, { emails: rows.map((r) => r.email), now, limits })
  return rows.map((u) => toRow(u, failures.get(u.email)))
}

/**
 * Create an account from a password **a human typed into the form**.
 *
 * The plaintext is hashed and then dropped: it is never returned, never written
 * to the audit row, never logged, and never put into an error message. There is
 * deliberately no generated-password path — a generated password has to be
 * shown to somebody to be usable, and the moment it is shown it is in a page, a
 * screenshot, or a chat message. The admin at the keyboard types one and tells
 * the person themselves.
 *
 * There is likewise no password-reset-by-email: this system has no mail path at
 * all, and inventing one is out of scope. `setUserPassword` is how a forgotten
 * password is dealt with.
 */
export async function createUser(
  db: PrismaClient,
  args: { email: string; name: string; password: string; role: Role; actorId: string },
): Promise<AdminUserRow> {
  const email = normaliseEmail(args.email)
  const name = args.name.trim()
  if (!email) throw new DomainError('EMAIL_REQUIRED', 'An email address is required.')
  if (!name) throw new DomainError('NAME_REQUIRED', 'A name is required — the audit trail shows it against every action this person takes.')
  requirePassword(args.password)

  // Hashed BEFORE the transaction opens. argon2id is deliberately slow, and
  // holding a database connection through it for no reason is how a pool runs
  // out under a handful of concurrent admins.
  const passwordHash = await hashPassword(args.password)

  try {
    return await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, name, passwordHash, role: args.role },
        select: ROW_SELECT,
      })
      await writeAudit(tx, {
        // No `checkId`: a user-administration event is about no cheque, and
        // `AuditLog.checkId` is nullable precisely so such an event can be
        // recorded without inventing one.
        actorType: 'USER',
        userId: args.actorId,
        action: 'user_created',
        details: { targetUserId: created.id, email: created.email, name: created.name, role: created.role },
        remarks: created.email,
      })
      return toRow(created)
    })
  } catch (e) {
    // The unique index on `email` is the only constraint this insert can trip,
    // and a raw Prisma P2002 in front of a Finance user is not an explanation.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new DomainError(
        'EMAIL_TAKEN',
        `An account for ${email} already exists. Accounts here are never deleted — reactivate ` +
        'it or change its role instead.',
      )
    }
    throw e
  }
}

export async function changeUserRole(
  db: PrismaClient,
  args: { userId: string; role: Role; actorId: string },
): Promise<AdminUserRow> {
  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    // Checked before the guard, not after: re-selecting FINANCE_ADMIN for the
    // sole admin changes nothing and must not be refused as a demotion. It also
    // keeps the audit trail honest — a row saying the role changed from
    // FINANCE_ADMIN to FINANCE_ADMIN is noise.
    if (target.role === args.role) return toRow(target)

    if (args.role !== 'FINANCE_ADMIN') await assertNotLastActiveAdmin(tx, target.id, 'DEMOTE')

    const updated = await tx.user.update({
      where: { id: target.id }, data: { role: args.role }, select: ROW_SELECT,
    })
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: 'user_role_changed',
      details: { targetUserId: target.id, email: target.email, from: target.role, to: args.role },
      remarks: `${target.email}: ${target.role} → ${args.role}`,
    })
    return toRow(updated)
  })
}

/**
 * Deactivate or reactivate. **This is what "remove a user" means here** — see
 * the module note. A deactivated row keeps every attribution it carries and is
 * refused at sign-in, which is the whole of what removal needs to accomplish.
 */
export async function setUserActive(
  db: PrismaClient,
  args: { userId: string; active: boolean; actorId: string },
): Promise<AdminUserRow> {
  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    if (target.active === args.active) return toRow(target)

    if (!args.active) await assertNotLastActiveAdmin(tx, target.id, 'DEACTIVATE')

    const updated = await tx.user.update({
      where: { id: target.id }, data: { active: args.active }, select: ROW_SELECT,
    })
    // Two distinct actions rather than one carrying a boolean: every audit
    // query, filter and screen that groups by action then separates a removal
    // from a restoration for free. `voidCheck` splits `voided_after_release`
    // out for the same reason.
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: args.active ? 'user_reactivated' : 'user_deactivated',
      details: { targetUserId: target.id, email: target.email, role: target.role },
      remarks: target.email,
    })
    return toRow(updated)
  })
}

/**
 * Set an existing user's password to one the admin typed.
 *
 * No last-admin guard: setting a password neither deactivates nor demotes
 * anybody, and a sole admin must always be able to change their own.
 */
export async function setUserPassword(
  db: PrismaClient,
  args: { userId: string; password: string; actorId: string },
): Promise<AdminUserRow> {
  requirePassword(args.password)
  const passwordHash = await hashPassword(args.password)

  return db.$transaction(async (tx) => {
    const target = await loadTarget(tx, args.userId)
    const updated = await tx.user.update({
      where: { id: target.id }, data: { passwordHash }, select: ROW_SELECT,
    })
    await writeAudit(tx, {
      actorType: 'USER',
      userId: args.actorId,
      action: 'user_password_set',
      // The target and the fact, and nothing else. Neither the plaintext nor
      // the hash goes in here: the audit trail is readable by every admin and
      // is append-only, so anything written to it is written permanently.
      details: { targetUserId: target.id, email: target.email },
      remarks: target.email,
    })
    return toRow(updated)
  })
}
