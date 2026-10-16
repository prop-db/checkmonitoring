import { Prisma } from '@prisma/client'

/**
 * ACUMATICA WINS OVER THE REGISTER (spec 2026-10-16-acumatica-wins-design.md).
 *
 * On a check Acumatica holds, a register row may not change what the ERP owns
 * (`ACUMATICA_OWNED` in ./upsert.ts). This module only answers "what did the
 * register offer that differs from what is stored", so the disagreement is
 * recorded rather than silently dropped. Pure: values in, differences out.
 *
 * Measured 2026-09-10: of 94 amounts the register changed, the register was
 * wrong in every one. So a difference here is evidence about the register, not
 * a question to put to anybody.
 */

/** The comparable state of a check, from either side. Codes, not ids, so the audit row reads. */
export type HeldValues = {
  amount: string | null
  checkDate: Date | null
  payeeName: string | null
  currency: string | null
  cvNumber: string | null
  isCheque: boolean
  companyCode: string | null
  cashAccountCode: string | null
  checkBookCode: string | null
}

type RefusedField =
  | 'amount' | 'checkDate' | 'payeeName' | 'currency' | 'cvNumber' | 'isCheque'
  | 'companyId' | 'cashAccountId' | 'checkBookId'

export type Refused = Partial<Record<RefusedField, { kept: string | null; offered: string }>>

const day = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 10))

function sameAmount(kept: string | null, offered: string): boolean {
  // Decimal, never a JS number (rule 8): '100.5' and '100.50' are one amount.
  return kept !== null && new Prisma.Decimal(kept).equals(new Prisma.Decimal(offered))
}

/**
 * Every field where the register OFFERS a value that differs from the stored
 * one. An offered null is the register not stating it, never a disagreement.
 */
export function refusedRegisterValues(kept: HeldValues, offered: HeldValues): Refused {
  const out: Refused = {}
  const text = (field: RefusedField, k: string | null, o: string | null) => {
    if (o !== null && k !== o) out[field] = { kept: k, offered: o }
  }
  if (offered.amount !== null && !sameAmount(kept.amount, offered.amount)) {
    out.amount = { kept: kept.amount === null ? null : new Prisma.Decimal(kept.amount).toString(), offered: offered.amount }
  }
  text('checkDate', day(kept.checkDate), day(offered.checkDate))
  text('payeeName', kept.payeeName, offered.payeeName)
  text('currency', kept.currency, offered.currency)
  text('cvNumber', kept.cvNumber, offered.cvNumber)
  text('isCheque', String(kept.isCheque), String(offered.isCheque))
  text('companyId', kept.companyCode, offered.companyCode)
  text('cashAccountId', kept.cashAccountCode, offered.cashAccountCode)
  text('checkBookId', kept.checkBookCode, offered.checkBookCode)
  return out
}
