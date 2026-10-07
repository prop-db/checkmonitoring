import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { backfillIncompleteFlags } from '@/lib/admin/backfill-incomplete'

beforeEach(resetDb)

// The 129 production cheques with no amount pre-date the flag, so something has
// to go and set it on rows nothing will import again. It repairs drift in both
// directions and reports what it changed, because a backfill that says nothing
// is one nobody can tell has run.
describe('backfillIncompleteFlags', () => {
  it('flags every check with no recorded amount', async () => {
    const a = await makeCheck({ amount: null })
    const b = await makeCheck({ amount: null })
    await testDb.check.updateMany({ where: {}, data: { isIncomplete: false } })

    const result = await backfillIncompleteFlags(testDb)

    expect(result).toEqual({ flagged: 2, unflagged: 0, incomplete: 2, total: 2 })
    const rows = await testDb.check.findMany({ where: { id: { in: [a.id, b.id] } } })
    expect(rows.every((r) => r.isIncomplete)).toBe(true)
  })

  // Re-runnable means re-runnable: the historical import is idempotent and was
  // interrupted once already, and this has to be safe to run after every one.
  it('changes nothing on a second run', async () => {
    await makeCheck({ amount: null })
    await makeCheck({ amount: '197715.42' })
    await testDb.check.updateMany({ where: {}, data: { isIncomplete: false } })

    await backfillIncompleteFlags(testDb)
    const second = await backfillIncompleteFlags(testDb)

    expect(second).toEqual({ flagged: 0, unflagged: 0, incomplete: 1, total: 2 })
  })

  // The other direction. A row flagged incomplete whose amount somebody has
  // since filled in would otherwise sit in the queue for ever, and the count on
  // the dashboard would never come down.
  it('clears the flag from a check that now records an amount', async () => {
    const check = await makeCheck({ amount: '197715.42' })
    await testDb.check.update({ where: { id: check.id }, data: { isIncomplete: true } })

    const result = await backfillIncompleteFlags(testDb)

    expect(result).toEqual({ flagged: 0, unflagged: 1, incomplete: 0, total: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).isIncomplete).toBe(false)
  })

  // A zero amount is a recorded figure, not a missing one — the same
  // distinction `formatMoney` and `getSummary` keep. A backfill that read
  // "falsy" instead of "null" would flag a cheque genuinely drawn for nothing
  // and offer it for deletion.
  it('does not flag a check recorded as zero', async () => {
    await makeCheck({ amount: '0.00' })
    const result = await backfillIncompleteFlags(testDb)
    expect(result).toEqual({ flagged: 0, unflagged: 0, incomplete: 0, total: 1 })
  })
})
