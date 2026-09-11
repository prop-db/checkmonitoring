export type FieldKind =
  | 'APV' | 'CV' | 'PO' | 'CHECKBOOK' | 'CHECK_NUMBER'
  | 'DATE_SERIAL' | 'CATEGORY' | 'RECEIPT_REF' | 'AMOUNT' | 'STATUS_WORD'
  | 'CASH_ACCOUNT' | 'UNKNOWN'

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
// Cheque numbers in this register are exactly 6 digits (BDO) or 10 (BPI, MBTC).
// A looser \d{6,10} also matched round-number amounts — 4200000, 20000000 —
// which then won the `??=` race by appearing earlier in the row and became the
// cheque number. Verified against the real register: constraining to 6 or 10
// leaves 337 six-digit and 11,828 ten-digit cheques and sends 44 ambiguous rows
// to review, which is where a 9- or 11-digit value belongs.
const CHECK_NUMBER = /^\d{6}$|^\d{10}$/
// "CR 6336", "CR08970". The register's REMARKS column (column 12 of the
// RELEASED sheets) carries one on 2,727 rows, and this rule once called it a
// CLEARING_REF — the bank's reference — on the strength of two letters.
// Client ruling 2026-09-11: it is the supplier's COLLECTION RECEIPT, the paper
// handed over at collection. The importer writes it to the receipt columns,
// never to `crNumber` (rule 11). `scripts/repair-cr-receipts.ts` moves the
// 2,727 that were filed wrong before this comment existed.
const RECEIPT_REF = /^CR\s?\d+$/
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
// The register's 'bank' column holds these account labels. They contain
// letters and are short, so without this rule they beat real company names to
// the payee slot - 1,264 rows in the real register. Matched as an exact set
// rather than a bank-name prefix, because 'BDO Unibank, Inc' is a genuine payee
// the group pays as a vendor.
const CASH_ACCOUNT_LABELS = new Set([
  'BPI STK', 'BPI P&P', 'BPI A1', 'MBTC A1+', 'MBTC P&P', 'BDO A1',
])

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
    // Same 6-or-10 rule as the string form. A 7- or 8-digit integer in this
    // register is an amount, not a cheque number.
    const digits = String(value).length
    if (Number.isInteger(value) && (digits === 6 || digits === 10)) return 'CHECK_NUMBER'
    return 'UNKNOWN'
  }

  if (typeof value !== 'string') return 'UNKNOWN'

  const s = value.trim().toUpperCase().replace(/\s+/g, ' ')
  if (s === '' || s === '#N/A') return 'UNKNOWN'

  if (CHECKBOOK.test(s)) return 'CHECKBOOK'
  if (APV.test(s)) return 'APV'
  if (CV.test(s)) return 'CV'
  if (PO.test(s)) return 'PO'
  if (RECEIPT_REF.test(s)) return 'RECEIPT_REF'
  if (CATEGORIES.has(s)) return 'CATEGORY'
  if (CHECK_NUMBER.test(s)) return 'CHECK_NUMBER'
  if (AMOUNT.test(s.replace(/,/g, ''))) return 'AMOUNT'
  // Status words the register puts in various columns. They are not payees, and
  // without this "CANCELLED" became a vendor name.
  if (STATUS_WORDS.has(s)) return 'STATUS_WORD'
  if (CASH_ACCOUNT_LABELS.has(s)) return 'CASH_ACCOUNT'

  return 'UNKNOWN'
}
