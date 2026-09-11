import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions } from '@/lib/queries'
import { listForecastRows } from '@/lib/forecast/query'
import { buildMatrices } from '@/lib/forecast/matrix'
import { parseStageParam, describeForecastFilters, forecastFilename } from '@/lib/forecast-view'
import { buildForecastWorkbook } from '@/lib/export/forecast-workbook'
import { EXPORT_ROW_LIMIT } from '@/lib/export/report'

/**
 * EXPORT THE FORECAST. The file is the view: the same filters as the page,
 * written into the title block.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` runs on Vercel and not locally, and this route is on neither
 * side's public list — it authenticates itself on its first line regardless,
 * because a route that leans on middleware is protected in one environment and
 * not the other. 401, not a redirect: a download that redirects arrives as a
 * login page saved under an .xlsx name.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const params = new URL(request.url).searchParams
  const options = await getFilterOptions(prisma)
  const bank = params.get('bank')?.trim() || undefined
  const companyParam = params.get('company')?.trim() || undefined
  // Validated against the companies that exist, as the dashboard does; an
  // unknown id is ignored rather than passed to the query.
  const company = options.companies.find((c) => c.id === companyParam)
  const stage = parseStageParam(params.get('stage') ?? undefined)

  const now = new Date()
  const [rows, incompleteCount] = await Promise.all([
    listForecastRows(prisma, { bankCode: bank, companyId: company?.id, stage }),
    prisma.check.count({ where: { isIncomplete: true } }),
  ])
  const { byBank, byStage, bucketed } = buildMatrices(rows, now)

  const workbook = await buildForecastWorkbook({
    byBank, byStage,
    // Capped after bucketing, so the matrices are struck over every cheque
    // and only the DETAIL listing is cut — and the title block says so.
    detail: bucketed.slice(0, EXPORT_ROW_LIMIT),
    meta: {
      generatedAt: now,
      generatedBy: user.name,
      filterDescription: describeForecastFilters({ bank, company: company?.code, stage }),
      totalRows: bucketed.length,
      incompleteCount,
    },
  })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${forecastFilename(now)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
