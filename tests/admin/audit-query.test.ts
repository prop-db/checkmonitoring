import { describe, it, expect, beforeEach } from 'vitest'
import type { Prisma } from '@prisma/client'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { listAuditRows, countAuditRows, listAuditActions, listAuditUsers } from '@/lib/audit-query'
import { AUDIT_PAGE_SIZE } from '@/lib/audit-view'

beforeEach(resetDb)

const at = (iso: string) => new Date(iso)

/**
 * Rows are created directly at a given `createdAt`, not through `writeAudit`
 * then re-dated: the append-only trigger's one exemption requires `createdAt`
 * to stay UNCHANGED (it detaches `checkId` on a deleted cheque and nothing
 * else), so a plain `auditLog.update` re-dating a row is refused — measured
 * against `audit_log_append_only()` in
 * prisma/migrations/20260905000100_audit_log_detach_on_check_delete. The
 * trigger only fires on UPDATE/DELETE, so a `create` with `createdAt` set
 * up front never touches it. `writeAudit` (lib/audit.ts) remains the only
 * writer the APPLICATION uses; this bypass is for the fixture only.
 */
async function row(o: { action: string; actor?: 'USER' | 'SYSTEM'; userId?: string; checkId?: string; createdAt: string; details?: Prisma.InputJsonValue; remarks?: string }) {
  return testDb.auditLog.create({
    data: {
      action: o.action,
      actorType: o.actor ?? 'USER',
      userId: o.userId,
      checkId: o.checkId,
      details: o.details,
      remarks: o.remarks,
      createdAt: at(o.createdAt),
    },
  })
}

describe('listAuditRows — the population', () => {
  it("shows people's actions by default and hides the system's", async () => {
    const u = await makeUser()
    await row({ action: 'released', userId: u.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T03:00:00Z' })
    const { rows } = await listAuditRows(testDb, { system: false }, null)
    expect(rows.map((r) => r.action)).toEqual(['released'])
    expect(rows[0].userName).toBe(u.name)
  })

  it('widens to everything on request, newest first', async () => {
    const u = await makeUser()
    await row({ action: 'released', userId: u.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T03:00:00Z' })
    const { rows } = await listAuditRows(testDb, { system: true }, null)
    expect(rows.map((r) => r.action)).toEqual(['imported', 'released'])
  })

  it('carries the check number from the check, or from details when the check is gone', async () => {
    const u = await makeUser()
    const check = await makeCheck({ checkNumber: '6000353106' })
    await row({ action: 'released', userId: u.id, checkId: check.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'bulk_removed_out_of_scope', actor: 'SYSTEM', createdAt: '2026-09-11T01:00:00Z', details: { checkNumber: '6000000001' } })
    const { rows } = await listAuditRows(testDb, { system: true }, null)
    expect(rows[0].checkNumber).toBe('6000353106')
    expect(rows[0].checkId).toBe(check.id)
    expect(rows[1].checkNumber).toBe('6000000001')
    expect(rows[1].checkId).toBeNull()
    expect(rows[1].plannedOutflowId).toBeNull()
  })

  it('marks a planned-outflow row as such — no check was ever involved', async () => {
    const u = await makeUser()
    await row({ action: 'planned_outflow_paid', userId: u.id, createdAt: '2026-09-12T02:00:00Z', details: { plannedOutflowId: 'po1', description: 'SEPT PAYROLL' } })
    const { rows } = await listAuditRows(testDb, { system: false }, null)
    expect(rows[0].plannedOutflowId).toBe('po1')
    expect(rows[0].checkId).toBeNull()
    expect(rows[0].checkNumber).toBeNull()
  })
})

describe('listAuditRows — the filters', () => {
  it('narrows by action, user, check number and date', async () => {
    const a = await makeUser()
    const b = await makeUser()
    const check = await makeCheck({ checkNumber: '6000353106' })
    await row({ action: 'released', userId: a.id, checkId: check.id, createdAt: '2026-09-10T02:00:00Z' })
    await row({ action: 'marked_signed', userId: b.id, createdAt: '2026-09-11T02:00:00Z' })

    expect((await listAuditRows(testDb, { system: false, action: 'released' }, null)).rows).toHaveLength(1)
    expect((await listAuditRows(testDb, { system: false, userId: b.id }, null)).rows.map((r) => r.action)).toEqual(['marked_signed'])
    expect((await listAuditRows(testDb, { system: false, checkNumber: '6000353106' }, null)).rows.map((r) => r.action)).toEqual(['released'])
    expect((await listAuditRows(testDb, {
      system: false, from: at('2026-09-10T16:00:00Z'), to: at('2026-09-11T15:59:59.999Z'),
    }, null)).rows.map((r) => r.action)).toEqual(['marked_signed'])
  })

  it('counts the same population the list shows', async () => {
    const u = await makeUser()
    await row({ action: 'released', userId: u.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T03:00:00Z' })
    expect(await countAuditRows(testDb, { system: false })).toBe(1)
    expect(await countAuditRows(testDb, { system: true })).toBe(2)
  })
})

describe('listAuditRows — the keyset', () => {
  it('pages without repeating or skipping a row, even when two share an instant', async () => {
    const u = await makeUser()
    // 101 rows: 99 distinct instants and two sharing the boundary instant.
    for (let i = 0; i < 99; i++) {
      await row({ action: `a${i}`, userId: u.id, createdAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.${String(Math.floor(i / 60))}00Z` })
    }
    await row({ action: 'twin-1', userId: u.id, createdAt: '2026-08-31T00:00:00Z' })
    await row({ action: 'twin-2', userId: u.id, createdAt: '2026-08-31T00:00:00Z' })

    const first = await listAuditRows(testDb, { system: false }, null)
    expect(first.rows).toHaveLength(AUDIT_PAGE_SIZE)
    expect(first.hasMore).toBe(true)
    const last = first.rows[first.rows.length - 1]
    const second = await listAuditRows(testDb, { system: false }, { createdAt: last.createdAt, id: last.id })
    expect(second.rows).toHaveLength(1)
    expect(second.hasMore).toBe(false)
    const seen = new Set([...first.rows, ...second.rows].map((r) => r.id))
    expect(seen.size).toBe(101)
  })
})

describe('the selects', () => {
  it('lists distinct actions, sorted, and users by name', async () => {
    const u = await makeUser()
    await row({ action: 'released', userId: u.id, createdAt: '2026-09-11T02:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T03:00:00Z' })
    await row({ action: 'imported', actor: 'SYSTEM', createdAt: '2026-09-11T04:00:00Z' })
    expect(await listAuditActions(testDb)).toEqual(['imported', 'released'])
    expect((await listAuditUsers(testDb)).map((x) => x.id)).toContain(u.id)
  })
})
