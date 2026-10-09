import { describe, it, expect, beforeEach } from 'vitest'
import type { Role } from '@prisma/client'
import { testDb, resetDb } from '../helpers/db'
import { DomainError } from '@/lib/domain/errors'
import { verifyPassword } from '@/lib/password'
import { BACKOFF_MINUTES, EMAIL_FREE_FAILURES, loginLockout } from '@/lib/login-throttle'
import {
  SEEDED_TEST_ACCOUNT_EMAILS,
  approveUser, changeUserRole, createUser, isPending, listUsers, registerUser, rejectUser,
  setUserActive, setUserPassword,
} from '@/lib/admin/users'

// A password that satisfies `validatePasswordStrength`. Used as the literal the
// "no password material anywhere" assertions search for, so it must be a
// distinctive string that could not appear in a row by coincidence.
const STRONG = 'Zq7!vantablack-Ledger'
const STRONG_TWO = 'Xw4?permafrost-Ledger'

beforeEach(resetDb)

async function makeAdmin(overrides: { email?: string; name?: string; active?: boolean } = {}) {
  return testDb.user.create({
    data: {
      email: overrides.email ?? `admin${Math.random().toString(36).slice(2)}@rcl.test`,
      name: overrides.name ?? 'Finance Admin',
      passwordHash: 'x',
      role: 'FINANCE_ADMIN',
      active: overrides.active ?? true,
    },
  })
}

async function makeFinanceUser(overrides: { email?: string; active?: boolean } = {}) {
  return testDb.user.create({
    data: {
      email: overrides.email ?? `user${Math.random().toString(36).slice(2)}@rcl.test`,
      name: 'Finance User',
      passwordHash: 'x',
      role: 'FINANCE_USER',
      active: overrides.active ?? true,
    },
  })
}

/** Every audit row, serialised, so a test can search the whole trail at once. */
async function auditText(): Promise<string> {
  return JSON.stringify(await testDb.auditLog.findMany())
}

describe('the user administration module', () => {
  // Rule 1, made structural rather than remembered. A `User` is referenced by
  // `AuditLog` and by five `Check` relations, all of which null out on delete —
  // so a hard delete silently erases who released real money. This assertion is
  // the same device `tests/actions/audit.test.ts` uses to keep `lib/audit.ts`
  // free of an update or delete helper.
  it('offers no delete of any kind', async () => {
    const mod = await import('@/lib/admin/users')
    const exported = Object.keys(mod).sort()
    expect(exported.some((k) => /delete|remove|destroy|purge/i.test(k))).toBe(false)
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
  })
})

describe('listUsers', () => {
  it('reports name, email, role, active and last login', async () => {
    const when = new Date('2026-09-03T02:15:00.000Z')
    await testDb.user.create({
      data: {
        email: 'r.santos@rcl.com.ph', name: 'Rosario Santos', passwordHash: 'x',
        role: 'FINANCE_ADMIN', active: true, lastLoginAt: when,
      },
    })

    const [row] = await listUsers(testDb)
    expect(row).toMatchObject({
      email: 'r.santos@rcl.com.ph',
      name: 'Rosario Santos',
      role: 'FINANCE_ADMIN',
      active: true,
      lastLoginAt: when,
    })
  })

  // This list is handed to a client component, and anything on it is serialised
  // into the page. An argon2 hash is not a secret a browser needs.
  it('never carries a password hash off the server', async () => {
    await createUser(testDb, {
      email: 'new@rcl.com.ph', name: 'New Person', password: STRONG,
      role: 'FINANCE_USER', actorId: (await makeAdmin()).id,
    })

    const rows = await listUsers(testDb)
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('passwordHash')
    }
    expect(JSON.stringify(rows)).not.toContain(STRONG)
  })

  it('flags the seeded test accounts and nothing else', async () => {
    for (const email of SEEDED_TEST_ACCOUNT_EMAILS) {
      await testDb.user.create({
        data: { email, name: 'Seeded', passwordHash: 'x', role: 'FINANCE_ADMIN' },
      })
    }
    const real = await makeAdmin({ email: 'real.admin@rcl.com.ph' })

    const rows = await listUsers(testDb)
    const flagged = rows.filter((r) => r.isSeededTestAccount).map((r) => r.email).sort()
    expect(flagged).toEqual([...SEEDED_TEST_ACCOUNT_EMAILS].sort())
    expect(rows.find((r) => r.id === real.id)?.isSeededTestAccount).toBe(false)
  })

  it('lists active users before deactivated ones', async () => {
    await makeFinanceUser({ email: 'z.gone@rcl.com.ph', active: false })
    await makeFinanceUser({ email: 'a.here@rcl.com.ph', active: true })

    const rows = await listUsers(testDb)
    expect(rows.map((r) => r.email)).toEqual(['a.here@rcl.com.ph', 'z.gone@rcl.com.ph'])
  })

  // Failed sign-ins are otherwise invisible. An admin who cannot see a count
  // climbing has no way to know the login is being attacked, and no way to
  // explain to a colleague why they are being refused.
  it('reports recent failed sign-ins and the lockout for each account', async () => {
    const now = new Date('2026-09-04T08:00:00.000Z')
    const justNow = new Date(now.getTime() - 5_000)
    await makeFinanceUser({ email: 'under.attack@rcl.com.ph' })
    await makeFinanceUser({ email: 'z.quiet@rcl.com.ph' })

    for (let i = 0; i < EMAIL_FREE_FAILURES + 1; i++) {
      await testDb.loginAttempt.create({
        data: {
          email: 'under.attack@rcl.com.ph', ip: '203.0.113.9',
          success: false, createdAt: justNow,
        },
      })
    }

    const rows = await listUsers(testDb, now)
    const attacked = rows.find((r) => r.email === 'under.attack@rcl.com.ph')!
    const quiet = rows.find((r) => r.email === 'z.quiet@rcl.com.ph')!

    expect(attacked.recentFailedLogins).toBe(EMAIL_FREE_FAILURES + 1)
    expect(attacked.lockedUntil).toEqual(new Date(justNow.getTime() + BACKOFF_MINUTES[0] * 60_000))
    expect(quiet).toMatchObject({ recentFailedLogins: 0, lockedUntil: null })
  })

  // The screen must agree with the gate: telling an admin an account is fine
  // while sign-in refuses it is worse than showing nothing at all.
  it('agrees with the sign-in gate about who is locked', async () => {
    const now = new Date('2026-09-04T08:00:00.000Z')
    await makeFinanceUser({ email: 'under.attack@rcl.com.ph' })
    for (let i = 0; i < EMAIL_FREE_FAILURES + 1; i++) {
      await testDb.loginAttempt.create({
        data: {
          email: 'under.attack@rcl.com.ph', ip: '203.0.113.9',
          success: false, createdAt: new Date(now.getTime() - 5_000),
        },
      })
    }

    const [row] = await listUsers(testDb, now)
    const lockout = await loginLockout(
      testDb, { email: 'under.attack@rcl.com.ph', ip: '198.51.100.4', now },
    )
    expect(row.lockedUntil).toEqual(lockout.until)
  })

  it('shows no lockout once the back-off has lapsed', async () => {
    const now = new Date('2026-09-04T08:00:00.000Z')
    await makeFinanceUser({ email: 'recovered@rcl.com.ph' })
    for (let i = 0; i < EMAIL_FREE_FAILURES + 1; i++) {
      await testDb.loginAttempt.create({
        data: {
          email: 'recovered@rcl.com.ph', ip: '203.0.113.9', success: false,
          createdAt: new Date(now.getTime() - (BACKOFF_MINUTES[0] + 1) * 60_000),
        },
      })
    }

    const [row] = await listUsers(testDb, now)
    expect(row.recentFailedLogins).toBe(EMAIL_FREE_FAILURES + 1)
    expect(row.lockedUntil).toBeNull()
  })
})

describe('createUser', () => {
  it('stores an argon2 hash of the password the human typed, never the password', async () => {
    const actor = await makeAdmin()
    const created = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_ADMIN', actorId: actor.id,
    })

    const row = await testDb.user.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.passwordHash).not.toBe(STRONG)
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(true)
  })

  // `authorize` lowercases and trims what is typed at sign-in before looking the
  // account up. An account stored as "J.Cruz@RCL.com.ph " could therefore never
  // be signed into at all — it would look like a wrong password forever.
  it('stores the email the way sign-in will look it up', async () => {
    const actor = await makeAdmin()
    const created = await createUser(testDb, {
      email: '  J.Cruz@RCL.com.ph ', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })
    expect(created.email).toBe('j.cruz@rcl.com.ph')
  })

  it('refuses a weak password and writes no user at all', async () => {
    const actor = await makeAdmin()
    const before = await testDb.user.count()

    await expect(createUser(testDb, {
      email: 'weak@rcl.com.ph', name: 'Weak', password: 'password',
      role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)

    expect(await testDb.user.count()).toBe(before)
  })

  it('refuses an email that already has an account', async () => {
    const actor = await makeAdmin()
    await makeFinanceUser({ email: 'taken@rcl.com.ph' })

    await expect(createUser(testDb, {
      email: 'TAKEN@rcl.com.ph', name: 'Second', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)
  })

  it('refuses a blank name rather than creating a nameless account', async () => {
    const actor = await makeAdmin()
    await expect(createUser(testDb, {
      email: 'nameless@rcl.com.ph', name: '   ', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)
  })

  it('writes an audit row naming the actor and the account, with no password material in it', async () => {
    const actor = await makeAdmin()
    const created = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_ADMIN', actorId: actor.id,
    })

    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({
      checkId: null,          // a user-administration event is about no cheque
      actorType: 'USER',
      userId: actor.id,
      action: 'user_created',
    })
    expect(row.details).toMatchObject({ targetUserId: created.id, email: 'j.cruz@rcl.com.ph', role: 'FINANCE_ADMIN' })

    // The plaintext, and the hash it produced, are both absent from the trail.
    const trail = await auditText()
    expect(trail).not.toContain(STRONG)
    const stored = await testDb.user.findUniqueOrThrow({ where: { id: created.id } })
    expect(trail).not.toContain(stored.passwordHash)
  })

  it('returns no password material to its caller', async () => {
    const actor = await makeAdmin()
    const created = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })
    expect(Object.keys(created)).not.toContain('passwordHash')
    expect(JSON.stringify(created)).not.toContain(STRONG)
  })
})

describe('changeUserRole', () => {
  it('promotes a Finance user and records who did it', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser()

    await changeUserRole(testDb, { userId: target.id, role: 'FINANCE_ADMIN', actorId: actor.id })

    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('FINANCE_ADMIN')
    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ actorType: 'USER', userId: actor.id, action: 'user_role_changed' })
    expect(row.details).toMatchObject({ targetUserId: target.id, from: 'FINANCE_USER', to: 'FINANCE_ADMIN' })
  })

  it('lets an admin demote themselves while another active admin exists', async () => {
    const actor = await makeAdmin({ name: 'Rosario Santos' })
    await makeAdmin({ name: 'The Other Admin' })

    await changeUserRole(testDb, { userId: actor.id, role: 'FINANCE_USER', actorId: actor.id })

    expect((await testDb.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe('FINANCE_USER')
  })

  it('refuses to let the last active admin demote themselves', async () => {
    const actor = await makeAdmin({ name: 'Rosario Santos' })

    await expect(changeUserRole(testDb, {
      userId: actor.id, role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)

    // Refused means unchanged, not partially applied.
    expect((await testDb.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe('FINANCE_ADMIN')
    expect(await testDb.auditLog.count()).toBe(0)
  })

  // A deactivated admin is refused at sign-in, so they cannot administer
  // anything. Counting them would leave the door apparently open and actually
  // locked.
  it('does not count a deactivated admin as keeping the door open', async () => {
    const actor = await makeAdmin()
    await makeAdmin({ active: false })

    await expect(changeUserRole(testDb, {
      userId: actor.id, role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)
  })

  it('says plainly why the last admin cannot be demoted', async () => {
    const actor = await makeAdmin({ name: 'Rosario Santos' })
    await expect(changeUserRole(testDb, {
      userId: actor.id, role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(/last active Finance Admin/i)
  })

  it('is a no-op when the role is already what was asked for', async () => {
    const actor = await makeAdmin()
    const only = await makeAdmin()

    // Would otherwise trip the guard: `only` is one of two active admins here,
    // but the same call against a sole admin must not be refused for "demoting"
    // them to the role they already hold.
    await changeUserRole(testDb, { userId: only.id, role: 'FINANCE_ADMIN', actorId: actor.id })
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('refuses an unknown user rather than reporting success', async () => {
    const actor = await makeAdmin()
    await expect(changeUserRole(testDb, {
      userId: 'nope', role: 'FINANCE_ADMIN', actorId: actor.id,
    })).rejects.toThrow(DomainError)
  })
})

describe('setUserActive', () => {
  it('deactivates a user and records it', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser()

    await setUserActive(testDb, { userId: target.id, active: false, actorId: actor.id })

    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(false)
    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ actorType: 'USER', userId: actor.id, action: 'user_deactivated' })
    expect(row.details).toMatchObject({ targetUserId: target.id })
  })

  it('reactivates a user and records that separately', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser({ active: false })

    await setUserActive(testDb, { userId: target.id, active: true, actorId: actor.id })

    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(true)
    expect((await testDb.auditLog.findFirstOrThrow()).action).toBe('user_reactivated')
  })

  it('refuses to deactivate the last active admin', async () => {
    const actor = await makeAdmin({ name: 'Rosario Santos' })

    await expect(setUserActive(testDb, {
      userId: actor.id, active: false, actorId: actor.id,
    })).rejects.toThrow(/last active Finance Admin/i)

    expect((await testDb.user.findUniqueOrThrow({ where: { id: actor.id } })).active).toBe(true)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('allows deactivating an admin once another active admin exists', async () => {
    const actor = await makeAdmin()
    const other = await makeAdmin()

    await setUserActive(testDb, { userId: other.id, active: false, actorId: actor.id })
    expect((await testDb.user.findUniqueOrThrow({ where: { id: other.id } })).active).toBe(false)
  })

  it('never blocks deactivating a Finance user', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser()
    await setUserActive(testDb, { userId: target.id, active: false, actorId: actor.id })
    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(false)
  })

  // The one the client actually has to perform. `admin@rcl.test` ships with a
  // password committed to `prisma/seed.ts`; retiring it is a deactivation,
  // never a delete, and the guard must permit it as soon as a real admin exists.
  it('permits deactivating a seeded admin account once a real admin exists', async () => {
    const seeded = await testDb.user.create({
      data: {
        email: SEEDED_TEST_ACCOUNT_EMAILS[0], name: 'Finance Admin',
        passwordHash: 'x', role: 'FINANCE_ADMIN',
      },
    })
    const real = await makeAdmin({ email: 'real.admin@rcl.com.ph' })

    await setUserActive(testDb, { userId: seeded.id, active: false, actorId: real.id })

    const row = await testDb.user.findUniqueOrThrow({ where: { id: seeded.id } })
    expect(row.active).toBe(false)
    // Deactivated, still present: the audit trail keeps pointing at a real row.
    expect(row.email).toBe(SEEDED_TEST_ACCOUNT_EMAILS[0])
  })

  it('is a no-op when the user is already in the state asked for', async () => {
    const actor = await makeAdmin()
    const only = await makeAdmin()
    await setUserActive(testDb, { userId: only.id, active: true, actorId: actor.id })
    expect(await testDb.auditLog.count()).toBe(0)
  })
})

describe('setUserPassword', () => {
  it('replaces the hash so the old password stops working and the new one starts', async () => {
    const actor = await makeAdmin()
    const target = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })

    await setUserPassword(testDb, { userId: target.id, password: STRONG_TWO, actorId: actor.id })

    const row = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(await verifyPassword(row.passwordHash, STRONG_TWO)).toBe(true)
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(false)
  })

  it('records that a password was set without recording the password', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser()

    await setUserPassword(testDb, { userId: target.id, password: STRONG, actorId: actor.id })

    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ actorType: 'USER', userId: actor.id, action: 'user_password_set' })
    expect(row.details).toMatchObject({ targetUserId: target.id })

    const trail = await auditText()
    expect(trail).not.toContain(STRONG)
    const stored = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(trail).not.toContain(stored.passwordHash)
  })

  it('refuses a weak password and leaves the existing one standing', async () => {
    const actor = await makeAdmin()
    const target = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })

    await expect(setUserPassword(testDb, {
      userId: target.id, password: 'short', actorId: actor.id,
    })).rejects.toThrow(DomainError)

    const row = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(true)
  })

  // Setting a password neither deactivates nor demotes, so the last-admin guard
  // has nothing to say about it — a sole admin must always be able to change
  // their own password.
  it('lets the last active admin set their own password', async () => {
    const actor = await makeAdmin()
    await setUserPassword(testDb, { userId: actor.id, password: STRONG, actorId: actor.id })
    const row = await testDb.user.findUniqueOrThrow({ where: { id: actor.id } })
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(true)
  })
})

describe('the role argument', () => {
  // Typed as the Prisma enum rather than a widened string, so a typo is a
  // compile error rather than a Prisma runtime failure in front of a user.
  it('accepts each declared role', async () => {
    const actor = await makeAdmin()
    const roles: Role[] = ['FINANCE_USER', 'FINANCE_ADMIN']
    for (const role of roles) {
      const created = await createUser(testDb, {
        email: `${role.toLowerCase()}@rcl.com.ph`, name: 'Person', password: STRONG,
        role, actorId: actor.id,
      })
      expect(created.role).toBe(role)
    }
  })
})

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

  it('requires an email', async () => {
    await expect(registerUser(testDb, { email: '   ', name: 'X', password: STRONG }))
      .rejects.toMatchObject({ code: 'EMAIL_REQUIRED' })
    expect(await testDb.user.count()).toBe(0)
  })

  it('leaves an ACTIVE account untouched: hash, name, flag, active, and no audit row', async () => {
    const before = await makeFinanceUser({ email: 'live@rcl.com.ph' })
    await expect(registerUser(testDb, { email: 'live@rcl.com.ph', name: 'Intruder', password: STRONG }))
      .rejects.toMatchObject({ code: 'EMAIL_TAKEN' })
    const after = await testDb.user.findUniqueOrThrow({ where: { id: before.id } })
    expect(after.passwordHash).toBe(before.passwordHash)
    expect(after.name).toBe(before.name)
    expect(after.pendingSince).toBeNull()
    expect(after.active).toBe(true)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('never sets a password on an account an admin activates at the same moment', async () => {
    // A property test, not a deterministic one: the interleaving is not
    // controllable. Either activation wins (active, ORIGINAL hash) or the
    // registration does (inactive and pending, NEW hash). Never active with
    // the new hash - the UPDATE is conditional on `active = false`.
    const admin = await makeAdmin()
    const target = await testDb.user.create({
      data: { email: 'race@rcl.com.ph', name: 'Old', passwordHash: 'original-hash', role: 'FINANCE_USER', active: false },
    })
    await Promise.allSettled([
      registerUser(testDb, { email: 'race@rcl.com.ph', name: 'New', password: STRONG }),
      setUserActive(testDb, { userId: target.id, active: true, actorId: admin.id }),
    ])
    const u = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    const hasNewHash = await verifyPassword(u.passwordHash, STRONG)
    if (u.active) {
      expect(hasNewHash).toBe(false)
      expect(u.passwordHash).toBe('original-hash')
    } else {
      expect(hasNewHash).toBe(true)
      expect(isPending(u)).toBe(true)
    }
  })

  it('records whether the row it re-opened was already pending', async () => {
    await testDb.user.create({
      data: { email: 'd@rcl.com.ph', name: 'D', passwordHash: 'x', role: 'FINANCE_USER', active: false },
    })
    await registerUser(testDb, { email: 'd@rcl.com.ph', name: 'D', password: STRONG })
    await registerUser(testDb, { email: 'd@rcl.com.ph', name: 'D', password: STRONG_TWO })
    const rows = await testDb.auditLog.findMany({ where: { action: 'user_reregistered' }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => (r.details as { wasPending?: boolean }).wasPending)).toEqual([false, true])
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

  it('refuses when the registration was re-done after the page the admin is looking at loaded', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'First', password: STRONG })
    const seen = (await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })).pendingSince!
    await new Promise((r) => setTimeout(r, 15))
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Second', password: STRONG_TWO })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })

    const err = await approveUser(testDb, {
      userId: pending.id, role: 'FINANCE_USER', actorId: actor.id, seenPendingSince: seen,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('REREGISTERED')
    expect(err.message).toBe('Second was re-registered after this page loaded. Reload and check the new registration before approving.')
    expect(isPending(await testDb.user.findUniqueOrThrow({ where: { id: pending.id } }))).toBe(true)
    expect(await testDb.auditLog.count({ where: { action: 'user_approved' } })).toBe(0)

    // The value the page actually displayed now is accepted.
    const ok = await approveUser(testDb, {
      userId: pending.id, role: 'FINANCE_USER', actorId: actor.id, seenPendingSince: pending.pendingSince!,
    })
    expect(ok.active).toBe(true)
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

  it('does not call a pending account "previously deactivated" because it re-registered while pending', async () => {
    await registerUser(testDb, { email: 'twice@rcl.com.ph', name: 'Twice', password: STRONG })
    await registerUser(testDb, { email: 'twice@rcl.com.ph', name: 'Twice', password: STRONG_TWO })
    const row = (await listUsers(testDb)).find((r) => r.email === 'twice@rcl.com.ph')!
    expect(row.previouslyDeactivated).toBe(false)
  })

  it('keeps previouslyDeactivated through a later re-registration while still pending', async () => {
    await testDb.user.create({
      data: { email: 'again@rcl.com.ph', name: 'Was Here', passwordHash: 'x', role: 'FINANCE_USER', active: false },
    })
    await registerUser(testDb, { email: 'again@rcl.com.ph', name: 'Again', password: STRONG })
    await registerUser(testDb, { email: 'again@rcl.com.ph', name: 'Again', password: STRONG_TWO })
    const row = (await listUsers(testDb)).find((r) => r.email === 'again@rcl.com.ph')!
    expect(row.previouslyDeactivated).toBe(true)
  })

  it('deactivating a pending account is a no-op: still pending, no audit row', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending Person', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const row = await setUserActive(testDb, { userId: pending.id, active: false, actorId: actor.id })
    expect(row.pendingSince).not.toBeNull()
    expect(isPending(await testDb.user.findUniqueOrThrow({ where: { id: pending.id } }))).toBe(true)
    expect(await testDb.auditLog.count({ where: { action: 'user_deactivated' } })).toBe(0)
  })
})
