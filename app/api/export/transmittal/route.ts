import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { listChecksByIds, toTableRow } from '@/lib/queries'
import { compareCheckNumbers } from '@/lib/transmittal'
import { buildTransmittalWorkbook } from '@/lib/export/transmittal-workbook'

/**
 * EXPORT THE TRANSMITTAL. A POST from the page's form: the ticked ids and the
 * typed names ride in the body, because a picked set of a thousand cheques does
 * not fit a URL. The rows are re-read here by id and re-checked — still
 * SIGNATURE PENDING or SIGNED, still a cheque, still with an amount — so the
 * file can never hold more than the page's list could. Authenticates on its
 * first line (401, not a redirect), like every export route; read-only.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_IDS = 5_000
const text = (v: FormDataEntryValue | null, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export async function POST(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
  }

  const form = await request.formData()
  const ids = [...new Set(text(form.get('ids'), 500_000).split(',').filter(Boolean))].slice(0, MAX_IDS)
  if (ids.length === 0) return new Response('NO CHECKS SELECTED', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } })

  const rows = (await listChecksByIds(prisma, ids))
    .filter((r) => (r.status === 'SIGNATURE_PENDING' || r.status === 'SIGNED') && r.isCheque && r.amount !== null)
    .map(toTableRow)
    .sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber))

  const date = /^\d{4}-\d{2}-\d{2}$/.test(text(form.get('date'))) ? text(form.get('date')) : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
  const workbook = await buildTransmittalWorkbook({
    lines: rows.map((r) => ({
      checkNumber: r.checkNumber,
      cashAccount: r.cashAccountCode ?? '',
      poNumber: r.poNumbers.join(', '),
      voucher: r.apvNumbers.join(', '),
      payee: r.payeeName ?? '',
      amount: r.amount,
      currency: r.currency,
    })),
    meta: {
      to: text(form.get('to')), date,
      preparedBy: text(form.get('preparedBy')), checkedBy: text(form.get('checkedBy')), approvedBy: text(form.get('approvedBy')),
    },
  })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="CHECKS TRANSMITTAL ${date}.xlsx"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
