import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { MAX_CLEARING_LINES } from '@/lib/clearing-paste'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }

vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser, requireAdmin: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(async () => {
  await resetDb()
  currentUser.id = (await makeUser()).id
})

const fd = (lines: string) => {
  const f = new FormData()
  f.append('lines', lines)
  return f
}

const released = (checkNumber: string) => makeCheck({ status: 'RELEASED', checkNumber })

describe('previewClearingAction', () => {
  it('classifies every line before anything is written', async () => {
    const { previewClearingAction } = await import('@/app/clearing/actions')
    const will = await released('6000000001')
    const done = await released('6000000002')
    await testDb.check.update({ where: { id: done.id }, data: { clearingStatus: 'CLEARED' } })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000003' })
    await released('6000000004')
    await released('6000000004') // a second company with the same number

    const result = await previewClearingAction(fd(
      '6000000001, 2026-09-10, BPI 1\n6000000002\n6000000003\n6000000009\n6000000004\nnot-a-number',
    ))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.map((r) => [r.checkNumber, r.verdict])).toEqual([
      ['6000000001', 'WILL_CLEAR'], ['6000000002', 'ALREADY_CLEARED'], ['6000000003', 'NOT_RELEASED'],
      ['6000000009', 'UNKNOWN'], ['6000000004', 'AMBIGUOUS'],
    ])
    expect(result.rows[0].checkId).toBe(will.id)
    expect(result.rows[0].clearedDate).toEqual(new Date('2026-09-10'))
    expect(result.rows[0].crNumber).toBe('BPI 1')
    expect(result.rows[2].detail).toBe('SIGNED')
    expect(result.errors).toEqual([{ line: 6, raw: 'not-a-number', message: 'Not a check number.' }])

    const untouched = await testDb.check.findUniqueOrThrow({ where: { id: will.id } })
    expect(untouched.clearingStatus).toBe('NONE')
  })

  it('refuses more lines than the cap, before reading the database', async () => {
    const { previewClearingAction } = await import('@/app/clearing/actions')
    const text = Array.from({ length: MAX_CLEARING_LINES + 1 }, (_, i) => `60000${String(i).padStart(5, '0')}`).join('\n')
    const result = await previewClearingAction(fd(text))
    expect(result.ok).toBe(false)
  })

  it('refuses an empty paste', async () => {
    const { previewClearingAction } = await import('@/app/clearing/actions')
    expect((await previewClearingAction(fd('\n \n'))).ok).toBe(false)
  })

  it('reads the paste cap from settings', async () => {
    const { previewClearingAction } = await import('@/app/clearing/actions')
    await testDb.setting.create({ data: { key: 'caps.bulkSelection', value: '2' } })
    const result = await previewClearingAction(fd('6000000001\n6000000002\n6000000003'))
    expect(result.ok).toBe(false)
  })
})

describe('confirmClearingAction', () => {
  it('records CLEARED, with the date and reference, only on the lines that will clear', async () => {
    const { confirmClearingAction } = await import('@/app/clearing/actions')
    const a = await released('6000000001')
    const b = await released('6000000002')
    const signed = await makeCheck({ status: 'SIGNED', checkNumber: '6000000003' })

    const result = await confirmClearingAction(fd('6000000001, 2026-09-10, BPI 1\n6000000002\n6000000003\n6000000009'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)

    const afterA = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(afterA.clearingStatus).toBe('CLEARED')
    expect(afterA.crNumber).toBe('BPI 1')
    expect(afterA.clearedDate).toEqual(new Date('2026-09-10'))
    expect(afterA.orNumber).toBeNull()
    const afterB = await testDb.check.findUniqueOrThrow({ where: { id: b.id } })
    expect(afterB.clearingStatus).toBe('CLEARED')
    expect(afterB.crNumber).toBeNull()
    expect(afterB.clearedDate).toBeNull()
    const afterSigned = await testDb.check.findUniqueOrThrow({ where: { id: signed.id } })
    expect(afterSigned.clearingStatus).toBe('NONE')

    const audit = await testDb.auditLog.findMany({ where: { checkId: a.id, action: 'clearing_recorded' } })
    expect(audit).toHaveLength(1)
    expect(audit[0].userId).toBe(currentUser.id)
  })

  it('refuses when no line would clear', async () => {
    const { confirmClearingAction } = await import('@/app/clearing/actions')
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000003' })
    const result = await confirmClearingAction(fd('6000000003\n6000000009'))
    expect(result.ok).toBe(false)
  })
})
