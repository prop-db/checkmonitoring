import { describe, it, expect } from 'vitest'
import {
  RECEIPT_TYPES, isReceiptType, checkReceipt, normaliseReceipt, hasReceipt,
} from '@/lib/domain/receipt'

// Pure. No database, no clock — every way a receipt can be typed wrong is
// answerable here, which is why the guard lives outside `actions.ts`.

describe('the receipt types', () => {
  it('is exactly OR and CR — the two pieces of paper a supplier hands over', () => {
    expect([...RECEIPT_TYPES]).toEqual(['OR', 'CR'])
  })

  it('recognises its own values and nothing else', () => {
    expect(isReceiptType('OR')).toBe(true)
    expect(isReceiptType('CR')).toBe(true)
    // The bank clearing reference lives in `crNumber` beside `clearingStatus`
    // and is a different fact entirely. Nothing here may be coaxed into it.
    expect(isReceiptType('CRN')).toBe(false)
    expect(isReceiptType('or')).toBe(false)
    expect(isReceiptType('')).toBe(false)
    expect(isReceiptType(null)).toBe(false)
    expect(isReceiptType(7)).toBe(false)
  })
})

describe('checkReceipt', () => {
  // The client's own wording: "It is optional. A cheque can be released with
  // the box empty and the receipt added later." RELEASE ALL at the counter
  // depends on this being true.
  it('permits no receipt at all', () => {
    expect(checkReceipt({})).toEqual({ ok: true })
    expect(checkReceipt({ orNumber: null, receiptType: null })).toEqual({ ok: true })
    expect(checkReceipt({ orNumber: '   ', receiptType: null })).toEqual({ ok: true })
  })

  it('permits a reference with a type', () => {
    expect(checkReceipt({ orNumber: 'OR-000123', receiptType: 'OR' })).toEqual({ ok: true })
    expect(checkReceipt({ orNumber: '4471', receiptType: 'CR' })).toEqual({ ok: true })
  })

  // The one combination refused. A reference stored without its kind is a
  // number nobody can classify later, and defaulting it to OR would invent the
  // answer rather than ask for it.
  it('refuses a reference with no type chosen', () => {
    const guard = checkReceipt({ orNumber: 'OR-000123', receiptType: null })
    expect(guard.ok).toBe(false)
    if (guard.ok) return
    expect(guard.code).toBe('RECEIPT_TYPE_REQUIRED')
    expect(guard.message).toContain('Official Receipt')
    expect(guard.message).toContain('Collection Receipt')
  })

  it('refuses a reference that is whitespace-padded but real, with no type', () => {
    expect(checkReceipt({ orNumber: '  OR-9  ', receiptType: null }).ok).toBe(false)
  })

  // Not a refusal: there is simply nothing to record. See `normaliseReceipt`.
  it('permits a type with no reference', () => {
    expect(checkReceipt({ orNumber: null, receiptType: 'OR' })).toEqual({ ok: true })
  })
})

describe('normaliseReceipt', () => {
  it('trims the reference', () => {
    expect(normaliseReceipt({ orNumber: '  OR-000123 ', receiptType: 'OR' })).toEqual({
      orNumber: 'OR-000123', orDate: null, receiptType: 'OR',
    })
  })

  it('keeps the date that belongs to a reference', () => {
    const d = new Date('2026-09-08T00:00:00Z')
    expect(normaliseReceipt({ orNumber: 'CR-77', orDate: d, receiptType: 'CR' })).toEqual({
      orNumber: 'CR-77', orDate: d, receiptType: 'CR',
    })
  })

  // A type and a date with no reference describe a receipt nobody can look up.
  // They are dropped rather than stored, so a report of "the CRs issued in
  // September" counts pieces of paper and not half-filled forms.
  it('drops a type and a date when there is no reference', () => {
    expect(normaliseReceipt({
      orNumber: '   ', orDate: new Date('2026-09-08T00:00:00Z'), receiptType: 'OR',
    })).toEqual({ orNumber: null, orDate: null, receiptType: null })
  })

  it('answers null for everything when it is given nothing', () => {
    expect(normaliseReceipt({})).toEqual({ orNumber: null, orDate: null, receiptType: null })
  })
})

describe('hasReceipt', () => {
  it('is true only when a reference was recorded', () => {
    expect(hasReceipt({ orNumber: 'OR-1', orDate: null, receiptType: 'OR' })).toBe(true)
    expect(hasReceipt({ orNumber: null, orDate: null, receiptType: null })).toBe(false)
  })
})
