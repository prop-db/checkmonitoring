import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { listVoucherCandidates } from '@/lib/export/voucher-query'
import { resolveVoucherRows, VOUCHER_INDEX_ROW_LIMIT, VOUCHER_INDEX_FILENAME } from '@/lib/export/voucher-index'
import { buildVoucherIndexWorkbook } from '@/lib/export/voucher-workbook'

/**
 * THE VOUCHER INDEX — `CHECK BY VOUCHER.xlsx`.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` DOES NOT RUN in this project. Node-runtime middleware is
 * unsupported in Next 15.5.25 and the file is silently never registered. Pages
 * are protected because each one calls `requireUser()` itself; a route handler
 * has NOTHING in front of it, so this one authenticates on its first line,
 * before it reads anything at all.
 *
 * A 401, not a redirect: this is fetched as a download, and a 307 to /login
 * arrives as an HTML login page saved under an .xlsx filename — which, given
 * the filename is fixed and an Excel formula points at it, would be a login
 * page silently answering every VLOOKUP in the Executive Report.
 *
 * FINANCE_USER, not admin. This is a routine file somebody produces whenever
 * the Executive Report is refreshed, and there is currently one active
 * FINANCE_ADMIN — gating it would mean one forgotten password stops the
 * month-end pack. It discloses less than /api/export: no amounts.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ExcelJS is Node-only. Honoured here, unlike in middleware.
export const runtime = 'nodejs'
// Derived from a session and from live financial data.
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(_request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const candidates = await listVoucherCandidates(prisma)
  const resolved = resolveVoucherRows(candidates)

  // Capped after resolving, not before: the cap is about how large a file can be
  // assembled in a serverless function, and a voucher's answer depends on every
  // cheque that names it. Slicing the candidates would silently turn a re-issue
  // into a contested row.
  const rows = resolved.slice(0, VOUCHER_INDEX_ROW_LIMIT)

  const workbook = await buildVoucherIndexWorkbook({
    rows,
    meta: {
      generatedAt: new Date(),
      generatedBy: user.name,
      totalRows: resolved.length,
    },
  })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      // FIXED. The Executive Report stores this name inside an external
      // reference; a dated filename would break the link on every regeneration.
      'content-disposition': `attachment; filename="${VOUCHER_INDEX_FILENAME}"`,
      // No `content-length` — the runtime sets it from the body it actually sends.
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
