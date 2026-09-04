import { describe, it, expect } from 'vitest'
import {
  COLUMN_KEYS, COLUMN_LABELS, ALWAYS_ON, DEFAULT_COLUMNS,
  isColumnKey, normaliseColumns, parseColumnPreference, serialiseColumnPreference,
  type ColumnKey,
} from '@/lib/table-columns'

// Pure. No database, no localStorage, no DOM — the browser only ever hands
// `parseColumnPreference` a string it read out of storage, so every way that
// string can be wrong is testable here.

describe('the column set', () => {
  it('labels every column, so none can render a blank header', () => {
    for (const key of COLUMN_KEYS) {
      expect(COLUMN_LABELS[key]).toBeTruthy()
    }
    expect(Object.keys(COLUMN_LABELS).sort()).toEqual([...COLUMN_KEYS].sort())
  })

  // A row nobody can identify, whose state is invisible, or that cannot be
  // opened is not a row. These three are not offered as choices at all.
  it('always keeps the check number, the status and the action', () => {
    expect([...ALWAYS_ON]).toEqual(['checkNumber', 'status', 'action'])
    for (const key of ALWAYS_ON) expect(COLUMN_KEYS).toContain(key)
  })

  it('defaults to every column, which is what the table renders before a preference loads', () => {
    expect(DEFAULT_COLUMNS).toEqual([...COLUMN_KEYS])
  })

  it('recognises its own keys and nothing else', () => {
    expect(isColumnKey('amount')).toBe(true)
    expect(isColumnKey('bank')).toBe(true)
    expect(isColumnKey('Amount')).toBe(false)
    expect(isColumnKey('sourceSheet')).toBe(false)
    expect(isColumnKey(7)).toBe(false)
    expect(isColumnKey(null)).toBe(false)
  })
})

describe('normaliseColumns', () => {
  it('returns the canonical column order regardless of the order it was given', () => {
    expect(normaliseColumns(['amount', 'checkNumber', 'status', 'action', 'bank']))
      .toEqual(['checkNumber', 'bank', 'amount', 'status', 'action'])
  })

  it('adds the always-on columns back when a stored preference omits them', () => {
    expect(normaliseColumns(['amount'])).toEqual(['checkNumber', 'amount', 'status', 'action'])
  })

  it('drops a key it does not recognise instead of rendering an empty column', () => {
    expect(normaliseColumns(['amount', 'payeeSecretNotes', 'bank']))
      .toEqual(['checkNumber', 'bank', 'amount', 'status', 'action'])
  })

  it('de-duplicates a repeated key', () => {
    expect(normaliseColumns(['amount', 'amount', 'amount']))
      .toEqual(['checkNumber', 'amount', 'status', 'action'])
  })

  it('yields exactly the always-on columns when everything else is unticked', () => {
    expect(normaliseColumns([])).toEqual(['checkNumber', 'status', 'action'])
  })
})

describe('parseColumnPreference', () => {
  // Every one of these means "this browser has no usable preference", and the
  // caller answers by showing the full table. A fresh browser and a corrupted
  // one must both show a working table rather than a flash of nothing.
  it('reports no preference for absent, empty or unparseable storage', () => {
    expect(parseColumnPreference(null)).toBeNull()
    expect(parseColumnPreference(undefined)).toBeNull()
    expect(parseColumnPreference('')).toBeNull()
    expect(parseColumnPreference('not json at all')).toBeNull()
    expect(parseColumnPreference('{"columns":["amount"]}')).toBeNull()
    expect(parseColumnPreference('"amount"')).toBeNull()
    expect(parseColumnPreference('null')).toBeNull()
    expect(parseColumnPreference('42')).toBeNull()
  })

  it('ignores non-string entries inside an otherwise valid array', () => {
    expect(parseColumnPreference('["amount", 3, null, "bank"]'))
      .toEqual(['checkNumber', 'bank', 'amount', 'status', 'action'])
  })

  it('reads a stored preference back in canonical order', () => {
    expect(parseColumnPreference('["status","amount","checkNumber","action"]'))
      .toEqual(['checkNumber', 'amount', 'status', 'action'])
  })

  // An empty array is a CHOICE — the user unticked every optional column — and
  // is not the same fact as "no preference stored". It must not fall back to
  // showing all eleven columns again.
  it('treats an empty stored array as a real choice, not as an absent preference', () => {
    expect(parseColumnPreference('[]')).toEqual(['checkNumber', 'status', 'action'])
  })

  it('survives a round trip through serialisation', () => {
    const chosen: ColumnKey[] = ['checkNumber', 'payeeName', 'amount', 'status', 'action']
    expect(parseColumnPreference(serialiseColumnPreference(chosen))).toEqual(chosen)
  })
})
