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
export const MAX_BULK_SELECTION = 50

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
export function parseSelection(raw: readonly string[]): SelectionResult {
  const checkIds = [...new Set(raw.map((v) => v.trim()).filter((v) => v !== ''))]

  if (checkIds.length === 0) {
    return { ok: false, message: 'Select at least one cheque first.' }
  }

  if (checkIds.length > MAX_BULK_SELECTION) {
    return {
      ok: false,
      message:
        `A bulk action is limited to ${MAX_BULK_SELECTION} cheques at a time; ` +
        `${checkIds.length} are selected. Narrow the selection and try again.`,
    }
  }

  return { ok: true, checkIds }
}
