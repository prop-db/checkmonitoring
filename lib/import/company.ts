import { cleanCell } from './normalise'

export type CompanyResolution =
  | { ok: true; companyCode: string; from: 'CASH_ACCOUNT' | 'CHECK_BOOK'; conflictedWith: string | null }
  | { ok: false }

// Only the two columns that matter are named, so a caller can pass a `ParsedRow`
// or an Acumatica row without either module knowing about the other.
export type CompanySignals = {
  checkBook: string | null
  cashAccountLabel: string | null
}

// The reference table is injected rather than imported at module scope. This
// module is pure and its tests must not depend on what happens to be seeded;
// `prisma/reference-data.ts`'s CASH_ACCOUNTS and CHECK_BOOKS satisfy this
// structurally, extra `bank` field and all.
export type CompanyReferenceData = {
  cashAccounts: readonly { code: string; company: string }[]
  checkBooks: readonly { code: string; company: string }[]
}

// Codes are compared the way the parser stores them: trimmed, upper-cased, with
// runs of whitespace collapsed. `cleanCell` also turns '' and '#N/A' into null,
// which is what the register writes for "no checkbook".
function key(value: string | null): string | null {
  return cleanCell(value)?.toUpperCase() ?? null
}

function lookup(
  table: readonly { code: string; company: string }[],
  code: string | null,
): string | null {
  const k = key(code)
  if (!k) return null
  // A code the reference table does not carry is treated as absent for that
  // signal: it says nothing about the company, so it cannot resolve one and
  // cannot disagree with the signal that does. Measured against the current
  // register this path has no live example — every one of the 9 checkbook codes
  // and 6 cash-account codes in the workbook is mapped in reference-data — so
  // it is a guard against a future code, not a case anyone has seen.
  return table.find((e) => key(e.code) === k)?.company ?? null
}

// Which company's cheque this is, from the two columns the register records it
// in. Measured over the register's 12,227 rows: 8,245 resolve from the checkbook
// alone, 362 from the cash account alone, 897 from both agreeing, 17 from both
// disagreeing, and 2,640 (21.7%) from neither.
//
// **Never infer the company from the sheet name.** The RELEASED sheets are
// 97-100% one company, but CANCELLED splits 59/41 between Starkson and A1+ and
// CHECK FINDING 63/37 — those sheets collect cheques from every company.
// Inferring would file roughly 213 cheques under the wrong company, and since
// the dedup key is `@@unique([companyId, checkNumber])`, a wrong company is a
// cheque that can silently duplicate later. A row that resolves to nothing is
// staged for a human instead; `{ ok: false }` is the whole of that decision.
export function resolveCompany(
  signals: CompanySignals,
  ref: CompanyReferenceData,
): CompanyResolution {
  const fromAccount = lookup(ref.cashAccounts, signals.cashAccountLabel)
  const fromBook = lookup(ref.checkBooks, signals.checkBook)

  if (fromAccount) {
    // The cash account wins whenever it resolves — including a conflict, which
    // is the Finance ruling of 2026-09-03. It names the bank account the money
    // actually leaves, and in all 17 conflicting rows it agrees with the sheet
    // the cheque sits on while the checkbook cell holds an implausible value,
    // two of them Metrobank book codes recorded on a BPI sheet.
    //
    // The loser is carried in `conflictedWith` and every one of the 17 is listed
    // on the reconciliation report so Finance can correct the register. This is
    // **reported, never silently preferred** — dropping `conflictedWith` would
    // turn a visible data-entry error into an invisible one.
    const conflictedWith = fromBook && fromBook !== fromAccount ? fromBook : null
    return { ok: true, companyCode: fromAccount, from: 'CASH_ACCOUNT', conflictedWith }
  }

  if (fromBook) {
    return { ok: true, companyCode: fromBook, from: 'CHECK_BOOK', conflictedWith: null }
  }

  return { ok: false }
}
