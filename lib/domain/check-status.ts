import { DomainError } from './errors'

export type CheckStatus =
  | 'GENERATED' | 'SIGNATURE_PENDING' | 'SIGNED'
  | 'READY_FOR_RELEASE' | 'SCHEDULED' | 'RELEASED' | 'CANCELLED' | 'VOIDED'

export type ClearingStatus = 'NONE' | 'DEPOSITED' | 'ENCASHED' | 'CLEARED'

// A check must be made available before it can be released, so SIGNED has no
// direct edge to RELEASED. SCHEDULED is optional: suppliers do collect without
// booking a slot in the portal.
//
// Acumatica can void a cheque at any point, including after Finance has
// released it. Refusing that transition would leave this system showing
// RELEASED for a cheque the ERP says no longer exists — the monitoring
// system disagreeing with the source of truth is worse than recording an
// uncomfortable fact. CANCELLED is excluded only because it is already a
// terminal Finance decision with a recorded reason.
const TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  GENERATED:         ['SIGNATURE_PENDING', 'CANCELLED', 'VOIDED'],
  SIGNATURE_PENDING: ['SIGNED', 'CANCELLED', 'VOIDED'],
  SIGNED:            ['READY_FOR_RELEASE', 'CANCELLED', 'VOIDED'],
  READY_FOR_RELEASE: ['SCHEDULED', 'RELEASED', 'SIGNED', 'CANCELLED', 'VOIDED'],
  SCHEDULED:         ['RELEASED', 'SIGNED', 'CANCELLED', 'VOIDED'],
  RELEASED:          ['VOIDED'],
  CANCELLED:         [],
  VOIDED:            [],
}

export function canTransition(from: CheckStatus, to: CheckStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: CheckStatus, to: CheckStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('ILLEGAL_TRANSITION', `Cannot move a check from ${from} to ${to}.`)
  }
}

export type ReadyGuardInput = {
  status: CheckStatus
  checkNumber: string | null
  payeeName: string | null
  amount: string | null
  checkDate: Date | null
  cashAccountCode: string | null
  availablePickupDate: Date | null
  isCheque: boolean
}

export type GuardResult = { ok: true } | { ok: false; code: string; message: string }

const REQUIRED_FIELDS: readonly (readonly [keyof ReadyGuardInput, string])[] = [
  ['checkNumber', 'CHECK NUMBER'],
  ['payeeName', 'PAYEE'],
  ['amount', 'AMOUNT'],
  ['checkDate', 'CHECK DATE'],
  ['cashAccountCode', 'CASH ACCOUNT'],
  ['availablePickupDate', 'AVAILABLE PICKUP DATE'],
]

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  return false
}

const NOT_A_CHEQUE_MESSAGE =
  'This payment is not a cheque, so it cannot be signed or released. It is tracked here for visibility only.'

// A non-cheque payment (an Acumatica transfer with no physical document) can
// never enter the release ladder. Thrown from markSigned and markReleased,
// which have no other guard function to route through.
export function assertReleasable(input: { isCheque: boolean }): void {
  if (!input.isCheque) {
    throw new DomainError('NOT_A_CHEQUE', NOT_A_CHEQUE_MESSAGE)
  }
}

// Order matters: NOT_A_CHEQUE is reported ahead of every other guard, because
// it is a structural fact about the payment, not a transient status one — no
// status change ever makes it releasable. ALREADY_RELEASED then comes before
// missing fields, because a released check is a terminal fact and telling the
// user to fill in a field would send them down a dead end.
export function checkReadyForRelease(input: ReadyGuardInput): GuardResult {
  if (!input.isCheque) {
    return { ok: false, code: 'NOT_A_CHEQUE', message: NOT_A_CHEQUE_MESSAGE }
  }

  if (input.status === 'RELEASED') {
    return {
      ok: false,
      code: 'ALREADY_RELEASED',
      message: 'This check cannot be released because it has already been RELEASED.',
    }
  }

  if (input.status !== 'SIGNED') {
    return {
      ok: false,
      code: 'NOT_SIGNED',
      message: 'This check cannot be released because it has not yet been marked as SIGNED.',
    }
  }

  const missing = REQUIRED_FIELDS.filter(([key]) => isBlank(input[key])).map(([, label]) => label)
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      message: `This check cannot be released because required information is missing: ${missing.join(', ')}.`,
    }
  }

  return { ok: true }
}

const CLEARING_TRANSITIONS: Record<ClearingStatus, readonly ClearingStatus[]> = {
  NONE:      ['DEPOSITED', 'ENCASHED'],
  DEPOSITED: ['CLEARED'],
  ENCASHED:  ['CLEARED'],
  CLEARED:   [],
}

export function canSetClearing(status: CheckStatus, from: ClearingStatus, to: ClearingStatus): boolean {
  if (status !== 'RELEASED') return false
  return CLEARING_TRANSITIONS[from].includes(to)
}

export function assertClearing(status: CheckStatus, from: ClearingStatus, to: ClearingStatus): void {
  if (!canSetClearing(status, from, to)) {
    throw new DomainError('ILLEGAL_CLEARING', `Cannot set clearing status to ${to} from ${from} while the check is ${status}.`)
  }
}
