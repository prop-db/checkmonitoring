import { describe, it, expect } from 'vitest'
import { previewRegisterImport } from '@/lib/import/preview'
import type { ParsedRow, ReviewItem } from '@/lib/import/parse'
import type { CompanyReferenceData } from '@/lib/import/company'

// The two signals `resolveCompany` reads, trimmed to what these cases need.
const REF: CompanyReferenceData = {
  cashAccounts: [
    { code: 'BPI STK', company: 'STK' },
    { code: 'MBTC P&P', company: 'A1PP' },
  ],
  checkBooks: [
    { code: 'BPI-S-4636', company: 'STK' },
    { code: 'MBT-A-9048', company: 'A1PP' },
  ],
}

const TODAY = new Date('2026-09-04T00:00:00Z')

const p = (o: Partial<ParsedRow> & { sheet: string; row: number; checkNumber: string }): ParsedRow => ({
  cvNumber: null, apvNumbers: [], poNumbers: [], checkBook: null, cashAccountLabel: null,
  category: null, receiptRef: null, checkDate: null, amount: null, currency: null,
  payee: null, unclassified: [], ...o,
})

// What `parseRows` hands back for a row it could not key: the row as far as it
// parsed, with a null cheque number.
const rev = (sheet: string, row: number, o: Partial<ParsedRow> = {}): ReviewItem => ({
  sheet, row, reason: 'NO_CHECK_NUMBER', cells: [],
  unkeyed: { ...p({ sheet, row, checkNumber: 'x' }), ...o, sheet, row, checkNumber: null },
})

const preview = (parsed: ParsedRow[], review: ReviewItem[] = []) =>
  previewRegisterImport({ parsed, review, ref: REF, today: TODAY })

describe('previewRegisterImport — the full accounting', () => {
  it('accounts for every input row, imported or not', () => {
    const r = preview(
      [
        p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000001', cashAccountLabel: 'BPI STK' }),
        p({ sheet: 'BPI RELEASED', row: 3, checkNumber: '6000000002' }),
      ],
      [rev('CANCELLED', 4)],
    )
    expect(r.totalRows).toBe(3)
    expect(r.willImport + r.willStage).toBe(r.totalRows)
    expect(r.willImport).toBe(1)
    expect(r.willStage).toBe(2)
  })

  it('counts the rows that will not import, by reason', () => {
    const r = preview(
      [
        p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000001', cashAccountLabel: 'BPI STK' }),
        p({ sheet: 'BPI RELEASED', row: 3, checkNumber: '6000000002' }),
        // One cheque number claimed by two companies: every row of it stages.
        p({ sheet: 'BPI RELEASED', row: 4, checkNumber: '6000000003', cashAccountLabel: 'BPI STK' }),
        p({ sheet: 'CANCELLED', row: 5, checkNumber: '6000000003', cashAccountLabel: 'MBTC P&P' }),
      ],
      [rev('CANCELLED', 6), rev('CHECK FINDING', 7)],
    )
    expect(r.stagedByReason).toEqual({
      NO_COMPANY: 1, AMBIGUOUS_COMPANY: 2, NO_CHECK_NUMBER: 2,
    })
  })

  it('carries a row a human can act on for every staged row', () => {
    const r = preview([
      p({
        sheet: 'BPI RELEASED', row: 3, checkNumber: '6000000002',
        payee: 'HENKEL PHILIPPINES INC.', amount: '197715.42',
      }),
    ])
    expect(r.stagedRows).toHaveLength(1)
    expect(r.stagedRows[0]).toMatchObject({
      sheet: 'BPI RELEASED', row: 3, reason: 'NO_COMPANY',
      checkNumber: '6000000002', payeeName: 'HENKEL PHILIPPINES INC.',
      amount: '197715.42', currency: 'PHP', impliedStatus: 'RELEASED',
    })
  })

  it('keeps a row it could not key legible rather than reducing it to a cell address', () => {
    const r = preview([], [rev('CANCELLED', 6, { payee: 'GDSM MARKETING', amount: '22300.00' })])
    expect(r.stagedRows[0]).toMatchObject({
      sheet: 'CANCELLED', row: 6, reason: 'NO_CHECK_NUMBER',
      checkNumber: null, payeeName: 'GDSM MARKETING', impliedStatus: 'CANCELLED',
    })
  })

  it('splits the staged rows by whether they are still live work', () => {
    // The 2026-09-04 scope ruling: 2,467 of the 2,766 staged rows are cheques
    // already handed over. A queue that does not separate them buries the
    // handful that still needs doing.
    const r = preview([
      p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000001' }),
      p({ sheet: 'CANCELLED', row: 3, checkNumber: '6000000002' }),
      p({ sheet: 'BPI STK AVAIL.', row: 4, checkNumber: '6000000003' }),
      p({ sheet: 'MBTC P&P', row: 5, checkNumber: '6000000004' }),
    ])
    expect(r.stagedLive).toBe(2)     // READY_FOR_RELEASE + SIGNATURE_PENDING
    expect(r.stagedClosed).toBe(2)   // RELEASED + CANCELLED
  })
})

describe('previewRegisterImport — what the reconciliation report has to show', () => {
  it('shows how the Finance ruling resolved each contradictory cheque', () => {
    const r = preview([
      p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000319079', cashAccountLabel: 'BPI STK' }),
      p({ sheet: 'CANCELLED', row: 3, checkNumber: '6000319079', cashAccountLabel: 'BPI STK' }),
      p({ sheet: 'CHECK FINDING', row: 4, checkNumber: '6000319079', cashAccountLabel: 'BPI STK' }),
    ])
    expect(r.contradictions).toHaveLength(1)
    expect(r.contradictions[0]).toMatchObject({
      checkNumber: '6000319079',
      implied: ['CANCELLED', 'RELEASED', 'FINDING'],
      resolvedFrom: 'CANCELLED',
      status: 'CANCELLED',
    })
  })

  it('reports a clash nobody has ruled on instead of throwing', () => {
    // `resolveImpliedStatus` throws on an unruled combination, deliberately.
    // A preview that propagated it would show a stack trace where the
    // accounting should be, and the operator would learn nothing about the
    // other twelve thousand rows.
    const r = preview([
      p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000009', cashAccountLabel: 'BPI STK' }),
      p({ sheet: 'FT & MC', row: 3, checkNumber: '6000000009', cashAccountLabel: 'BPI STK' }),
    ])
    expect(r.unruledClashes).toHaveLength(1)
    expect(r.unruledClashes[0]).toMatchObject({ checkNumber: '6000000009' })
    // Still accounted for: the classification does not depend on status.
    expect(r.willImport + r.willStage).toBe(2)
  })

  it('lists the rows whose cash account and checkbook name different companies', () => {
    const r = preview([
      p({
        sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000001',
        cashAccountLabel: 'BPI STK', checkBook: 'MBT-A-9048',
      }),
    ])
    expect(r.companyConflicts).toEqual([
      {
        sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000001',
        cashAccountLabel: 'BPI STK', checkBook: 'MBT-A-9048',
        resolved: 'STK', conflictedWith: 'A1PP',
      },
    ])
    // The cash account wins, so the row still imports — it is reported, not held.
    expect(r.willImport).toBe(1)
  })

  it('offers a vendor merge list of only the names that actually merge', () => {
    const r = preview([
      p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000001', payee: 'HENKEL PHILIPPINES INC.' }),
      p({ sheet: 'BPI RELEASED', row: 3, checkNumber: '6000000002', payee: 'Henkel Philippines Inc' }),
      p({ sheet: 'BPI RELEASED', row: 4, checkNumber: '6000000003', payee: 'GDSM MARKETING' }),
    ])
    expect(r.vendorMerges).toHaveLength(1)
    expect(r.vendorMerges[0].variants).toHaveLength(2)
    // The single-spelling names are not a merge, but they are still payees.
    expect(r.distinctPayees).toBe(3)
  })

  it('counts the conflicts by kind so none of them can hide behind the others', () => {
    const r = preview([
      p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000001', cashAccountLabel: 'BPI STK', amount: '100.00' }),
      p({ sheet: 'CANCELLED', row: 3, checkNumber: '6000000001', cashAccountLabel: 'BPI STK', amount: '200.00' }),
      p({
        sheet: 'BPI RELEASED', row: 4, checkNumber: '6000000004',
        cashAccountLabel: 'BPI STK', checkDate: new Date('2028-01-01T00:00:00Z'),
      }),
    ])
    expect(r.conflictsByKind.DUPLICATE_ACROSS_SHEETS).toBe(1)
    expect(r.conflictsByKind.CONTRADICTORY_STATUS).toBe(1)
    expect(r.conflictsByKind.AMOUNT_MISMATCH).toBe(1)
    expect(r.conflictsByKind.IMPLAUSIBLE_DATE).toBe(1)
  })

  it('reports how many rows each sheet contributed', () => {
    const r = preview(
      [
        p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000001' }),
        p({ sheet: 'BPI RELEASED', row: 3, checkNumber: '6000000002' }),
      ],
      [rev('CANCELLED', 4)],
    )
    expect(r.sheets).toEqual([
      { sheet: 'BPI RELEASED', rows: 2 },
      { sheet: 'CANCELLED', rows: 1 },
    ])
  })
})

describe('previewRegisterImport — unruled clashes are reported per cheque', () => {
  // The resolution is cached on the sheet set. Recording the clash on the cache
  // miss reported one cheque per distinct combination and swallowed every other
  // cheque sharing it — silent under-reporting on the one report whose entire
  // purpose is that nothing is hidden.
  it('lists every cheque blocked by the same sheet combination, not just the first', () => {
    const r = preview([
      p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000009', cashAccountLabel: 'BPI STK' }),
      p({ sheet: 'FT & MC', row: 3, checkNumber: '6000000009', cashAccountLabel: 'BPI STK' }),
      p({ sheet: 'BPI RELEASED', row: 4, checkNumber: '6000000010', cashAccountLabel: 'BPI STK' }),
      p({ sheet: 'FT & MC', row: 5, checkNumber: '6000000010', cashAccountLabel: 'BPI STK' }),
    ])
    expect(r.unruledClashes.map((c) => c.checkNumber).sort()).toEqual(['6000000009', '6000000010'])
    expect(r.unruledClashes[0].rows).toHaveLength(2)
  })

  it('keeps the staged split adding up to the staged total', () => {
    // A staged row whose status could not be resolved belongs to neither the
    // live nor the closed count, so a third figure is carried rather than
    // letting the two silently fail to sum to the number they sit under.
    const r = preview([
      p({ sheet: 'BPI RELEASED', row: 2, checkNumber: '6000000009' }),
      p({ sheet: 'FT & MC', row: 3, checkNumber: '6000000009' }),
    ])
    expect(r.willStage).toBe(2)
    expect(r.stagedUnruled).toBe(2)
    expect(r.stagedLive + r.stagedClosed + r.stagedUnruled).toBe(r.willStage)
  })
})
