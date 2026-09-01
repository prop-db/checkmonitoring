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
})
