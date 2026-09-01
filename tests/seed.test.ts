import { describe, it, expect } from 'vitest'
import { formatPhp } from '@/lib/money'

describe('formatPhp', () => {
  it('formats with the peso sign, thousands separators and two decimals', () => {
    expect(formatPhp('197715.42')).toBe('₱197,715.42')
    expect(formatPhp('7950')).toBe('₱7,950.00')
    expect(formatPhp('0')).toBe('₱0.00')
  })

  it('handles large treasury amounts without losing precision', () => {
    expect(formatPhp('16000000')).toBe('₱16,000,000.00')
    expect(formatPhp('1471800.5')).toBe('₱1,471,800.50')
  })

  it('rounds half-up rather than truncating', () => {
    expect(formatPhp('10.005')).toBe('₱10.01')
    expect(formatPhp('10.004')).toBe('₱10.00')
    expect(formatPhp('0.999')).toBe('₱1.00')
    expect(formatPhp('9.999')).toBe('₱10.00')
    expect(formatPhp('99.999')).toBe('₱100.00')
    // Carry across a grouping boundary must not corrupt the separators.
    expect(formatPhp('999999.999')).toBe('₱1,000,000.00')
  })

  it('formats negative amounts with the sign outside the peso symbol', () => {
    expect(formatPhp('-32500.00')).toBe('-₱32,500.00')
    expect(formatPhp('-0.005')).toBe('-₱0.01')
  })
})
