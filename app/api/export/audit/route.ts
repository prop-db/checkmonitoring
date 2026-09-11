import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { EXPORT_ROW_LIMIT } from '@/lib/export/report'
import { listAuditRows, countAuditRows, listAuditUsers, type AuditRow } from '@/lib/audit-query'
import { parseAuditParams, describeAuditFilters, auditFilename } from '@/lib/audit-view'
import { buildAuditWorkbook } from '@/lib/export/audit-workbook'

/**
 * EXPORT THE AUDIT TRAIL — the filtered range the admin is looking at.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────
 * `middleware.ts` runs on Vercel and not locally; this route leans on neither.
 * It authenticates on its first line, and — because the page it mirrors is
 * admin-only — refuses a FINANCE_USER as well. 401, not a redirect: a
 * download that redirects arrives as a login page saved under an .xlsx name.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const refuse = () => new Response('UNAUTHORISED', {
  status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
})

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user || user.role !== 'FINANCE_ADMIN') return refuse()

  const params = new URL(request.url).searchParams
  const read = (k: string) => params.get(k) ?? undefined
  const { filters } = parseAuditParams({
    system: read('system'), action: read('action'), user: read('user'), check: read('check'), from: read('from'), to: read('to'),
  })

  // Newest first, page by page through the same keyset the screen uses, up to
  // the cap. The cap is stated in the title block, as every export states it.
  const rows: AuditRow[] = []
  let cursor = null as { createdAt: Date; id: string } | null
  while (rows.length < EXPORT_ROW_LIMIT) {
    const page = await listAuditRows(prisma, filters, cursor)
    rows.push(...page.rows)
    if (!page.hasMore) break
    const last = page.rows[page.rows.length - 1]
    cursor = { createdAt: last.createdAt, id: last.id }
  }
  const [total, users] = await Promise.all([countAuditRows(prisma, filters), listAuditUsers(prisma)])
  const now = new Date()

  const workbook = await buildAuditWorkbook({
    rows: rows.slice(0, EXPORT_ROW_LIMIT),
    meta: {
      generatedAt: now, generatedBy: user.name, totalRows: total,
      filterDescription: describeAuditFilters(filters, { user: users.find((u) => u.id === filters.userId)?.name }),
    },
  })
  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${auditFilename(now)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
