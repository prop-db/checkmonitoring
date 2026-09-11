import type { PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { normaliseReceipt } from '@/lib/domain/receipt'

/**
 * 2,727 supplier receipts out of the bank's clearing column.
 *
 * WHAT WAS WRONG. The register's RELEASED sheets carry "CR 6336" in column 12,
 * headed REMARKS — the same column that holds DEPOSITED, dates and names. The
 * importer's sniffer classified any `CR <digits>` as the bank's CLEARING_REF on
 * the strength of two letters, and `upsertCheck` wrote it to `crNumber`. That
 * is rule 11's exact hazard at scale: to every report and reconciliation a
 * value in `crNumber` says the money cleared, and for 2,727 cheques it said so
 * about a piece of paper handed across a counter.
 *
 * THE RULING. Client, 2026-09-11: those numbers are the supplier's Collection
 * Receipt. So `receiptType = CR` here is set on a ruling about that column,
 * recorded on every row it touches — not parsed back out of the prefix, which
 * is the guess rule 11 forbids.
 *
 * WHAT THIS DOES. For every cheque whose `crNumber` is CR-shaped AND that has
 * no receipt AND no clearing of any kind: `orNumber = crNumber`,
 * `receiptType = CR`, `crNumber = null`, `orDate` left null (the register never
 * recorded one), one SYSTEM audit row. Anything failing a condition is counted
 * and left alone — a cheque with a real clearing recorded may hold a genuine
 * bank reference, and nobody here can tell which.
 *
 * Plan first, snapshot, then apply, and the apply re-checks each row inside its
 * own transaction so a row that changed in between is skipped, not clobbered.
 */

export const CR_RECEIPT = /^CR\s?\d+$/
export const RECEIPT_RECLASSIFIED_ACTION = 'receipt_reclassified_from_register'
export const RULING =
  "2026-09-11 client ruling: the CR numbers in the register's REMARKS column are the " +
  "supplier's Collection Receipts, not the bank's clearing reference."

/**
 * Prisma's interactive-transaction defaults (5s to run, 2s to acquire a
 * connection) killed the 9 September register load mid-run — see CLAUDE.md.
 * 2,727 small transactions to ap-southeast-1 will eventually meet one slow
 * round trip; this is the same override `lib/import/upsert.ts` carries. A
 * death mid-run is still safe to re-run: a repaired row loses its `crNumber`
 * and falls out of the next plan.
 */
const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const

export type RepairSkip = 'NOT_CR_SHAPED' | 'RECEIPT_ALREADY_RECORDED' | 'CLEARING_RECORDED'

export type RepairRow = {
  id: string
  checkNumber: string
  crNumber: string
  orNumber: string | null
  receiptType: string | null
  clearingStatus: string
  clearedDate: Date | null
  sourceSheet: string | null
  sourceRow: number | null
}

/** Pure. Why a row that carries a `crNumber` is, or is not, repaired. */
export function classifyRow(row: RepairRow): { repair: true } | { repair: false; reason: RepairSkip } {
  if (!CR_RECEIPT.test(row.crNumber.trim().toUpperCase())) return { repair: false, reason: 'NOT_CR_SHAPED' }
  if (row.orNumber !== null || row.receiptType !== null) return { repair: false, reason: 'RECEIPT_ALREADY_RECORDED' }
  if (row.clearingStatus !== 'NONE' || row.clearedDate !== null) return { repair: false, reason: 'CLEARING_RECORDED' }
  return { repair: true }
}

export type RepairPlan = {
  candidates: RepairRow[]
  skipped: Record<RepairSkip, number>
  /** Every cheque carrying any `crNumber` at all — the population classified. */
  withCrNumber: number
}

export async function planRepair(db: PrismaClient): Promise<RepairPlan> {
  const rows = await db.check.findMany({
    where: { crNumber: { not: null } },
    select: {
      id: true, checkNumber: true, crNumber: true, orNumber: true, receiptType: true,
      clearingStatus: true, clearedDate: true, sourceSheet: true, sourceRow: true,
    },
    orderBy: [{ sourceSheet: 'asc' }, { sourceRow: 'asc' }],
  })
  const plan: RepairPlan = {
    candidates: [],
    skipped: { NOT_CR_SHAPED: 0, RECEIPT_ALREADY_RECORDED: 0, CLEARING_RECORDED: 0 },
    withCrNumber: rows.length,
  }
  for (const r of rows) {
    // `crNumber: { not: null } ` above makes this a type narrowing, not a filter.
    if (r.crNumber === null) continue
    const row: RepairRow = { ...r, crNumber: r.crNumber }
    const verdict = classifyRow(row)
    if (verdict.repair) plan.candidates.push(row)
    else plan.skipped[verdict.reason]++
  }
  return plan
}

export type Snapshot = {
  takenAt: string
  ruling: string
  rows: {
    id: string; checkNumber: string; crNumber: string
    orNumber: string | null; receiptType: string | null; clearingStatus: string
  }[]
}

/** Every affected row as it stands before the write — CLAUDE.md item 7, built in. */
export function snapshotOf(plan: RepairPlan, takenAt: Date): Snapshot {
  return {
    takenAt: takenAt.toISOString(),
    ruling: RULING,
    rows: plan.candidates.map((c) => ({
      id: c.id, checkNumber: c.checkNumber, crNumber: c.crNumber,
      orNumber: c.orNumber, receiptType: c.receiptType, clearingStatus: c.clearingStatus,
    })),
  }
}

export async function applyRepair(
  db: PrismaClient, plan: RepairPlan,
): Promise<{ repaired: number; raced: number }> {
  let repaired = 0
  let raced = 0
  for (const c of plan.candidates) {
    // Exactly as the release form stores a receipt: trimmed, typed.
    const receipt = normaliseReceipt({ orNumber: c.crNumber, receiptType: 'CR' })
    await db.$transaction(async (tx) => {
      // The conditions re-asserted in the WHERE, so a row somebody touched
      // between plan and apply matches nothing and is left exactly as they
      // left it. `count` is the only honest signal of that.
      const { count } = await tx.check.updateMany({
        where: {
          id: c.id, crNumber: c.crNumber,
          orNumber: null, receiptType: null, clearingStatus: 'NONE', clearedDate: null,
        },
        data: {
          orNumber: receipt.orNumber,
          receiptType: receipt.receiptType,
          orDate: null,
          crNumber: null,
        },
      })
      if (count === 0) { raced++; return }
      await writeAudit(tx, {
        checkId: c.id,
        actorType: 'SYSTEM',
        action: RECEIPT_RECLASSIFIED_ACTION,
        remarks: RULING,
        details: {
          from: 'crNumber', value: c.crNumber,
          sourceSheet: c.sourceSheet, sourceRow: c.sourceRow, ruling: RULING,
        },
      })
      repaired++
    }, TX_OPTIONS)
  }
  return { repaired, raced }
}
