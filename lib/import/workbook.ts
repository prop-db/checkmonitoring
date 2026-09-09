import ExcelJS from 'exceljs'

export type RawRow = {
  sheet: string
  row: number
  cells: unknown[]
  /**
   * Row 1 of the sheet this row came from, read exactly like a data row and
   * otherwise untouched.
   *
   * Carried because a sheet's NAME is not evidence of its shape. The
   * approval-for-release workbook was two sheets called `LIST` and `PIVOT` on
   * 4 September and three called `Sheet3`, `local supplier` and `BROKERAGE` on
   * 7 September; a parser keyed on the name read zero rows out of the second
   * one and reported success. The header row is the thing that did not change:
   * every data sheet of that workbook carries the same 24-column header and
   * every pivot sheet carries an empty row 1. See `isBillSheet`.
   *
   * Optional only so that a test may state a grid without one — a row with no
   * header belongs to no known sheet shape, which is a refusal, never a
   * fallback to reading columns positionally.
   */
  header?: readonly unknown[]
}

// ExcelJS wraps formula results and rich text; unwrap to the value. Used for
// the header row as well as the data rows, so a header cell that happens to be
// rich text is compared as the text a human sees.
function cellValue(v: unknown): unknown {
  if (v && typeof v === 'object' && 'result' in v) return (v as { result: unknown }).result
  if (v && typeof v === 'object' && 'richText' in v) {
    return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('')
  }
  return v
}

// I/O only: reads every sheet into rows of raw cell values and interprets
// nothing. Keeping interpretation out of here is what lets parseRows be tested
// without a fixture file.
export async function readWorkbook(buffer: Buffer): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)

  const out: RawRow[] = []
  wb.eachSheet((sheet) => {
    // One array per sheet, shared by reference across its rows: this is the
    // sheet's header, not the row's, and copying it 12,227 times would say
    // otherwise as well as cost.
    const header: unknown[] = []
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell) => header.push(cellValue(cell.value)))

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return // header
      const cells: unknown[] = []
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellValue(cell.value)))
      out.push({ sheet: sheet.name, row: rowNumber, cells, header })
    })
  })
  return out
}
