import { DEFAULT_MAX_BULK_SELECTION } from '@/lib/settings/defaults'
/**
 * The selection a bulk action is allowed to act on.
 *
 * Pure, and separate from the server actions, because the cap is a rule about
 * how much money one click may move and it deserves to be asserted on its own
 * rather than inferred from a database test.
 */

/**
 * The most cheques one click may act on.
 *
 * Not a performance limit. Each cheque is processed in its own transaction, so
 * a larger batch would work — it would simply take longer. The cap exists
 * because the dashboard's default view is the ~400 live cheques and a
 * select-all over a filter is exactly how "the twelve I meant" becomes "every
 * cheque in the company". Fifty is a screenful a person can still read back
 * before pressing the button, and the refusal below tells them how many they
 * actually selected so they can see the mistake.
 */
export const MAX_BULK_SELECTION = DEFAULT_MAX_BULK_SELECTION

export type SelectionResult =
  | { ok: true; checkIds: string[] }
  | { ok: false; message: string }

/**
 * Cleans a submitted selection, or refuses it.
 *
 * De-duplication happens BEFORE the cap is applied, and matters for more than
 * arithmetic: the same id submitted twice would otherwise be acted on twice,
 * and the second attempt would fail on a transition the first one just made —
 * reporting a refusal for a cheque the user did in fact release.
 *
 * A truncation is deliberately not offered. Silently acting on the first fifty
 * of sixty would leave ten cheques untouched with nothing on screen saying so.
 */
export function parseSelection(raw: readonly string[], cap: number = MAX_BULK_SELECTION): SelectionResult {
  const checkIds = [...new Set(raw.map((v) => v.trim()).filter((v) => v !== ''))]

  if (checkIds.length === 0) {
    return { ok: false, message: 'Select at least one cheque first.' }
  }

  if (checkIds.length > cap) {
    return {
      ok: false,
      message:
        `A bulk action is limited to ${cap} cheques at a time; ` +
        `${checkIds.length} are selected. Narrow the selection and try again.`,
    }
  }

  return { ok: true, checkIds }
}

/**
 * Splits a set into batches `parseSelection` will accept.
 *
 * For TODAY'S RELEASE, where the set is defined by a QUERY rather than by ticked
 * boxes: 81 cheques are ready in production and the cap is 50.
 *
 * **Batching is correct here and raising the cap is not.** The cap guards two
 * different things, both still true. Fifty concurrent interactive transactions
 * against Neon deadlock (`40P01`) — batching does not touch that, because every
 * cheque is still processed one at a time in its own transaction either way.
 * And the cap is what stops a select-all over a filter turning "the twelve I
 * meant" into "every cheque in the company" — which is a rule about an
 * UNBOUNDED, user-composed selection. TODAY'S RELEASE has no such selection:
 * the set is exactly what the panel counted, the user confirmed that count, and
 * the action refuses if the set has grown since. Raising the cap to fit 81
 * would loosen the tick-box path, which has neither of those protections, to
 * solve a problem the tick-box path does not have.
 *
 * De-duplication happens BEFORE splitting, for the reason `parseSelection`
 * gives: the same id twice is one cheque released, then a spurious refusal for
 * the transition the first release just made.
 */
export function chunkSelection(raw: readonly string[], cap: number = MAX_BULK_SELECTION): string[][] {
  const ids = [...new Set(raw.map((v) => v.trim()).filter((v) => v !== ''))]

  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += cap) {
    batches.push(ids.slice(i, i + cap))
  }
  // An empty set produces no batches at all, so a caller looping over the
  // result does nothing rather than submitting a batch of none.
  return batches
}
