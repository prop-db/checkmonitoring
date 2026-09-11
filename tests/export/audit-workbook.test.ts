import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildAuditWorkbook, AUDIT_SHEET, AUDIT_HEADER_ROW, AUDIT_FIRST_DATA_ROW, AUDIT_HEADERS } from '@/lib/export/audit-workbook'
import type { AuditRow } from '@/lib/audit-query'

const AT = new Date('2026-09-11T02:18:51.275Z')

function row(o: Partial<AuditRow> & { id: string }): AuditRow {
  return {
    createdAt: AT, actorType: 'USER', action: 'release_reversed', remarks: 'Ticked the wrong row',
    details: { releasedAt: '2026-09-10T01:00:00.000Z' }, userName: 'Paolo Parcon',
    checkId: 'chk1', checkNumber: '6000353106', plannedOutflowId: null, ...o,
  }
}

async function build(rows: AuditRow[], totalRows = rows.length) {
  const buffer = await buildAuditWorkbook({
    rows, meta: { generatedAt: AT, generatedBy: 'Paolo Parcon', filterDescription: "PEOPLE'S ACTIONS ONLY", totalRows },
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb.getWorksheet(AUDIT_SHEET)!
}

describe('buildAuditWorkbook', () => {
  it('writes the header on row 6 and the first row on row 7', async () => {
    const ws = await build([row({ id: 'a' })])
    expect((ws.getRow(AUDIT_HEADER_ROW).values as string[]).slice(1)).toEqual([...AUDIT_HEADERS])
    const r = ws.getRow(AUDIT_FIRST_DATA_ROW).values as unknown[]
    expect(r[2]).toBe('Paolo Parcon')
    expect(r[3]).toBe('RELEASE REVERSED')
    expect(r[4]).toBe('6000353106')
    expect(r[6]).toBe('{"releasedAt":"2026-09-10T01:00:00.000Z"}')
  })

  it('writes SYSTEM for a system row and the detached marker for a row with no cheque', async () => {
    const ws = await build([row({ id: 'a', actorType: 'SYSTEM', userName: null, checkId: null, checkNumber: null })])
    const r = ws.getRow(AUDIT_FIRST_DATA_ROW).values as unknown[]
    expect(r[2]).toBe('SYSTEM')
    expect(r[4]).toBe('(cheque removed)')
  })

  it('names a planned-outflow row as such, never as a removed cheque', async () => {
    const ws = await build([row({
      id: 'a', action: 'planned_outflow_paid', checkId: null, checkNumber: null, plannedOutflowId: 'po1',
      details: { plannedOutflowId: 'po1', description: 'SEPT PAYROLL' },
    })])
    const r = ws.getRow(AUDIT_FIRST_DATA_ROW).values as unknown[]
    expect(r[4]).toBe('PLANNED OUTFLOW')
  })

  it('states the filters and the cap in the title block', async () => {
    const ws = await build([row({ id: 'a' })], 20_000)
    expect(String(ws.getCell('A2').value)).toContain("PEOPLE'S ACTIONS ONLY")
    expect(String(ws.getCell('A3').value)).toContain('FIRST 1 OF 20,000')
  })
})
