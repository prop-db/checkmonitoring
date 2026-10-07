import type { CheckStatus } from '@prisma/client'
import { statusWords } from './report'

/**
 * THE VOUCHER INDEX — one row per AP voucher, saying which cheque pays it.
 *
 * It exists because the Finance Executive Report's `AP Local` sheet found a
 * payable's cheque with three VLOOKUPs into the released sheets of
 * `CHECK MONITORING <date>.xlsx`, and that register was retired on 2026-09-10.
 * A VLOOKUP into a stale external does not fail; it returns its last cached
 * value indefinitely. See docs/superpowers/specs/2026-09-10-voucher-index-export-design.md.
 *
 * PURE. No database, no ExcelJS, no clock — the decisions worth pinning by test
 * are decisions, and a test that has to open a spreadsheet to check them is a
 * test nobody runs. Same split as `report.ts` and `workbook.ts`.
 */

/**
 * FIXED, both of them — not because a formula depends on them. It used to be
 * true: an external VLOOKUP into `CHECK MONITORING <date>.xlsx` is exactly the
 * failure this export was built to fix (see the module comment above), and
 * while that VLOOKUP existed a dated filename would have broken it on every
 * regeneration. The register was retired on 2026-09-10, and nothing outside
 * this system depends on the name, the sheet or the timestamp cell any more.
 *
 * They stay fixed anyway, for a plainer reason: `CHECK BY VOUCHER.xlsx` is
 * this screen's extract, and a stable name is cheaper to consume than a dated
 * one — a bookmark or a shared-drive shortcut keeps working across every
 * regeneration — and costs nothing to keep.
 *
 * The price of a fixed name is that a stale copy looks identical to a fresh one,
 * which is why the generation timestamp goes in a fixed cell — see
 * `voucher-workbook.ts` and `TIMESTAMP_CELL`.
 */
export const VOUCHER_INDEX_SHEET = 'INDEX'
export const VOUCHER_INDEX_FILENAME = 'CHECK BY VOUCHER.xlsx'

/** Where `/vouchers`' EXPORT EXCEL button points. Stated once so the link and the route agree. */
export const VOUCHER_INDEX_HREF = '/api/export/vouchers'

/**
 * The most rows one index will contain.
 *
 * A CAP, not streaming, for the same reason `EXPORT_ROW_LIMIT` is one: the
 * workbook is assembled whole in memory inside a serverless function, and the
 * column widths are fitted to the full row set before the first byte is written.
 *
 * 15,000 rather than the register export's 10,000 because this row is narrower —
 * ten short columns, no amounts, no second sheet — and today's population is
 * ~10,985 vouchers. That is ~37% headroom. RE-MEASURE it the way the original
 * was measured before raising it further; do not reason from the ratio.
 *
 * The cap is never silent: `describeVoucherScope` writes it into the title block.
 */
export const VOUCHER_INDEX_ROW_LIMIT = 15_000

/**
 * `VOUCHER` is FIRST and must stay first. VLOOKUP searches the first column of
 * the range it is given and cannot be told to search any other.
 *
 * There is deliberately NO AMOUNT COLUMN. A cheque can settle several bills, so
 * its amount is not the `Detail Total` sitting beside it on `AP Local`, and the
 * two would eventually be subtracted from one another. `StagedBill` omits an
 * amount for the mirror image of this reason. Client decision, 2026-09-10.
 */
export const VOUCHER_HEADERS = [
  'VOUCHER', 'CHECK NUMBER', 'BANK', 'COMPANY', 'STATUS',
  'CHECK DATE', 'PAYEE', 'RELEASED', 'SUPERSEDES', 'REMARKS',
] as const

/** Four lines of title block, one blank row, header on 6, first voucher on 7. */
export const VOUCHER_HEADER_ROW = 6
export const VOUCHER_FIRST_DATA_ROW = VOUCHER_HEADER_ROW + 1

/**
 * Three statuses that are not a `CheckStatus`, because they are facts about the
 * ROW rather than about a cheque. Spelled in the same voice as `statusWords`
 * output so the column reads consistently.
 */
export const CONTESTED = 'CONTESTED'
export const ALL_CANCELLED = 'ALL CANCELLED'
export const NOT_KEYED = 'NOT KEYED'

/** A cheque is dead when it can never be released. */
const DEAD_STATUSES: readonly CheckStatus[] = ['CANCELLED', 'VOIDED']
function isDead(status: CheckStatus): boolean {
  return DEAD_STATUSES.includes(status)
}

/** One (voucher, cheque) pair as the database hands it over. */
export type CheckCandidate = {
  voucher: string
  /** `Check.id`, so a screen can link the number. The workbook ignores it. */
  checkId: string
  checkNumber: string
  status: CheckStatus
  bank: string | null
  company: string
  checkDate: Date | null
  payee: string | null
  releasedAt: Date | null
}

/** One (voucher, staged row) pair. A staged row has no company, so no bank. */
export type StagedCandidate = {
  voucher: string
  sourceSheet: string | null
  sourceRow: number | null
  statedCheckRef: string | null
  checkNumber: string | null
  acumaticaRef: string | null
}

export type VoucherIndexInput = {
  checks: readonly CheckCandidate[]
  staged: readonly StagedCandidate[]
}

/** One line of the sheet. `checkNumber` is null exactly when we will not guess. */
export type VoucherRow = {
  voucher: string
  /** Null exactly when `checkNumber` is — the screen links one to the other. */
  checkId: string | null
  checkNumber: string | null
  bank: string | null
  company: string | null
  status: string
  checkDate: Date | null
  payee: string | null
  releasedAt: Date | null
  supersedes: string | null
  remarks: string | null
}

function describeCheque(c: CheckCandidate): string {
  return `${c.checkNumber} (${statusWords(c.status)})`
}

/**
 * Same job as `describeCheque`, plus the company — used ONLY in the two
 * messages that describe a genuine CONTESTED/ALL_CANCELLED conflict.
 *
 * Two cheques can legitimately share a `checkNumber`: the schema's real
 * uniqueness constraint is `@@unique([companyId, checkNumber])`, not on
 * `checkNumber` alone. When a voucher names two live cheques that happen to
 * carry the same number, `describeCheque` alone renders
 * `6000300008 (SIGNED); 6000300008 (SIGNED)` — two identical strings naming
 * the very two cheques a human is being sent to go reconcile, with nothing
 * to tell them apart. That is not a hypothetical: it is exactly the shape
 * `resolveOne`'s CONTESTED branch exists to flag. The company is what
 * distinguishes them, so it goes in the remarks — `6000300008 · STK
 * (SIGNED)` vs `6000300008 · A1+ (SIGNED)` — even though `CHECK NUMBER`
 * alone is ambiguous, `COMPANY` is the column a reader can actually use to
 * find the right row in Check Release Monitoring.
 *
 * `describeCheque` stays as it is and keeps doing the `supersedes` job
 * alone: a superseded cheque is the SAME company's own prior issuance of
 * the same voucher (see `resolveOne`'s re-issue comment), never a different
 * company's, so the company is already implied by the row it sits in and
 * naming it again would be noise, not disambiguation. Widening
 * `describeCheque` itself to always include the company would also break
 * the pinned `supersedes` format (`'6000300001 (VOIDED)'`) for no reason —
 * that column was never ambiguous.
 */
function describeConflict(c: CheckCandidate): string {
  return `${c.checkNumber} · ${c.company} (${statusWords(c.status)})`
}

function fromCheque(
  voucher: string,
  c: CheckCandidate,
  superseded: readonly CheckCandidate[],
): VoucherRow {
  return {
    voucher,
    checkId: c.checkId,
    checkNumber: c.checkNumber,
    bank: c.bank,
    company: c.company,
    status: statusWords(c.status),
    checkDate: c.checkDate,
    payee: c.payee,
    releasedAt: c.releasedAt,
    supersedes: superseded.length ? superseded.map(describeCheque).join('; ') : null,
    remarks: null,
  }
}

function withoutCheque(voucher: string, status: string, remarks: string): VoucherRow {
  return {
    voucher,
    checkId: null,
    checkNumber: null,
    bank: null,
    company: null,
    status,
    checkDate: null,
    payee: null,
    releasedAt: null,
    supersedes: null,
    remarks,
  }
}

/**
 * One voucher's cheques, collapsed to one row.
 *
 * A re-issue — one live cheque and some voided predecessors — is NOT an
 * ambiguity. It has an obvious right answer, and refusing to give it would
 * throw away 46 measured answers to guard against 6.
 *
 * Two LIVE cheques is a genuine conflict and is refused outright, the same way
 * `bills.ts` refuses `AMBIGUOUS_CHECK`. The lookup then returns nothing, which
 * is correct: a bill hung on the wrong cheque is a supplier told the wrong thing.
 */
function resolveOne(voucher: string, candidates: readonly CheckCandidate[]): VoucherRow {
  // De-duplicate by cheque IDENTITY before counting. `byVoucher` in
  // `resolveVoucherRows` pushes every (voucher, cheque) ROW it is handed, and
  // nothing at the database level stops the same cheque being handed over
  // twice for one voucher — `Check.apvNumbers` has no uniqueness constraint on
  // its elements. Measured against production on 2026-09-10: no `Check` row
  // carries a duplicate element today, so this has not happened yet, but the
  // five `StagedCheck` rows that do carry duplicates are exactly why the
  // staged query already reads with `SELECT DISTINCT` — the same shape of bug,
  // caught there and not here. Counting ENTRIES instead of distinct cheques
  // would make a repeated entry look like a second cheque: `live.length > 1`
  // would fire, the resolver would report CONTESTED, and the one real answer
  // would be withheld from a lookup a treasury workbook depends on.
  //
  // The identity is NOT `checkNumber` alone — `@@unique([companyId,
  // checkNumber])` is the real constraint, so two different companies can
  // legitimately issue a cheque bearing the same number, and a voucher naming
  // both is a genuine conflict that must still report CONTESTED. Key on the
  // pair, joined by a separator ('\u0000') that cannot occur in either a
  // company code or a cheque number, and keep the first occurrence of each.
  const seen = new Map<string, CheckCandidate>()
  for (const c of candidates) {
    const identity = `${c.company}\u0000${c.checkNumber}`
    if (!seen.has(identity)) seen.set(identity, c)
  }
  const deduped = [...seen.values()]

  const live = deduped.filter((c) => !isDead(c.status))
  const dead = deduped.filter((c) => isDead(c.status))

  if (live.length === 1) return fromCheque(voucher, live[0], dead)
  if (live.length > 1) {
    return withoutCheque(
      voucher,
      CONTESTED,
      `More than one live check names this voucher: ${live.map(describeConflict).join('; ')}. ` +
        'Settle it in Check Release Monitoring; no check number is given here because ' +
        'attaching a bill to the wrong check tells a supplier the wrong thing.',
    )
  }
  // Nothing live. One dead cheque is still an answer — "the cheque for this was
  // voided" is what somebody chasing an open payable needs to know.
  if (dead.length === 1) return fromCheque(voucher, dead[0], [])
  return withoutCheque(
    voucher,
    ALL_CANCELLED,
    `Every check naming this voucher was cancelled or voided: ${dead.map(describeConflict).join('; ')}.`,
  )
}

/**
 * A voucher known only to `StagedCheck`.
 *
 * The staged row DOES carry a cheque number, and it stays out of `CHECK NUMBER`
 * deliberately: the row was staged because nothing said which company's cheque
 * it is, and therefore which bank's. A number with no bank feeding the
 * workbook's `bank` column is precisely the guess staging exists to prevent. It
 * goes in `REMARKS`, where a human reads it, never in the column a formula does.
 *
 * The remark does NOT say why the row is staged, because `listVoucherCandidates`
 * reads every `StagedCheck` row with no filter on `reason` — this function
 * cannot see it and must not guess it. `NO_COMPANY` and `AMBIGUOUS_COMPANY` rows
 * are indeed unresolved company assignments, but a `NO_CHECK_NUMBER` row (twelve
 * measured) has the OPPOSITE problem: the company is fine and the cheque NUMBER
 * itself is the thing in question. Asserting "never resolved to a company" on a
 * `NO_CHECK_NUMBER` row would send whoever reads `/admin/staged` to fix a company
 * assignment that was never broken. State only what every staged row shares —
 * that it names this voucher and was never settled — and let the per-row detail
 * that follows (sheet, row, stated reference) carry the specifics.
 */
function stagedRow(voucher: string, rows: readonly StagedCandidate[]): VoucherRow {
  const where = rows
    .map((s) => {
      const at = s.sourceSheet && s.sourceRow !== null
        ? `${s.sourceSheet} row ${s.sourceRow}`
        : s.acumaticaRef ?? 'an Acumatica row'
      const stated = s.checkNumber ?? s.statedCheckRef
      return stated ? `${at} states ${stated}` : at
    })
    .join('; ')
  return withoutCheque(
    voucher,
    NOT_KEYED,
    'A staged row names this voucher and was never settled, so no check ' +
      `number can be given here — see /admin/staged. ${where}.`,
  )
}

export function resolveVoucherRows({ checks, staged }: VoucherIndexInput): VoucherRow[] {
  const byVoucher = new Map<string, CheckCandidate[]>()
  for (const c of checks) {
    const found = byVoucher.get(c.voucher)
    if (found) found.push(c)
    else byVoucher.set(c.voucher, [c])
  }

  const rows: VoucherRow[] = []
  for (const [voucher, candidates] of byVoucher) rows.push(resolveOne(voucher, candidates))

  // A voucher with a real cheque never falls back to its staged row: the cheque
  // is the better answer, and two rows for one voucher would silently break the
  // lookup, which returns whichever it meets first.
  const stagedOnly = new Map<string, StagedCandidate[]>()
  for (const s of staged) {
    if (byVoucher.has(s.voucher)) continue
    const found = stagedOnly.get(s.voucher)
    if (found) found.push(s)
    else stagedOnly.set(s.voucher, [s])
  }
  for (const [voucher, group] of stagedOnly) rows.push(stagedRow(voucher, group))

  // Sorted so two runs of the same data produce the same file. VLOOKUP's exact
  // match does not need order; a reviewer diffing two exports does.
  return rows.sort((a, b) => (a.voucher < b.voucher ? -1 : a.voucher > b.voucher ? 1 : 0))
}

const count = (n: number) => n.toLocaleString('en-PH')

/**
 * Line 2 of the scope, for the title block.
 *
 * "NO VOUCHERS" is spelled out for the same reason `describeScope` spells out
 * "NO CHEQUES MATCH": an empty table and a broken export look identical.
 */
export function describeVoucherScope(exported: number, total: number): string {
  if (exported === 0) return 'NO VOUCHERS'
  if (exported < total) return `FIRST ${count(exported)} OF ${count(total)} VOUCHERS`
  return `${count(exported)} VOUCHER${exported === 1 ? '' : 'S'}`
}
