import type { AcumaticaTenant } from './integrations/acumatica/companies'

/**
 * The one shape both ingestion paths converge on.
 *
 * The workbook importer and the Acumatica mapper both emit this, and
 * `upsertCheck` is the only thing that reads it. Keeping one shape is what lets
 * two very different sources share a single write path, and therefore a single
 * place where duplicate prevention lives. Adding a field that only one source
 * can fill is fine; adding a field only one source can *read* is not — that is
 * how the two paths drift apart and duplicate-prevention ends up in two places.
 *
 * Almost everything is nullable on purpose. Both sources are incomplete in
 * different ways: the register does not always record an amount or a payee, and
 * the generic inquiry exposes no checkbook or category at all. A null says the
 * one true thing — the source did not state it — where a default would silently
 * invent a fact about money.
 */
export type NormalisedRow = {
  source: 'ACUMATICA' | 'WORKBOOK'

  /**
   * The payment document's identity in Acumatica (`ReferenceNbr`), null for a
   * workbook row. Deliberately the same value as `cvNumber` for an Acumatica
   * payment: in this feed the CV number *is* the document key. They are separate
   * fields because one is provenance and the other is a business identifier a
   * workbook row can also carry.
   */
  acumaticaPaymentId: string | null

  // Identity. `checkNumber` plus a resolved company is the duplicate key.
  // From Acumatica this is `PaymentRef`, NOT `ReferenceNbr` — see map.ts.
  checkNumber: string | null
  cvNumber: string | null

  checkDate: Date | null
  /**
   * A decimal string, never a JS number. Parsing 197715.42 into a float and
   * back is how centavos get lost, and the column is `Decimal(18,2)`.
   */
  amount: string | null
  /** Null means the source did not state one. Never defaulted to PHP: the feed
   * carries PHP, CNY and USD, and a mislabelled currency is a wrong number that
   * looks authoritative. */
  currency: string | null

  payeeName: string | null
  vendorCode: string | null
  /** Null when the source cannot say which company — never defaulted. An
   * unrecognised branch is a data surprise that must land somewhere a human
   * sees it, not under company one. */
  companyCode: string | null
  cashAccountCode: string | null
  checkBookCode: string | null
  category: string | null

  /**
   * Not every payment is a cheque. The China offices pay by transfer and their
   * reference is an AP document number, so there is no physical document to
   * sign or hand over. Such a payment is imported for visibility and blocked
   * from the release ladder.
   */
  isCheque: boolean
  /** An Acumatica fact, distinct from the Finance action `CANCELLED`. */
  voided: boolean

  // Acumatica provenance; null for workbook rows.
  acumaticaDocType: string | null
  acumaticaStatus: string | null
  /** The raw branch code, kept even when it resolves to no company, so an
   * unrecognised branch is still legible in the row a human ends up reading. */
  acumaticaBranch: string | null
  acumaticaTenant: AcumaticaTenant | null
  lastModifiedOn: Date | null

  // Provenance for the workbook path: the sheet and row, so a reconciliation
  // report can point a human at the cell. Null for Acumatica rows.
  sourceSheet: string | null
  sourceRow: number | null
}
