import { describe, it, expect } from 'vitest'
import { dueBefore, isDueForAutoSign, type AutoSignFacts } from '@/lib/domain/auto-sign'

const DAY = 86_400_000
const now = new Date('2026-09-25T10:00:00Z') // 18:00 Manila, the cron's hour

const pending = (o: Partial<AutoSignFacts> = {}): AutoSignFacts => ({
  status: 'SIGNATURE_PENDING', acumaticaPaymentId: 'BPI-000123', isCheque: true,
  acumaticaStatus: 'Balanced', createdAt: new Date(now.getTime() - 3 * DAY), ...o,
})

describe('dueBefore', () => {
  it('is now minus whole calendar days of elapsed time', () => {
    expect(dueBefore(now, 3).toISOString()).toBe('2026-09-22T10:00:00.000Z')
  })
})

describe('isDueForAutoSign', () => {
  it('is due at exactly three days, and not one minute before', () => {
    expect(isDueForAutoSign(pending(), now, 3)).toBe(true)
    expect(isDueForAutoSign(pending({ createdAt: new Date(now.getTime() - 3 * DAY + 60_000) }), now, 3)).toBe(false)
  })

  it('counts the weekend: in the app Friday 18:00, due Monday 18:00', () => {
    const friday = new Date('2026-09-18T10:00:00Z')
    expect(isDueForAutoSign(pending({ createdAt: friday }), new Date('2026-09-21T10:00:00Z'), 3)).toBe(true)
  })

  it('takes a null Acumatica status as not voided', () => {
    expect(isDueForAutoSign(pending({ acumaticaStatus: null }), now, 3)).toBe(true)
  })

  it('leaves anything past SIGNATURE_PENDING, or not from Acumatica, or not a cheque, or voided', () => {
    for (const status of ['GENERATED', 'SIGNED', 'READY_FOR_RELEASE', 'RELEASED', 'CANCELLED', 'VOIDED']) {
      expect(isDueForAutoSign(pending({ status }), now, 3), status).toBe(false)
    }
    expect(isDueForAutoSign(pending({ acumaticaPaymentId: null }), now, 3)).toBe(false)
    expect(isDueForAutoSign(pending({ isCheque: false }), now, 3)).toBe(false)
    expect(isDueForAutoSign(pending({ acumaticaStatus: 'Voided' }), now, 3)).toBe(false)
  })

  it('is never due when the setting is 0 or less', () => {
    expect(isDueForAutoSign(pending({ createdAt: new Date('2020-01-01') }), now, 0)).toBe(false)
    expect(isDueForAutoSign(pending({ createdAt: new Date('2020-01-01') }), now, -1)).toBe(false)
  })
})
