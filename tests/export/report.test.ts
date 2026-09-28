import { describe, it, expect } from 'vitest'
import {
  EXPORT_ROW_LIMIT,
  MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH,
  exportViewLabel, slugify, exportFilename,
  describeFilters, fitColumnWidth,
  toCentavos, fromCentavos, totalsByCurrency,
  currencyNumberFormat, bankLabel, statusWords, describeScope,
} from '@/lib/export/report'

describe('exportViewLabel', () => {
  it('names the default view', () => {
    expect(exportViewLabel({ status: null, showAll: false })).toBe('NEEDS ACTION')
  })

  it('names the everything view', () => {
    expect(exportViewLabel({ status: null, showAll: true })).toBe('ALL CHEQUES')
  })

  it('names a status view in words, not in enum spelling', () => {
    expect(exportViewLabel({ status: 'READY_FOR_RELEASE', showAll: false })).toBe('READY FOR RELEASE')
    expect(exportViewLabel({ status: 'SIGNATURE_PENDING', showAll: false })).toBe('SIGNATURE PENDING')
  })

  // An explicit status wins over the scope flag, exactly as viewStatusFilter
  // resolves it — otherwise the file would be named for a view it does not hold.
  it('lets an explicit status win over scope=all', () => {
    expect(exportViewLabel({ status: 'RELEASED', showAll: true })).toBe('RELEASED')
  })
})

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('READY FOR RELEASE')).toBe('ready-for-release')
  })

  it('collapses runs of punctuation into one hyphen and trims the ends', () => {
    expect(slugify('ALL CHEQUES — EVERY STATUS')).toBe('all-cheques-every-status')
    expect(slugify('  SIGNED  ')).toBe('signed')
  })

  it('never returns an empty slug', () => {
    expect(slugify('———')).toBe('export')
    expect(slugify('')).toBe('export')
  })
})

describe('exportFilename', () => {
  it('carries the view and the date', () => {
    // Local time, deliberately: a file generated at 08:00 in Manila must not be
    // named for the previous day because UTC has not caught up.
    expect(exportFilename('READY FOR RELEASE', new Date(2026, 8, 6, 8, 30)))
      .toBe('check-register-ready-for-release-2026-09-06.xlsx')
  })

  it('zero-pads the month and day', () => {
    expect(exportFilename('ALL CHEQUES', new Date(2026, 0, 3, 23, 59)))
      .toBe('check-register-all-cheques-2026-01-03.xlsx')
  })
})

describe('describeFilters', () => {
  it('says so plainly when nothing is narrowing the view', () => {
    expect(describeFilters({})).toBe('No filters applied')
  })

  it('names each filter in words', () => {
    expect(describeFilters({ company: 'STK' })).toBe('COMPANY: STK')
    expect(describeFilters({ bank: 'BPI STK' })).toBe('BANK / CASH ACCOUNT: BPI STK')
    expect(describeFilters({ eligibility: 'SUPPLIER' })).toBe('ELIGIBILITY: SUPPLIER')
    expect(describeFilters({ q: 'henkel' })).toBe('SEARCH: "henkel"')
    expect(describeFilters({ incomplete: true })).toBe('INCOMPLETE RECORDS ONLY (NO AMOUNT)')
  })

  it('joins several in a stable order', () => {
    expect(describeFilters({
      q: 'henkel', company: 'STK', bank: 'BPI STK', eligibility: 'SUPPLIER', incomplete: true,
    })).toBe([
      'COMPANY: STK',
      'BANK / CASH ACCOUNT: BPI STK',
      'ELIGIBILITY: SUPPLIER',
      'SEARCH: "henkel"',
      'INCOMPLETE RECORDS ONLY (NO AMOUNT)',
    ].join('  ·  '))
  })

  // A blank search box is not a filter. `undefined` incompleteness is not one
  // either — `buildWhere` reads it as "do not narrow on this".
  it('ignores empty values rather than listing them', () => {
    expect(describeFilters({ q: '   ', company: null, bank: undefined }))
      .toBe('No filters applied')
  })

  /**
   * SUPERSEDED BY A CLIENT DECISION, 2026-09-06. `incomplete: false` used to be
   * silent, because it meant "do not narrow on this" and there was nothing to
   * announce. It now REMOVES the 129 cheques with no recorded amount from the
   * file, and a report that does not say what it excludes is a report that will
   * be read as the whole picture — the same reason "No filters applied" is
   * spelled out rather than left blank.
   */
  /**
   * The range as the reader typed it — days, not instants. A title block that
   * printed "2026-09-24T16:00:00.000Z" would be read as the wrong day by
   * everyone in Manila.
   */
  it('names the DATE RELEASED range in the three ways it can be given', () => {
    expect(describeFilters({ releasedFrom: '2026-09-01', releasedTo: '2026-09-15' }))
      .toBe('DATE RELEASED: 2026-09-01 TO 2026-09-15')
    expect(describeFilters({ releasedFrom: '2026-09-01' })).toBe('DATE RELEASED: FROM 2026-09-01')
    expect(describeFilters({ releasedTo: '2026-09-15' })).toBe('DATE RELEASED: TO 2026-09-15')
  })

  it('places the range after the search and before the incomplete clause', () => {
    expect(describeFilters({ q: 'henkel', releasedFrom: '2026-09-01', incomplete: false }))
      .toBe('SEARCH: "henkel"  ·  DATE RELEASED: FROM 2026-09-01  ·  EXCLUDES RECORDS WITH NO AMOUNT')
  })

  it('ignores a blank day rather than printing an empty bound', () => {
    expect(describeFilters({ releasedFrom: '  ', releasedTo: null })).toBe('No filters applied')
  })

  it('announces the exclusion of the records with no amount', () => {
    expect(describeFilters({ incomplete: false })).toBe('EXCLUDES RECORDS WITH NO AMOUNT')
    expect(describeFilters({ q: 'henkel', incomplete: false }))
      .toBe('SEARCH: "henkel"  ·  EXCLUDES RECORDS WITH NO AMOUNT')
  })
})

describe('fitColumnWidth', () => {
  it('fits the longest value when it beats the header', () => {
    expect(fitColumnWidth('COMPANY', ['STARKSON PACKAGING INC.']))
      .toBe('STARKSON PACKAGING INC.'.length + 2)
  })

  it('fits the header when it beats every value', () => {
    expect(fitColumnWidth('AVAILABLE DATE', ['1'])).toBe('AVAILABLE DATE'.length + 2)
  })

  it('never falls below the minimum', () => {
    expect(fitColumnWidth('NO', [''])).toBe(MIN_COLUMN_WIDTH)
  })

  // One 200-character payee must not produce a 200-character column that pushes
  // every other column off the printed page.
  it('never exceeds the maximum', () => {
    expect(fitColumnWidth('SUPPLIER NAME', ['x'.repeat(200)])).toBe(MAX_COLUMN_WIDTH)
  })

  it('handles a column with no values at all', () => {
    expect(fitColumnWidth('CHECK NUMBER', [])).toBe('CHECK NUMBER'.length + 2)
  })
})

describe('toCentavos / fromCentavos', () => {
  it('round-trips a decimal string without going through a float', () => {
    expect(fromCentavos(toCentavos('197715.42'))).toBe('197715.42')
    expect(fromCentavos(toCentavos('0.01'))).toBe('0.01')
    expect(fromCentavos(toCentavos('-500.50'))).toBe('-500.50')
  })

  it('reads a Prisma-trimmed trailing zero correctly', () => {
    // Prisma renders 988577.10 as "988577.1"; read as 98857710 centavos, not
    // 9885771.
    expect(toCentavos('988577.1')).toBe(9_885_771_0n)
  })

  it('reads a whole-peso string', () => {
    expect(toCentavos('1000')).toBe(100_000n)
  })

  it('keeps every centavo of a 16-digit amount', () => {
    // Decimal(18,2) permits this, and a JS number would not survive it.
    expect(fromCentavos(toCentavos('9999999999999999.99'))).toBe('9999999999999999.99')
  })

  it('rounds half up at the third decimal, as formatMoney does', () => {
    expect(fromCentavos(toCentavos('9.999'))).toBe('10.00')
    expect(fromCentavos(toCentavos('9.994'))).toBe('9.99')
  })
})

describe('totalsByCurrency', () => {
  it('gives every currency its own total and never adds them together', () => {
    expect(totalsByCurrency([
      { currency: 'PHP', amount: '1000.00' },
      { currency: 'PHP', amount: '500.50' },
      { currency: 'CNY', amount: '2000.25' },
    ])).toEqual([
      { currency: 'CNY', total: '2000.25', count: 1 },
      { currency: 'PHP', total: '1500.50', count: 2 },
    ])
  })

  // The 129 production cheques with no recorded amount. They are counted, and
  // they are absent from the total — never absorbed as zero.
  it('counts a cheque with no amount but leaves it out of the total', () => {
    expect(totalsByCurrency([
      { currency: 'PHP', amount: '1000.00' },
      { currency: 'PHP', amount: null },
    ])).toEqual([{ currency: 'PHP', total: '1000.00', count: 2 }])
  })

  // "No amount is known for any of these" is not "these are worth nothing".
  // getSummary carries the same null through for the same reason.
  it('answers null, not zero, when no amount in a currency is known', () => {
    expect(totalsByCurrency([
      { currency: 'PHP', amount: null },
      { currency: 'PHP', amount: null },
    ])).toEqual([{ currency: 'PHP', total: null, count: 2 }])
  })

  it('answers nothing at all for no rows', () => {
    expect(totalsByCurrency([])).toEqual([])
  })

  it('sums negatives, which a voided cheque can produce', () => {
    expect(totalsByCurrency([
      { currency: 'PHP', amount: '1000.00' },
      { currency: 'PHP', amount: '-1000.00' },
    ])).toEqual([{ currency: 'PHP', total: '0.00', count: 2 }])
  })
})

describe('currencyNumberFormat', () => {
  it('prefixes the symbol of a known currency to the standard money format', () => {
    expect(currencyNumberFormat('PHP')).toBe('"₱"#,##0.00')
    expect(currencyNumberFormat('CNY')).toBe('"¥"#,##0.00')
    expect(currencyNumberFormat('USD')).toBe('"$"#,##0.00')
  })

  // Same rule formatMoney follows: an unfamiliar ISO code is better than a
  // wrong symbol on a financial figure.
  it('falls back to the ISO code rather than guessing a symbol', () => {
    expect(currencyNumberFormat('SGD')).toBe('"SGD "#,##0.00')
  })
})

describe('bankLabel', () => {
  it('shows the cash account code Finance says out loud', () => {
    expect(bankLabel('BPI STK', 'BPI')).toBe('BPI STK')
  })

  it('adds the institution when the account code does not already name it', () => {
    expect(bankLabel('STK MAIN', 'BPI')).toBe('STK MAIN (BPI)')
  })

  it('falls back to the bank alone, and then to nothing', () => {
    expect(bankLabel(null, 'BPI')).toBe('BPI')
    expect(bankLabel(null, null)).toBe(null)
  })
})

describe('statusWords', () => {
  it('spells a status the way the screen does', () => {
    expect(statusWords('READY_FOR_RELEASE')).toBe('READY FOR RELEASE')
    expect(statusWords('SIGNED')).toBe('SIGNED')
  })
})

describe('EXPORT_ROW_LIMIT', () => {
  // A deliberate cap, not an accident: the whole workbook is built in memory in
  // a serverless function. It is stated in the file's own title block whenever
  // it bites, so an export can never be quietly short.
  it('is a stated, finite cap', () => {
    expect(EXPORT_ROW_LIMIT).toBe(10_000)
    expect(MAX_COLUMN_WIDTH).toBeGreaterThan(MIN_COLUMN_WIDTH)
  })
})

describe('describeScope', () => {
  it('names the view and how many cheques the file holds', () => {
    expect(describeScope('READY FOR RELEASE', 200, 200)).toBe('READY FOR RELEASE — 200 CHEQUES')
  })

  it('says one cheque, not one cheques', () => {
    expect(describeScope('SIGNED', 1, 1)).toBe('SIGNED — 1 CHEQUE')
  })

  // The cap must never be silent. A short file that says nothing reads as a
  // small result, and a manager has no way to tell the two apart.
  it('states the truncation when fewer rows were exported than matched', () => {
    expect(describeScope('ALL CHEQUES', 10_000, 12_227))
      .toBe('ALL CHEQUES — FIRST 10,000 OF 12,227 MATCHING CHEQUES')
  })

  it('says plainly when nothing matched, rather than showing an empty table', () => {
    expect(describeScope('SCHEDULED', 0, 0)).toBe('SCHEDULED — NO CHEQUES MATCH')
  })
})
