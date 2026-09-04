import { describe, it, expect, beforeEach, vi } from 'vitest'

// `auth.config.ts` reaches for the application database through `@/lib/db`.
// Point it at the test database instead — this suite writes users and login
// attempts, and the guard in tests/helpers/test-db-url.ts exists because the
// alternative is a destructive suite aimed at the real one.
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})

// A real argon2 verify on every path is the timing defence this file mostly
// exists to pin, so the module is passed through rather than replaced — the
// spy counts calls without changing what they cost.
vi.mock('@/lib/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/password')>()
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) }
})

import { testDb, resetDb } from '../helpers/db'
import { hashPassword, verifyPassword } from '@/lib/password'
import { EMAIL_FREE_FAILURES, IP_FREE_FAILURES, BACKOFF_MINUTES } from '@/lib/login-throttle'
import { authorizeCredentials } from '@/auth.config'

const verifySpy = vi.mocked(verifyPassword)

beforeEach(async () => {
  await resetDb()
  verifySpy.mockClear()
})

const PASSWORD = 'Zq7!vantablack-Ledger'
const WRONG = 'Xw4?permafrost-Ledger'
const REAL = 'r.santos@rcl.com.ph'
const UNKNOWN = 'nobody.at.all@rcl.com.ph'
const CLIENT_IP = '203.0.113.9'

/** A request shaped like the one Vercel's proxy produces. */
function requestFrom(ip: string, spoof?: string) {
  const chain = spoof ? `${spoof}, ${ip}` : ip
  return new Request('https://checks.example/api/auth/callback/credentials', {
    headers: { 'x-forwarded-for': chain },
  })
}

async function makeRealUser(overrides: { active?: boolean } = {}) {
  return testDb.user.create({
    data: {
      email: REAL,
      name: 'Rosario Santos',
      passwordHash: await hashPassword(PASSWORD),
      role: 'FINANCE_ADMIN',
      active: overrides.active ?? true,
    },
  })
}

const secondsAgo = (n: number) => new Date(Date.now() - n * 1_000)

/** Failures already on the record, as though they had just been made. */
async function priorFailures(n: number, o: { email?: string; ip?: string } = {}) {
  for (let i = 0; i < n; i++) {
    await testDb.loginAttempt.create({
      data: {
        email: o.email ?? REAL,
        ip: o.ip ?? CLIENT_IP,
        success: false,
        createdAt: secondsAgo(5),
      },
    })
  }
}

describe('authorizeCredentials, signing in', () => {
  it('admits a real user with the right password', async () => {
    const user = await makeRealUser()

    const result = await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )
    expect(result).toMatchObject({ id: user.id, email: REAL, role: 'FINANCE_ADMIN' })
  })

  it('refuses a real user with the wrong password', async () => {
    await makeRealUser()

    expect(await authorizeCredentials(
      { email: REAL, password: WRONG }, requestFrom(CLIENT_IP),
    )).toBeNull()
  })

  it('still refuses a deactivated account', async () => {
    await makeRealUser({ active: false })

    expect(await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )).toBeNull()
  })
})

describe('authorizeCredentials, recording attempts', () => {
  // Rule 5. Without this nobody ever learns an attack happened.
  it('records a success with the email and the client address', async () => {
    await makeRealUser()

    await authorizeCredentials({ email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP))

    const [row] = await testDb.loginAttempt.findMany()
    expect(row).toMatchObject({ email: REAL, ip: CLIENT_IP, success: true })
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  it('records a failure against a real account', async () => {
    await makeRealUser()

    await authorizeCredentials({ email: REAL, password: WRONG }, requestFrom(CLIENT_IP))

    const [row] = await testDb.loginAttempt.findMany()
    expect(row).toMatchObject({ email: REAL, ip: CLIENT_IP, success: false })
  })

  // An address nobody holds is exactly what an enumeration sweep looks like,
  // so it is the most important kind of attempt to have on record.
  it('records a failure against an address no account uses', async () => {
    await authorizeCredentials({ email: UNKNOWN, password: WRONG }, requestFrom(CLIENT_IP))

    const [row] = await testDb.loginAttempt.findMany()
    expect(row).toMatchObject({ email: UNKNOWN, ip: CLIENT_IP, success: false })
  })

  it('records the attempt under the same normalised address the lookup used', async () => {
    await makeRealUser()

    await authorizeCredentials({ email: '  R.Santos@RCL.com.ph ', password: WRONG }, requestFrom(CLIENT_IP))

    const [row] = await testDb.loginAttempt.findMany()
    expect(row.email).toBe(REAL)
  })
})

describe('authorizeCredentials, the email lockout', () => {
  it('lets the right password through below the allowance', async () => {
    await makeRealUser()
    await priorFailures(EMAIL_FREE_FAILURES)

    expect(await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )).not.toBeNull()
  })

  // The point of the whole exercise: past the allowance, even the right
  // password does not open the door.
  it('refuses the right password once the email is locked', async () => {
    await makeRealUser()
    await priorFailures(EMAIL_FREE_FAILURES + 1)

    expect(await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )).toBeNull()
  })

  // Rule 4. The lock is measured from the last failure, so it lapses without
  // anybody being telephoned.
  it('admits the user again once the back-off has lapsed', async () => {
    await makeRealUser()
    const long_ago = new Date(Date.now() - (BACKOFF_MINUTES[0] + 1) * 60_000)
    for (let i = 0; i < EMAIL_FREE_FAILURES + 1; i++) {
      await testDb.loginAttempt.create({
        data: { email: REAL, ip: CLIENT_IP, success: false, createdAt: long_ago },
      })
    }

    expect(await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )).not.toBeNull()
  })

  // Rule 3, end to end. Four misses, one good sign-in, then a fifth miss must
  // not be the one that locks — otherwise a user who mistypes twice a day is
  // locked out by Thursday.
  it('clears the count on a successful sign-in', async () => {
    await makeRealUser()

    for (let i = 0; i < EMAIL_FREE_FAILURES; i++) {
      await authorizeCredentials({ email: REAL, password: WRONG }, requestFrom(CLIENT_IP))
    }
    expect(await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )).not.toBeNull()

    await authorizeCredentials({ email: REAL, password: WRONG }, requestFrom(CLIENT_IP))

    expect(await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )).not.toBeNull()
  })
})

describe('authorizeCredentials, the address lockout', () => {
  // Rule 1. Spreading the guesses across accounts must not evade the counter.
  it('refuses an address that has been guessing across many accounts', async () => {
    await makeRealUser()
    for (let i = 0; i <= IP_FREE_FAILURES + BACKOFF_MINUTES.length; i++) {
      await priorFailures(1, { email: `victim${i}@rcl.com.ph` })
    }

    expect(await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )).toBeNull()
  })

  // Rule 7. The counter is keyed on the entry the proxy appended, so putting
  // a fresh address at the front of the chain buys the attacker nothing.
  it('cannot be reset by spoofing x-forwarded-for', async () => {
    await makeRealUser()
    for (let i = 0; i <= IP_FREE_FAILURES + BACKOFF_MINUTES.length; i++) {
      await priorFailures(1, { email: `victim${i}@rcl.com.ph` })
    }

    for (const spoof of ['1.1.1.1', '8.8.8.8, 9.9.9.9', '203.0.113.250']) {
      expect(await authorizeCredentials(
        { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP, spoof),
      )).toBeNull()
    }
  })

  it('leaves an innocent address alone', async () => {
    await makeRealUser()
    for (let i = 0; i <= IP_FREE_FAILURES + BACKOFF_MINUTES.length; i++) {
      await priorFailures(1, { email: `victim${i}@rcl.com.ph`, ip: '198.51.100.4' })
    }

    expect(await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )).not.toBeNull()
  })
})

describe('authorizeCredentials, telling nobody which accounts exist', () => {
  // Rule 2. A locked real account and an address nobody holds must be the same
  // event as far as anyone outside can tell.
  it('answers a locked real account exactly as it answers an unknown address', async () => {
    await makeRealUser()
    await priorFailures(EMAIL_FREE_FAILURES + 1)
    await priorFailures(EMAIL_FREE_FAILURES + 1, { email: UNKNOWN, ip: '198.51.100.4' })

    const locked = await authorizeCredentials(
      { email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP),
    )
    const unknown = await authorizeCredentials(
      { email: UNKNOWN, password: PASSWORD }, requestFrom('198.51.100.4'),
    )

    expect(locked).toBeNull()
    expect(unknown).toBeNull()
    expect(locked).toEqual(unknown)
  })

  /**
   * Rule 2, structurally.
   *
   * `authorize` equalises the cost of every rejection by verifying against a
   * memoised throwaway hash when there is no account to verify against — see
   * the note on `dummyHash`. A lockout that returned before reaching the hash
   * would rebuild the timing oracle by another route: the locked account would
   * answer in a millisecond and the unknown address in an argon2's worth of
   * milliseconds, and the difference would say which addresses are real.
   *
   * Asserted by counting argon2 verifications rather than by timing them.
   * Wall-clock assertions against Neon from Manila are how a suite starts
   * failing one run in three on network latency, and a flaky security test
   * teaches people to re-run rather than read. Do not "strengthen" this into a
   * stopwatch.
   */
  it('still pays for an argon2 verification when it is refusing a locked account', async () => {
    await makeRealUser()
    await priorFailures(EMAIL_FREE_FAILURES + 1)

    verifySpy.mockClear()
    await authorizeCredentials({ email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP))
    const whenLocked = verifySpy.mock.calls.length

    verifySpy.mockClear()
    await authorizeCredentials({ email: UNKNOWN, password: PASSWORD }, requestFrom('198.51.100.4'))
    const whenUnknown = verifySpy.mock.calls.length

    expect(whenLocked).toBe(1)
    expect(whenUnknown).toBe(1)
  })

  it('pays for one just the same when the account is merely deactivated', async () => {
    await makeRealUser({ active: false })

    await authorizeCredentials({ email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP))

    expect(verifySpy.mock.calls.length).toBe(1)
  })

  // A locked account is still an account being attacked, and the record of the
  // attack should not stop at the point the throttle started refusing.
  it('goes on recording attempts while it is refusing them', async () => {
    await makeRealUser()
    await priorFailures(EMAIL_FREE_FAILURES + 1)
    const before = await testDb.loginAttempt.count()

    await authorizeCredentials({ email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP))

    expect(await testDb.loginAttempt.count()).toBe(before + 1)
  })

  // A refused sign-in must not leave a footprint on the user row that says the
  // password was right.
  it('does not stamp lastLoginAt when the lockout refuses a correct password', async () => {
    const user = await makeRealUser()
    await priorFailures(EMAIL_FREE_FAILURES + 1)

    await authorizeCredentials({ email: REAL, password: PASSWORD }, requestFrom(CLIENT_IP))

    const after = await testDb.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.lastLoginAt).toBeNull()
  })
})
