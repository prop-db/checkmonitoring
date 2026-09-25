import { describe, it, expect } from 'vitest'
import { dueBefore, isDueForAutoSign, type AutoSignFacts } from '@/lib/domain/auto-sign'

const DAY = 86_400_000
const now = new Date('2026-09-25T10:00:00Z') // 18:00 Manila, the cron's hour

const pending = (o: Partial<AutoSignFacts> = {}): AutoSignFacts => ({
  status: 'SIGNATURE_PENDING', acumaticaPaymentId: 'BPI-000123', isCheque: true,
  acumaticaStatus: 'Balanced', createdAt: new Date(now.getTime() - 3 * DAY), ...o,
})

describe('dueBefore', () => {
  it('is the first instant of the Manila day after the one N days before today', () => {
    // now = 2026-09-25T10:00Z = 18:00 Manila, 25 Sep. 3 days before is 22 Sep,
    // so this is 00:00 Manila on 23 Sep (expressed in UTC) — 22 Sep and
    // earlier are due.
    expect(dueBefore(now, 3).toISOString()).toBe('2026-09-22T16:00:00.000Z')
  })

  it('pins the exact boundary: created at dueBefore is not due, one ms earlier is', () => {
    const boundary = dueBefore(now, 3)
    expect(isDueForAutoSign(pending({ createdAt: boundary }), now, 3)).toBe(false)
    expect(isDueForAutoSign(pending({ createdAt: new Date(boundary.getTime() - 1) }), now, 3)).toBe(true)
  })
})

describe('isDueForAutoSign', () => {
  it('is due when created a few minutes into Monday\'s run and checked Thursday', () => {
    // Created Monday 2026-09-21T10:05Z (18:05 Manila) — a few minutes into
    // that run. Elapsed time would not reach 72h at Thursday's 18:00 run, but
    // Monday's Manila day is 3 calendar days before Thursday's, so it is due.
    const createdAt = new Date('2026-09-21T10:05:00Z')
    const checkedThursday = new Date('2026-09-24T10:00:00Z')
    expect(isDueForAutoSign(pending({ createdAt }), checkedThursday, 3)).toBe(true)
  })

  it('is due at the last minute of Monday and checked just after midnight Thursday', () => {
    const createdAt = new Date('2026-09-21T15:59:00Z') // 23:59 Manila Monday
    const checkedAt = new Date('2026-09-23T16:01:00Z') // 00:01 Manila Thursday
    expect(isDueForAutoSign(pending({ createdAt }), checkedAt, 3)).toBe(true)
  })

  it('is NOT due when created just after midnight Tuesday and checked just before midnight Thursday', () => {
    const createdAt = new Date('2026-09-21T16:01:00Z') // 00:01 Manila Tuesday
    const checkedAt = new Date('2026-09-24T15:59:00Z') // 23:59 Manila Thursday
    expect(isDueForAutoSign(pending({ createdAt }), checkedAt, 3)).toBe(false)
  })

  it('counts the weekend: generated Friday 18:00 Manila, due Monday 18:00 Manila', () => {
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
