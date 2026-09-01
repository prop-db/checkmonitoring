import { DomainError } from './errors'

export type CheckStatus =
  | 'GENERATED' | 'SIGNATURE_PENDING' | 'SIGNED'
  | 'READY_FOR_RELEASE' | 'SCHEDULED' | 'RELEASED' | 'CANCELLED'

export type ClearingStatus = 'NONE' | 'DEPOSITED' | 'ENCASHED' | 'CLEARED'

// A check must be made available before it can be released, so SIGNED has no
// direct edge to RELEASED. SCHEDULED is optional: suppliers do collect without
// booking a slot in the portal.
const TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  GENERATED:         ['SIGNATURE_PENDING', 'CANCELLED'],
  SIGNATURE_PENDING: ['SIGNED', 'CANCELLED'],
  SIGNED:            ['READY_FOR_RELEASE', 'CANCELLED'],
  READY_FOR_RELEASE: ['SCHEDULED', 'RELEASED', 'SIGNED', 'CANCELLED'],
  SCHEDULED:         ['RELEASED', 'SIGNED', 'CANCELLED'],
  RELEASED:          [],
  CANCELLED:         [],
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

// Order matters: ALREADY_RELEASED is reported before missing fields, because a
// released check is a terminal fact and telling the user to fill in a field
// would send them down a dead end.
export function checkReadyForRelease(input: ReadyGuardInput): GuardResult {
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
