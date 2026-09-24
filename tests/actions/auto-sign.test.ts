import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { autoSign } from '@/lib/domain/actions'
import { AUTO_SIGNED_ACTION } from '@/lib/domain/auto-sign'

const DAY = 86_400_000
const now = new Date('2026-09-25T10:00:00Z')

async function acumaticaPending(daysInApp: number, o: { isCheque?: boolean; acumaticaStatus?: string | null } = {}) {
  const c = await makeCheck({ status: 'SIGNATURE_PENDING', isCheque: o.isCheque ?? true })
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: `PAY-${c.id}`,
      acumaticaStatus: o.acumaticaStatus === undefined ? 'Balanced' : o.acumaticaStatus,
      createdAt: new Date(now.getTime() - daysInApp * DAY),
    },
  })
}

beforeEach(resetDb)

describe('autoSign', () => {
  it('signs a due cheque with no signing user, and writes one SYSTEM audit row', async () => {
    const c = await acumaticaPending(3)
    const signed = await autoSign(testDb, { checkId: c.id, now, days: 3 })
    expect(signed).toMatchObject({ status: 'SIGNED', signedById: null })
    expect(signed!.signedAt!.toISOString()).toBe(now.toISOString())

    const audit = await testDb.auditLog.findMany({ where: { checkId: c.id, action: AUTO_SIGNED_ACTION } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', userId: null })
    expect(audit[0].details).toMatchObject({
      from: 'SIGNATURE_PENDING', to: 'SIGNED', afterDays: 3, inAppSince: c.createdAt.toISOString(),
    })
  })

  it('queues no portal event', async () => {
    const c = await acumaticaPending(5)
    await autoSign(testDb, { checkId: c.id, now, days: 3 })
    expect(await testDb.portalEvent.count()).toBe(0)
  })

  it('returns null and writes nothing for a cheque that is not due as it stands', async () => {
    const young = await acumaticaPending(2)
    const signedByHand = await acumaticaPending(9)
    await testDb.check.update({ where: { id: signedByHand.id }, data: { status: 'SIGNED' } })
    const debitAdv = await acumaticaPending(9, { isCheque: false })

    for (const c of [young, signedByHand, debitAdv]) {
      expect(await autoSign(testDb, { checkId: c.id, now, days: 3 })).toBeNull()
    }
    expect(await testDb.auditLog.count({ where: { action: AUTO_SIGNED_ACTION } })).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: young.id } })).status).toBe('SIGNATURE_PENDING')
  })
})
