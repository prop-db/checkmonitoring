import { describe, it, expect } from 'vitest'
import { mapParsedRow, REGISTER_CURRENCY } from '@/lib/import/map-row'
import type { ParsedRow } from '@/lib/import/parse'
import type { CompanyReferenceData } from '@/lib/import/company'

// The same tiny injected table `tests/import/company.test.ts` uses, for the same
// reason: these tests pin the conversion, not the contents of the seed data.
const REF: CompanyReferenceData = {
  cashAccounts: [
    { code: 'BPI STK', company: 'STK' },
    { code: 'MBTC P&P', company: 'A1PP' },
  ],
  checkBooks: [
    { code: 'BPI-S-4636', company: 'STK' },
    { code: 'MBT-A-4155', company: 'A1+' },
  ],
}

function parsed(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    sheet: 'BPI RELEASED',
    row: 412,
    checkNumber: '6000319079',
    cvNumber: 'CV-ST-004112',
    apvNumbers: ['APV-ST-009911'],
    poNumbers: ['PO-ST-027363'],
    checkBook: 'BPI-S-4636',
    cashAccountLabel: null,
    category: 'SUPPLIER',
    receiptRef: 'CR 12345',
    checkDate: new Date('2026-01-19T00:00:00Z'),
    amount: '197715.42',
    currency: null,
    payee: 'HENKEL PHILIPPINES INC.',
    unclassified: ['SOME FREE TEXT'],
    ...overrides,
  }
}

describe('mapParsedRow', () => {
  it('carries the register row across field for field', () => {
    const row = mapParsedRow(parsed(), REF)

    expect(row.source).toBe('WORKBOOK')
    expect(row.checkNumber).toBe('6000319079')
    expect(row.cvNumber).toBe('CV-ST-004112')
    expect(row.checkDate).toEqual(new Date('2026-01-19T00:00:00Z'))
    expect(row.amount).toBe('197715.42')
    expect(row.apvNumbers).toEqual(['APV-ST-009911'])
    expect(row.poNumbers).toEqual(['PO-ST-027363'])
    expect(row.receiptRef).toBe('CR 12345')
    expect(row.category).toBe('SUPPLIER')
    expect(row.checkBookCode).toBe('BPI-S-4636')
    expect(row.sourceSheet).toBe('BPI RELEASED')
    expect(row.sourceRow).toBe(412)
  })

  // The one field whose name changes between the two shapes. `ParsedRow.payee`
  // becomes `NormalisedRow.payeeName`, because the normalised shape is named to
  // match the `Check` columns it feeds. A silent mis-wiring here would blank the
  // payee on every one of the register's 12,161 rows — and a blank payee
  // classifies INTERNAL, so the symptom would be thousands of supplier cheques
  // quietly becoming unpublishable rather than an error anybody sees.
  it('renames payee to payeeName', () => {
    expect(mapParsedRow(parsed({ payee: 'HENKEL PHILIPPINES INC.' }), REF).payeeName)
      .toBe('HENKEL PHILIPPINES INC.')
    expect(mapParsedRow(parsed({ payee: null }), REF).payeeName).toBeNull()
  })

  it('resolves the company from the checkbook and cash account columns', () => {
    expect(mapParsedRow(parsed({ checkBook: 'BPI-S-4636', cashAccountLabel: null }), REF).companyCode)
      .toBe('STK')
    expect(mapParsedRow(parsed({ checkBook: null, cashAccountLabel: 'MBTC P&P' }), REF).companyCode)
      .toBe('A1PP')
  })

  // 2,640 of the register's rows. The company is left null rather than guessed;
  // `upsertCheck` stages such a row instead of filing it under a company.
  it('leaves the company null when neither column resolves one', () => {
    expect(mapParsedRow(parsed({ checkBook: null, cashAccountLabel: null }), REF).companyCode)
      .toBeNull()
  })

  it('applies the cash account over a conflicting checkbook, as resolveCompany rules', () => {
    // The 17 conflicting rows. `conflictedWith` is not carried on the normalised
    // row — the reconciliation report calls resolveCompany itself for that.
    expect(mapParsedRow(parsed({ checkBook: 'MBT-A-4155', cashAccountLabel: 'BPI STK' }), REF).companyCode)
      .toBe('STK')
  })

  describe('the PHP default', () => {
    it('is applied when the register states no currency', () => {
      expect(mapParsedRow(parsed({ currency: null }), REF).currency).toBe(REGISTER_CURRENCY)
      expect(REGISTER_CURRENCY).toBe('PHP')
    })

    it('never overrides a currency the register states inline', () => {
      // "USD 300000" on the FT & MC sheet. Read as a bare peso figure this
      // cheque would be understated by the exchange rate.
      expect(mapParsedRow(parsed({ currency: 'USD', amount: '300000' }), REF).currency).toBe('USD')
    })
  })

  describe('the fields the register cannot carry', () => {
    it('is not an Acumatica row and says so', () => {
      const row = mapParsedRow(parsed(), REF)
      expect(row.acumaticaPaymentId).toBeNull()
      expect(row.acumaticaDocType).toBeNull()
      expect(row.acumaticaStatus).toBeNull()
      expect(row.acumaticaBranch).toBeNull()
      expect(row.acumaticaTenant).toBeNull()
      expect(row.lastModifiedOn).toBeNull()
      expect(row.vendorCode).toBeNull()
    })

    // The register is a cheque register: every row on it is a physical cheque,
    // and it has no vocabulary for a void at all. VOIDED is an Acumatica fact
    // (D3), so a workbook row can never assert one.
    it('is always a cheque and never voided', () => {
      const row = mapParsedRow(parsed({ sheet: 'CANCELLED' }), REF)
      expect(row.isCheque).toBe(true)
      expect(row.voided).toBe(false)
    })
  })
})

describe('mapParsedRow: the cheque number is canonicalised here too', () => {
  it('leaves the register’s bare cheque number exactly as written', () => {
    // The register is already canonical on essentially every row; running the
    // rule here is what makes "one place the rule lives" true rather than
    // "one place per source", and it is a no-op on 12,161 rows.
    expect(mapParsedRow(parsed({ checkNumber: '6000319079' }), REF).checkNumber).toBe('6000319079')
  })

  it('strips a bank prefix if a register row ever carries one', () => {
    const row = mapParsedRow(parsed({ checkNumber: 'BPI 6000319079' }), REF)
    expect(row.checkNumber).toBe('6000319079')
    // The cell as typed survives, so a human can see what the register said.
    expect(row.statedCheckRef).toBe('BPI 6000319079')
  })

  it('keeps a register row whose cheque number is register noise unkeyable', () => {
    // `ParsedRow.checkNumber` is non-nullable by construction — the 66 rows
    // with no number at all never reach here, they go to the review queue. What
    // can still arrive is the register's own noise, and nothing here invents a
    // number to replace it.
    const row = mapParsedRow(parsed({ checkNumber: '#N/A' }), REF)
    expect(row.checkNumber).toBeNull()
  })

  it('does NOT apply the Acumatica feed’s free-text rule to the register', () => {
    // The 80 free-text refs are an Acumatica fact. The register's cheque number
    // column is a cheque number column, and holding it to a numeric shape here
    // would stage rows nobody has ruled on.
    expect(mapParsedRow(parsed({ checkNumber: 'MBTC 1791 to 1795' }), REF).checkNumber)
      .toBe('MBTC 1791 to 1795')
  })
})
