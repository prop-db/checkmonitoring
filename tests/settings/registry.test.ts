import { describe, it, expect } from 'vitest'
import {
  SETTINGS, SETTING_KEYS, DEFAULTS, settingDef, isSettingKey, parseSettingText, formatSettingText, isCategory,
} from '@/lib/settings/registry'
import { STALE_AFTER_HOURS } from '@/lib/sync/staleness'
import { MAX_BULK_SELECTION } from '@/lib/bulk'
import { EMAIL_FREE_FAILURES } from '@/lib/login-throttle'

describe('the registry', () => {
  it('declares ten settings, each key once', () => {
    expect(SETTINGS).toHaveLength(10)
    expect(new Set(SETTING_KEYS).size).toBe(10)
  })

  it('takes every default from the constant the code already uses', () => {
    expect(DEFAULTS['sync.staleAfterHours']).toBe(STALE_AFTER_HOURS)
    expect(DEFAULTS['caps.bulkSelection']).toBe(MAX_BULK_SELECTION)
    expect(DEFAULTS['login.emailFreeFailures']).toBe(EMAIL_FREE_FAILURES)
    expect(DEFAULTS.categories).toContain('PAYROLL')
  })

  it('keeps every int default inside its own bounds', () => {
    for (const d of SETTINGS) {
      if (d.kind === 'int') expect(d.default, d.key).toBeGreaterThanOrEqual(d.min)
      if (d.kind === 'int') expect(d.default, d.key).toBeLessThanOrEqual(d.max)
    }
  })

  it('finds a definition by key and refuses an unknown one', () => {
    expect(settingDef('caps.exportRows')?.kind).toBe('int')
    expect(settingDef('nope')).toBeUndefined()
    expect(isSettingKey('categories')).toBe(true)
    expect(isSettingKey('login.backoff')).toBe(false)
  })
})

describe('parseSettingText — int', () => {
  const def = settingDef('login.emailFreeFailures')!
  it('reads a whole number inside the bounds', () => {
    expect(parseSettingText(def, ' 6 ')).toEqual({ ok: true, value: 6 })
  })
  it('refuses below the floor, above the ceiling, and anything not a whole number', () => {
    expect(parseSettingText(def, '2')).toMatchObject({ ok: false })
    expect(parseSettingText(def, '11')).toMatchObject({ ok: false })
    expect(parseSettingText(def, '4.5')).toMatchObject({ ok: false })
    expect(parseSettingText(def, '')).toMatchObject({ ok: false })
    expect(parseSettingText(def, 'four')).toMatchObject({ ok: false })
    const r = parseSettingText(def, '2')
    if (!r.ok) expect(r.message).toMatch(/3/)
  })
  it('formats back to the digits', () => {
    expect(formatSettingText(def, 6)).toBe('6')
  })
})

describe('parseSettingText — the category list', () => {
  const def = settingDef('categories')!
  it('reads one per line, trims, upper-cases, drops blanks, refuses duplicates and an empty list', () => {
    expect(parseSettingText(def, ' payroll \n\nTax\r\nLocal Supplier\n')).toEqual({ ok: true, value: ['PAYROLL', 'TAX', 'LOCAL SUPPLIER'] })
    expect(parseSettingText(def, 'PAYROLL\npayroll')).toMatchObject({ ok: false })
    expect(parseSettingText(def, '\n \n')).toMatchObject({ ok: false })
  })
  it('stores as a JSON array and formats one per line', () => {
    expect(formatSettingText(def, ['PAYROLL', 'TAX'])).toBe('["PAYROLL","TAX"]')
  })
  it('isCategory is exact after upper-casing', () => {
    expect(isCategory(['PAYROLL'], 'payroll')).toBe(true)
    expect(isCategory(['PAYROLL'], 'PAY ROLL')).toBe(false)
  })
})
