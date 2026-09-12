import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { listBankCodes } from '@/lib/forecast/query'
import { listOutstandingCandidates, countExcludedIncomplete } from '@/lib/recon/query'
import { summariseByAccount } from '@/lib/recon/summary'
import { parseAsOf, describeReconFilters, reconFilename } from '@/lib/recon-view'
import { buildReconWorkbook } from '@/lib/export/recon-workbook'
import { loadSettings } from '@/lib/settings/read'

/**
 * EXPORT THE OUTSTANDING CHEQUES. The file is the view: the as-of day and the
 * filters are in the title block. Authenticates on its first line — 401, not a
 * redirect — as every export route does; never on the public list.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
  }

  const params = new URL(request.url).searchParams
  const now = new Date()
  const asOfDay = parseAsOf(params.get('asOf') ?? undefined, now)
  const [options, banks, settings] = await Promise.all([getFilterOptions(prisma), listBankCodes(prisma), loadSettings(prisma)])
  const bankParam = params.get('bank')?.trim() || undefined
  const bank = bankParam && banks.includes(bankParam) ? bankParam : undefined
  const company = options.companies.find((c) => c.id === (params.get('company')?.trim() || undefined))
  const account = options.cashAccounts.find((a) => a.id === (params.get('account')?.trim() || undefined))
  const filters = { bankCode: bank, companyId: company?.id, cashAccountId: account?.id }

  const [rows, incompleteCount] = await Promise.all([
    listOutstandingCandidates(prisma, filters),
    countExcludedIncomplete(prisma, filters),
  ])
  const summary = summariseByAccount(rows, asOfDay)

  const workbook = await buildReconWorkbook({
    summary,
    detail: summary.lines.slice(0, settings.values['caps.exportRows']),
    meta: {
      asOfDay, generatedAt: now, generatedBy: user.name,
      filterDescription: describeReconFilters({ bank, company: company?.code, account: account?.code }),
      totalRows: summary.lines.length, incompleteCount, notYetIssuedCount: summary.notYetIssued,
    },
  })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${reconFilename(asOfDay)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
