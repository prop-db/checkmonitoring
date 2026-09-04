import type { CheckStatus, GuardResult } from './check-status'

/**
 * Incomplete records, and the narrow rule for deleting one.
 *
 * Pure: no database, network, filesystem or clock, like the rest of
 * `lib/domain/` apart from `actions.ts`.
 *
 * **What "incomplete" means here is exactly "the amount is not recorded".** It
 * is deliberately not "the amount or the payee", though 46 of the 129 carry no
 * payee either: the delete rule below is keyed on the same fact the flag is,
 * and widening the definition would widen what is deletable without anyone
 * deciding to. If a future author does widen it, `backfillIncompleteFlags` must
 * be re-run and `checkDeletable` revisited in the same change.
 *
 * **It is not `Check.isStale`.** That column is reserved for the design's R3
 * queue — 88 cheques from 2025 still sitting AVAILABLE, which are complete
 * records that have simply sat too long. "Has sat too long" and "is missing a
 * fact" are different questions with different answers and different remedies,
 * and a cheque can be either, both or neither. Reusing `isStale` for this would
 * have made the R3 queue unbuildable without first untangling the two.
 */

export function isCheckIncomplete(input: { amount: string | null }): boolean {
  // `=== null`, never a falsy test. `Check.amount` is `Decimal(18,2)` and
  // nullable, and NULL means "not recorded" while 0.00 means a cheque genuinely
  // drawn for nothing. `formatMoney`, `getSummary` and the release guard all
  // keep the two apart; a falsy test here would flag a real zero-value cheque
  // and then offer it for deletion.
  return input.amount === null
}

/**
 * The statuses that block deletion outright, and the whole of why the answer to
 * Finance's request is 98 of the 129 rather than all of them.
 *
 * Measured against production on 2026-09-04: 25 of the 129 are RELEASED and 6
 * are READY_FOR_RELEASE, so 31 are not deletable. Deleting a RELEASED cheque
 * erases the record of money that actually moved. A READY_FOR_RELEASE or
 * SCHEDULED cheque may already have been announced to a supplier — that is the
 * automation this whole system exists for — and deleting one leaves the
 * supplier holding a promise about a record that no longer exists.
 *
 * Exported so the screen and the report name the same three statuses the guard
 * enforces instead of restating them and drifting. Do not widen this list to
 * make the number look better.
 */
export const UNDELETABLE_STATUSES = [
  'RELEASED', 'READY_FOR_RELEASE', 'SCHEDULED',
] as const satisfies readonly CheckStatus[]

export type DeleteGuardInput = {
  actorRole: 'FINANCE_USER' | 'FINANCE_ADMIN'
  /** The cheque's own amount, NOT the stored `isIncomplete` flag. See below. */
  amount: string | null
  status: CheckStatus
  releasedAt: Date | null
}

/**
 * All four conditions must hold, and the order they are reported in is part of
 * the design.
 *
 * Authorisation first, because it is a fact about the actor rather than about
 * the cheque and there is no reason to tell someone who may not do this
 * anything else about it.
 *
 * Then the money facts, and only then the amount. A released cheque that DOES
 * record an amount must be refused as released — reporting "this cheque records
 * an amount" would read as an invitation to blank the amount out and try again,
 * turning a safety rule into a two-step workaround. Pinned by test.
 *
 * `releasedAt` is tested independently of `status`, not as a proxy for it: a
 * cheque voided after release still carries its release facts, because
 * `voidCheck` deliberately leaves them standing as the evidence that the cheque
 * was handed over. That is precisely the cheque whose deletion would do the
 * damage this guard exists to prevent.
 *
 * It reads `amount`, never `isIncomplete`. The flag is a stored derivation
 * maintained by the importer, and a stored derivation can drift; a rule about
 * deleting the record of a payment must read the fact itself.
 */
export function checkDeletable(input: DeleteGuardInput): GuardResult {
  if (input.actorRole !== 'FINANCE_ADMIN') {
    return {
      ok: false,
      code: 'NOT_ADMIN',
      message: 'Only a Finance Admin can delete a cheque record.',
    }
  }

  if (input.status === 'RELEASED' || input.releasedAt !== null) {
    return {
      ok: false,
      code: 'ALREADY_RELEASED',
      message:
        'This cheque has been RELEASED. Deleting it would erase the record of money that ' +
        'actually moved, so it cannot be deleted from here.',
    }
  }

  if (input.status === 'READY_FOR_RELEASE' || input.status === 'SCHEDULED') {
    return {
      ok: false,
      code: 'ANNOUNCED',
      message:
        `This cheque is ${input.status.replace(/_/g, ' ')}, so a supplier may already have been ` +
        'told it is waiting for them. It cannot be deleted — revert its availability first if ' +
        'that was a mistake.',
    }
  }

  if (!isCheckIncomplete({ amount: input.amount })) {
    return {
      ok: false,
      code: 'AMOUNT_RECORDED',
      message:
        'This cheque records an amount, so it is not an incomplete record. Only a cheque whose ' +
        'amount was never recorded can be deleted; cancel it instead.',
    }
  }

  return { ok: true }
}
