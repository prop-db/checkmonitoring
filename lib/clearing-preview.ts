import type { PrismaClient } from '@prisma/client'
import type { PastedLine } from '@/lib/clearing-paste'

/**
 * What CONFIRM would do to each pasted line, decided before anything is
 * written and shown to the person who pasted it.
 *
 * Every verdict is a fact about the cheque as it stands. An AMBIGUOUS number
 * — two companies sharing it, which the (company, number) key permits — is
 * refused and named, never resolved by picking: the bank statement says which
 * account it came from, and this screen does not know that yet. `payeeName`
 * is carried so the preview can be read back against the statement; no
 * amount is, so no Decimal crosses to the client.
 */
export type PreviewVerdict = 'WILL_CLEAR' | 'ALREADY_CLEARED' | 'NOT_RELEASED' | 'UNKNOWN' | 'AMBIGUOUS'

export type PreviewRow = {
  line: number
  checkNumber: string
  clearedDate: Date | null
  crNumber: string | null
  verdict: PreviewVerdict
  checkId: string | null
  companyCode: string | null
  payeeName: string | null
  /** The status, the companies, or ''. Read beside the verdict. */
  detail: string
}

export async function previewClearing(db: PrismaClient, lines: PastedLine[]): Promise<PreviewRow[]> {
  const found = await db.check.findMany({
    where: { checkNumber: { in: lines.map((l) => l.checkNumber) } },
    select: {
      id: true, checkNumber: true, status: true, clearingStatus: true, payeeName: true,
      company: { select: { code: true } },
    },
  })
  const byNumber = new Map<string, typeof found>()
  for (const c of found) byNumber.set(c.checkNumber, [...(byNumber.get(c.checkNumber) ?? []), c])

  return lines.map((l) => {
    const matches = byNumber.get(l.checkNumber) ?? []
    const base = { line: l.line, checkNumber: l.checkNumber, clearedDate: l.clearedDate, crNumber: l.crNumber }
    if (matches.length === 0) {
      return { ...base, verdict: 'UNKNOWN' as const, checkId: null, companyCode: null, payeeName: null, detail: '' }
    }
    if (matches.length > 1) {
      return {
        ...base, verdict: 'AMBIGUOUS' as const, checkId: null, companyCode: null, payeeName: null,
        detail: matches.map((m) => m.company.code).sort().join(' / '),
      }
    }
    const [c] = matches
    const rest = { checkId: c.id, companyCode: c.company.code, payeeName: c.payeeName }
    if (c.clearingStatus === 'CLEARED') return { ...base, ...rest, verdict: 'ALREADY_CLEARED' as const, detail: '' }
    if (c.status !== 'RELEASED') return { ...base, ...rest, verdict: 'NOT_RELEASED' as const, detail: c.status }
    return { ...base, ...rest, verdict: 'WILL_CLEAR' as const, detail: '' }
  })
}
