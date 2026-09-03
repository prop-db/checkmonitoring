import { describe, it, expect } from 'vitest'
import { mapPayment } from '@/lib/integrations/acumatica/map'

// The exact field names the `AP-Checks and Payments` generic inquiry exposes.
// Taken from the Supplier Portal's working reader, not guessed.
const paymentRow = {
  Type: 'Payment',
  ReferenceNbr: 'CV-ST011550',
  Vendor: 'V001234',
  VendorName: 'HENKEL PHILIPPINES INC.',
  Status: 'Closed',
  PaymentDate: '2025-12-23T00:00:00',
  Description: 'WEEKLY DIRECT (DISNEY)',
  PaymentRef: '6000308584',
  PaymentAmount: 7950,
  Balance: 0,
  Currency: 'PHP',
  CashAccount: 'BPI STK',
  PaymentMethod: 'CHECK',
  Branch: 'ST',
  LastModifiedOn: '2025-12-24T09:15:00',
}

describe('mapPayment: PaymentRef is the cheque number, ReferenceNbr is the CV', () => {
  it('does NOT put ReferenceNbr in checkNumber or PaymentRef in cvNumber — the single most likely mapping error', () => {
    // Reversing these two files every cheque under its voucher number. The
    // dedup key is (company, checkNumber), so the mistake is not cosmetic: it
    // silently keys 37,000 payments on the wrong identifier and makes them
    // impossible to match against the workbook's "CHECK NUMBER" column.
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.checkNumber).toBe('6000308584')
    expect(r.cvNumber).toBe('CV-ST011550')
    expect(r.checkNumber).not.toBe('CV-ST011550')
    expect(r.cvNumber).not.toBe('6000308584')
  })

  it('keeps the payment document reference as the Acumatica identity as well', () => {
    // ReferenceNbr is the payment document's unique key in this feed — the
    // Supplier Portal's ap_payment.ref is UNIQUE on exactly this value — so it
    // is both the CV number a human reads and the identity the sync matches on.
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.acumaticaPaymentId).toBe('CV-ST011550')
  })
})

describe('mapPayment: document types', () => {
  it('maps a Payment to a normalised row', () => {
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r).not.toBeNull()
    expect(r.source).toBe('ACUMATICA')
    expect(r.acumaticaDocType).toBe('Payment')
    expect(r.voided).toBe(false)
  })

  it('maps a Voided Payment to a row flagged voided', () => {
    const r = mapPayment({ ...paymentRow, Type: 'Voided Payment', PaymentAmount: -7950, Status: 'Closed' }, 'GOLIVE')!
    expect(r.voided).toBe(true)
    expect(r.acumaticaDocType).toBe('Voided Payment')
  })

  it('also flags the ORIGINAL row of a voided pair, which carries Status "Voided"', () => {
    // A voided cheque arrives as two rows under one reference: the original
    // (Type Payment, positive, Status "Voided") and its reversal (Type Voided
    // Payment, negative, Status "Closed"). The original is the row that
    // describes what happened, so flagging only the reversal would leave the
    // cheque a human actually looks at unmarked.
    const r = mapPayment({ ...paymentRow, Status: 'Voided' }, 'GOLIVE')!
    expect(r.acumaticaDocType).toBe('Payment')
    expect(r.voided).toBe(true)
  })

  it('returns null for the document types we do not import', () => {
    for (const t of ['Prepayment', 'Debit Adj.', 'Refund']) {
      expect(mapPayment({ ...paymentRow, Type: t }, 'GOLIVE'), t).toBeNull()
    }
  })

  it('returns null for a type it has never seen rather than importing it blind', () => {
    expect(mapPayment({ ...paymentRow, Type: 'Credit Adj.' }, 'GOLIVE')).toBeNull()
    expect(mapPayment({ ...paymentRow, Type: '' }, 'GOLIVE')).toBeNull()
    expect(mapPayment({ ...paymentRow, Type: undefined }, 'GOLIVE')).toBeNull()
  })

  it('returns null for something that is not a feed row at all', () => {
    for (const v of [null, undefined, 'a string', 42, []]) {
      expect(mapPayment(v, 'GOLIVE'), String(v)).toBeNull()
    }
  })
})

describe('mapPayment: company resolution', () => {
  it('resolves the company from the branch, per tenant', () => {
    expect(mapPayment(paymentRow, 'GOLIVE')!.companyCode).toBe('STK')
    expect(mapPayment(paymentRow, 'MANUFACTURING')!.companyCode).toBe('STPP')
    expect(mapPayment(paymentRow, 'MANUFACTURING')!.acumaticaTenant).toBe('MANUFACTURING')
  })

  it('produces a row with NO company for an unrecognised branch rather than defaulting to one', () => {
    // ONEMARANAO exists in the live feed and has no company here. A default
    // would file its cheques under whichever company happens to be first.
    const r = mapPayment({ ...paymentRow, Branch: 'ONEMARANAO' }, 'GOLIVE')!
    expect(r).not.toBeNull()
    expect(r.companyCode).toBeNull()
    // The raw code survives so a human can still see what the feed said.
    expect(r.acumaticaBranch).toBe('ONEMARANAO')
  })

  it('tolerates the padding Acumatica applies to branch codes', () => {
    expect(mapPayment({ ...paymentRow, Branch: '  ST  ' }, 'GOLIVE')!.companyCode).toBe('STK')
  })

  it('leaves the company null when the feed states no branch', () => {
    const r = mapPayment({ ...paymentRow, Branch: '' }, 'GOLIVE')!
    expect(r.companyCode).toBeNull()
    expect(r.acumaticaBranch).toBeNull()
  })
})

describe('mapPayment: not every payment is a cheque', () => {
  it('flags the China offices as non-cheque payments', () => {
    // DG (Dongguan) and SH (Shanghai) pay by transfer in CNY, and their
    // PaymentRef carries an AP reference rather than a cheque number. There is
    // no physical document to sign or hand over.
    const dg = mapPayment({
      ...paymentRow,
      Branch: 'DG',
      Currency: 'CNY',
      PaymentRef: 'AP-DG001931',
      PaymentMethod: 'TT',
      CashAccount: 'RMB-C-2213',
    }, 'GOLIVE')!
    expect(dg.isCheque).toBe(false)
    expect(dg.companyCode).toBe('DG')
    expect(dg.currency).toBe('CNY')
    // The AP reference is kept, not discarded: it is the only identifier the
    // payment has, and dropping it would make the row unkeyable.
    expect(dg.checkNumber).toBe('AP-DG001931')

    const sh = mapPayment({ ...paymentRow, Branch: 'SH', Currency: 'CNY', PaymentRef: 'AP-SH000442' }, 'GOLIVE')!
    expect(sh.isCheque).toBe(false)
    expect(sh.companyCode).toBe('SH')
  })

  it('treats every other branch as a cheque', () => {
    expect(mapPayment(paymentRow, 'GOLIVE')!.isCheque).toBe(true)
    expect(mapPayment({ ...paymentRow, Branch: 'A1+' }, 'GOLIVE')!.isCheque).toBe(true)
    // Even an unrecognised branch: the two non-cheque branches are known by
    // name, and guessing from the PaymentRef's shape would misclassify cheques.
    expect(mapPayment({ ...paymentRow, Branch: 'ONEMARANAO' }, 'GOLIVE')!.isCheque).toBe(true)
  })
})

describe('mapPayment: money never becomes a float', () => {
  it('carries the amount as a decimal string', () => {
    const r = mapPayment({ ...paymentRow, PaymentAmount: 197715.42 }, 'GOLIVE')!
    expect(r.amount).toBe('197715.42')
    expect(typeof r.amount).toBe('string')
  })

  it('accepts an amount the feed sends as a string, unchanged', () => {
    expect(mapPayment({ ...paymentRow, PaymentAmount: '197715.42' }, 'GOLIVE')!.amount).toBe('197715.42')
    expect(mapPayment({ ...paymentRow, PaymentAmount: ' -88426.95 ' }, 'GOLIVE')!.amount).toBe('-88426.95')
  })

  it('keeps a negative reversal negative rather than taking its magnitude', () => {
    const r = mapPayment({ ...paymentRow, Type: 'Voided Payment', PaymentAmount: -88426.95 }, 'GOLIVE')!
    expect(r.amount).toBe('-88426.95')
  })

  it('rejects an exponent form rather than expanding it', () => {
    // Expanding 1e21 invents 21 digits nobody wrote down. Nothing in this feed
    // renders that way, so a value that does is a surprise, not an amount.
    expect(mapPayment({ ...paymentRow, PaymentAmount: 1e21 }, 'GOLIVE')!.amount).toBeNull()
    expect(mapPayment({ ...paymentRow, PaymentAmount: 1e-7 }, 'GOLIVE')!.amount).toBeNull()
    expect(mapPayment({ ...paymentRow, PaymentAmount: '1e21' }, 'GOLIVE')!.amount).toBeNull()
  })

  it('leaves the amount null when the feed does not state one', () => {
    for (const v of [null, undefined, '', 'CANCELLED', NaN]) {
      expect(mapPayment({ ...paymentRow, PaymentAmount: v }, 'GOLIVE')!.amount, String(v)).toBeNull()
    }
  })

  it('leaves the currency null when the feed does not state one, rather than assuming pesos', () => {
    expect(mapPayment({ ...paymentRow, Currency: '' }, 'GOLIVE')!.currency).toBeNull()
    expect(mapPayment({ ...paymentRow, Currency: 'usd' }, 'GOLIVE')!.currency).toBe('USD')
  })
})

describe('mapPayment: dates', () => {
  it('reads the payment date as a UTC day, discarding the time component', () => {
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.checkDate?.toISOString()).toBe('2025-12-23T00:00:00.000Z')
  })

  it('does not shift the day by the host machine timezone', () => {
    // Acumatica's timestamps are naive. `new Date('2025-12-23T00:00:00')`
    // parses as LOCAL time, so on a UTC+8 host the cheque would land on the
    // 22nd. The day the feed states is the day we store.
    expect(mapPayment({ ...paymentRow, PaymentDate: '2025-12-23T00:00:00' }, 'GOLIVE')!.checkDate?.toISOString().slice(0, 10)).toBe('2025-12-23')
    expect(mapPayment({ ...paymentRow, PaymentDate: '2025-12-23' }, 'GOLIVE')!.checkDate?.toISOString().slice(0, 10)).toBe('2025-12-23')
  })

  it('preserves the LastModifiedOn wall clock so the watermark round-trips', () => {
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.lastModifiedOn?.toISOString().slice(0, 19)).toBe('2025-12-24T09:15:00')
  })

  it('leaves a missing or unparseable date null rather than passing Invalid Date to the database', () => {
    for (const v of [null, undefined, '', 'not a date', 0]) {
      expect(mapPayment({ ...paymentRow, PaymentDate: v }, 'GOLIVE')!.checkDate, String(v)).toBeNull()
      expect(mapPayment({ ...paymentRow, LastModifiedOn: v }, 'GOLIVE')!.lastModifiedOn, String(v)).toBeNull()
    }
  })
})

describe('mapPayment: the rest of the shared row contract', () => {
  it('fills the fields the feed knows and nulls the ones it does not', () => {
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.payeeName).toBe('HENKEL PHILIPPINES INC.')
    expect(r.vendorCode).toBe('V001234')
    expect(r.cashAccountCode).toBe('BPI STK')
    expect(r.acumaticaStatus).toBe('Closed')
    // The generic inquiry exposes no checkbook and no payment category. A
    // guess from PaymentMethod or Description would invent both.
    expect(r.checkBookCode).toBeNull()
    expect(r.category).toBeNull()
    // Provenance belongs to the workbook path.
    expect(r.sourceSheet).toBeNull()
    expect(r.sourceRow).toBeNull()
  })

  it('turns a blank cell into null rather than an empty string', () => {
    const r = mapPayment({ ...paymentRow, VendorName: '   ', Vendor: '', CashAccount: null, PaymentRef: '' }, 'GOLIVE')!
    expect(r.payeeName).toBeNull()
    expect(r.vendorCode).toBeNull()
    expect(r.cashAccountCode).toBeNull()
    expect(r.checkNumber).toBeNull()
  })
})
