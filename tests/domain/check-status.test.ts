import { describe, it, expect } from 'vitest'
import {
  canTransition, assertTransition, checkReadyForRelease,
  canSetClearing, assertClearing,
} from '@/lib/domain/check-status'
import { DomainError } from '@/lib/domain/errors'

describe('release ladder transitions', () => {
  it('allows the forward path', () => {
    expect(canTransition('GENERATED', 'SIGNATURE_PENDING')).toBe(true)
    expect(canTransition('SIGNATURE_PENDING', 'SIGNED')).toBe(true)
    expect(canTransition('SIGNED', 'READY_FOR_RELEASE')).toBe(true)
    expect(canTransition('READY_FOR_RELEASE', 'SCHEDULED')).toBe(true)
    expect(canTransition('SCHEDULED', 'RELEASED')).toBe(true)
  })

  it('allows release without a confirmed pickup slot', () => {
    expect(canTransition('READY_FOR_RELEASE', 'RELEASED')).toBe(true)
  })

  it('forbids releasing a check that was never made available', () => {
    expect(canTransition('SIGNED', 'RELEASED')).toBe(false)
  })

  it('allows revert back to SIGNED from both available states', () => {
    expect(canTransition('READY_FOR_RELEASE', 'SIGNED')).toBe(true)
    expect(canTransition('SCHEDULED', 'SIGNED')).toBe(true)
  })

  it('allows cancellation from any pre-released state', () => {
    for (const s of ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED'] as const) {
      expect(canTransition(s, 'CANCELLED')).toBe(true)
    }
  })

  it('treats RELEASED and CANCELLED as terminal', () => {
    expect(canTransition('RELEASED', 'SIGNED')).toBe(false)
    expect(canTransition('RELEASED', 'CANCELLED')).toBe(false)
    expect(canTransition('CANCELLED', 'SIGNED')).toBe(false)
  })

  it('forbids skipping the signature step', () => {
    expect(canTransition('GENERATED', 'READY_FOR_RELEASE')).toBe(false)
  })

  it('assertTransition throws a coded DomainError on an illegal move', () => {
    expect(() => assertTransition('SIGNED', 'RELEASED')).toThrow(DomainError)
    try { assertTransition('SIGNED', 'RELEASED') }
    catch (e) { expect((e as DomainError).code).toBe('ILLEGAL_TRANSITION') }
  })
})

describe('VOIDED', () => {
  it('is reachable from every pre-terminal state, including RELEASED', () => {
    for (const s of [
      'GENERATED', 'SIGNATURE_PENDING', 'SIGNED',
      'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED',
    ] as const) {
      expect(canTransition(s, 'VOIDED')).toBe(true)
    }
  })

  it('is not reachable from CANCELLED', () => {
    expect(canTransition('CANCELLED', 'VOIDED')).toBe(false)
  })

  it('is itself terminal', () => {
    for (const s of [
      'GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE',
      'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED',
    ] as const) {
      expect(canTransition('VOIDED', s)).toBe(false)
    }
  })
})

const validReady = {
  status: 'SIGNED' as const,
  checkNumber: '6000329924',
  payeeName: 'HENKEL PHILIPPINES INC.',
  amount: '197715.42',
  checkDate: new Date('2026-09-01'),
  cashAccountCode: 'BPI STK',
  availablePickupDate: new Date('2026-09-03'),
}

describe('READY FOR RELEASE guards', () => {
  it('passes when signed and complete', () => {
    expect(checkReadyForRelease(validReady)).toEqual({ ok: true })
  })

  it('blocks a check that is not SIGNED, with the exact spec message', () => {
    const r = checkReadyForRelease({ ...validReady, status: 'SIGNATURE_PENDING' })
    expect(r).toEqual({
      ok: false,
      code: 'NOT_SIGNED',
      message: 'This check cannot be released because it has not yet been marked as SIGNED.',
    })
  })

  it('blocks a check that is already RELEASED', () => {
    const r = checkReadyForRelease({ ...validReady, status: 'RELEASED' })
    expect(r).toEqual({
      ok: false,
      code: 'ALREADY_RELEASED',
      message: 'This check cannot be released because it has already been RELEASED.',
    })
  })

  it('names every missing required field', () => {
    const r = checkReadyForRelease({ ...validReady, checkNumber: null, availablePickupDate: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('MISSING_FIELDS')
    expect(r.message).toBe(
      'This check cannot be released because required information is missing: CHECK NUMBER, AVAILABLE PICKUP DATE.')
  })

  it('treats an empty string as missing', () => {
    const r = checkReadyForRelease({ ...validReady, payeeName: '   ' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('MISSING_FIELDS')
    expect(r.message).toBe(
      'This check cannot be released because required information is missing: PAYEE.')
  })

  it('reports ALREADY_RELEASED ahead of missing fields', () => {
    const r = checkReadyForRelease({ ...validReady, status: 'RELEASED', checkNumber: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('ALREADY_RELEASED')
  })
})

describe('clearing axis', () => {
  it('permits clearing only once the check is RELEASED', () => {
    expect(canSetClearing('RELEASED', 'NONE', 'DEPOSITED')).toBe(true)
    expect(canSetClearing('SCHEDULED', 'NONE', 'DEPOSITED')).toBe(false)
    expect(canSetClearing('READY_FOR_RELEASE', 'NONE', 'ENCASHED')).toBe(false)
  })

  it('allows DEPOSITED or ENCASHED then CLEARED', () => {
    expect(canSetClearing('RELEASED', 'NONE', 'ENCASHED')).toBe(true)
    expect(canSetClearing('RELEASED', 'DEPOSITED', 'CLEARED')).toBe(true)
    expect(canSetClearing('RELEASED', 'ENCASHED', 'CLEARED')).toBe(true)
  })

  it('forbids skipping straight to CLEARED and forbids moving off CLEARED', () => {
    expect(canSetClearing('RELEASED', 'NONE', 'CLEARED')).toBe(false)
    expect(canSetClearing('RELEASED', 'CLEARED', 'DEPOSITED')).toBe(false)
  })

  it('assertClearing throws a coded DomainError', () => {
    expect(() => assertClearing('SIGNED', 'NONE', 'DEPOSITED')).toThrow(DomainError)
    try { assertClearing('SIGNED', 'NONE', 'DEPOSITED') }
    catch (e) { expect((e as DomainError).code).toBe('ILLEGAL_CLEARING') }
  })
})
