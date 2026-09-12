import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { loadSettings, categoryUsage } from '@/lib/settings/read'
import { DEFAULTS } from '@/lib/settings/registry'

beforeEach(resetDb)

describe('loadSettings', () => {
  it('answers the defaults when the table is empty', async () => {
    const s = await loadSettings(testDb)
    expect(s.values).toEqual(DEFAULTS)
    expect(s.overridden.size).toBe(0)
    expect(s.outOfBounds.size).toBe(0)
  })

  it('applies a stored override and says which keys are overridden', async () => {
    await testDb.setting.create({ data: { key: 'sync.staleAfterHours', value: '48' } })
    await testDb.setting.create({ data: { key: 'categories', value: '["PAYROLL","RENT"]' } })
    const s = await loadSettings(testDb)
    expect(s.values['sync.staleAfterHours']).toBe(48)
    expect(s.values.categories).toEqual(['PAYROLL', 'RENT'])
    expect([...s.overridden].sort()).toEqual(['categories', 'sync.staleAfterHours'])
  })

  it('falls back to the default, and says so, for a stored value that no longer parses', async () => {
    await testDb.setting.create({ data: { key: 'login.emailFreeFailures', value: '1' } })
    await testDb.setting.create({ data: { key: 'caps.exportRows', value: 'lots' } })
    const s = await loadSettings(testDb)
    expect(s.values['login.emailFreeFailures']).toBe(DEFAULTS['login.emailFreeFailures'])
    expect(s.values['caps.exportRows']).toBe(DEFAULTS['caps.exportRows'])
    expect([...s.outOfBounds].sort()).toEqual(['caps.exportRows', 'login.emailFreeFailures'])
  })

  it('ignores a row whose key is not a setting', async () => {
    await testDb.setting.create({ data: { key: 'legacy.thing', value: 'x' } })
    const s = await loadSettings(testDb)
    expect(s.values).toEqual(DEFAULTS)
  })
})

describe('categoryUsage', () => {
  it('counts cheques and planned lines per category', async () => {
    const a = await makeCheck({ status: 'SIGNED' })
    const b = await makeCheck({ status: 'SIGNED' })
    await testDb.check.update({ where: { id: a.id }, data: { category: 'PAYROLL' } })
    await testDb.check.update({ where: { id: b.id }, data: { category: 'PAYROLL' } })
    const usage = await categoryUsage(testDb)
    expect(usage.get('PAYROLL')).toEqual({ cheques: 2, lines: 0 })
    expect(usage.get('TAX')).toBeUndefined()
  })
})
