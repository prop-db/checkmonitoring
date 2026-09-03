export type FieldKind =
  | 'APV' | 'CV' | 'PO' | 'CHECKBOOK' | 'CHECK_NUMBER'
  | 'DATE_SERIAL' | 'CATEGORY' | 'CLEARING_REF' | 'AMOUNT' | 'STATUS_WORD' | 'UNKNOWN'

// The client's monitoring workbook has fifteen sheets whose columns do not line
// up: the APV is column H on one sheet, F on another, B and D on a third, and
// column E holds a payee on one sheet and a description on the next. Positional
// parsing cannot work, so every cell is identified by what it contains.
//
// Order matters. CHECKBOOK is tested before CHECK_NUMBER because "BPI-S-4636"
// contains digits, and DATE_SERIAL is bounded because an unbounded numeric rule
// would swallow six-digit BDO cheque numbers.

// The entity code after AP-/CV- is not always two letters. The register carries
// AP-ST (2 letters), AP-A1 (letter+digit), and AP-IND (3 letters), so a
// [A-Z]{2} class silently rejects every A1+ and Starkson Industries document —
// they would fall through to UNKNOWN and land in the review queue rather than
// on the cheque.
const APV = /^(AP-[A-Z0-9]{2,3}\d+|(?:STPP|A1PP)-AP-\d+)$/
const CV = /^(CV-[A-Z0-9]{2,3}\d+|(?:STPP|A1PP)-CV-\d+)$/
const PO = /^(P[OR]-[A-Z0-9]{1,4}-?\d+|(?:STPP|A1PP)-PO-\d+)$/
const CHECKBOOK = /^(BPI|MBT|BDO)-[SA]-\d+$/
const CHECK_NUMBER = /^\d{6,10}$/
const CLEARING_REF = /^CR\s?\d+$/
// A text-formatted amount. Without this such a cell falls through to UNKNOWN
// and competes to be the payee — the real register produced vendors named
// "17187.5" and "3746.25" before this rule existed. Requires a decimal point,
// so it cannot swallow a whole-number cheque number.
const AMOUNT = /^-?\d{1,3}(,\d{3})*\.\d+$|^-?\d+\.\d+$/

const CATEGORIES = new Set([
  'LOCAL SUPPLIER', 'PAYROLL', 'UTILITIES', 'TAX', 'FUND TRANSFER',
  'BROKERS', 'SALARIES', 'FTP', 'TRANSPO,GAS AND OIL',
])

// Excel serials: 44000 is 2020-06, 48000 is 2031-05. A bare number outside that
// band is a cheque number or an amount, never a date in this data.
const STATUS_WORDS = new Set([
  'PAID', 'YES', 'CANCELLED', 'DEPOSITED', 'ENCASHMENT', 'CLEARED', 'RELEASED', 'AVAILABLE',
])

const SERIAL_MIN = 44000
const SERIAL_MAX = 48000

export function sniff(value: unknown): FieldKind {
  if (value === null || value === undefined) return 'UNKNOWN'

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'UNKNOWN'
    if (value >= SERIAL_MIN && value <= SERIAL_MAX) return 'DATE_SERIAL'
    if (Number.isInteger(value) && String(value).length >= 6) return 'CHECK_NUMBER'
    return 'UNKNOWN'
  }

  if (typeof value !== 'string') return 'UNKNOWN'

  const s = value.trim().toUpperCase().replace(/\s+/g, ' ')
  if (s === '' || s === '#N/A') return 'UNKNOWN'

  if (CHECKBOOK.test(s)) return 'CHECKBOOK'
  if (APV.test(s)) return 'APV'
  if (CV.test(s)) return 'CV'
  if (PO.test(s)) return 'PO'
  if (CLEARING_REF.test(s)) return 'CLEARING_REF'
  if (CATEGORIES.has(s)) return 'CATEGORY'
  if (CHECK_NUMBER.test(s)) return 'CHECK_NUMBER'
  if (AMOUNT.test(s.replace(/,/g, ''))) return 'AMOUNT'
  // Status words the register puts in various columns. They are not payees, and
  // without this "CANCELLED" became a vendor name.
  if (STATUS_WORDS.has(s)) return 'STATUS_WORD'

  return 'UNKNOWN'
}
