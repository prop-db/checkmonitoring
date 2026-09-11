import { describe, it, expect } from 'vitest'
import {
  AUDIT_PATH, AUDIT_EXPORT_PATH, AUDIT_PAGE_SIZE,
  parseAuditParams, encodeCursor, decodeCursor, manilaDayStart, manilaDayEnd,
  auditHref, describeAuditFilters, actionWords, auditFilename,
} from '@/lib/audit-view'

/** Pure. The page reads these and decides nothing itself. */
describe('the cursor', () => {
  it('round-trips a (createdAt, id) pair', () => {
    const c = { createdAt: new Date('2026-09-11T02:18:51.275Z'), id: 'clx0001' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('refuses anything malformed rather than paging from garbage', () => {
    expect(decodeCursor(undefined)).toBeNull()
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-a-date|x')).toBeNull()
    expect(decodeCursor('2026-09-11T02:18:51.275Z')).toBeNull()
  })
})

describe('Manila day bounds', () => {
  it('start and end of a Manila day, as UTC instants', () => {
    expect(manilaDayStart('2026-09-11').toISOString()).toBe('2026-09-10T16:00:00.000Z')
    expect(manilaDayEnd('2026-09-11').toISOString()).toBe('2026-09-11T15:59:59.999Z')
  })
})

describe('parseAuditParams', () => {
  it('defaults to people only, no filters, first page', () => {
    const { filters, cursor } = parseAuditParams({})
    expect(filters).toEqual({ system: false })
    expect(cursor).toBeNull()
  })

  it('reads every filter, and widens to the system on request', () => {
    const { filters } = parseAuditParams({
      system: '1', action: 'release_reversed', user: 'u1', check: ' 6000353106 ', from: '2026-09-01', to: '2026-09-11',
    })
    expect(filters.system).toBe(true)
    expect(filters.action).toBe('release_reversed')
    expect(filters.userId).toBe('u1')
    expect(filters.checkNumber).toBe('6000353106')
    expect(filters.from?.toISOString()).toBe('2026-08-31T16:00:00.000Z')
    expect(filters.to?.toISOString()).toBe('2026-09-11T15:59:59.999Z')
  })

  it('ignores a date it cannot read rather than filtering to nothing', () => {
    const { filters } = parseAuditParams({ from: '11/09/2026', to: '' })
    expect(filters.from).toBeUndefined()
    expect(filters.to).toBeUndefined()
  })
})

describe('auditHref', () => {
  it('is the bare path with nothing set', () => {
    expect(auditHref({})).toBe(AUDIT_PATH)
  })

  it('carries filters and the cursor, drops empties, and can point at the export without the cursor', () => {
    expect(auditHref({ system: '1', action: 'imported', before: 'x' })).toBe('/admin/audit?system=1&action=imported&before=x')
    expect(auditHref({ system: '1', action: 'imported', before: 'x' }, AUDIT_EXPORT_PATH)).toBe('/api/export/audit?system=1&action=imported')
  })
})

describe('describeAuditFilters', () => {
  it('names each filter in force, with the user by name', () => {
    expect(describeAuditFilters(
      { system: true, action: 'release_reversed', userId: 'u1', checkNumber: '6000353106', from: manilaDayStart('2026-09-01'), to: manilaDayEnd('2026-09-11') },
      { user: 'Paolo Parcon' },
    )).toBe('INCLUDING SYSTEM ROWS  ·  ACTION: RELEASE REVERSED  ·  USER: Paolo Parcon  ·  CHECK: 6000353106  ·  FROM 2026-09-01  ·  TO 2026-09-11')
  })

  it('says what the default is', () => {
    expect(describeAuditFilters({ system: false }, {})).toBe("PEOPLE'S ACTIONS ONLY")
  })
})

describe('words and names', () => {
  it('spells an action as words', () => {
    expect(actionWords('release_reversed')).toBe('RELEASE REVERSED')
  })

  it('dates the filename on the Manila day', () => {
    expect(auditFilename(new Date('2026-09-10T16:30:00Z'))).toBe('audit-2026-09-11.xlsx')
  })

  it('pages by 100', () => {
    expect(AUDIT_PAGE_SIZE).toBe(100)
  })
})
