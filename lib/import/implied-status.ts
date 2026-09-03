import { DomainError } from '@/lib/domain/errors'
import type { CheckStatus } from '@/lib/domain/check-status'
import { IMPLIED_STATUS, registerStatus, type RegisterStatus } from './reconcile'

// The register's vocabulary is not the release ladder's, and the gap is not
// cosmetic:
//
//   AVAILABLE — the register's word for the rung this system calls
//               READY_FOR_RELEASE.
//   FINDING   — not a rung at all. A finding is a query raised against a
//               cheque, so the cheque stays where it sat, at SIGNATURE_PENDING,
//               and the caller records a remark saying why. Mapping it to a
//               status of its own would put a query on the release ladder.
//   FT_MC     — fund transfers and manager's cheques. The sheet says nothing
//               about signing or release, so the cheque waits.
//
// The vocabulary itself lives in `reconcile.ts` and is imported, not copied:
// the importer and the reconciliation report must reach the same verdict about
// the same cheque.
const TO_CHECK_STATUS: Readonly<Record<RegisterStatus, CheckStatus>> = {
  RELEASED: 'RELEASED',
  AVAILABLE: 'READY_FOR_RELEASE',
  CANCELLED: 'CANCELLED',
  FINDING: 'SIGNATURE_PENDING',
  FT_MC: 'SIGNATURE_PENDING',
}

// A sheet whose name asserts nothing — 'MBTC P&P', 'BPI PAPER AND PLASTIC', the
// pending registers. A cheque sitting on one has been generated and is waiting
// for a signature. This is also the safe default: import never advances a cheque
// up the ladder on its own, so the lowest live rung is the only honest answer.
const PENDING: CheckStatus = 'SIGNATURE_PENDING'

// What one sheet asserts about a cheque, on this system's ladder.
export function impliedStatus(sheet: string): CheckStatus {
  const register = registerStatus(sheet)
  return register ? TO_CHECK_STATUS[register] : PENDING
}

export type ImpliedStatusResolution = {
  // The ladder status to import the cheque at.
  status: CheckStatus
  // Every sheet the cheque appeared on, deduped, in the order given.
  sheets: string[]
  // The register statuses that clashed, in vocabulary order. One entry means no
  // clash; none means no sheet asserted anything. `implied.includes('FINDING')`
  // is how the caller knows to record the finding remark.
  implied: RegisterStatus[]
  // The register status the ruling chose, for the audit row's wording. Null only
  // when nothing was asserted.
  resolvedFrom: RegisterStatus | null
}

// Finance's ruling of 2026-09-03 on the seven combinations the real register
// actually contains, keyed by the clashing statuses sorted alphabetically.
//
// Two things a future reader must NOT "tidy":
//
//  1. RELEASED + CANCELLED resolves to RELEASED, but RELEASED + CANCELLED +
//     FINDING resolves to CANCELLED. Adding FINDING flips the decision. That
//     looks like an oversight and is not: it is a ruling on exactly one cheque,
//     6000319079, and making the three-way case agree with the two-way one
//     would overturn it.
//
//  2. The three single-cheque heterogeneous cases resolve to the **later**
//     state, not to CANCELLED. Two of them have no CANCELLED entry on any
//     sheet, and marking a released cheque cancelled would invent a status the
//     register never records.
const RULINGS: Readonly<Record<string, RegisterStatus>> = {
  'CANCELLED+FINDING': 'CANCELLED',            // 48 cheques
  'CANCELLED+RELEASED': 'RELEASED',            // 25
  'FINDING+RELEASED': 'RELEASED',              // 25
  'CANCELLED+FINDING+RELEASED': 'CANCELLED',   //  1 — 6000319079; see (1) above
  'AVAILABLE+RELEASED': 'RELEASED',            //  1 — later state; see (2)
  'AVAILABLE+CANCELLED': 'CANCELLED',          //  1
  'AVAILABLE+FINDING': 'AVAILABLE',            //  1
}

const VOCABULARY_ORDER = IMPLIED_STATUS.map(([, status]) => status)

// Resolve the status of one cheque from every sheet it appears on, applying the
// ruling above when they disagree.
//
// An unlisted combination throws rather than defaulting. A new sheet or a new
// clash is a fact about money that nobody has ruled on, and quietly picking one
// of the candidates would be exactly the kind of invented fact this importer
// exists to avoid. The import stops, a human decides, the ruling is added here.
export function resolveImpliedStatus(sheetNames: readonly string[]): ImpliedStatusResolution {
  const sheets = [...new Set(sheetNames)]

  // A sheet that asserts nothing is excluded from the clash, as it already is in
  // `reconcile`. Every cheque starts on a pending register and moves to a
  // release sheet; that is the normal lifecycle, not a contradiction, and
  // counting it as one would refer thousands of cheques to a human for a ruling.
  const present = new Set(
    sheets.map(registerStatus).filter((s): s is RegisterStatus => s !== null),
  )
  const implied = VOCABULARY_ORDER.filter((s) => present.has(s))

  if (implied.length === 0) {
    return { status: PENDING, sheets, implied, resolvedFrom: null }
  }

  if (implied.length === 1) {
    return { status: TO_CHECK_STATUS[implied[0]], sheets, implied, resolvedFrom: implied[0] }
  }

  const ruling = RULINGS[[...implied].sort().join('+')]
  if (!ruling) {
    throw new DomainError(
      'UNRULED_STATUS_CLASH',
      `The register implies ${implied.join(' and ')} for one cheque, on ${sheets.join(', ')}. ` +
        'Finance has not ruled on this combination, so the import cannot choose one.',
    )
  }

  return { status: TO_CHECK_STATUS[ruling], sheets, implied, resolvedFrom: ruling }
}
