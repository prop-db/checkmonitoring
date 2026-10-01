import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getFilterOptions, listChecks, countChecks, toTableRow, getSummary } from '@/lib/queries'
import { resolveDashboardQuery, type DashboardSearchParams } from '@/lib/dashboard-params'
import { buildExportWorkbook, exportColumnOrder } from '@/lib/export/workbook'
import { SORT_COOKIE, readCookie } from '@/lib/list-sort'
import { describeRefusal } from '@/lib/column-filters'
import { exportFilename } from '@/lib/export/report'
import { loadSettings } from '@/lib/settings/read'

/**
 * EXPORT TO EXCEL.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * This endpoint returns every cheque the group has issued that the filters
 * admit: payee, amount, bank, cheque number, dates. It is the single largest
 * disclosure in the system.
 *
 * `middleware.ts` DOES NOT RUN in this project. Node-runtime middleware is
 * unsupported in Next 15.5.25 and the file is silently never registered — the
 * middleware manifest is empty after a clean build. Pages are protected because
 * each one calls `requireUser()` itself. A route handler has NOTHING in front
 * of it, so this one authenticates itself, on its first line, before it reads
 * anything at all. `tests/export/route.test.ts` asserts that an unauthenticated
 * request never so much as touches the database.
 *
 * A 401, not a redirect: this is fetched as a download, and a 307 to /login
 * would arrive as an HTML login page saved under an .xlsx filename.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The file holds EXACTLY the view the reader is looking at. The URL carries the
 * same parameters the dashboard does and is resolved by `resolveDashboardQuery`
 * — the very function `app/page.tsx` calls — so there is one filtering path,
 * not two that agree today.
 */

// ExcelJS is Node-only. Explicit rather than relied upon: unlike in middleware,
// where this export is silently ignored, a route handler honours it.
export const runtime = 'nodejs'
// Never cached, never prerendered. The response is derived from a session and
// from live financial data.
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
  // The remembered order (part C4) arrives as a cookie on the download
  // request — same origin, SameSite=Lax — so the file is ordered as the
  // screen was even when the URL names no sort.
  const sortCookie = readCookie(request.headers.get('cookie'), SORT_COOKIE)

  // Loaded before the filters are resolved because the company and cash-account
  // ids are validated against the rows the dashboard's dropdowns actually
  // offer — the same list, so the two cannot disagree about what is selectable.
  const [options, settings] = await Promise.all([getFilterOptions(prisma), loadSettings(prisma)])

  // Every parameter the dashboard reads, through the dashboard's own resolver.
  // An unknown one is simply never read.
  // A cast, not a conversion: every value is a string, which is all the type claims.
  // The FIRST value of a repeated key, as the dashboard page reads it —
  // `Object.fromEntries` would keep the last, and the file would not be the view.
  const firstValues: Record<string, string> = {}
  for (const [k, v] of params.entries()) if (!(k in firstValues)) firstValues[k] = v
  const query = resolveDashboardQuery(firstValues as DashboardSearchParams, options, { sortCookie })

  // A box the screen refused is refused here too — never a file of everything,
  // and never an empty workbook, which would read as "nothing matches". Answered
  // before anything is listed or built, so no title can name the refused value.
  if (query.refused) {
    return new Response(describeRefusal(query.filterErrors), {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const [rows, matching, summary] = await Promise.all([
    /**
     * Capped, deliberately — see EXPORT_ROW_LIMIT. The whole workbook is
     * assembled in memory in a serverless function and the table holds 21,817
     * rows, so an uncapped export is a request that can exhaust the function
     * rather than a slow one. `matching` is read alongside and written into the
     * sheet's title block, so a capped file always states what it left out.
     */
    listChecks(prisma, query.filters, settings.values['caps.exportRows'], query.sort),
    countChecks(prisma, query.filters),
    // No filters, exactly as the dashboard's summary cards are counted: a total
    // that quietly reported the filtered subset would read as the whole. The
    // SUMMARY sheet says outright that this is what it is.
    getSummary(prisma),
  ])

  const generatedAt = new Date()
  const workbook = await buildExportWorkbook({
    // Mapped through `toTableRow`, the same narrowing the dashboard table uses:
    // a whole `Check` carries cancellation reasons, portal sync state and the
    // source sheet and row, none of which belong in a file that leaves the
    // building. It is also what turns a `Prisma.Decimal` into a decimal string.
    rows: rows.map(toTableRow),
    summary,
    meta: {
      viewLabel: query.viewLabel,
      filterDescription: query.filterDescription,
      generatedAt,
      generatedBy: user.name,
      totalMatching: matching,
    },
    // The viewer's on-screen order (added by ExportLink at click time). It
    // reorders the file's columns and never removes one.
    columns: exportColumnOrder(params.get('cols')),
  })

  const filename = exportFilename(query.viewLabel, generatedAt)

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${filename}"`,
      // No `content-length`. The runtime sets it from the body it actually
      // sends; a hand-written one is wrong the moment anything in front of this
      // handler compresses the response, and a wrong length is a truncated
      // download rather than a slow one.
      //
      // A register of real cheques must not be left in a shared proxy or in the
      // browser's back/forward cache on a machine several people in Finance use.
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
