import { describe, it, expect } from 'vitest'
import { MAX_BULK_SELECTION, parseSelection, chunkSelection } from '@/lib/bulk'

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

/**
 * `chunkSelection` exists for TODAY'S RELEASE, where the set is defined by a
 * QUERY rather than by ticked boxes: 81 cheques are ready in production and the
 * cap is 50.
 *
 * The cap is not raised. It exists because fifty concurrent interactive
 * transactions against Neon deadlock (`40P01`), and because a select-all over a
 * filter is how "the twelve I meant" becomes "every cheque in the company" -
 * both still true. Splitting into sequential batches keeps every cheque's own
 * transaction, guards and audit row, and keeps `parseSelection` as the single
 * gate each batch passes through.
 */
describe('chunkSelection', () => {
  it('returns one batch when the set fits under the cap', () => {
    expect(chunkSelection(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']])
  })

  it('splits a set larger than the cap into batches of at most the cap', () => {
    const ids = Array.from({ length: MAX_BULK_SELECTION * 2 + 1 }, (_, i) => `id-${i}`)
    const batches = chunkSelection(ids)

    expect(batches).toHaveLength(3)
    expect(batches.map((b) => b.length)).toEqual([MAX_BULK_SELECTION, MAX_BULK_SELECTION, 1])
    // Nothing dropped, nothing reordered, nothing repeated.
    expect(batches.flat()).toEqual(ids)
  })

  // Each batch is handed to `parseSelection`, so a batch it would refuse is a
  // batch that silently does nothing.
  it('produces batches parseSelection accepts', () => {
    const ids = Array.from({ length: MAX_BULK_SELECTION + 7 }, (_, i) => `id-${i}`)
    for (const batch of chunkSelection(ids)) {
      expect(parseSelection(batch).ok).toBe(true)
    }
  })

  it('de-duplicates before splitting, so one cheque is never released twice', () => {
    expect(chunkSelection(['a', 'b', 'a', ' b ', ''])).toEqual([['a', 'b']])
  })

  it('answers no batches at all for an empty set', () => {
    expect(chunkSelection([])).toEqual([])
    expect(chunkSelection(['', '  '])).toEqual([])
  })
})
