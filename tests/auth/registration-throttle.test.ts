import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { RETENTION_DAYS, UNKNOWN_IP } from '@/lib/login-throttle'
import {
  REGISTRATION_WINDOW_MINUTES,
  pruneRegistrationAttempts, recordRegistrationAttempt,
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

describe('recordRegistrationAttempt', () => {
  it('writes the row and prunes rows past retention in the same call', async () => {
    await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60_000) })
    await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })
    const rows = await testDb.registrationAttempt.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ip: IP, email: 'new@example.com', createdAt: NOW })
  })

  it('counts its own row when there is nothing else', async () => {
    expect(await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).toEqual({ recent: 1 })
  })

  it('counts the row it just wrote: N prior rows in the window give N + 1', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt()
    expect(await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).toEqual({ recent: LIMIT + 1 })
  })

  it('does not count submissions older than the hour', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt({ at: minutesBefore(REGISTRATION_WINDOW_MINUTES + 1) })
    expect((await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).recent).toBe(1)
  })

  it('counts only the asking address', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt({ ip: '198.51.100.7' })
    expect((await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).recent).toBe(1)
  })

  it('counts a row exactly 60 minutes old and not one 1 ms older', async () => {
    await attempt({ at: minutesBefore(REGISTRATION_WINDOW_MINUTES) })
    await attempt({ at: new Date(NOW.getTime() - REGISTRATION_WINDOW_MINUTES * 60_000 - 1) })
    expect((await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).recent).toBe(2)
  })

  // The shared bucket over-throttles rather than under-throttles. Deliberate.
  it('counts the unknown-address bucket like any other', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt({ ip: UNKNOWN_IP })
    expect((await recordRegistrationAttempt(testDb, { ip: UNKNOWN_IP, email: 'new@example.com', now: NOW })).recent).toBe(LIMIT + 1)
  })

  it('keeps a recent row through the prune and deletes one past retention', async () => {
    await attempt({ at: minutesBefore(5) })
    await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60_000) })
    await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })
    expect(await testDb.registrationAttempt.count()).toBe(2)
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
