import { describe, it, expect } from 'vitest'
import { detectWorkbook, BILL_WORKBOOK_SHEETS, REGISTER_SHEETS } from '@/lib/import/detect'
import type { RawRow } from '@/lib/import/workbook'

const rows = (spec: Record<string, number>): RawRow[] =>
  Object.entries(spec).flatMap(([sheet, n]) =>
    Array.from({ length: n }, (_, i) => ({ sheet, row: i + 2, cells: [] })),
  )

describe('detectWorkbook', () => {
  it('recognises the approval-for-release workbook by its two sheets', () => {
    expect(detectWorkbook(rows({ LIST: 85, PIVOT: 74 }))).toMatchObject({
      kind: 'BILLS',
      // Only LIST is read; PIVOT is a pivot table over it and importing a row
      // of it would double-count a bill.
      dataRows: 85,
    })
  })

  it('recognises a LIST sheet on its own', () => {
    expect(detectWorkbook(rows({ LIST: 85 }))).toMatchObject({ kind: 'BILLS', dataRows: 85 })
  })

  it('recognises the cheque register by its own sheet names', () => {
    const d = detectWorkbook(rows({ 'BPI RELEASED': 6026, CANCELLED: 774, 'FT & MC': 50 }))
    expect(d).toMatchObject({ kind: 'REGISTER', dataRows: 6026 + 774 + 50 })
  })

  it('reads every register sheet, including ones nobody has seen before', () => {
    // The register is fifteen hand-maintained sheets and Finance adds to them.
    // A new sheet name must not make the whole file unrecognisable.
    expect(detectWorkbook(rows({ 'BPI RELEASED': 3, 'BPI 2027 AVAIL.': 2 }))).toMatchObject({
      kind: 'REGISTER', dataRows: 5,
    })
  })

  it('refuses to guess when a file carries sheets of both shapes', () => {
    const d = detectWorkbook(rows({ LIST: 85, 'BPI RELEASED': 10 }))
    expect(d.kind).toBe('UNKNOWN')
  })

  it('refuses to guess at an empty workbook', () => {
    expect(detectWorkbook([]).kind).toBe('UNKNOWN')
  })

  it('refuses a bills workbook whose LIST sheet has no data rows', () => {
    // PIVOT alone says nothing: it is derived, and importing it is forbidden.
    expect(detectWorkbook(rows({ PIVOT: 74 })).kind).toBe('UNKNOWN')
  })

  it('refuses a workbook that carries no sheet either shape is known by', () => {
    // Stricter than "not a bills file, therefore a register": a stray export
    // parsed as a register produces twelve thousand review rows and no error.
    const d = detectWorkbook(rows({ Sheet1: 3 }))
    expect(d.kind).toBe('UNKNOWN')
    expect(d.sheets).toEqual(['Sheet1'])
  })

  it('exports the measured sheet names it recognises', () => {
    expect([...BILL_WORKBOOK_SHEETS]).toEqual(['LIST', 'PIVOT'])
    expect(REGISTER_SHEETS).toHaveLength(15)
    expect(REGISTER_SHEETS).toContain('BPI RELEASED')
    expect(REGISTER_SHEETS).toContain('CHECK FINDING')
  })
})
