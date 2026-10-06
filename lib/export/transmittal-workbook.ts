import ExcelJS from 'exceljs'
import { totalsByCurrency } from '@/lib/transmittal'

/**
 * The CHECKS TRANSMITTAL as a workbook, laid out like the sheet Finance used
 * to type: title, TO and date, the seven columns, a total, and the three
 * signature blocks. Amounts are Excel numbers in the cells (the one sanctioned
 * use of a JS number for money); the adding is done in centavos in
 * `lib/transmittal.ts`.
 */
export const TRANSMITTAL_SHEET = 'TRANSMITTAL'
export const TRANSMITTAL_HEADERS = [
  'NO.', 'CHECK NUMBER', 'CASH ACCOUNT', 'PO NUMBER/ VENDOR REF', 'VOUCHER NUMBER', 'PAYEE', 'AMOUNT',
] as const

export type TransmittalLine = {
  checkNumber: string
  cashAccount: string
  poNumber: string
  voucher: string
  payee: string
  amount: string | null
  currency: string
}

export type TransmittalMeta = { to: string; date: string; preparedBy: string; checkedBy: string; approvedBy: string }

const BORDER = { style: 'thin', color: { argb: 'FF000000' } } as const
const BOX = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER }

/** `2026-10-06` as `10/6/2026`, as the sheet writes it; anything else verbatim. */
function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return y && m && d ? `${m}/${d}/${y}` : iso
}

export async function buildTransmittalWorkbook(
  { lines, meta, logo }: { lines: readonly TransmittalLine[]; meta: TransmittalMeta; logo?: Buffer | null },
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Check Release Monitoring'
  const ws = wb.addWorksheet(TRANSMITTAL_SHEET, {
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  ;[7, 18, 16, 22, 20, 46, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w })

  // Title block: logo left, CHECKS TRANSMITTAL centred, rows 1-4.
  ws.mergeCells('A2:G3')
  const title = ws.getCell('A2')
  title.value = 'CHECKS TRANSMITTAL'
  title.font = { bold: true, size: 20 }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  if (logo) {
    const id = wb.addImage({ buffer: logo as unknown as ExcelJS.Buffer, extension: 'png' })
    ws.addImage(id, { tl: { col: 0.1, row: 0.1 }, ext: { width: 80, height: 88 } })
  }
  for (let r = 1; r <= 4; r++) ws.getRow(r).height = 22

  // TO / date.
  ws.mergeCells('A6:F6')
  ws.getCell('A6').value = `TO:  ${meta.to}`
  ws.getCell('G6').value = formatDay(meta.date)
  ws.getCell('G6').alignment = { horizontal: 'center' }
  for (let c = 1; c <= 7; c++) ws.getRow(6).getCell(c).border = BOX
  ws.getRow(6).font = { size: 12 }
  ws.getRow(6).height = 22

  const head = ws.getRow(7)
  TRANSMITTAL_HEADERS.forEach((label, i) => {
    const cell = head.getCell(i + 1)
    cell.value = label
    cell.font = { bold: true }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = BOX
  })
  head.height = 32

  let r = 8
  lines.forEach((l, i) => {
    const row = ws.getRow(r++)
    const values = [i + 1, l.checkNumber, l.cashAccount, l.poNumber, l.voucher, l.payee, l.amount === null ? null : Number(l.amount)]
    values.forEach((v, col) => {
      const cell = row.getCell(col + 1)
      cell.value = v
      cell.border = BOX
      cell.alignment = { horizontal: col === 5 ? 'left' : col === 6 ? 'right' : 'center', vertical: 'middle' }
    })
    // A cheque number is an identifier, never a number: keep it text.
    row.getCell(2).numFmt = '@'
    row.getCell(7).numFmt = '#,##0.00'
  })

  for (const t of totalsByCurrency(lines)) {
    const row = ws.getRow(r++)
    ws.mergeCells(row.number, 1, row.number, 6)
    row.getCell(1).value = `TOTAL (${t.count} CHEQUE${t.count === 1 ? '' : 'S'})${t.currency !== 'PHP' ? `  ${t.currency}` : ''}`
    row.getCell(1).alignment = { horizontal: 'right' }
    row.getCell(7).value = Number(t.total.replace(/,/g, ''))
    row.getCell(7).numFmt = '#,##0.00'
    row.font = { bold: true }
    for (let c = 1; c <= 7; c++) row.getCell(c).border = BOX
  }

  // Signature blocks.
  r += 1
  const blocks: [string, string, number, number][] = [
    ['PREPARED BY:', meta.preparedBy, 1, 3],
    ['CHECKED BY:', meta.checkedBy, 4, 5],
    ['APPROVED BY:', meta.approvedBy, 6, 7],
  ]
  for (const [label, name, from, to] of blocks) {
    ws.mergeCells(r, from, r, to)
    ws.getCell(r, from).value = label
    ws.getCell(r, from).font = { bold: true }
    ws.mergeCells(r + 3, from, r + 3, to)
    const n = ws.getCell(r + 3, from)
    n.value = name.toUpperCase()
    n.font = { bold: true }
    n.alignment = { horizontal: 'center' }
    n.border = { top: BORDER }
  }
  ws.getRow(r + 3).height = 20

  return wb.xlsx.writeBuffer()
}
