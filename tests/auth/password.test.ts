import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, validatePasswordStrength } from '@/lib/password'

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('Str0ng!Passw0rd')
    expect(hash).not.toContain('Str0ng!Passw0rd')
    expect(await verifyPassword(hash, 'Str0ng!Passw0rd')).toBe(true)
    expect(await verifyPassword(hash, 'wrong')).toBe(false)
  })

  it('produces a different hash for the same password each time', async () => {
    expect(await hashPassword('Str0ng!Passw0rd')).not.toBe(await hashPassword('Str0ng!Passw0rd'))
  })
})

describe('password strength', () => {
  it('accepts a strong password', () => {
    expect(validatePasswordStrength('Str0ng!Passw0rd')).toEqual({ ok: true })
  })

  it('rejects passwords under 12 characters', () => {
    const r = validatePasswordStrength('Sh0rt!1')
    expect(r.ok).toBe(false)
  })

  it('requires upper, lower, digit and symbol', () => {
    expect(validatePasswordStrength('alllowercase1!').ok).toBe(false)
    expect(validatePasswordStrength('ALLUPPERCASE1!').ok).toBe(false)
    expect(validatePasswordStrength('NoDigitsHere!!').ok).toBe(false)
    expect(validatePasswordStrength('NoSymbols1234').ok).toBe(false)
  })
})
