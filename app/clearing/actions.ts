'use server'

import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { recordClearing } from '@/lib/domain/actions'
import { parseClearingPaste, MAX_CLEARING_LINES, type PastedLine, type PasteError } from '@/lib/clearing-paste'
import { previewClearing, type PreviewRow } from '@/lib/clearing-preview'
import { runEach, type BulkActionResult } from '@/lib/bulk-run'

/**
 * Bulk mark-cleared from pasted statement lines. Any Finance user.
 *
 * PREVIEW reads; CONFIRM re-runs the same preview and writes only the lines
 * that would clear — through `recordClearing`, one transaction per cheque,
 * so every clearing carries its audit row and the domain's own guards.
 * Re-running the preview at confirm time rather than trusting ids from the
 * form is deliberate: a server action is an HTTP endpoint, and the only
 * input it takes is the text.
 */

export type ClearingPreviewResult =
  | { ok: true; rows: PreviewRow[]; errors: PasteError[] }
  | { ok: false; message: string }

type Parsed = { ok: true; lines: PastedLine[]; errors: PasteError[] } | { ok: false; message: string }

function parse(formData: FormData): Parsed {
  const text = String(formData.get('lines') ?? '')
  const { lines, errors } = parseClearingPaste(text)
  const total = lines.length + errors.length
  if (total === 0) return { ok: false, message: 'Paste at least one cheque number, one per line.' }
  if (total > MAX_CLEARING_LINES) {
    return {
      ok: false,
      message: `Up to ${MAX_CLEARING_LINES} lines at a time; ${total} were pasted. Split the list and try again.`,
    }
  }
  return { ok: true, lines, errors }
}

export async function previewClearingAction(formData: FormData): Promise<ClearingPreviewResult> {
  await requireUser()
  const parsed = parse(formData)
  if (!parsed.ok) return parsed
  const rows = await previewClearing(prisma, parsed.lines)
  return { ok: true, rows, errors: parsed.errors }
}

export async function confirmClearingAction(formData: FormData): Promise<BulkActionResult> {
  const user = await requireUser()
  const parsed = parse(formData)
  if (!parsed.ok) return parsed
  const rows = await previewClearing(prisma, parsed.lines)
  const willClear = rows.filter((r) => r.verdict === 'WILL_CLEAR' && r.checkId !== null)
  if (willClear.length === 0) {
    return { ok: false, message: 'None of these lines names a released cheque that is not yet cleared.' }
  }
  const byId = new Map(willClear.map((r) => [r.checkId as string, r]))
  const now = new Date()
  return runEach(prisma, [...byId.keys()], (checkId) => {
    const r = byId.get(checkId)!
    return recordClearing(prisma, {
      checkId, userId: user.id, clearingStatus: 'CLEARED',
      crNumber: r.crNumber ?? undefined, clearedDate: r.clearedDate ?? undefined, now,
    })
  })
}
