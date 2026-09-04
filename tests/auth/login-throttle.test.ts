import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import {
  BACKOFF_MINUTES, EMAIL_FREE_FAILURES, IP_FREE_FAILURES, RETENTION_DAYS,
  UNKNOWN_IP, WINDOW_MINUTES,
  clientIp, loginFailureSummary, loginLockout, pruneLoginAttempts, recordLoginAttempt,
} from '@/lib/login-throttle'

beforeEach(resetDb)

// A fixed instant, so every "n ago" below is exact rather than racing the
// clock across a 30-second Neon round trip.
const NOW = new Date('2026-09-04T08:00:00.000Z')
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000)
const secondsBefore = (n: number) => new Date(NOW.getTime() - n * 1_000)

// The default instant for a failure: recent enough that even the shortest
// back-off step is still running at NOW, so a test that means "locked" is not
// quietly passing because the lock had already expired.
const JUST_NOW = secondsBefore(5)

const VICTIM = 'r.santos@rcl.com.ph'
const ATTACKER_IP = '203.0.113.9'

// Enough failures from one address to reach the top of the back-off schedule,
// so an address-lock fixture cannot expire between being written and read.
const IP_LOCK_FAILURES = IP_FREE_FAILURES + BACKOFF_MINUTES.length

async function attempt(overrides: {
  email?: string; ip?: string; success?: boolean; at?: Date
} = {}) {
  return testDb.loginAttempt.create({
    data: {
      email: overrides.email ?? VICTIM,
      ip: overrides.ip ?? ATTACKER_IP,
      success: overrides.success ?? false,
      createdAt: overrides.at ?? JUST_NOW,
    },
  })
}

/** `n` failures against one email from one address, all at the same instant. */
async function failTimes(n: number, o: { email?: string; ip?: string; at?: Date } = {}) {
  for (let i = 0; i < n; i++) await attempt({ email: o.email, ip: o.ip, at: o.at })
}

/** `n` failures from one address, each against a different account. */
async function sprayTimes(n: number, o: { ip?: string; at?: Date } = {}) {
  for (let i = 0; i < n; i++) {
    await attempt({ email: `victim${i}@rcl.com.ph`, ip: o.ip, at: o.at })
  }
}

describe('clientIp', () => {
  const headers = (h: Record<string, string>) => new Headers(h)

  // Rule 7. Behind Vercel the client's own address is the entry appended by
  // the proxy closest to us, which is the RIGHTMOST one — everything to its
  // left was either added by a further-out proxy or sent by the client.
  it('takes the rightmost entry of x-forwarded-for', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1, 203.0.113.9' })))
      .toBe('203.0.113.9')
  })

  it('reads a single-entry header as the client address', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9')
  })

  // The control is decorative if an attacker can mint a fresh bucket per
  // request. Whatever they put in the header, the entry we key on is the one
  // the proxy appended, so every one of these lands in the SAME bucket.
  it('cannot be moved to another bucket by a spoofed header', () => {
    const spoofs = [
      '1.1.1.1, 203.0.113.9',
      '2.2.2.2, 3.3.3.3, 203.0.113.9',
      ', 203.0.113.9',
      '203.0.113.9',
    ]
    const buckets = new Set(spoofs.map((v) => clientIp(headers({ 'x-forwarded-for': v }))))
    expect([...buckets]).toEqual(['203.0.113.9'])
  })

  it('ignores empty entries and trailing separators', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.9, ,' }))).toBe('203.0.113.9')
  })

  // A per-request source port would be a fresh bucket per request, which is
  // the same hole as a spoofable header reached by another route.
  it('drops an IPv4 port so one client stays one bucket', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '10.0.0.1, 203.0.113.9:51514' })))
      .toBe('203.0.113.9')
  })

  it('keeps an IPv6 address whole', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '2001:db8::a1b2' }))).toBe('2001:db8::a1b2')
  })

  // With no proxy header there is no trustworthy source, so everything shares
  // one bucket. That over-throttles, which is the safe direction to be wrong.
  it('falls back to one shared bucket when no proxy header is present', () => {
    expect(clientIp(headers({}))).toBe(UNKNOWN_IP)
  })

  // x-real-ip is a single value with nothing appending to it, so trusting it
  // where x-forwarded-for is absent would hand an attacker a fresh bucket per
  // request in exactly the case we already know we are not behind a proxy.
  it('does not trust x-real-ip in place of the proxy chain', () => {
    expect(clientIp(headers({ 'x-real-ip': '1.2.3.4' }))).toBe(UNKNOWN_IP)
  })
})

describe('recordLoginAttempt', () => {
  // Rule 5. Both outcomes, with email, address and time — this is the evidence.
  it('records a failure with its email, address and timestamp', async () => {
    await recordLoginAttempt(testDb, { email: VICTIM, ip: ATTACKER_IP, success: false, now: NOW })

    const [row] = await testDb.loginAttempt.findMany()
    expect(row).toMatchObject({ email: VICTIM, ip: ATTACKER_IP, success: false })
    expect(row.createdAt.toISOString()).toBe(NOW.toISOString())
  })

  it('records a success too', async () => {
    await recordLoginAttempt(testDb, { email: VICTIM, ip: ATTACKER_IP, success: true, now: NOW })

    const [row] = await testDb.loginAttempt.findMany()
    expect(row).toMatchObject({ email: VICTIM, success: true })
  })

  // Rule 6. No cron exists, so the write path prunes.
  it('prunes rows past the retention window as it writes', async () => {
    const stale = await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 86_400_000) })
    const fresh = await attempt({ at: JUST_NOW })

    await recordLoginAttempt(testDb, { email: VICTIM, ip: ATTACKER_IP, success: false, now: NOW })

    const ids = (await testDb.loginAttempt.findMany()).map((r) => r.id)
    expect(ids).not.toContain(stale.id)
    expect(ids).toContain(fresh.id)
  })
})

describe('pruneLoginAttempts', () => {
  it('is callable on its own and reports what it removed', async () => {
    await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 2) * 86_400_000) })
    await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 86_400_000) })
    await attempt({ at: JUST_NOW })

    expect(await pruneLoginAttempts(testDb, { now: NOW })).toBe(2)
    expect(await testDb.loginAttempt.count()).toBe(1)
  })

  it('keeps a row that is still inside the retention window', async () => {
    await attempt({ at: new Date(NOW.getTime() - RETENTION_DAYS * 86_400_000 + 60_000) })

    expect(await pruneLoginAttempts(testDb, { now: NOW })).toBe(0)
  })
})

describe('loginLockout, on the email', () => {
  it('lets an honest mistake through below the allowance', async () => {
    await failTimes(EMAIL_FREE_FAILURES)

    const lockout = await loginLockout(testDb, { email: VICTIM, ip: ATTACKER_IP, now: NOW })
    expect(lockout.locked).toBe(false)
  })

  it('locks on the first failure past the allowance', async () => {
    await failTimes(EMAIL_FREE_FAILURES + 1)

    const lockout = await loginLockout(testDb, { email: VICTIM, ip: ATTACKER_IP, now: NOW })
    expect(lockout).toMatchObject({ locked: true, scope: 'EMAIL' })
  })

  // Rule 4, and the numbers. The lock runs from the LAST failure, so the
  // schedule is 1, 2, 5 then 15 minutes and never longer.
  it('backs off on the published schedule and no further', async () => {
    // A separate address per step rather than a reset per step: `resetDb`
    // truncates fifteen tables over the network, and six of those inside one
    // test is most of the timeout budget.
    const steps = BACKOFF_MINUTES.length + 2
    const at = secondsBefore(30)
    for (let extra = 1; extra <= steps; extra++) {
      await failTimes(EMAIL_FREE_FAILURES + extra, {
        email: `step${extra}@rcl.com.ph`, ip: `198.51.100.${extra}`, at,
      })
    }

    const seen: number[] = []
    for (let extra = 1; extra <= steps; extra++) {
      const lockout = await loginLockout(
        testDb, { email: `step${extra}@rcl.com.ph`, ip: `198.51.100.${extra}`, now: NOW },
      )
      expect(lockout.until).not.toBeNull()
      seen.push(Math.round((lockout.until!.getTime() - at.getTime()) / 60_000))
    }
    expect(seen).toEqual([...BACKOFF_MINUTES, 15, 15])
  })

  // Rule 4. Nobody has to be telephoned to unlock an account.
  it('expires on its own once the back-off has passed', async () => {
    // One past the allowance is a one-minute step, and the last failure was
    // three minutes ago.
    await failTimes(EMAIL_FREE_FAILURES + 1, { at: minutesBefore(3) })

    const lockout = await loginLockout(testDb, { email: VICTIM, ip: ATTACKER_IP, now: NOW })
    expect(lockout.locked).toBe(false)
  })

  it('forgets failures older than the counting window entirely', async () => {
    await failTimes(EMAIL_FREE_FAILURES + 20, { at: minutesBefore(WINDOW_MINUTES + 40) })

    const lockout = await loginLockout(testDb, { email: VICTIM, ip: ATTACKER_IP, now: NOW })
    expect(lockout.locked).toBe(false)
  })

  // Rule 3. Otherwise a user who mistypes twice a day is locked out by
  // Thursday.
  it('clears the email counter on a successful sign-in', async () => {
    await failTimes(EMAIL_FREE_FAILURES + 1, { at: minutesBefore(10) })
    await attempt({ success: true, at: minutesBefore(3) })
    await attempt({ at: JUST_NOW })

    const lockout = await loginLockout(testDb, { email: VICTIM, ip: ATTACKER_IP, now: NOW })
    expect(lockout.locked).toBe(false)
  })

  // The success clears the counter without erasing the evidence: those rows
  // are how anyone answers "was there an attack".
  it('clears the counter without deleting the failures it cleared', async () => {
    await failTimes(EMAIL_FREE_FAILURES + 1, { at: minutesBefore(10) })
    await recordLoginAttempt(testDb, { email: VICTIM, ip: ATTACKER_IP, success: true, now: NOW })

    expect(await testDb.loginAttempt.count({ where: { success: false } }))
      .toBe(EMAIL_FREE_FAILURES + 1)
  })

  it('does not let a success on one address clear another address', async () => {
    await failTimes(EMAIL_FREE_FAILURES + 1)
    await attempt({ email: 'someone.else@rcl.com.ph', success: true, at: secondsBefore(2) })

    const lockout = await loginLockout(testDb, { email: VICTIM, ip: ATTACKER_IP, now: NOW })
    expect(lockout.locked).toBe(true)
  })
})

describe('loginLockout, on the address', () => {
  // Rule 1. Email-only throttling lets an attacker spread one guess across
  // thousands of accounts, so the address is counted independently of whoever
  // is being guessed at.
  it('locks an address guessing across many different accounts', async () => {
    await sprayTimes(IP_LOCK_FAILURES)

    const lockout = await loginLockout(
      testDb, { email: 'never.seen@rcl.com.ph', ip: ATTACKER_IP, now: NOW },
    )
    expect(lockout).toMatchObject({ locked: true, scope: 'IP' })
  })

  it('does not lock an address below its own allowance', async () => {
    await sprayTimes(IP_FREE_FAILURES)

    const lockout = await loginLockout(
      testDb, { email: 'never.seen@rcl.com.ph', ip: ATTACKER_IP, now: NOW },
    )
    expect(lockout.locked).toBe(false)
  })

  // Deliberately NOT symmetrical with the email rule. An attacker holding one
  // valid account could otherwise sign into it whenever they liked and reset
  // their own address counter at will.
  it('is not cleared by a successful sign-in from that address', async () => {
    await sprayTimes(IP_LOCK_FAILURES, { at: minutesBefore(2) })
    await attempt({ email: 'insider@rcl.com.ph', success: true, at: JUST_NOW })

    const lockout = await loginLockout(
      testDb, { email: 'never.seen@rcl.com.ph', ip: ATTACKER_IP, now: NOW },
    )
    expect(lockout.locked).toBe(true)
  })

  // Rule 1, the other half: an address nobody is attacking from must not be
  // penalised for a victim's own fat fingers.
  it('leaves a different address alone', async () => {
    await sprayTimes(IP_LOCK_FAILURES)

    const lockout = await loginLockout(
      testDb, { email: 'never.seen@rcl.com.ph', ip: '198.51.100.4', now: NOW },
    )
    expect(lockout.locked).toBe(false)
  })
})

describe('loginLockout, when both apply', () => {
  // Rule 1: the stricter one wins, and stricter means the later deadline.
  it('reports the later of the two deadlines', async () => {
    // The address sits at the 15-minute cap, but its last failure was 14
    // minutes ago, so it has one minute left to run.
    await sprayTimes(IP_LOCK_FAILURES, { at: minutesBefore(14) })
    // The email is three past its allowance — a five-minute step — but runs
    // from half a minute ago, so it outlasts the address. Deliberately from a
    // DIFFERENT address: as the attacker's own failures these would extend the
    // address lock instead, and the test would no longer be about which of two
    // deadlines wins.
    await failTimes(EMAIL_FREE_FAILURES + 3, { ip: '198.51.100.77', at: secondsBefore(30) })

    const lockout = await loginLockout(testDb, { email: VICTIM, ip: ATTACKER_IP, now: NOW })
    expect(lockout.locked).toBe(true)
    expect(lockout.scope).toBe('EMAIL')
    expect(lockout.until!.getTime()).toBe(secondsBefore(30).getTime() + 5 * 60_000)
  })

  it('locks on the address even when the email is clean', async () => {
    await sprayTimes(IP_LOCK_FAILURES)
    await attempt({ email: VICTIM, success: true, at: secondsBefore(2) })

    const lockout = await loginLockout(testDb, { email: VICTIM, ip: ATTACKER_IP, now: NOW })
    expect(lockout).toMatchObject({ locked: true, scope: 'IP' })
  })
})

describe('loginFailureSummary', () => {
  // What the users screen reads. It has to agree with the gate, so it is built
  // from the same per-email count rather than a second interpretation of it.
  it('counts recent failures per address and reports the lockout', async () => {
    await failTimes(EMAIL_FREE_FAILURES + 1)
    await attempt({ email: 'quiet@rcl.com.ph', at: minutesBefore(2) })

    const summary = await loginFailureSummary(
      testDb, { emails: [VICTIM, 'quiet@rcl.com.ph', 'unheard@rcl.com.ph'], now: NOW },
    )

    expect(summary.get(VICTIM)).toMatchObject({ recentFailures: EMAIL_FREE_FAILURES + 1 })
    expect(summary.get(VICTIM)!.lockedUntil).not.toBeNull()
    expect(summary.get('quiet@rcl.com.ph')).toEqual({ recentFailures: 1, lockedUntil: null })
    expect(summary.get('unheard@rcl.com.ph')).toEqual({ recentFailures: 0, lockedUntil: null })
  })

  it('agrees with the gate about who is locked', async () => {
    await failTimes(EMAIL_FREE_FAILURES + 1)

    const summary = await loginFailureSummary(testDb, { emails: [VICTIM], now: NOW })
    const lockout = await loginLockout(testDb, { email: VICTIM, ip: '198.51.100.4', now: NOW })

    expect(summary.get(VICTIM)!.lockedUntil!.getTime()).toBe(lockout.until!.getTime())
  })

  it('reports nothing for an empty list', async () => {
    expect(await loginFailureSummary(testDb, { emails: [], now: NOW })).toEqual(new Map())
  })
})
