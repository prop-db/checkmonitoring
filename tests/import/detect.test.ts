import { describe, it, expect } from 'vitest'
import { detectWorkbook, REGISTER_SHEETS } from '@/lib/import/detect'
import type { RawRow } from '@/lib/import/workbook'

// The 24-column Acumatica header every data sheet of the approval-for-release
// workbook carries on row 1, measured on the 4, 7 and 10 September exports.
// Restated here rather than imported so this file pins the signature against
// the workbook rather than agreeing with the detector.
const HEADER: readonly (string | null)[] = [
  'Date', 'Post Period', 'Reference Nbr.', 'Vendor Ref.', 'Vendor Name', 'Balance Amount',
  'Description', 'Due Date', 'Type', 'Detail Total', 'Terms Code', 'Created By', 'NO. OF DAYS',
  '1-30 days Over due', '31-60 days Over due', '61-90days Over due', 'OVER 90 DAYS', 'GL Account',
  'FINANCE REMARKS', 'Payment Ref. #', 'check No. ', 'bank', null, null,
]

// A sheet's rows. `header` is what says what the sheet IS: the bill header, or
// the empty row 1 a pivot sheet carries, or the register's own headers, which
// this detector does not read.
const rows = (spec: Record<string, number>, header: readonly unknown[] = []): RawRow[] =>
  Object.entries(spec).flatMap(([sheet, n]) =>
    Array.from({ length: n }, (_, i) => ({ sheet, row: i + 2, cells: [], header })),
  )

const billRows = (spec: Record<string, number>) => rows(spec, HEADER)

describe('detectWorkbook', () => {
  it('recognises the approval-for-release workbook by its header, not its sheet names', () => {
    // 7 September. There is no sheet called LIST any more — the detector used
    // to require one, which made this file unrecognisable — and `Sheet3` is the
    // pivot, whose rows are derived subtotals and are not bills.
    const d = detectWorkbook([
      ...rows({ Sheet3: 162 }),
      ...billRows({ 'local supplier': 227, BROKERAGE: 11 }),
    ])
    expect(d).toMatchObject({ kind: 'BILLS', dataRows: 227 + 11 })
    expect(d.sheets).toEqual(['Sheet3', 'local supplier', 'BROKERAGE'])
  })

  it('recognises the 4 September shape by the same rule', () => {
    // LIST and PIVOT are just two more names. Nothing about them is special and
    // the detector must not learn them again.
    expect(detectWorkbook([...billRows({ LIST: 85 }), ...rows({ PIVOT: 75 })]))
      .toMatchObject({ kind: 'BILLS', dataRows: 85 })
  })

  it('does not count the rows of a sheet that will not be read', () => {
    // This number is what an operator compares against the import's own
    // accounting. Counting a pivot's rows here would promise bills that are not
    // there and make the import look as though it dropped them.
    const d = detectWorkbook([...billRows({ LIST: 85 }), ...rows({ PIVOT: 75 })])
    expect(d.dataRows).toBe(85)
  })

  it('does not recognise a sheet whose header has moved', () => {
    // Every column of a bill sheet is read positionally, and the header is the
    // only thing that makes that safe. A shifted column is refused, not read.
    const shifted = HEADER.map((h) => (h === 'check No. ' ? 'cheque' : h))
    expect(detectWorkbook(rows({ 'local supplier': 227 }, shifted)).kind).toBe('UNKNOWN')
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
    const d = detectWorkbook([...billRows({ LIST: 85 }), ...rows({ 'BPI RELEASED': 10 })])
    expect(d.kind).toBe('UNKNOWN')
  })

  it('refuses to guess at an empty workbook', () => {
    expect(detectWorkbook([]).kind).toBe('UNKNOWN')
  })

  it('refuses a bills workbook that is nothing but a pivot sheet', () => {
    // A pivot alone says nothing: it is derived, and importing it is forbidden.
    expect(detectWorkbook(rows({ PIVOT: 74 })).kind).toBe('UNKNOWN')
  })

  it('refuses a workbook that carries no sheet either shape is known by', () => {
    // Stricter than "not a bills file, therefore a register": a stray export
    // parsed as a register produces twelve thousand review rows and no error.
    const d = detectWorkbook(rows({ Sheet1: 3 }))
    expect(d.kind).toBe('UNKNOWN')
    expect(d.sheets).toEqual(['Sheet1'])
  })

  it('exports the measured register sheet names it recognises', () => {
    expect(REGISTER_SHEETS).toHaveLength(15)
    expect(REGISTER_SHEETS).toContain('BPI RELEASED')
    expect(REGISTER_SHEETS).toContain('CHECK FINDING')
  })
})
