import { describe, it, expect } from 'vitest'
import { MAX_BULK_SELECTION, parseSelection } from '@/lib/bulk'

describe('parseSelection', () => {
  it('keeps the ticked ids in the order they were submitted', () => {
    expect(parseSelection(['a', 'b', 'c'])).toEqual({ ok: true, checkIds: ['a', 'b', 'c'] })
  })

  it('drops blanks and whitespace-only entries', () => {
    expect(parseSelection(['a', '', '   ', 'b'])).toEqual({ ok: true, checkIds: ['a', 'b'] })
  })

  it('trims each id', () => {
    expect(parseSelection([' a ', 'b'])).toEqual({ ok: true, checkIds: ['a', 'b'] })
  })

  it('de-duplicates, so one cheque is never acted on twice in a batch', () => {
    expect(parseSelection(['a', 'b', 'a'])).toEqual({ ok: true, checkIds: ['a', 'b'] })
  })

  it('refuses an empty selection', () => {
    expect(parseSelection([])).toEqual({
      ok: false,
      message: 'Select at least one cheque first.',
    })
  })

  it('refuses a selection of nothing but blanks', () => {
    expect(parseSelection(['', '  '])).toEqual({
      ok: false,
      message: 'Select at least one cheque first.',
    })
  })

  it('caps the selection size', () => {
    const many = Array.from({ length: MAX_BULK_SELECTION + 1 }, (_, i) => `id-${i}`)
    expect(parseSelection(many)).toEqual({
      ok: false,
      message:
        `A bulk action is limited to ${MAX_BULK_SELECTION} cheques at a time; ` +
        `${MAX_BULK_SELECTION + 1} are selected. Narrow the selection and try again.`,
    })
  })

  it('allows exactly the cap', () => {
    const many = Array.from({ length: MAX_BULK_SELECTION }, (_, i) => `id-${i}`)
    const result = parseSelection(many)
    expect(result.ok).toBe(true)
  })

  it('counts duplicates only once against the cap', () => {
    const many = Array.from({ length: MAX_BULK_SELECTION }, (_, i) => `id-${i}`)
    const result = parseSelection([...many, 'id-0', 'id-1'])
    expect(result).toEqual({ ok: true, checkIds: many })
  })
})
