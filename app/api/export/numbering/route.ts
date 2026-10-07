// app/api/export/numbering/route.ts
import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { manilaDay } from '@/lib/forecast/buckets'
import { listNumberingAccounts, countChequesWithoutCheckBook, countRegisterOnlyCheques, listCheckBookOptions } from '@/lib/numbering/query'
import { isMissingOnly, describeNumberingFilters, numberingFilename } from '@/lib/numbering-view'
import { buildNumberingWorkbook } from '@/lib/export/numbering-workbook'
import { loadSettings } from '@/lib/settings/read'

/**
 * EXPORT THE CHEQUE NUMBERING. The file is the view: company, account and
 * MISSING ONLY are in the title block. Authenticates on its first line — 401,
 * not a redirect — as every export route does; never on the public list. The
 * `account` parameter names a cheque book; an id that names no cheque book is
 * a 404, never a widened file.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) return new Response('UNAUTHORISED', { status: 401, headers: TEXT })

  const params = new URL(request.url).searchParams
  const now = new Date()
  const [options, books, settings] = await Promise.all([getFilterOptions(prisma), listCheckBookOptions(prisma), loadSettings(prisma)])
  const company = options.companies.find((c) => c.id === (params.get('company')?.trim() || undefined))
  const accountParam = params.get('account')?.trim() || undefined
  const account = books.find((b) => b.id === accountParam)
  if (accountParam && !account) return new Response('UNKNOWN CHECK BOOK', { status: 404, headers: TEXT })
  const missingOnly = isMissingOnly(params.get('missing'))

  // With an account open the company filter is not applied, so it must not be described or counted either.
  const scopedCompany = account ? undefined : company
  const [accounts, noAccountCount, registerOnlyCount] = await Promise.all([
    listNumberingAccounts(prisma, { companyId: scopedCompany?.id, checkBookId: account?.id }),
    account ? Promise.resolve(null) : countChequesWithoutCheckBook(prisma, { companyId: scopedCompany?.id }),
    account ? Promise.resolve(null) : countRegisterOnlyCheques(prisma, { companyId: scopedCompany?.id }),
  ])

  const workbook = await buildNumberingWorkbook({
    accounts,
    meta: {
      generatedAt: now, generatedBy: user.name, missingOnly, noAccountCount, registerOnlyCount,
      filterDescription: describeNumberingFilters({ company: scopedCompany?.code, account: account?.code, missingOnly }),
      rowLimit: settings.values['caps.exportRows'],
    },
  })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${numberingFilename(manilaDay(now))}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
