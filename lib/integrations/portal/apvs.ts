/**
 * The APVs the portal would receive for a cheque — the one definition, shared
 * by the delivery client (which refuses an event with none) and by the domain
 * actions (which do not queue a CANCELLED event the portal cannot match; spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §A1). `apvNumbers` is the
 * source's list; a cheque imported before 2026-09-07 may carry only bills.
 */
export function portalApvs(
  check: { apvNumbers: readonly string[]; bills: readonly { apvNumber: string }[] },
): string[] {
  return check.apvNumbers.length ? [...check.apvNumbers] : check.bills.map((b) => b.apvNumber)
}
