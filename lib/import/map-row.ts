import type { NormalisedRow } from '@/lib/normalised-row'
import { resolveCompany, type CompanyReferenceData } from './company'
import type { ParsedRow } from './parse'

// One row of the client's check register -> the shared normalised row. The
// workbook counterpart of `lib/integrations/acumatica/map.ts`, and pure for the
// same reason: no database, no network, no `new Date()` of its own.
//
// Almost all of this is a rename. `NormalisedRow` is named to match the `Check`
// columns it feeds, so the upsert is a copy rather than a translation, and the
// only field whose name actually changes between the two shapes is the payee.

/**
 * The register is a Philippine group's, and every amount on it that carries no
 * currency prefix is in pesos. **This is the one place that default is applied**
 * — the parser deliberately leaves `ParsedRow.currency` null unless the register
 * states one inline ("USD 300000" on FT & MC), so that choosing a default is a
 * visible decision made once rather than a `?? 'PHP'` scattered through the code
 * where nobody can audit it.
 *
 * It is applied HERE, on the workbook side, and not in `upsertCheck`, because it
 * is a fact about this register and not about ingestion in general. The
 * Acumatica feed carries PHP, CNY and USD and states the currency on every row;
 * defaulting a missing currency there would relabel a CNY payment as pesos,
 * which is a wrong number that looks authoritative. A null currency reaching the
 * upsert from Acumatica is a surprise, and must stay one.
 */
export const REGISTER_CURRENCY = 'PHP'

export function mapParsedRow(parsed: ParsedRow, ref: CompanyReferenceData): NormalisedRow {
  // `ParsedRow` structurally satisfies `CompanySignals`, so the two modules
  // wire together without either knowing about the other. The reconciliation
  // report calls `resolveCompany` again for `conflictedWith` — it is pure, so
  // the second call is free, and carrying the losing signal on the normalised
  // row would put a reporting concern into the shape the upsert reads.
  const company = resolveCompany(parsed, ref)

  return {
    source: 'WORKBOOK',
    // The register knows nothing about Acumatica document keys.
    acumaticaPaymentId: null,

    checkNumber: parsed.checkNumber,
    cvNumber: parsed.cvNumber,

    checkDate: parsed.checkDate,
    amount: parsed.amount,
    currency: parsed.currency ?? REGISTER_CURRENCY,

    // The one rename: `ParsedRow.payee` is `NormalisedRow.payeeName`. Getting
    // this wrong blanks the payee on all 12,161 rows, and a blank payee
    // classifies INTERNAL — so the symptom would be thousands of supplier
    // cheques quietly becoming unpublishable rather than anything that errors.
    payeeName: parsed.payee,
    // The register records a payee name, never a vendor code.
    vendorCode: null,

    // Null when neither the checkbook nor the cash account resolves one: 2,640
    // of the register's rows. Never inferred from the sheet name — the CANCELLED
    // and CHECK FINDING sheets collect cheques from every company, and since the
    // dedup key is (company, cheque number), a wrong company is a cheque that
    // can silently duplicate later.
    companyCode: company.ok ? company.companyCode : null,
    cashAccountCode: parsed.cashAccountLabel,
    checkBookCode: parsed.checkBook,
    category: parsed.category,

    apvNumbers: parsed.apvNumbers,
    poNumbers: parsed.poNumbers,
    clearingRef: parsed.clearingRef,

    // The register is a cheque register: every row on it is a physical document
    // somebody signs and hands over. Non-cheque payments are an Acumatica fact
    // (the China branches' wire transfers) and cannot appear here.
    isCheque: true,
    // Likewise a void (D3): the register's vocabulary is RELEASED, AVAILABLE,
    // CANCELLED, FINDING and FT & MC, and it has no word for a void at all.
    // VOIDED comes from Acumatica or from nowhere.
    voided: false,

    acumaticaDocType: null,
    acumaticaStatus: null,
    acumaticaBranch: null,
    acumaticaTenant: null,
    lastModifiedOn: null,

    // The provenance that makes a staged row correctable: a human can be
    // pointed at the cell.
    sourceSheet: parsed.sheet,
    sourceRow: parsed.row,
  }
}
