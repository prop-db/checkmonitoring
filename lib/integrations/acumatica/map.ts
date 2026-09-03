import type { NormalisedRow } from '@/lib/normalised-row'
import { companyForBranch, type AcumaticaTenant } from './companies'

// One row of the `AP-Checks and Payments` generic inquiry -> the shared
// normalised row. Pure: no database, no network, no filesystem, no
// `process.env`, no `new Date()` of its own.
//
// Every rule here comes from the feed itself rather than from inference. Where
// the inquiry does not publish a field — there is no checkbook and no payment
// category in it — this returns null rather than deriving one from Description
// or PaymentMethod, because a derived checkbook files a cheque under a sibling
// company and a derived category is simply made up.

const str = (v: unknown): string => (v == null ? '' : String(v)).trim()
const orNull = (v: unknown): string | null => str(v) || null

/**
 * PaymentRef is the CHEQUE number. ReferenceNbr is the CV (check voucher)
 * number. Reversing these two is the single most likely mapping error in this
 * file: both are short reference-looking strings, both are present on every
 * row, and swapping them produces data that looks entirely plausible while
 * keying 37,000 payments on the wrong identifier. The workbook's "CHECK NUMBER"
 * column is PaymentRef and its "VOUCHER NUMBER" column is ReferenceNbr, so the
 * mistake also silently breaks every match between the two ingestion paths.
 * `tests/integrations/acumatica-map.test.ts` pins it by name.
 */
const CHECK_NUMBER_FIELD = 'PaymentRef'
const CV_NUMBER_FIELD = 'ReferenceNbr'

// D2: only the first two are cheques Finance hands to a supplier. The feed also
// carries Prepayment, Debit Adj. and Refund; those are not imported. An
// unrecognised type is treated the same way — importing a document we have
// never seen is how a refund ends up on a cheque register.
const PAYMENT = 'Payment'
const VOIDED_PAYMENT = 'Voided Payment'
const IMPORTED_DOC_TYPES: ReadonlySet<string> = new Set([PAYMENT, VOIDED_PAYMENT])

// Acumatica's own word for a voided cheque, on the ORIGINAL row of the pair.
const VOIDED_STATUS = 'Voided'

// The Dongguan and Shanghai offices pay by transfer in CNY; their PaymentRef
// carries an AP document reference (`AP-DG001931`) rather than a cheque number,
// and there is no physical document to sign or hand over.
//
// Matched on the branch, which is a stated fact, and NOT on the shape of the
// PaymentRef. A shape rule looks tempting — these all start "AP-" — but cheque
// numbering is a bank's business and nothing guarantees a future bank's format
// stays numeric. A wrong answer here either blocks a real cheque from release
// or offers a release button for money that has already moved by wire.
const NON_CHEQUE_BRANCHES: ReadonlySet<string> = new Set(['DG', 'SH'])

/**
 * A decimal string, or null. Never a JS number and never a round trip through
 * one: parsing 197715.42 into a float and formatting it back is how centavos
 * get lost, and the column is `Decimal(18,2)`.
 *
 * An exponent form is rejected rather than expanded — expanding 1e21 invents 21
 * digits nobody wrote down. Nothing in this feed renders that way, so a value
 * that does is a surprise and belongs in front of a human, not in a total.
 */
function decimalString(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const s = String(value)
    return /^-?\d+(\.\d+)?$/.test(s) ? s : null
  }
  if (typeof value !== 'string') return null
  const s = value.trim()
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null
}

/**
 * Acumatica's timestamps are naive: `2025-12-23T00:00:00`, no zone. Handing
 * that string to `new Date` parses it as LOCAL time, so on a UTC+8 host a
 * cheque dated the 23rd lands on the 22nd. Appending `Z` pins the wall clock
 * the feed stated, which is also what makes the sync watermark round-trip:
 * `toISOString().slice(0, 19)` gives back the exact string Acumatica sent.
 *
 * Deviation from the Supplier Portal, which keeps these as strings throughout
 * and never has to choose. We store `DateTime`, so the choice is unavoidable
 * and is made here, once, visibly.
 */
function naiveDate(value: unknown, { dayOnly }: { dayOnly: boolean }): Date | null {
  const s = str(value)
  // The shape is checked BEFORE parsing, not after. `new Date('0Z')` is not an
  // Invalid Date — it is 2000-01-01 — so an `isNaN` check alone lets a stray 0
  // in the feed become a plausible-looking cheque date. Only a full ISO day
  // prefix is accepted.
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null
  const day = s.slice(0, 10)
  const time = dayOnly ? '00:00:00' : (/T(\d{2}:\d{2}:\d{2})/.exec(s)?.[1] ?? '00:00:00')
  const d = new Date(`${day}T${time}Z`)
  // A date we cannot read is not a date: an Invalid Date reaches Prisma as a
  // throw, and a null is what "the feed did not say" actually means.
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Returns null for a document type we do not import, and for anything that is
 * not a feed row at all. A null is "not our business", not an error: the sync
 * counts it as skipped and moves on.
 */
export function mapPayment(row: unknown, tenant: AcumaticaTenant): NormalisedRow | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const r = row as Record<string, unknown>

  const docType = str(r.Type)
  if (!IMPORTED_DOC_TYPES.has(docType)) return null

  const status = str(r.Status)
  const branch = orNull(r.Branch)

  return {
    source: 'ACUMATICA',
    acumaticaPaymentId: orNull(r[CV_NUMBER_FIELD]),

    checkNumber: orNull(r[CHECK_NUMBER_FIELD]),
    cvNumber: orNull(r[CV_NUMBER_FIELD]),

    checkDate: naiveDate(r.PaymentDate, { dayOnly: true }),
    // No sign manipulation. A Voided Payment reversal arrives negative and
    // stays negative; the portal's sign rule applies to bill adjustments, which
    // this feed does not carry.
    amount: decimalString(r.PaymentAmount),
    currency: orNull(r.Currency)?.toUpperCase() ?? null,

    payeeName: orNull(r.VendorName),
    vendorCode: orNull(r.Vendor),
    // null for an unrecognised branch, by `companyForBranch`'s own contract.
    companyCode: branch ? companyForBranch(tenant, branch) : null,
    cashAccountCode: orNull(r.CashAccount),
    // The generic inquiry publishes neither. See the note at the top of the file.
    checkBookCode: null,
    category: null,

    // Nor these. The payments inquiry is one row per payment and carries no
    // bill breakdown, so the APV and PO references a workbook row supplies
    // simply are not available here. Empty rather than absent: the upsert must
    // be able to tell "this source has no bill references" from "this source
    // forgot to set the field", and it must not clear references the workbook
    // already established for the same cheque.
    apvNumbers: [],
    poNumbers: [],
    clearingRef: null,

    isCheque: !(branch && NON_CHEQUE_BRANCHES.has(branch.toUpperCase())),

    // A voided cheque is TWO rows under one reference: the original (Type
    // "Payment", positive, Status "Voided") and its reversal (Type "Voided
    // Payment", negative, Status "Closed"). Flagging only the reversal would
    // leave the original — the row that describes what actually happened, and
    // the one the Supplier Portal's dedupe deliberately keeps — unmarked. Both
    // conditions are needed; do not "simplify" this to the docType alone.
    voided: docType === VOIDED_PAYMENT || status === VOIDED_STATUS,

    acumaticaDocType: docType,
    acumaticaStatus: status || null,
    acumaticaBranch: branch,
    acumaticaTenant: tenant,
    lastModifiedOn: naiveDate(r.LastModifiedOn, { dayOnly: false }),

    // Sheet and row belong to the workbook path.
    sourceSheet: null,
    sourceRow: null,
  }
}
