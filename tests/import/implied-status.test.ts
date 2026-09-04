import { describe, it, expect } from 'vitest'
import { impliedStatus, resolveImpliedStatus } from '@/lib/import/implied-status'
import { IMPLIED_STATUS } from '@/lib/import/reconcile'

describe('impliedStatus', () => {
  it('maps the release sheets onto the release ladder', () => {
    expect(impliedStatus('BPI RELEASED')).toBe('RELEASED')
    expect(impliedStatus('MBTC RELEASED')).toBe('RELEASED')
    expect(impliedStatus('STK P&P RELEASED')).toBe('RELEASED')
  })

  it('maps an AVAIL. sheet to SIGNED, because available is not approved', () => {
    // Was READY_FOR_RELEASE until 2026-09-04, when Finance saw 396 cheques on
    // the dashboard where they expected 85: "checks available are signed checks
    // but not yet ready to release". The AVAIL. sheets hold cheques that have
    // been signed and are physically in hand; approving one for release is a
    // separate act, recorded in the APPROVAL FOR RELEASE workbook.
    //
    // Do not restore the old mapping. It offered 311 cheques to Finance as
    // ready to hand over when they had not been approved, and it did so
    // silently — each was a real cheque at a real rung, one rung too high.
    expect(impliedStatus('MBTC AVAIL.')).toBe('SIGNED')
  })

  it('maps CANCELLED', () => {
    expect(impliedStatus('CANCELLED')).toBe('CANCELLED')
  })

  it('maps a finding sheet to SIGNATURE_PENDING, not to a rung of its own', () => {
    // A finding is a query raised against a cheque, not a step on the release
    // ladder. The cheque sits where it sat; the caller records a remark.
    expect(impliedStatus('CHECK FINDING')).toBe('SIGNATURE_PENDING')
  })

  it('maps FT & MC to SIGNATURE_PENDING', () => {
    expect(impliedStatus('FT & MC')).toBe('SIGNATURE_PENDING')
  })

  it('maps a sheet with no status word at all to SIGNATURE_PENDING', () => {
    // The pending registers. A cheque sitting on one has been generated and is
    // waiting for a signature; the sheet asserts nothing further.
    expect(impliedStatus('MBTC P&P')).toBe('SIGNATURE_PENDING')
    expect(impliedStatus('BPI PAPER AND PLASTIC')).toBe('SIGNATURE_PENDING')
  })

  it('reuses the register vocabulary rather than a second copy of it', () => {
    // If a sheet-name rule is added to reconcile, this module must see it too.
    // Two divergent vocabularies is how the reconciliation report and the
    // import start disagreeing about the same cheque.
    expect(IMPLIED_STATUS.map(([, s]) => s))
      .toEqual(['CANCELLED', 'RELEASED', 'AVAILABLE', 'FINDING', 'FT_MC'])
  })

  it('matches CANCELLED ahead of RELEASED, as the register vocabulary does', () => {
    // A constructed name, not one of the fifteen: the point is the precedence
    // order the vocabulary already encodes, which exists because sheet names
    // are not guaranteed to contain only one of these words.
    expect(impliedStatus('CANCELLED / RELEASED')).toBe('CANCELLED')
  })
})

describe('resolveImpliedStatus', () => {
  it('resolves a cheque on a single sheet to the status that sheet asserts', () => {
    const r = resolveImpliedStatus(['BPI RELEASED'])
    expect(r.status).toBe('RELEASED')
    expect(r.sheets).toEqual(['BPI RELEASED'])
    expect(r.implied).toEqual(['RELEASED'])
    expect(r.resolvedFrom).toBe('RELEASED')
  })

  it('does not treat two sheets that agree as a clash', () => {
    const r = resolveImpliedStatus(['BPI RELEASED', 'MBTC RELEASED'])
    expect(r.status).toBe('RELEASED')
    expect(r.implied).toEqual(['RELEASED'])
  })

  it('returns the sheets and the clashing implied statuses for the audit row', () => {
    const r = resolveImpliedStatus(['BPI RELEASED', 'CHECK FINDING'])
    expect(r.sheets).toEqual(['BPI RELEASED', 'CHECK FINDING'])
    expect(r.implied).toEqual(['RELEASED', 'FINDING'])
    expect(r.status).toBe('RELEASED')
    expect(r.resolvedFrom).toBe('RELEASED')
  })

  // The Finance ruling of 2026-09-03, one row of the table per case.
  it('resolves CANCELLED + FINDING to CANCELLED', () => {
    // 48 cheques.
    expect(resolveImpliedStatus(['CANCELLED', 'CHECK FINDING']).status).toBe('CANCELLED')
  })

  it('resolves RELEASED + CANCELLED to RELEASED', () => {
    // 25 cheques. The money moved; the register's CANCELLED entry is stale.
    expect(resolveImpliedStatus(['BPI RELEASED', 'CANCELLED']).status).toBe('RELEASED')
  })

  it('resolves RELEASED + FINDING to RELEASED', () => {
    // 25 cheques.
    expect(resolveImpliedStatus(['BPI RELEASED', 'CHECK FINDING']).status).toBe('RELEASED')
  })

  it('resolves RELEASED + CANCELLED + FINDING to CANCELLED, flipping the pair above', () => {
    // Exactly one cheque, 6000319079. Adding FINDING to RELEASED + CANCELLED
    // reverses the decision. Deliberate, ruled on by Finance, and not to be
    // "tidied" into consistency with the two-way case.
    expect(resolveImpliedStatus(['BPI RELEASED', 'CANCELLED', 'CHECK FINDING']).status)
      .toBe('CANCELLED')
    expect(resolveImpliedStatus(['BPI RELEASED', 'CANCELLED']).status).toBe('RELEASED')
  })

  it('resolves RELEASED + AVAILABLE to RELEASED', () => {
    // 1 cheque. The later state, not CANCELLED - no sheet says cancelled.
    expect(resolveImpliedStatus(['BPI RELEASED', 'MBTC AVAIL.']).status).toBe('RELEASED')
  })

  it('resolves AVAILABLE + CANCELLED to CANCELLED', () => {
    // 1 cheque.
    expect(resolveImpliedStatus(['MBTC AVAIL.', 'CANCELLED']).status).toBe('CANCELLED')
  })

  it('resolves AVAILABLE + FINDING to AVAILABLE', () => {
    // 1 cheque, and the reason FINDING is not a rung: it does not pull the
    // cheque back down the ladder.
    expect(resolveImpliedStatus(['MBTC AVAIL.', 'CHECK FINDING']).status).toBe('SIGNED')
    expect(resolveImpliedStatus(['MBTC AVAIL.', 'CHECK FINDING']).resolvedFrom).toBe('AVAILABLE')
  })

  it('is not sensitive to the order the sheets are given in', () => {
    expect(resolveImpliedStatus(['CANCELLED', 'BPI RELEASED']).status).toBe('RELEASED')
    expect(resolveImpliedStatus(['CHECK FINDING', 'CANCELLED']).status).toBe('CANCELLED')
  })

  it('ignores a pending register when deciding whether there is a clash', () => {
    // Every cheque starts on a pending register and moves to a release sheet.
    // That is the normal lifecycle, not a contradiction, and treating it as one
    // would send thousands of cheques to a human for a ruling.
    const r = resolveImpliedStatus(['MBTC P&P', 'MBTC RELEASED'])
    expect(r.status).toBe('RELEASED')
    expect(r.implied).toEqual(['RELEASED'])
    expect(r.sheets).toEqual(['MBTC P&P', 'MBTC RELEASED'])
  })

  it('falls back to SIGNATURE_PENDING when no sheet asserts anything', () => {
    const r = resolveImpliedStatus(['MBTC P&P', 'BPI PAPER AND PLASTIC'])
    expect(r.status).toBe('SIGNATURE_PENDING')
    expect(r.implied).toEqual([])
    expect(r.resolvedFrom).toBeNull()
  })

  it('counts one sheet listed twice as one sheet', () => {
    const r = resolveImpliedStatus(['BPI RELEASED', 'BPI RELEASED'])
    expect(r.sheets).toEqual(['BPI RELEASED'])
    expect(r.status).toBe('RELEASED')
  })

  it('throws on a clash no one has ruled on, rather than picking a winner', () => {
    // A new sheet, or a new combination, is something a human must rule on.
    // Silently defaulting would invent a fact about money the register does not
    // state - exactly what this importer exists to avoid.
    expect(() => resolveImpliedStatus(['FT & MC', 'CANCELLED'])).toThrow(/FT_MC/)
    expect(() => resolveImpliedStatus(['FT & MC', 'BPI RELEASED'])).toThrow()
    expect(() => resolveImpliedStatus(['MBTC AVAIL.', 'CANCELLED', 'CHECK FINDING'])).toThrow()
  })

  it('names the sheets in the error so a human can find them', () => {
    expect(() => resolveImpliedStatus(['FT & MC', 'CANCELLED'])).toThrow(/FT & MC/)
  })
})
