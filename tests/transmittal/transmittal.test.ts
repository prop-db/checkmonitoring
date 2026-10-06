import { describe, it, expect } from 'vitest'
import { amountToCentavos, formatAmount, totalsByCurrency, compareCheckNumbers } from '@/lib/transmittal'

describe('formatAmount', () => {
  it('groups thousands and pads to two decimals', () => {
    expect(formatAmount('190817.35')).toBe('190,817.35')
    expect(formatAmount('5000')).toBe('5,000.00')
    expect(formatAmount('12.5')).toBe('12.50')
    expect(formatAmount('-1234567.89')).toBe('-1,234,567.89')
  })
  it('renders no amount as a dash, never zero', () => {
    expect(formatAmount(null)).toBe('—')
  })
})

describe('amountToCentavos', () => {
  it('reads decimal strings and refuses anything else', () => {
    expect(amountToCentavos('0.05')).toBe(BigInt(5))
    expect(amountToCentavos('12x')).toBeNull()
  })
})

describe('totalsByCurrency', () => {
  it('sums to the centavo, per currency, skipping blanks', () => {
    const rows = [
      { amount: '190817.35', currency: 'PHP' },
      { amount: '180521.15', currency: 'PHP' },
      { amount: '0.10', currency: 'PHP' },
      { amount: null, currency: 'PHP' },
      { amount: '10.00', currency: 'USD' },
    ]
    expect(totalsByCurrency(rows)).toEqual([
      { currency: 'PHP', total: '371,338.60', count: 3 },
      { currency: 'USD', total: '10.00', count: 1 },
    ])
  })
})

describe('compareCheckNumbers', () => {
  it('orders numerically, text last', () => {
    expect(['1791406000', '179140599', 'PCF26-00001', '1791405999'].sort(compareCheckNumbers))
      .toEqual(['179140599', '1791405999', '1791406000', 'PCF26-00001'])
  })
})
