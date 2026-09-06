import type { Check, Company, Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'

/**
 * The same ruling `lib/import/upsert.ts` cites, restated here rather than
 * imported from the importer: this module repairs rows the importer has already
 * written, and a repair script that pulled a constant out of the write path
 * would start failing to compile the day the write path is retired.
 */
export const MERGE_RULING_BASIS =
  'Client ruling of 2026-09-06: Acumatica\'s Branch is authoritative for which company owns a cheque'

export type MergeRefusalReason =
  /** Not one register row and one Acumatica-only row. Nothing to merge INTO. */
  | 'NOT_ONE_REGISTER_AND_ONE_ACUMATICA_ROW'
  /** The outbox holds an instruction about the duplicate. */
  | 'PORTAL_EVENT'
  /** A Finance user signed, made ready, released or cancelled the duplicate. */
  | 'FINANCE_ACTION'
  /** The duplicate carries bill lines, which would cascade away with it. */
  | 'BILLS_ON_DUPLICATE'
  /** Both rows name a DIFFERENT Acumatica payment: two payments, not one cheque. */
  | 'TWO_ACUMATICA_PAYMENTS'

export type MergeRefusal = {
  checkNumber: string
  reason: MergeRefusalReason
  /** One sentence an operator can act on. Never a payee, never an amount. */
  detail: string
}

export type MergeSummary = {
  /** Cheque numbers held by more than one row when the run started. */
  duplicateNumbersBefore: number
  /** Pairs merged — or, on a dry run, that would be. */
  merged: number
  refused: MergeRefusal[]
  refusedByReason: Record<MergeRefusalReason, number>
  /**
   * Cheque numbers still held by more than one row. Measured after the run;
   * on a dry run, projected as `duplicateNumbersBefore - merged`, because
   * nothing was written to measure.
   */
  duplicateNumbersAfter: number
  /**
   * Pairs whose two rows record different amounts. Reported as a COUNT ONLY —
   * never the amounts themselves. The register's figure survives the merge
   * untouched; this is here so an operator can see whether the ERP disagrees
   * with it anywhere, which is a separate question for Finance.
   */
  amountsDiffer: number
}

const NO_REFUSALS: Record<MergeRefusalReason, number> = {
  NOT_ONE_REGISTER_AND_ONE_ACUMATICA_ROW: 0,
  PORTAL_EVENT: 0,
  FINANCE_ACTION: 0,
  BILLS_ON_DUPLICATE: 0,
  TWO_ACUMATICA_PAYMENTS: 0,
}

type Row = Check & { company: Pick<Company, 'code'> }

/**
 * Merges the cheques that were stored twice before `upsertCheck` learned to
 * look a cheque up by its number alone.
 *
 * 1,865 physical cheques exist as two rows: one written by the register, whose
 * company came from the cheque book, and one written by the Acumatica sync,
 * whose company came from the payment's `Branch`. The two tables disagree in no
 * consistent pattern, and because duplicate prevention keyed on `(companyId,
 * checkNumber)` the disagreement read as two different cheques.
 *
 * **The register row is the survivor**, always. It carries the real status, the
 * source sheet, its bills and its audit history — everything a Finance user
 * established. Only its `companyId` changes, to the one Acumatica asserted.
 *
 * **Nothing else moves.** Not the amount, not the status, not `releasedAt`. A
 * cheque the register says is RELEASED stays RELEASED. The one exception is the
 * absorbed row's Acumatica provenance (its ReferenceNbr, branch, tenant, doc
 * type and status), copied onto the survivor where the survivor has none —
 * otherwise the ERP link dies with the deleted row, because the sync's
 * watermark means an unchanged payment is never read again.
 *
 * References to the absorbed row are carried across rather than broken: its
 * audit rows detach (ON DELETE SET NULL, the append-only trigger's one
 * exemption) and any staged row promoted into it is repointed at the survivor.
 *
 * Deliberately one pair per transaction rather than one transaction for all
 * 1,865: a merge that failed on pair 1,800 would otherwise roll back 1,799
 * correct ones, and every pair is independent of every other.
 */
export async function mergeDuplicateCheques(
  db: PrismaClient,
  args: { dryRun: boolean; now: Date },
): Promise<MergeSummary> {
  const duplicates = await db.check.groupBy({
    by: ['checkNumber'],
    _count: { _all: true },
    having: { checkNumber: { _count: { gt: 1 } } },
  })

  const summary: MergeSummary = {
    duplicateNumbersBefore: duplicates.length,
    merged: 0,
    refused: [],
    refusedByReason: { ...NO_REFUSALS },
    duplicateNumbersAfter: 0,
    amountsDiffer: 0,
  }

  const refuse = (checkNumber: string, reason: MergeRefusalReason, detail: string) => {
    summary.refused.push({ checkNumber, reason, detail })
    summary.refusedByReason[reason]++
  }

  for (const group of duplicates) {
    const checkNumber = group.checkNumber
    const rows: Row[] = await db.check.findMany({
      where: { checkNumber },
      include: { company: { select: { code: true } } },
    })

    // The register wrote a sheet name and a row number; the sync wrote neither.
    // That is what tells the two halves apart, and it is a fact about how the
    // row was created rather than a guess about which is real.
    const register = rows.filter((r) => r.sourceSheet !== null)
    const acumatica = rows.filter((r) => r.sourceSheet === null)

    if (register.length !== 1 || acumatica.length !== 1) {
      refuse(
        checkNumber,
        'NOT_ONE_REGISTER_AND_ONE_ACUMATICA_ROW',
        `${rows.length} rows carry this number: ${register.length} from the register ` +
          `(${register.map((r) => r.company.code).join(', ') || 'none'}) and ${acumatica.length} ` +
          `from Acumatica (${acumatica.map((r) => r.company.code).join(', ') || 'none'}). ` +
          'A human has to say which cheque is which.',
      )
      continue
    }

    const survivor = register[0]!
    const duplicate = acumatica[0]!

    // Finance history, not import residue. Any one of these means somebody
    // acted on the row that is about to be deleted, and the act would go with
    // it. `cancelledById` is checked alongside the three the brief named for
    // the same reason they are: cancelling a cheque is a Finance decision with
    // a recorded reason.
    const financeAction =
      duplicate.signedById ?? duplicate.readyById ?? duplicate.releasedById ?? duplicate.cancelledById
    if (financeAction !== null) {
      refuse(
        checkNumber,
        'FINANCE_ACTION',
        `The Acumatica row (${duplicate.company.code}, ${duplicate.status}) records a Finance ` +
          'action. Deleting it would delete the record of what someone did.',
      )
      continue
    }

    // `PortalEvent.checkId` is NOT NULL and the FK is ON DELETE RESTRICT, so
    // the database would refuse this anyway — with a foreign-key violation
    // instead of a sentence. Refused here first, and every event counts: a
    // SYNCED one is the record that a supplier was told something.
    const [events, promoted, bills, absorbedAuditRows] = await Promise.all([
      db.portalEvent.count({ where: { checkId: duplicate.id } }),
      // NOT a refusal, unlike in `deleteIncompleteCheck`. There the cheque
      // ceases to exist and the staged row's promotion has no target left; here
      // it is absorbed, and the survivor IS the cheque the row was promoted
      // into. The pointer is moved, below, in the same transaction.
      db.stagedCheck.count({ where: { promotedCheckId: duplicate.id } }),
      db.checkBill.count({ where: { checkId: duplicate.id } }),
      // Counted before the delete, for the record: they detach rather than die.
      db.auditLog.count({ where: { checkId: duplicate.id } }),
    ])

    if (events > 0) {
      refuse(
        checkNumber,
        'PORTAL_EVENT',
        `The supplier portal outbox holds ${events} instruction(s) about the Acumatica row.`,
      )
      continue
    }
    if (bills > 0) {
      // `CheckBill` is ON DELETE CASCADE, so these would vanish silently.
      refuse(
        checkNumber,
        'BILLS_ON_DUPLICATE',
        `The Acumatica row carries ${bills} bill line(s), which would cascade away with it.`,
      )
      continue
    }

    // Two different ReferenceNbrs is two payments in the ERP, which is not one
    // cheque entered twice — whatever the numbers say.
    if (
      survivor.acumaticaPaymentId !== null &&
      duplicate.acumaticaPaymentId !== null &&
      survivor.acumaticaPaymentId !== duplicate.acumaticaPaymentId
    ) {
      refuse(
        checkNumber,
        'TWO_ACUMATICA_PAYMENTS',
        'The two rows name different Acumatica payments, so they are not one cheque stored ' +
          'twice.',
      )
      continue
    }

    if (survivor.amount?.toString() !== duplicate.amount?.toString()) summary.amountsDiffer++

    summary.merged++
    if (args.dryRun) continue

    await db.$transaction(async (tx) => {
      // FIRST, and in this transaction: the audit row is written on the
      // survivor before anything is destroyed, so the record of what was
      // absorbed exists even if the delete below fails.
      await writeAudit(tx, {
        checkId: survivor.id,
        actorType: 'SYSTEM',
        action: 'duplicate_check_merged',
        details: {
          checkNumber,
          previousCompanyId: survivor.companyId,
          previousCompanyCode: survivor.company.code,
          companyId: duplicate.companyId,
          companyCode: duplicate.company.code,
          absorbedCheckId: duplicate.id,
          absorbedStatus: duplicate.status,
          absorbedAcumaticaPaymentId: duplicate.acumaticaPaymentId,
          absorbedAcumaticaBranch: duplicate.acumaticaBranch,
          absorbedAcumaticaTenant: duplicate.acumaticaTenant,
          // Kept because the row that held them is about to stop existing.
          // Stated as null rather than omitted when absent: "not recorded" is
          // itself the fact, and a missing key would read as an oversight.
          absorbedAmount: duplicate.amount?.toString() ?? null,
          absorbedPayeeName: duplicate.payeeName,
          absorbedCheckDate: duplicate.checkDate?.toISOString() ?? null,
          detachedAuditRows: absorbedAuditRows,
          repointedStagedRows: promoted,
          mergedAt: args.now.toISOString(),
          basis: MERGE_RULING_BASIS,
        },
        remarks:
          `Absorbed the Acumatica-only row for cheque ${checkNumber} (${duplicate.company.code}, ` +
          `${duplicate.status}) into this register row (${survivor.company.code}, ` +
          `${survivor.status}), and refiled it under ${duplicate.company.code}. ` +
          `${MERGE_RULING_BASIS}.`,
      })

      // Moved before the delete, while the row it points at still exists, so
      // the staged queue is never momentarily pointing at nothing.
      if (promoted > 0) {
        await tx.stagedCheck.updateMany({
          where: { promotedCheckId: duplicate.id },
          data: { promotedCheckId: survivor.id },
        })
      }

      // Before the update, not after: the survivor cannot take the duplicate's
      // company while the duplicate still holds `(companyId, checkNumber)`.
      // Its audit rows detach rather than dying — ON DELETE SET NULL, which the
      // append-only trigger permits only once the cheque is gone.
      await tx.check.delete({ where: { id: duplicate.id } })

      await tx.check.update({
        where: { id: survivor.id },
        data: {
          companyId: duplicate.companyId,
          ...acumaticaProvenance(survivor, duplicate),
        },
      })
    })
  }

  summary.duplicateNumbersAfter = args.dryRun
    ? summary.duplicateNumbersBefore - summary.merged
    : (
      await db.check.groupBy({
        by: ['checkNumber'],
        _count: { _all: true },
        having: { checkNumber: { _count: { gt: 1 } } },
      })
    ).length

  return summary
}

/**
 * The absorbed row's ERP identity, for the fields the survivor has none of.
 *
 * Only ever fills a gap — it never overwrites what the survivor already
 * records. Every field here is in `IMPORT_WRITABLE`; nothing Finance owns is
 * touched, and neither is the amount.
 */
function acumaticaProvenance(
  survivor: Check,
  duplicate: Check,
): Prisma.CheckUncheckedUpdateInput {
  const fill = <T>(mine: T | null, theirs: T | null): T | undefined =>
    mine === null && theirs !== null ? theirs : undefined

  return {
    acumaticaPaymentId: fill(survivor.acumaticaPaymentId, duplicate.acumaticaPaymentId),
    acumaticaBranch: fill(survivor.acumaticaBranch, duplicate.acumaticaBranch),
    acumaticaTenant: fill(survivor.acumaticaTenant, duplicate.acumaticaTenant),
    acumaticaDocType: fill(survivor.acumaticaDocType, duplicate.acumaticaDocType),
    acumaticaStatus: fill(survivor.acumaticaStatus, duplicate.acumaticaStatus),
    lastModifiedOn: fill(survivor.lastModifiedOn, duplicate.lastModifiedOn),
  }
}
