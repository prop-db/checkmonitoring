'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { DomainError } from '@/lib/domain/errors'
import { isNextControlFlowError } from '@/lib/next-errors'
import {
  importBills, parseBillRows, previewBillImport, type BillImportSummary, type BillPreview,
} from '@/lib/import/bills'
import { detectWorkbook } from '@/lib/import/detect'
import { mapParsedRow } from '@/lib/import/map-row'
import { parseRows } from '@/lib/import/parse'
import { previewRegisterImport, type ImportPreview } from '@/lib/import/preview'
import { loadCompanyReferenceData, loadOwnCompanyNames } from '@/lib/import/reference'
import { importRows, type ImportSummary } from '@/lib/import/upsert'
import { readWorkbook } from '@/lib/import/workbook'
import { createClientForTenant } from '@/lib/integrations/acumatica/from-env'
import { lastSyncWatermark, runSync } from '@/lib/sync/run'
import { runScheduledBillsSync } from '@/lib/sync/bills'
import { runScheduledBillRefsSync } from '@/lib/sync/bill-refs'
import { loadSettings } from '@/lib/settings/read'

/**
 * The two Finance Admin actions.
 *
 * **Both refuse a FINANCE_USER by RETURNING a result, never by redirecting.**
 * `requireAdmin` redirects, and Next implements a redirect by throwing — which
 * the catch below would then have to re-throw out of a form submission that had
 * already been accepted. `revertAction` established the pattern for exactly
 * this reason and these follow it: `requireUser()` first, outside any try, then
 * an explicit role test that returns.
 */

const ADMIN_ONLY_SYNC = 'Only a Finance Admin can run a sync.'
const ADMIN_ONLY_IMPORT = 'Only a Finance Admin can import a workbook.'

export type AdminActionResult = { ok: true } | { ok: false; message: string }

const tenantSchema = z.enum(['GOLIVE', 'MANUFACTURING'])

export type SyncNowResult =
  | {
      ok: true
      tenant: 'GOLIVE' | 'MANUFACTURING'
      mode: string
      fetched: number
      imported: number
      updated: number
      staged: number
      skipped: number
      collapsed: number
      promoted: number
      errors: number
    }
  | { ok: false; message: string }

export type ImportWorkbookResult =
  | { ok: true; kind: 'REGISTER'; stage: 'PREVIEW'; fileName: string; preview: ImportPreview }
  | {
      ok: true; kind: 'REGISTER'; stage: 'IMPORTED'; fileName: string
      preview: ImportPreview; summary: ImportSummary
    }
  | { ok: true; kind: 'BILLS'; stage: 'PREVIEW'; fileName: string; preview: BillPreview }
  | {
      ok: true; kind: 'BILLS'; stage: 'IMPORTED'; fileName: string
      preview: BillPreview; summary: BillImportSummary
    }
  | { ok: false; message: string }

/**
 * The register is about 2 MB and the approval list a few dozen kilobytes. The
 * cap is not a policy about what Finance may upload; it is a refusal to buffer
 * an arbitrarily large file into memory in a request handler.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

// Domain errors carry copy written for a Finance user. Anything else is a bug
// or an integration failure, and its text may name a URL or a setting — so it
// goes to the server log and the user gets a fixed sentence. Not paranoia: an
// OData failure's message routinely carries the request URL.
function failure(e: unknown, message: string): { ok: false; message: string } {
  if (e instanceof DomainError) return { ok: false, message: e.message }
  console.error(e)
  return { ok: false, message }
}

export async function syncNowAction(formData: FormData): Promise<SyncNowResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY_SYNC }

  // Stated, never inferred and never defaulted: Go-Live `ST` is Starkson
  // Packaging and MANUFACTURING `ST` is Starkson Paper and Plastic, so a run
  // that guessed would file cheques under the wrong legal entity while looking
  // perfectly healthy.
  const tenant = tenantSchema.safeParse(String(formData.get('tenant') ?? ''))
  if (!tenant.success) {
    return { ok: false, message: 'Choose which Acumatica tenant to read: Go-Live or Manufacturing.' }
  }

  try {
    const settings = await loadSettings(prisma)
    const since = await lastSyncWatermark(prisma, tenant.data)
    const result = await runSync(prisma, {
      client: createClientForTenant(tenant.data),
      tenant: tenant.data,
      since,
      now: new Date(),
      trigger: 'MANUAL',
      inProgressMinutes: settings.values['sync.inProgressMinutes'],
    })
    // The payment read brings in the cheque; the vouchers it pays and the PO each
    // bill names arrive by their own reads, which only the cron used to run. A
    // cheque first read by SYNC NOW therefore sat with no APV and no PO NUMBER
    // until the next cron (CV-HF000157..160, 2026-10-06). Run both now, as the
    // cron does after a payment read that RAN. Neither throws; neither touches
    // status. They are recorded as SCHEDULED runs (the only trigger they write).
    const readOnly = { tenant: tenant.data, now: new Date(), client: () => createClientForTenant(tenant.data) }
    await runScheduledBillsSync(prisma, readOnly)
    await runScheduledBillRefsSync(prisma, readOnly)
    revalidatePath('/admin/sync')
    revalidatePath('/')
    return {
      ok: true,
      tenant: result.tenant,
      mode: result.mode,
      fetched: result.fetched,
      imported: result.imported,
      updated: result.updated,
      staged: result.staged,
      skipped: result.skipped,
      collapsed: result.collapsed,
      promoted: result.promoted,
      errors: result.errors,
    }
  } catch (e) {
    if (isNextControlFlowError(e)) throw e
    // `runSync` has already written the failure onto the `SyncRun` row with its
    // own truncated message, so nothing is lost by not repeating it here.
    return failure(e, 'The sync could not be completed. The run and its error are recorded in the sync log below.')
  }
}

/**
 * Upload → parse → preview → confirm → import, for either workbook.
 *
 * **The preview step is not optional.** Without `confirm`, this reads the file
 * and returns the accounting and the vendor merge list, having written nothing.
 * The spec requires the merge list be presented before it is applied, and the
 * import's own numbers require the same treatment: 22% of the register does not
 * import, and the only moment anybody can act on that is before it runs.
 *
 * The client re-sends the same file with `confirm` rather than the server
 * holding it between the two requests. Nothing is parked on disk, and a
 * confirmation can never apply to a file other than the one that was previewed.
 *
 * The one-time 12,227-row historical load belongs to
 * `scripts/import-workbook.ts`, not here: this writes rows one at a time inside
 * one request, and a request that times out half way through leaves a partial
 * import. Harmless — `importRows` is idempotent, so re-running finishes it —
 * but the CLI is the tool for that job and has a dry run.
 */
export async function importWorkbookAction(formData: FormData): Promise<ImportWorkbookResult> {
  const user = await requireUser()
  if (user.role !== 'FINANCE_ADMIN') return { ok: false, message: ADMIN_ONLY_IMPORT }

  const file = formData.get('workbook')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose a workbook to import.' }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: `That file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` }
  }
  const confirmed = String(formData.get('confirm') ?? '') === 'true'

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const rows = await readWorkbook(buffer)

    // Which workbook this is, from the file rather than from a dropdown. The
    // two have different grains and feed different tables; a register parsed as
    // bill detail imports nothing at all and says so in no way a user would
    // notice.
    const detected = detectWorkbook(rows)
    if (detected.kind === 'UNKNOWN') {
      return {
        ok: false,
        message: `This does not look like either workbook. ${detected.reason}`,
      }
    }

    const now = new Date()

    if (detected.kind === 'BILLS') {
      // `sheets` travels with them: which sheets were read, and which carried
      // no bill header and were skipped. The workbook's sheet names change
      // between exports, so this is the difference between "no bills" and "we
      // did not read the sheet the bills were on".
      const { bills, review, sheets } = parseBillRows(rows)
      const preview = await previewBillImport(prisma, { bills, review, sheets })
      if (!confirmed) {
        return { ok: true, kind: 'BILLS', stage: 'PREVIEW', fileName: file.name, preview }
      }
      // `review` travels with `bills` so the rows this file refuses are staged
      // rather than reported once into a response nobody keeps. Every row of
      // every sheet that was read is now either a `CheckBill` or a `StagedBill`.
      const summary = await importBills(prisma, { bills, review, sheets, now })
      revalidatePath('/')
      revalidatePath('/admin/import')
      return { ok: true, kind: 'BILLS', stage: 'IMPORTED', fileName: file.name, preview, summary }
    }

    const ref = await loadCompanyReferenceData(prisma)
    const { parsed, review } = parseRows(rows)
    const preview = previewRegisterImport({ parsed, review, ref, today: now })

    // Refuse rather than import 12,000 rows and stop on the first cheque nobody
    // has ruled on. `resolveImpliedStatus` throws on an unruled combination, by
    // design; the preview catches that so the operator sees the whole picture,
    // and this is where that picture becomes a decision.
    if (preview.unruledClashes.length > 0) {
      return {
        ok: false,
        message:
          `${preview.unruledClashes.length} cheque(s) appear on a combination of sheets Finance ` +
          'has not ruled on, so the import cannot choose a status for them. Preview the file to see which.',
      }
    }

    if (!confirmed) {
      return { ok: true, kind: 'REGISTER', stage: 'PREVIEW', fileName: file.name, preview }
    }

    const ownCompanyNames = await loadOwnCompanyNames(prisma)
    // The rows that could not be keyed travel with the rest, in the same order
    // the preview counted them. They are staged NO_CHECK_NUMBER, not dropped:
    // `rows === created + updated + staged` is what makes "nothing is silently
    // dropped" checkable rather than asserted.
    const normalised = [
      ...parsed.map((p) => mapParsedRow(p, ref)),
      ...review.map((r) => mapParsedRow(r.unkeyed, ref)),
    ]
    const summary = await importRows(prisma, { rows: normalised, ownCompanyNames, now })
    revalidatePath('/')
    revalidatePath('/admin/import')
    revalidatePath('/admin/staged')
    return { ok: true, kind: 'REGISTER', stage: 'IMPORTED', fileName: file.name, preview, summary }
  } catch (e) {
    if (isNextControlFlowError(e)) throw e
    return failure(e, 'The workbook could not be read. Check that it is the .xlsx file exported from Acumatica.')
  }
}
