import type { AcumaticaTenant } from '../lib/integrations/acumatica/companies'

export type CompanyRef = {
  code: string
  name: string
  tenant: AcumaticaTenant
  branch: string
  legalNames: string[]
}

// Six companies across two Acumatica tenants. Mirrors the Supplier Portal's
// routing table. `legalNames` feeds classifyEligibility's inter-company check —
// a payment to one of our own companies is INTERNAL and must never reach the
// supplier portal.
export const COMPANIES: readonly CompanyRef[] = [
  { code: 'STK',   name: 'Starkson Packaging Inc.',            tenant: 'GOLIVE',        branch: 'ST',
    legalNames: ['STARKSON PACKAGING INC.'] },
  { code: 'A1+',   name: 'A1+ Multinational Packaging Inc.',   tenant: 'GOLIVE',        branch: 'A1+',
    legalNames: ['A1+ MULTINATIONAL PACKAGING INC.'] },
  { code: 'STPP',  name: 'Starkson Paper and Plastic',         tenant: 'MANUFACTURING', branch: 'ST',
    legalNames: ['STARKSON PAPER AND PLASTIC'] },
  { code: 'A1PP',  name: 'A1+ Paper and Plastic',              tenant: 'MANUFACTURING', branch: 'A1+',
    legalNames: ['A1+ PAPER AND PLASTIC'] },
  { code: 'HAMFI', name: 'Happy Alliance Mono Film Inc.',      tenant: 'GOLIVE',        branch: 'HAMFI(HO)',
    legalNames: ['HAPPY ALLIANCE MONO FILM INC', 'HAPPY ALLIANCE MONO FILM INC.'] },
  { code: 'IND',   name: 'Starkson Industries Inc.',           tenant: 'GOLIVE',        branch: 'STINDUSTRY',
    legalNames: ['STARKSON INDUSTRIES', 'STARKSON INDUSTRIES INC'] },
  // China offices pay by bank transfer in CNY, not by cheque. They still need a
  // company row so their payments can be tracked (`isCheque = false`).
  { code: 'DG',    name: 'Dongguan Office',                    tenant: 'GOLIVE',        branch: 'DG',
    legalNames: ['DONGGUAN OFFICE'] },
  { code: 'SH',    name: 'Shanghai Office',                    tenant: 'GOLIVE',        branch: 'SH',
    legalNames: ['SHANGHAI OFFICE'] },
]

// Bank + company. Codes are exactly as they appear in the client's register.
export const CASH_ACCOUNTS: readonly { code: string; bank: string; company: string }[] = [
  { code: 'BPI STK',  bank: 'BPI',  company: 'STK' },
  { code: 'BPI P&P',  bank: 'BPI',  company: 'STPP' },
  { code: 'BPI A1',   bank: 'BPI',  company: 'A1+' },
  { code: 'MBTC A1+', bank: 'MBTC', company: 'A1+' },
  { code: 'MBTC P&P', bank: 'MBTC', company: 'A1PP' },
  { code: 'BDO A1',   bank: 'BDO',  company: 'A1+' },
]

export const CHECK_BOOKS: readonly { code: string; bank: string; company: string }[] = [
  { code: 'BPI-S-4636', bank: 'BPI',  company: 'STK' },
  { code: 'BPI-A-5713', bank: 'BPI',  company: 'A1+' },
  { code: 'BPI-S-8879', bank: 'BPI',  company: 'STPP' },
  { code: 'BPI-A-8879', bank: 'BPI',  company: 'A1PP' },
  { code: 'MBT-A-4155', bank: 'MBTC', company: 'A1+' },
  { code: 'MBT-A-9048', bank: 'MBTC', company: 'A1PP' },
  // NOTE: `MBT-S-9048` appears once in the register but is NOT a real
  // checkbook — Finance confirmed (2026-09-03) it is a mis-keying of
  // MBT-A-9048. It is deliberately absent here and corrected on import by
  // `canonicalCheckBook`. Do not "restore" it: listing it would seed a
  // CheckBook row for a book that does not exist and split one physical
  // book's cheques across two records. Both codes happen to map to A1PP, so
  // the symptom is not a wrong company — which is exactly why this would
  // survive unnoticed if it were re-added.
  { code: 'MBT-S-1121', bank: 'MBTC', company: 'STK' },
  { code: 'BDO-A-3838', bank: 'BDO',  company: 'A1+' },
]
