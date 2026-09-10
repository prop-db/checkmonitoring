import type ExcelJS from 'exceljs'

/**
 * The look every generated sheet shares.
 *
 * Extracted from `workbook.ts` when the voucher index arrived, because two
 * files each holding their own copy of `FF1E293B` is two files that drift: the
 * register export and the voucher index are handed to the same reader, often in
 * the same week, and a header that is nearly the same navy reads as a mistake.
 *
 * Only what is genuinely shared lives here. Neither sheet's title block does —
 * the register's row 2 is a scope line and the index's is a machine-readable
 * timestamp, and a styler with an option for that would serve neither well.
 */

/** slate-800 / white — the dashboard's own header. */
export const HEADER_FILL = 'FF1E293B'
/** slate-100, for row banding. */
export const BAND_FILL = 'FFF1F5F9'
/** slate-200, for cell borders. */
export const GRID = 'FFE2E8F0'

export const DATE_FORMAT = 'dd mmm yyyy'
export const COUNT_FORMAT = '#,##0'

/** Every date renders as `01 Sep 2026`; this is what a date column must fit. */
export const DATE_WIDTH_SAMPLE = '01 Sep 2026'

/**
 * One header cell: the fill, the white bold text, and the border that keeps the
 * band from bleeding into it.
 */
export function styleHeaderCell(
  cell: ExcelJS.Cell,
  label: string,
  align: 'left' | 'right' = 'left',
): void {
  cell.value = label
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
  cell.alignment = { horizontal: align, vertical: 'middle' }
  cell.border = {
    top: { style: 'thin', color: { argb: HEADER_FILL } },
    bottom: { style: 'thin', color: { argb: HEADER_FILL } },
    left: { style: 'thin', color: { argb: HEADER_FILL } },
    right: { style: 'thin', color: { argb: HEADER_FILL } },
  }
}
