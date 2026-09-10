import type { GuardResult } from './check-status'

/**
 * The supplier's receipt — the paper handed over when the cheque is collected.
 *
 * Pure: no database, network, filesystem or clock, like the rest of
 * `lib/domain/` apart from `actions.ts`.
 *
 * **This is NOT `Check.crNumber`.** That column sits beside `clearingStatus`
 * (NONE/DEPOSITED/ENCASHED/CLEARED) and `clearedDate` and holds the BANK's
 * clearing reference, recorded weeks after release when the cheque comes back
 * through the account. A supplier's Collection Receipt is a piece of paper
 * handed across a counter on the day. The two abbreviate to the same two
 * letters and mean nothing like each other: a receipt number written into the
 * column that tracks whether a cheque cleared the bank would read, to every
 * report and every reconciliation, as evidence the money had cleared. The
 * receipt lives in `orNumber` / `orDate` / `receiptType`, and nothing here ever
 * writes `crNumber`.
 *
 * **The type is stored, not inferred.** "OR-000123" and "4471" and "CR 88" are
 * all references a supplier writes, and parsing the kind back out of the string
 * would be a guess dressed as a fact — the register already taught this project
 * what positional and prefix guesses cost. Finance says which kind it is, once,
 * and the answer is a column.
 */

export const RECEIPT_TYPES = ['OR', 'CR'] as const
export type ReceiptType = (typeof RECEIPT_TYPES)[number]

/** What the two letters stand for, spelled out wherever a user has to choose. */
export const RECEIPT_TYPE_LABELS: Record<ReceiptType, string> = {
  OR: 'OFFICIAL RECEIPT',
  CR: 'COLLECTION RECEIPT',
}

export function isReceiptType(value: unknown): value is ReceiptType {
  return typeof value === 'string' && (RECEIPT_TYPES as readonly string[]).includes(value)
}

export type ReceiptInput = {
  orNumber?: string | null
  orDate?: Date | null
  receiptType?: ReceiptType | null
}

export type Receipt = {
  orNumber: string | null
  orDate: Date | null
  receiptType: ReceiptType | null
}

const reference = (input: ReceiptInput): string | null => {
  const raw = (input.orNumber ?? '').trim()
  return raw === '' ? null : raw
}

/**
 * The one combination that is refused: a reference with no type.
 *
 * Everything else is permitted, because the client made the receipt optional —
 * "A cheque can be released with the box empty and the receipt added later" —
 * and RELEASE ALL at the counter releases 81 cheques without one.
 *
 * A reference with no type is refused rather than defaulted to OR. Defaulting
 * would turn "the person releasing did not say" into "the person releasing said
 * OR", which is the difference between a gap somebody can fill and a fact
 * nobody can distinguish from a real one. The message names both kinds so the
 * answer is in the question.
 */
export function checkReceipt(input: ReceiptInput): GuardResult {
  if (reference(input) !== null && !isReceiptType(input.receiptType ?? null)) {
    return {
      ok: false,
      code: 'RECEIPT_TYPE_REQUIRED',
      message:
        'Choose whether this reference is an Official Receipt (OR) or a Collection Receipt (CR). ' +
        'A receipt reference cannot be recorded without saying which kind of receipt it is.',
    }
  }
  return { ok: true }
}

/**
 * What is actually stored, once the guard has passed.
 *
 * A type or a date with no reference is dropped rather than written: both are
 * attributes OF a reference, and a receipt with no number is a receipt nobody
 * can look up. Storing them would leave a cheque reading as "an OR dated the
 * 8th" with nothing to find, and would inflate any later count of the receipts
 * Finance actually holds.
 */
export function normaliseReceipt(input: ReceiptInput): Receipt {
  const orNumber = reference(input)
  if (orNumber === null) return { orNumber: null, orDate: null, receiptType: null }
  return {
    orNumber,
    orDate: input.orDate ?? null,
    receiptType: isReceiptType(input.receiptType) ? input.receiptType : null,
  }
}

/** True when a receipt was actually recorded, which is what gets an audit row. */
export function hasReceipt(receipt: Receipt): boolean {
  return receipt.orNumber !== null
}
