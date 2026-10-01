import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { revertSignature } from '@/lib/domain/actions'
import { SIGNATURE_REVERTED_ACTION } from '@/lib/domain/auto-sign'
import { DomainError } from '@/lib/domain/errors'

const now = new Date('2026-09-30T04:00:00Z')
beforeEach(resetDb)

describe('revertSignature', () => {
  it('returns a SIGNED cheque to SIGNATURE_PENDING, clears the signer, writes one row', async () => {
    const signer = await makeUser()
    const actor = await makeUser()
    const c = await makeCheck({ status: 'SIGNED' })
    await testDb.check.update({ where: { id: c.id }, data: { signedById: signer.id, signedAt: now } })

    const after = await revertSignature(testDb, { checkId: c.id, userId: actor.id, reason: 'Wrong batch', now })
    expect(after).toMatchObject({ status: 'SIGNATURE_PENDING', signedById: null, signedAt: null })

    const rows = await testDb.auditLog.findMany({ where: { checkId: c.id, action: SIGNATURE_REVERTED_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actorType: 'USER', userId: actor.id, remarks: 'Wrong batch' })
    expect(rows[0].details).toMatchObject({
      from: 'SIGNED', to: 'SIGNATURE_PENDING', previousSignerId: signer.id, previousSignedAt: now.toISOString(),
    })
  })

  it('accepts no reason, and records an auto-signed cheque as such', async () => {
    const actor = await makeUser()
    const c = await makeCheck({ status: 'SIGNED' })
    await revertSignature(testDb, { checkId: c.id, userId: actor.id, now })
    const row = await testDb.auditLog.findFirstOrThrow({ where: { checkId: c.id, action: SIGNATURE_REVERTED_ACTION } })
    expect(row.remarks).toBeNull()
    expect(row.details).toMatchObject({ previousSignerId: null, previousSignedAt: null })
  })

  it('refuses every status but SIGNED and writes nothing', async () => {
    const actor = await makeUser()
    for (const status of ['SIGNATURE_PENDING', 'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED'] as const) {
      const c = await makeCheck({ status })
      await expect(revertSignature(testDb, { checkId: c.id, userId: actor.id, now }), status).rejects.toBeInstanceOf(DomainError)
      expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe(status)
    }
    expect(await testDb.auditLog.count({ where: { action: SIGNATURE_REVERTED_ACTION } })).toBe(0)
  })

  it('queues no portal event', async () => {
    const actor = await makeUser()
    const c = await makeCheck({ status: 'SIGNED' })
    await revertSignature(testDb, { checkId: c.id, userId: actor.id, now })
    expect(await testDb.portalEvent.count({ where: { checkId: c.id } })).toBe(0)
  })
})
