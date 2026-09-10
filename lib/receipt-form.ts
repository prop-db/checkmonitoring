import { z } from 'zod'
import { RECEIPT_TYPES, type ReceiptType } from '@/lib/domain/receipt'

/**
 * The OR/CR box, off the wire.
 *
 * Shared by the single release form, the tick-box release and the add-it-later
 * receipt page, and it lives here rather than in `app/checks/actions.ts`
 * because a `'use server'` module may only export async functions — a helper
 * exported from one would become a server action of its own.
 *
 * **An empty toggle is `null`, never OR.** "Nobody chose" is a state the domain
 * has to see, because `checkReceipt` refuses a reference with no type. A
 * default here would answer the question on the user's behalf at the one point
 * where the whole feature depends on it having been asked.
 *
 * **Anything that is not OR or CR is rejected, not coerced.** A server action is
 * an HTTP endpoint and this field arrives from a form nobody has to use; the
 * same treatment `clearingAction` gives a bogus clearing status.
 */
const receiptTypeSchema = z.enum(RECEIPT_TYPES)

export type ReceiptFormFields = {
  orNumber: string | undefined
  orDate: Date | undefined
  receiptType: ReceiptType | null
}

export type ReceiptFormResult =
  | ({ ok: true } & ReceiptFormFields)
  | { ok: false; message: string }

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim()

const date = (f: FormData, k: string) => {
  const v = str(f, k)
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export function readReceiptFields(formData: FormData): ReceiptFormResult {
  const raw = str(formData, 'receiptType')
  let receiptType: ReceiptType | null = null
  if (raw !== '') {
    const parsed = receiptTypeSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid receipt type.' }
    receiptType = parsed.data
  }
  return {
    ok: true,
    orNumber: str(formData, 'orNumber') || undefined,
    orDate: date(formData, 'orDate'),
    receiptType,
  }
}

/** True when the user typed anything into the receipt box at all. */
export function receiptWasTyped(fields: ReceiptFormFields): boolean {
  return fields.orNumber !== undefined || fields.orDate !== undefined || fields.receiptType !== null
}
