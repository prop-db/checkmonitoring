import { describe, it, expect } from 'vitest'
import { isDueForAutoSign, isManilaTuesday, mondayWindow, type AutoSignFacts } from '@/lib/domain/auto-sign'

// 29 Sep 2026 is a Tuesday (25 Sep is a Friday).
const tuesdayNoon = new Date('2026-09-29T04:00:00Z') // 12:00 Manila, Tuesday 29 Sep
const mondayStart = new Date('2026-09-27T16:00:00Z') // 00:00 Manila, Monday 28 Sep
const tuesdayStart = new Date('2026-09-28T16:00:00Z') // 00:00 Manila, Tuesday 29 Sep

const pending = (o: Partial<AutoSignFacts> = {}): AutoSignFacts => ({
  status: 'SIGNATURE_PENDING', acumaticaPaymentId: 'BPI-000123', isCheque: true,
  acumaticaStatus: 'Balanced', createdAt: new Date('2026-09-28T10:00:00Z'), reverted: false, ...o,
})

describe('isManilaTuesday', () => {
  it('is the Manila calendar day, not UTC', () => {
    expect(isManilaTuesday(tuesdayNoon)).toBe(true)
    expect(isManilaTuesday(tuesdayStart)).toBe(true)                               // Tue 00:00 Manila = Mon 16:00 UTC
    expect(isManilaTuesday(new Date(tuesdayStart.getTime() - 1))).toBe(false)      // Mon 23:59:59.999 Manila
    expect(isManilaTuesday(new Date('2026-09-29T15:59:59.999Z'))).toBe(true)       // Tue 23:59:59.999 Manila
    expect(isManilaTuesday(new Date('2026-09-29T16:00:00Z'))).toBe(false)          // Wed 00:00 Manila
  })
})

describe('mondayWindow', () => {
  it('is the Manila day before now', () => {
    expect(mondayWindow(tuesdayNoon)).toEqual({ from: mondayStart, to: tuesdayStart })
  })
})

describe('isDueForAutoSign', () => {
  it('signs Monday 00:00 and Monday 23:59:59.999 Manila at Tuesday’s run', () => {
    expect(isDueForAutoSign(pending({ createdAt: mondayStart }), tuesdayNoon, true)).toBe(true)
    expect(isDueForAutoSign(pending({ createdAt: new Date(tuesdayStart.getTime() - 1) }), tuesdayNoon, true)).toBe(true)
  })

  it('does not sign Sunday 23:59:59.999 or Tuesday 00:00 Manila', () => {
    expect(isDueForAutoSign(pending({ createdAt: new Date(mondayStart.getTime() - 1) }), tuesdayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ createdAt: tuesdayStart }), tuesdayNoon, true)).toBe(false)
  })

  it('does not reach back to an earlier Monday', () => {
    expect(isDueForAutoSign(pending({ createdAt: new Date('2026-09-21T10:00:00Z') }), tuesdayNoon, true)).toBe(false)
  })

  it('signs nothing on any day but Tuesday', () => {
    const monday = pending({ createdAt: mondayStart })
    for (const iso of ['2026-09-28T04:00:00Z', '2026-09-30T04:00:00Z', '2026-10-01T04:00:00Z', '2026-10-02T04:00:00Z', '2026-10-03T04:00:00Z', '2026-10-04T04:00:00Z']) {
      expect(isDueForAutoSign(monday, new Date(iso), true), iso).toBe(false)
    }
  })

  it('signs nothing when switched off', () => {
    expect(isDueForAutoSign(pending(), tuesdayNoon, false)).toBe(false)
  })

  it('never re-signs a check someone reverted', () => {
    expect(isDueForAutoSign(pending({ reverted: true }), tuesdayNoon, true)).toBe(false)
  })

  it('accepts a null Acumatica status', () => {
    expect(isDueForAutoSign(pending({ acumaticaStatus: null }), tuesdayNoon, true)).toBe(true)
  })

  it('refuses other statuses, register-only, non-checks and Voided', () => {
    for (const status of ['GENERATED', 'SIGNED', 'READY_FOR_RELEASE', 'RELEASED', 'CANCELLED', 'VOIDED']) {
      expect(isDueForAutoSign(pending({ status }), tuesdayNoon, true), status).toBe(false)
    }
    expect(isDueForAutoSign(pending({ acumaticaPaymentId: null }), tuesdayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ isCheque: false }), tuesdayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ acumaticaStatus: 'Voided' }), tuesdayNoon, true)).toBe(false)
  })
})
