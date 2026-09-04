import { describe, it, expect, beforeEach } from 'vitest'
import type { CheckStatus, StagedReason } from '@prisma/client'
import { testDb, resetDb } from '../helpers/db'
import { getStagedSummary, listStagedChecks, countStagedChecks } from '@/lib/admin/staged-queue'

beforeEach(resetDb)

let n = 0
const staged = (o: {
  reason?: StagedReason
  impliedStatus?: CheckStatus
  sheet?: string
  checkNumber?: string | null
  promoted?: boolean
} = {}) => {
  n += 1
  return testDb.stagedCheck.create({
    data: {
      source: 'WORKBOOK',
      sourceSheet: o.sheet ?? 'BPI RELEASED',
      sourceRow: n,
      reason: o.reason ?? 'NO_COMPANY',
      impliedStatus: o.impliedStatus ?? 'RELEASED',
      checkNumber: o.checkNumber === undefined ? `600000${1000 + n}` : o.checkNumber,
      promotedCheckId: o.promoted ? 'some-check-id' : null,
    },
  })
}

describe('the staged queue', () => {
  it('defaults to the rows that are still live work', async () => {
    // Measured 2026-09-04: 2,467 of the 2,766 staged register rows are cheques
    // already handed over and 214 are cancelled, leaving about 28 that anyone
    // has to do anything about. A queue that opens on all 2,766 shows the wrong
    // 2,738 first.
    await staged({ impliedStatus: 'RELEASED' })
    await staged({ impliedStatus: 'CANCELLED' })
    await staged({ impliedStatus: 'READY_FOR_RELEASE' })
    await staged({ impliedStatus: 'SIGNATURE_PENDING' })

    const rows = await listStagedChecks(testDb, {})
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.impliedStatus).sort()).toEqual(['READY_FOR_RELEASE', 'SIGNATURE_PENDING'])
  })

  it('puts the live rows first when everything is asked for', async () => {
    await staged({ impliedStatus: 'RELEASED' })
    await staged({ impliedStatus: 'RELEASED' })
    await staged({ impliedStatus: 'SIGNED' })

    const rows = await listStagedChecks(testDb, { scope: 'ALL' })
    expect(rows).toHaveLength(3)
    expect(rows[0].impliedStatus).toBe('SIGNED')
  })

  it('can show only the closed history', async () => {
    await staged({ impliedStatus: 'RELEASED' })
    await staged({ impliedStatus: 'SIGNED' })
    const rows = await listStagedChecks(testDb, { scope: 'CLOSED' })
    expect(rows.map((r) => r.impliedStatus)).toEqual(['RELEASED'])
  })

  it('filters by why the row was staged', async () => {
    await staged({ reason: 'NO_COMPANY', impliedStatus: 'SIGNED' })
    await staged({ reason: 'NO_CHECK_NUMBER', impliedStatus: 'SIGNED', checkNumber: null })
    const rows = await listStagedChecks(testDb, { reason: 'NO_CHECK_NUMBER' })
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe('NO_CHECK_NUMBER')
  })

  it('filters by the status the register implies', async () => {
    await staged({ impliedStatus: 'SIGNED' })
    await staged({ impliedStatus: 'READY_FOR_RELEASE' })
    const rows = await listStagedChecks(testDb, { impliedStatus: 'READY_FOR_RELEASE' })
    expect(rows).toHaveLength(1)
  })

  it('honours a filter and the scope together rather than one of them', async () => {
    await staged({ reason: 'NO_COMPANY', impliedStatus: 'RELEASED' })
    await staged({ reason: 'NO_COMPANY', impliedStatus: 'SIGNED' })
    expect(await listStagedChecks(testDb, { reason: 'NO_COMPANY' })).toHaveLength(1)
    expect(await listStagedChecks(testDb, { reason: 'NO_COMPANY', scope: 'ALL' })).toHaveLength(2)
  })

  it('counts what the filters match, ignoring the display limit', async () => {
    await staged({ impliedStatus: 'SIGNED' })
    await staged({ impliedStatus: 'SIGNED' })
    await staged({ impliedStatus: 'SIGNED' })
    expect(await listStagedChecks(testDb, {}, 2)).toHaveLength(2)
    expect(await countStagedChecks(testDb, {})).toBe(3)
  })

  it('never lets the live rows be crowded out by the closed ones under a limit', async () => {
    await staged({ impliedStatus: 'RELEASED' })
    await staged({ impliedStatus: 'RELEASED' })
    await staged({ impliedStatus: 'SIGNED' })
    const rows = await listStagedChecks(testDb, { scope: 'ALL' }, 1)
    expect(rows.map((r) => r.impliedStatus)).toEqual(['SIGNED'])
  })
})

describe('getStagedSummary', () => {
  it('reports the whole pile and the part of it that is work', async () => {
    await staged({ reason: 'NO_COMPANY', impliedStatus: 'RELEASED' })
    await staged({ reason: 'NO_COMPANY', impliedStatus: 'CANCELLED' })
    await staged({ reason: 'AMBIGUOUS_COMPANY', impliedStatus: 'SIGNED' })
    await staged({ reason: 'NO_CHECK_NUMBER', impliedStatus: 'READY_FOR_RELEASE', checkNumber: null })

    const s = await getStagedSummary(testDb)
    expect(s.total).toBe(4)
    expect(s.live).toBe(2)
    expect(s.closed).toBe(2)
    expect(s.byReason).toEqual({ NO_COMPANY: 2, AMBIGUOUS_COMPANY: 1, NO_CHECK_NUMBER: 1 })
    expect(s.byImpliedStatus).toContainEqual({ status: 'SIGNED', count: 1 })
  })

  it('counts the rows the sync has since linked to a cheque', async () => {
    // The staged row is linked, never deleted: it is the evidence of why the
    // cheque was held. So a promoted row is still in the queue and has to be
    // countable, or the backlog never appears to shrink.
    await staged({ promoted: true, impliedStatus: 'SIGNED' })
    await staged({ impliedStatus: 'SIGNED' })
    const s = await getStagedSummary(testDb)
    expect(s.promoted).toBe(1)
  })
})
