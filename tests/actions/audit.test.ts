import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { writeAudit } from '@/lib/audit'

beforeEach(resetDb)

describe('writeAudit', () => {
  it('appends a system row', async () => {
    await writeAudit(testDb, { actorType: 'SYSTEM', action: 'imported_from_acumatica', remarks: 'New check' })
    const rows = await testDb.auditLog.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0].actorType).toBe('SYSTEM')
    expect(rows[0].action).toBe('imported_from_acumatica')
  })

  it('appends a user row carrying structured details', async () => {
    const user = await testDb.user.create({
      data: { email: 'a@b.com', name: 'Finance User', passwordHash: 'x' },
    })
    await writeAudit(testDb, {
      actorType: 'USER', userId: user.id, action: 'ready_for_release',
      details: { pickupDate: '2026-09-03' },
    })
    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row.userId).toBe(user.id)
    expect(row.details).toEqual({ pickupDate: '2026-09-03' })
  })

  it('exposes no update or delete helper', async () => {
    const mod = await import('@/lib/audit')
    expect(Object.keys(mod)).toEqual(['writeAudit'])
  })
})
