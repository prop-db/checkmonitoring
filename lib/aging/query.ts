import { listChecks, toTableRow, displayApvNumbers } from '@/lib/queries'
import { compareCheckNumbers } from '@/lib/transmittal'
import { ageCheck, type AgingBucket, type BillTerms } from '@/lib/aging/buckets'

type Db = Parameters<typeof listChecks>[0]

/** Above this the page says it is short. SIGNED is ~1,400 (measured 2026-10). */
export const AGING_LIMIT = 25_000

export type AgingRow = {
  id: string
  checkNumber: string
  cvNumber: string | null
  apvNumbers: string[]
  poNumbers: string[]
  payee: string | null
  company: string
  /** The check book, else the register label (`accountWhere`'s rule). */
  bank: string | null
  checkDate: string | null
  dueDate: string | null
  daysPastDue: number | null
  bucket: AgingBucket
  /** Decimal string, rule 8. */
  amount: string | null
  currency: string
}

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/**
 * THE POPULATION (spec 2026-10-15): SIGNED, a real check, an amount — the only
 * checks that may move to READY FOR RELEASE. Each is aged by its bills: per
 * APV, Acumatica's due date and terms (`AcumaticaBillTerms`), and only when
 * Acumatica states no date, the approval workbook's (`CheckBill`).
 */
export async function loadAgingRows(db: Db, now: Date): Promise<{ rows: AgingRow[]; truncated: boolean }> {
  const checks = (await listChecks(
    db, { statusIn: ['SIGNED'], incomplete: false }, AGING_LIMIT, { key: 'checkNumber', dir: 'asc' },
  )).filter((c) => c.isCheque)

  const apvs = [...new Set(checks.flatMap((c) => displayApvNumbers(c)))]
  const terms = apvs.length === 0 ? [] : await db.acumaticaBillTerms.findMany({
    where: { apvNumber: { in: apvs } },
    select: { apvNumber: true, dueDate: true, termsCode: true },
  })
  const byApv = new Map(terms.map((t) => [t.apvNumber, t]))

  const rows = checks.map((c): AgingRow => {
    const table = toTableRow(c)
    const bills: BillTerms[] = table.apvNumbers.map((apv) => {
      const acu = byApv.get(apv)
      const local = c.bills.find((b) => b.apvNumber === apv)
      return acu?.dueDate
        ? { dueDate: acu.dueDate, termsCode: acu.termsCode }
        : { dueDate: local?.dueDate ?? null, termsCode: acu?.termsCode ?? local?.termsCode ?? null }
    })
    const aging = ageCheck(bills, now)
    return {
      id: c.id,
      checkNumber: c.checkNumber,
      cvNumber: c.cvNumber,
      apvNumbers: table.apvNumbers,
      poNumbers: table.poNumbers,
      payee: table.payeeName,
      company: table.companyCode,
      bank: table.cashAccountCode,
      checkDate: ymd(table.checkDate),
      dueDate: ymd(aging.dueDate),
      daysPastDue: aging.daysPastDue,
      bucket: aging.bucket,
      amount: table.amount,
      currency: table.currency,
    }
  })
  rows.sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber))
  return { rows, truncated: checks.length >= AGING_LIMIT }
}
