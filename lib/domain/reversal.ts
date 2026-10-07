import type { GuardResult } from './check-status'

/**
 * Whether a release may be reversed. Pure, and read by BOTH the domain action
 * and the detail page, so the page cannot offer a button the action would
 * refuse — it shows the refusal sentence instead.
 *
 * Two refusals, in this order.
 *
 * A RECEIPT ON RECORD is the client's own condition (2026-09-10): an OR or CR
 * number in `orNumber` is the supplier's paper saying they took the cheque.
 * Reversing the release over it would make this system claim a cheque is
 * available for collection while holding the supplier's own evidence that it
 * was collected. It is settled with the supplier, and the receipt removed,
 * before the release is reversed.
 *
 * CLEARED is the addition approved on 2026-09-11: any clearing recorded —
 * status, the bank's reference, or a cleared date — means the bank has paid
 * the cheque. Money that has moved cannot be un-handed-over. `crNumber` here
 * is the BANK's reference (rule 11), which is exactly why it counts.
 */
export type ReversalInput = {
  orNumber: string | null
  receiptType: string | null
  clearingStatus: string
  crNumber: string | null
  clearedDate: Date | null
}

export const RECEIPT_ON_RECORD_MESSAGE =
  "A receipt is recorded: the supplier's own paper says they collected this check. " +
  'Settle that with the supplier before reversing the release.'

export const CLEARED_MESSAGE = 'The bank has cleared this check; it cannot be un-released.'

export function checkReleaseReversible(input: ReversalInput): GuardResult {
  if (input.orNumber !== null || input.receiptType !== null) {
    return { ok: false, code: 'RECEIPT_ON_RECORD', message: RECEIPT_ON_RECORD_MESSAGE }
  }
  if (input.clearingStatus !== 'NONE' || input.crNumber !== null || input.clearedDate !== null) {
    return { ok: false, code: 'CLEARED', message: CLEARED_MESSAGE }
  }
  return { ok: true }
}
