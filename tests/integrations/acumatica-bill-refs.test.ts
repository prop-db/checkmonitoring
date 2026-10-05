import { describe, it, expect } from 'vitest'
import {
  BILL_REFS_FEED, BILL_REF_COLUMNS, billRefsSelect, billRefsSinceFilter, billRefsInScopeFilter,
  extractPoNumbers, mapBillRef,
} from '@/lib/integrations/acumatica/bill-refs'

describe('extractPoNumbers — real POs', () => {
  const POSITIVE: [string, string[]][] = [
    ['PO-ST-031109', ['PO-ST-031109']],
    ['PO-A1-012345', ['PO-A1-012345']],
    ['PO-IND123456', ['PO-IND123456']],
    ['PO-HF-004512', ['PO-HF-004512']],
    ['PO-ST123456', ['PO-ST123456']],          // no second dash
    ['PO-ST-03110', ['PO-ST-03110']],          // 5 digits
    ['PO-ST-0311090', ['PO-ST-0311090']],      // 7 digits
    ['A1PP-PO-000123', ['A1PP-PO-000123']],    // MANUFACTURING
    ['STPP-PO-0001234', ['STPP-PO-0001234']],
    ['PO-ST-031109.', ['PO-ST-031109']],       // a trailing dot is not part of the PO
    ['po-st-031109', ['PO-ST-031109']],        // lower case -> upper
    ['stpp-po-000123', ['STPP-PO-000123']],
    ['PO-A1-012345 / PO-A1-012346', ['PO-A1-012345', 'PO-A1-012346']],
    ['PO-ST-031110 PO-ST-031109', ['PO-ST-031110', 'PO-ST-031109']], // order of appearance
    ['PO-ST-031109/PO-ST-031110', ['PO-ST-031109', 'PO-ST-031110']],
    ['PO-ST-031109 / po-st-031109.', ['PO-ST-031109']],              // de-duplicated
    ['DR 4471, PO-ST-031109', ['PO-ST-031109']],
    ['  PO-ST-031109  ', ['PO-ST-031109']],
  ]
  it.each(POSITIVE)('%s', (ref, expected) => {
    expect(extractPoNumbers(ref)).toEqual(expected)
  })
})

describe('extractPoNumbers — anything else is no PO', () => {
  const NEGATIVE: string[] = [
    'SI#1659',
    '26X06-0267A',
    'PO-ST-',           // no digits
    'PONDE 1234',
    'for next po',
    'PO-ST-12',         // too few digits
    'PO-ST-03110912',   // eight digits
    'XPO-ST-031109',    // inside a longer alphanumeric run
    'PO-ST-031109A',
    'PO-0001',
    '',
  ]
  it.each(NEGATIVE)('%s', (ref) => {
    expect(extractPoNumbers(ref)).toEqual([])
  })

  it('reads null and undefined as no PO', () => {
    expect(extractPoNumbers(null)).toEqual([])
    expect(extractPoNumbers(undefined)).toEqual([])
  })
})

describe('the feed', () => {
  it('names one column map for both tenants', () => {
    expect(BILL_REFS_FEED).toBe('AP-Bills and Adjustments')
    expect(BILL_REF_COLUMNS).toEqual({
      type: 'Type', ref: 'ReferenceNbr', date: 'Date', vendorRef: 'VendorRef', lastModified: 'LastModifiedOn',
    })
    expect(billRefsSelect()).toEqual(['Type', 'ReferenceNbr', 'Date', 'VendorRef', 'LastModifiedOn'])
  })

  it('filters on one column with the datetime literal, no zone', () => {
    expect(billRefsSinceFilter(new Date('2026-09-29T06:15:00.000Z')))
      .toBe("LastModifiedOn ge datetime'2026-09-29T06:15:00'")
    expect(billRefsInScopeFilter()).toBe("Date ge datetime'2026-01-01T00:00:00'")
  })
})

describe('mapBillRef', () => {
  const doc = (o: Record<string, unknown> = {}) => ({
    Type: 'Bill', ReferenceNbr: ' ap-st044591 ', Date: '2026-09-29T00:00:00',
    VendorRef: ' PO-ST-031109. ', LastModifiedOn: '2026-09-29T08:15:00', ...o,
  })

  it('maps a 2026 bill: APV trimmed and upper-cased, ref trimmed, POs extracted', () => {
    expect(mapBillRef(doc())).toEqual({
      apvNumber: 'AP-ST044591',
      vendorRef: 'PO-ST-031109.',
      poNumbers: ['PO-ST-031109'],
      lastModifiedOn: new Date('2026-09-29T08:15:00Z'),
    })
  })

  it('keeps a bill whose ref is not a PO, with no POs, so the run can delete a stale row', () => {
    expect(mapBillRef(doc({ VendorRef: 'SI#1659' }))).toMatchObject({ vendorRef: 'SI#1659', poNumbers: [] })
    expect(mapBillRef(doc({ VendorRef: null }))).toMatchObject({ vendorRef: '', poNumbers: [] })
  })

  it('keeps only Bills', () => {
    for (const t of ['Debit Adj.', 'Prepayment', 'Credit Adj.']) expect(mapBillRef(doc({ Type: t })), t).toBeNull()
  })

  it('refuses a bill dated before 2026 or with no date — the sync’s scope', () => {
    expect(mapBillRef(doc({ Date: '2025-12-31T00:00:00' }))).toBeNull()
    expect(mapBillRef(doc({ Date: null }))).toBeNull()
    expect(mapBillRef(doc({ Date: '2026-01-01T00:00:00' }))).not.toBeNull()
  })

  it('refuses a row with no reference, and anything that is not a row', () => {
    expect(mapBillRef(doc({ ReferenceNbr: '   ' }))).toBeNull()
    expect(mapBillRef(null)).toBeNull()
    expect(mapBillRef([])).toBeNull()
  })

  it('keeps a row whose LastModifiedOn cannot be read, with a null date', () => {
    expect(mapBillRef(doc({ LastModifiedOn: 'nonsense' }))?.lastModifiedOn).toBeNull()
  })
})
