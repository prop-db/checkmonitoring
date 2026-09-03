import { describe, it, expect } from 'vitest'
import { formatMoney } from '@/lib/money'

describe('formatMoney: PHP (every case formatPhp used to cover)', () => {
  it('formats with the peso sign, thousands separators and two decimals', () => {
    expect(formatMoney('197715.42', 'PHP')).toBe('₱197,715.42')
    expect(formatMoney('7950', 'PHP')).toBe('₱7,950.00')
    expect(formatMoney('0', 'PHP')).toBe('₱0.00')
  })

  it('handles large treasury amounts without losing precision', () => {
    expect(formatMoney('16000000', 'PHP')).toBe('₱16,000,000.00')
    expect(formatMoney('1471800.5', 'PHP')).toBe('₱1,471,800.50')
  })

  it('rounds half-up rather than truncating', () => {
    expect(formatMoney('10.005', 'PHP')).toBe('₱10.01')
    expect(formatMoney('10.004', 'PHP')).toBe('₱10.00')
    expect(formatMoney('0.999', 'PHP')).toBe('₱1.00')
    expect(formatMoney('9.999', 'PHP')).toBe('₱10.00')
    expect(formatMoney('99.999', 'PHP')).toBe('₱100.00')
    // Carry across a grouping boundary must not corrupt the separators.
    expect(formatMoney('999999.999', 'PHP')).toBe('₱1,000,000.00')
  })

  it('formats negative amounts with the sign outside the peso symbol', () => {
    expect(formatMoney('-32500.00', 'PHP')).toBe('-₱32,500.00')
    expect(formatMoney('-0.005', 'PHP')).toBe('-₱0.01')
  })
})

describe('formatMoney: other currencies', () => {
  it('formats CNY with the yuan sign', () => {
    expect(formatMoney('892140', 'CNY')).toBe('¥892,140.00')
  })

  it('formats USD with the dollar sign', () => {
    expect(formatMoney('1250.5', 'USD')).toBe('$1,250.50')
  })

  it('renders an unknown currency code rather than guessing a symbol', () => {
    expect(formatMoney('1000', 'XYZ')).toBe('XYZ 1,000.00')
  })

  it('is case-insensitive on the currency code', () => {
    expect(formatMoney('892140', 'cny')).toBe('¥892,140.00')
  })
})

// 397 of the register's 12,161 rows carry no amount at all - 260 blank, 135
// where the amount column literally holds the word "CANCELLED", 2 shifted rows
// holding a date. Storing those as 0.00 would understate every total they
// appear in and would be indistinguishable from a genuine zero-value cheque.
describe('formatMoney: an amount the register does not know', () => {
  it('renders an em dash for null rather than a zero or a crash', () => {
    expect(formatMoney(null, 'PHP')).toBe('—')
    expect(formatMoney(null, 'CNY')).toBe('—')
    expect(formatMoney(null, 'XYZ')).toBe('—')
  })

  // The load-bearing pair. Unknown and zero are different facts about a cheque
  // and must never render the same; do not "tidy" these two into one case.
  it('still renders a genuine zero as a zero, not as unknown', () => {
    expect(formatMoney('0', 'PHP')).toBe('₱0.00')
    expect(formatMoney(0, 'PHP')).toBe('₱0.00')
    expect(formatMoney('0.00', 'PHP')).toBe('₱0.00')
  })
})
