import type { CheckStatus } from '@prisma/client'
import { canonicalCheckNumber } from '@/lib/import/normalise'

/**
 * Which cheque pays an AP voucher, read from Acumatica.
 *
 * WHY. `Check.apvNumbers` was filled from the register, retired 2026-09-10, and
 * the payments inquiry the sync reads (`AP-Checks and Payments`) publishes no
 * bill reference — so a cheque generated since then carries no voucher here and
 * a for-release list naming its voucher resolves to nothing. Measured
 * 2026-09-25: all 90 LOCAL vouchers of `FOR RELEASE 9.25.2026.xlsx` that "named
 * no cheque" were paid by a cheque this system already held at SIGNED.
 * `AP-PAYMENTS-WITH-BILLS` is the inquiry that joins a payment to the bills it
 * settles; its bill column is `AdjdRefNbr` in Go-Live and `ReferenceNbr_2` in
 * MANUFACTURING, which rejects a filter on the Go-Live name with a 500.
 *
 * EXACTLY ONE LIVE CHEQUE, or nothing: the rule `release-list.ts` and `bills.ts`
 * hold. An application from a voided cheque (`VCK`, or a cheque this system or
 * Acumatica holds as voided) and a non-cheque application (`ADR`, a debit
 * adjustment) are evidence of history, not of the cheque that pays it now.
 */

export const PAYMENTS_WITH_BILLS_FEED = 'AP-PAYMENTS-WITH-BILLS'

/** Per tenant: the column holding the bill (adjusted) reference. */
export const BILL_COLUMN = { GOLIVE: 'AdjdRefNbr', MANUFACTURING: 'ReferenceNbr_2' } as const

export type Application = { payType: unknown; paymentRef: unknown }

export type AppCheque = {
  id: string
  checkNumber: string
  status: CheckStatus
  acumaticaStatus: string | null
  isCheque: boolean
}

export type LinkVerdict =
  | { kind: 'LINK'; check: AppCheque }
  | { kind: 'NO_APPLICATION' }
  | { kind: 'NO_LIVE_CHEQUE_HERE' }
  | { kind: 'AMBIGUOUS'; checkNumbers: string[] }

const DEAD: readonly CheckStatus[] = ['CANCELLED', 'VOIDED']

/**
 * Pure. `applications` are the voucher's rows from the inquiry (both tenants);
 * `byNumber` is every cheque this system holds under each canonical number.
 */
export function judgeLink(applications: readonly Application[], byNumber: ReadonlyMap<string, readonly AppCheque[]>): LinkVerdict {
  if (applications.length === 0) return { kind: 'NO_APPLICATION' }
  const live = new Map<string, AppCheque>()
  for (const a of applications) {
    if (a.payType !== 'CHK') continue
    const n = canonicalCheckNumber(typeof a.paymentRef === 'string' ? a.paymentRef : null)
    if (!n) continue
    const held = (byNumber.get(n) ?? []).filter((c) => !DEAD.includes(c.status) && c.acumaticaStatus !== 'Voided' && c.isCheque)
    // A number held twice here is not "one cheque"; refuse it rather than pick.
    if (held.length > 1) return { kind: 'AMBIGUOUS', checkNumbers: held.map((c) => c.checkNumber) }
    if (held.length === 1) live.set(held[0].id, held[0])
  }
  if (live.size === 0) return { kind: 'NO_LIVE_CHEQUE_HERE' }
  if (live.size > 1) return { kind: 'AMBIGUOUS', checkNumbers: [...live.values()].map((c) => c.checkNumber) }
  return { kind: 'LINK', check: [...live.values()][0] }
}
