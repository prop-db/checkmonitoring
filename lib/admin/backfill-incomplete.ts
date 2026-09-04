import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type BackfillIncompleteResult = {
  /** Rows this run set from false to true. */
  flagged: number
  /** Rows this run set from true to false, because an amount has since arrived. */
  unflagged: number
  /** Rows flagged incomplete once the run finished. */
  incomplete: number
  /** Every cheque in the table, so `incomplete` has a denominator. */
  total: number
}

/**
 * Sets `Check.isIncomplete` from `Check.amount`, in both directions.
 *
 * It exists because the flag post-dates the data: 129 of production's 9,247
 * register-derived cheques carry no amount and nothing will ever import them
 * again, so something has to go and say so once. Migration
 * `20260905000000_check_is_incomplete` runs the same UPDATE, which covers a
 * fresh deploy; this is the re-runnable version for a database whose rows moved
 * afterwards.
 *
 * **Idempotent, and re-runnable by design.** Each statement is filtered on the
 * flag it is about to change, so a second run reports 0 and 0. The historical
 * import is idempotent for the same reason and was interrupted once already;
 * anything that follows it has to be safe to run again.
 *
 * **Both directions, not just the flagging one.** A row flagged incomplete
 * whose amount somebody has since filled in would otherwise sit in the queue
 * for ever and the dashboard count would never come down. The importer
 * maintains the flag as it writes amounts, so this is a repair rather than the
 * mechanism — if it ever reports a non-zero `unflagged` outside a first run,
 * something else has been writing `amount` behind the importer's back and that
 * is worth finding.
 *
 * `amount: null`, never a falsy test: 0.00 is a cheque drawn for nothing, which
 * is a recorded figure and not a gap.
 */
export async function backfillIncompleteFlags(db: Db): Promise<BackfillIncompleteResult> {
  const flagged = await db.check.updateMany({
    where: { amount: null, isIncomplete: false },
    data: { isIncomplete: true },
  })
  const unflagged = await db.check.updateMany({
    where: { amount: { not: null }, isIncomplete: true },
    data: { isIncomplete: false },
  })

  const [incomplete, total] = await Promise.all([
    db.check.count({ where: { isIncomplete: true } }),
    db.check.count(),
  ])

  return { flagged: flagged.count, unflagged: unflagged.count, incomplete, total }
}
