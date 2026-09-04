import { describe, it, expect, beforeEach } from 'vitest'
import type { Role } from '@prisma/client'
import { testDb, resetDb } from '../helpers/db'
import { DomainError } from '@/lib/domain/errors'
import { verifyPassword } from '@/lib/password'
import {
  SEEDED_TEST_ACCOUNT_EMAILS,
  createUser, changeUserRole, listUsers, setUserActive, setUserPassword,
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
      'changeUserRole',
      'createUser',
      'listUsers',
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
