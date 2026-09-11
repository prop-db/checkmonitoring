import { describe, it, expect } from 'vitest'
import {
  FORECAST_PATH, FORECAST_EXPORT_PATH, STAGE_OPTIONS,
  parseStageParam, forecastHref, describeForecastFilters, forecastFilename,
} from '@/lib/forecast-view'

describe('STAGE_OPTIONS', () => {
  it('offers the live statuses as words, in ladder order', () => {
    expect(STAGE_OPTIONS.map((o) => o.value)).toEqual(['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED', 'PLANNED'])
    expect(STAGE_OPTIONS.find((o) => o.value === 'READY_FOR_RELEASE')!.label).toBe('READY FOR RELEASE')
  })
})

describe('parseStageParam', () => {
  it('accepts a live status in either spelling and answers the enum', () => {
    expect(parseStageParam('READY_FOR_RELEASE')).toBe('READY_FOR_RELEASE')
    expect(parseStageParam('ready for release')).toBe('READY_FOR_RELEASE')
  })

  it('refuses a closed status and nonsense', () => {
    expect(parseStageParam('RELEASED')).toBeUndefined()
    expect(parseStageParam('DELIVERED')).toBeUndefined()
    expect(parseStageParam(undefined)).toBeUndefined()
  })

  it('accepts PLANNED', () => {
    expect(parseStageParam('planned')).toBe('PLANNED')
  })
})

describe('forecastHref', () => {
  it('is the bare path with nothing set', () => {
    expect(forecastHref({})).toBe(FORECAST_PATH)
  })

  it('carries the filters, drops empties, and can point at the export', () => {
    expect(forecastHref({ bank: 'BPI', company: '', stage: 'SIGNED' })).toBe('/forecast?bank=BPI&stage=SIGNED')
    expect(forecastHref({ bank: 'BPI' }, FORECAST_EXPORT_PATH)).toBe('/api/export/forecast?bank=BPI')
  })
})

describe('describeForecastFilters', () => {
  it('names each filter in force', () => {
    expect(describeForecastFilters({ bank: 'BPI', company: 'STK', stage: 'SIGNED' }))
      .toBe('BANK: BPI  ·  COMPANY: STK  ·  STAGE: SIGNED')
  })

  it('says so when there are none', () => {
    expect(describeForecastFilters({})).toBe('No filters applied')
  })
})

describe('forecastFilename', () => {
  it('is dated in the Manila day, not the server\'s UTC one', () => {
    // 16:30Z on the 10th is 00:30 on the 11th in Manila (UTC+8) — the case
    // that would read as yesterday if the filename used local getters on a
    // UTC server, as it used to.
    expect(forecastFilename(new Date('2026-09-10T16:30:00Z'))).toBe('cash-outflow-2026-09-11.xlsx')
  })

  it('agrees with the title block on an ordinary instant too', () => {
    expect(forecastFilename(new Date('2026-09-11T02:00:00Z'))).toBe('cash-outflow-2026-09-11.xlsx')
  })
})
