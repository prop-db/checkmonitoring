import { describe, it, expect } from 'vitest'
import { issuedOn, clearedOn, isOutstandingAsOf, type OutstandingInput } from '@/lib/recon/outstanding'

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
const base: OutstandingInput = {
  status: 'RELEASED', releasedAt: null, checkDate: d('2026-08-20'),
  clearingStatus: 'NONE', clearedDate: null, amount: '100.00',
}

describe('issuedOn', () => {
  it('uses the release day when one was recorded', () => {
    // 2026-09-10 23:30 Manila is 15:30Z — the Manila day is the 10th.
    expect(issuedOn({ releasedAt: new Date('2026-09-10T15:30:00Z'), checkDate: d('2026-08-20') }))
      .toEqual({ day: '2026-09-10', basis: 'RELEASED AT' })
  })
  it('falls back to the check date, and says so', () => {
    expect(issuedOn({ releasedAt: null, checkDate: d('2026-08-20') })).toEqual({ day: '2026-08-20', basis: 'CHECK DATE' })
  })
  it('is null with neither date', () => {
    expect(issuedOn({ releasedAt: null, checkDate: null })).toBeNull()
  })
})

describe('clearedOn', () => {
  it('is null unless CLEARED', () => {
    expect(clearedOn({ clearingStatus: 'NONE', clearedDate: null })).toBeNull()
    expect(clearedOn({ clearingStatus: 'DEPOSITED', clearedDate: d('2026-09-01') })).toBeNull()
  })
  it('is the cleared day, or UNKNOWN when CLEARED carries no date', () => {
    expect(clearedOn({ clearingStatus: 'CLEARED', clearedDate: d('2026-09-01') })).toBe('2026-09-01')
    expect(clearedOn({ clearingStatus: 'CLEARED', clearedDate: null })).toBe('UNKNOWN')
  })
})

describe('isOutstandingAsOf', () => {
  it('counts a released, uncleared check issued on or before the day', () => {
    expect(isOutstandingAsOf(base, '2026-09-12')).toBe(true)
    expect(isOutstandingAsOf(base, '2026-08-20')).toBe(true)   // issued that very day
    expect(isOutstandingAsOf(base, '2026-08-19')).toBe(false)  // not yet issued
  })
  it('never counts a check that is not RELEASED', () => {
    for (const status of ['SIGNED', 'READY_FOR_RELEASE', 'CANCELLED', 'VOIDED'] as const) {
      expect(isOutstandingAsOf({ ...base, status }, '2026-09-12'), status).toBe(false)
    }
  })
  it('stops counting on the cleared day, and counts up to the day before', () => {
    const cleared = { ...base, clearingStatus: 'CLEARED' as const, clearedDate: d('2026-09-05') }
    expect(isOutstandingAsOf(cleared, '2026-09-04')).toBe(true)
    expect(isOutstandingAsOf(cleared, '2026-09-05')).toBe(false)
    expect(isOutstandingAsOf(cleared, '2026-09-12')).toBe(false)
  })
  it('treats CLEARED with no date as cleared on every day', () => {
    expect(isOutstandingAsOf({ ...base, clearingStatus: 'CLEARED' }, '2026-08-20')).toBe(false)
  })
  it('keeps DEPOSITED and ENCASHED outstanding — the bank has not paid', () => {
    expect(isOutstandingAsOf({ ...base, clearingStatus: 'DEPOSITED' }, '2026-09-12')).toBe(true)
    expect(isOutstandingAsOf({ ...base, clearingStatus: 'ENCASHED' }, '2026-09-12')).toBe(true)
  })
  it('counts a released check with no date at all on any day', () => {
    expect(isOutstandingAsOf({ ...base, checkDate: null }, '2000-01-01')).toBe(true)
  })
  it('never counts a check with no recorded amount', () => {
    expect(isOutstandingAsOf({ ...base, amount: null }, '2026-09-12')).toBe(false)
  })
})
