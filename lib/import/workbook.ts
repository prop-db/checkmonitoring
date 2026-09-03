import ExcelJS from 'exceljs'

export type RawRow = { sheet: string; row: number; cells: unknown[] }

// I/O only: reads every sheet into rows of raw cell values and interprets
// nothing. Keeping interpretation out of here is what lets parseRows be tested
// without a fixture file.
export async function readWorkbook(buffer: Buffer): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)

  const out: RawRow[] = []
  wb.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return // header
      const cells: unknown[] = []
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value
        // ExcelJS wraps formula results and rich text; unwrap to the value.
        if (v && typeof v === 'object' && 'result' in v) cells.push((v as { result: unknown }).result)
        else if (v && typeof v === 'object' && 'richText' in v) {
          cells.push((v as { richText: { text: string }[] }).richText.map((t) => t.text).join(''))
        } else if (v instanceof Date) cells.push(v)
        else cells.push(v)
      })
      out.push({ sheet: sheet.name, row: rowNumber, cells })
    })
  })
  return out
}
