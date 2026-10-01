import { describe, it, expect } from 'vitest'
import { portalApvs } from '@/lib/integrations/portal/apvs'

describe('portalApvs', () => {
  it('prefers the cheque\'s own apvNumbers', () => {
    expect(portalApvs({ apvNumbers: ['AP-1', 'AP-2'], bills: [{ apvNumber: 'AP-9' }] })).toEqual(['AP-1', 'AP-2'])
  })
  it('falls back to the bills when apvNumbers is empty', () => {
    expect(portalApvs({ apvNumbers: [], bills: [{ apvNumber: 'AP-9' }, { apvNumber: 'AP-8' }] })).toEqual(['AP-9', 'AP-8'])
  })
  it('is empty when the cheque has neither', () => {
    expect(portalApvs({ apvNumbers: [], bills: [] })).toEqual([])
  })
  it('returns a copy, never the caller\'s array', () => {
    const apvNumbers = ['AP-1']
    const out = portalApvs({ apvNumbers, bills: [] })
    out.push('AP-X')
    expect(apvNumbers).toEqual(['AP-1'])
  })
})
