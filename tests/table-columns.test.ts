import { describe, it, expect } from 'vitest'
import {
  COLUMN_KEYS, COLUMN_LABELS, ALWAYS_ON, DEFAULT_COLUMNS, COLUMN_STORAGE_KEY,
  isColumnKey, columnControls, normaliseColumns, insertColumn, toggleColumn, moveColumn, canMoveColumn, withColumns, withColumnOrder, parseColumnPreference, serialiseColumnPreference,
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
    expect(isColumnKey('releasedAt')).toBe(true)
    expect(isColumnKey('Amount')).toBe(false)
    expect(isColumnKey('sourceSheet')).toBe(false)
    expect(isColumnKey(7)).toBe(false)
    expect(isColumnKey(null)).toBe(false)
  })
})

describe('PO NUMBER', () => {
  it('sits right after APV NUMBER, labelled PO NUMBER', () => {
    expect(COLUMN_KEYS[COLUMN_KEYS.indexOf('apvNumbers') + 1]).toBe('poNumbers')
    expect(COLUMN_LABELS.poNumbers).toBe('PO NUMBER')
  })

  it('reads no v1 value: a new column must appear for viewers who chose columns before it existed', () => {
    expect(COLUMN_STORAGE_KEY).toBe('check-monitoring.columns.v2')
  })
})

describe('normaliseColumns', () => {
  // Part C3: the stored array is the VISIBLE columns IN DISPLAY ORDER.
  it('keeps the order it is given, ACTION last', () => {
    expect(normaliseColumns(['amount', 'checkNumber', 'status', 'action', 'bank']))
      .toEqual(['amount', 'checkNumber', 'status', 'bank', 'action'])
  })

  it('reads part B’s canonical-order value as the default order', () => {
    expect(normaliseColumns([...COLUMN_KEYS])).toEqual([...COLUMN_KEYS])
  })

  it('adds a missing always-on column beside its canonical neighbour', () => {
    expect(normaliseColumns(['amount'])).toEqual(['checkNumber', 'amount', 'status', 'action'])
    expect(normaliseColumns(['bank', 'amount'])).toEqual(['checkNumber', 'bank', 'amount', 'status', 'action'])
  })

  it('drops a key it does not recognise and de-duplicates', () => {
    expect(normaliseColumns(['amount', 'payeeSecretNotes', 'amount', 'bank']))
      .toEqual(['checkNumber', 'amount', 'status', 'bank', 'action'])
  })

  it('yields exactly the always-on columns when everything else is unticked', () => {
    expect(normaliseColumns([])).toEqual(['checkNumber', 'status', 'action'])
  })
})

describe('reordering', () => {
  const ORDER = ['checkNumber', 'payeeName', 'amount', 'status', 'action'] as const

  it('moves a column one place either way, never past ACTION or the ends', () => {
    expect(moveColumn([...ORDER], 'amount', -1)).toEqual(['checkNumber', 'amount', 'payeeName', 'status', 'action'])
    expect(moveColumn([...ORDER], 'payeeName', 1)).toEqual(['checkNumber', 'amount', 'payeeName', 'status', 'action'])
    expect(moveColumn([...ORDER], 'checkNumber', -1)).toEqual([...ORDER])
    expect(moveColumn([...ORDER], 'status', 1)).toEqual([...ORDER])
    expect(moveColumn([...ORDER], 'action', -1)).toEqual([...ORDER])
    expect(canMoveColumn([...ORDER], 'status', 1)).toBe(false)
    expect(canMoveColumn([...ORDER], 'status', -1)).toBe(true)
    expect(canMoveColumn([...ORDER], 'action', -1)).toBe(false)
  })

  it('hides and shows a column, bringing it back beside its canonical neighbour', () => {
    expect(toggleColumn([...ORDER], 'payeeName')).toEqual(['checkNumber', 'amount', 'status', 'action'])
    expect(toggleColumn(['checkNumber', 'amount', 'status', 'action'], 'bank'))
      .toEqual(['checkNumber', 'bank', 'amount', 'status', 'action'])
    expect(toggleColumn([...ORDER], 'status')).toEqual([...ORDER])
  })

  it('inserts at the front when no canonical predecessor is on screen', () => {
    expect(insertColumn(['amount', 'status', 'action'], 'checkNumber')).toEqual(['checkNumber', 'amount', 'status', 'action'])
  })

  it('forces columns in without disturbing the rest', () => {
    expect(withColumns(['status', 'checkNumber', 'action'], ['payeeName', 'amount']))
      .toEqual(['status', 'checkNumber', 'payeeName', 'amount', 'action'])
  })

  it('round-trips an order through storage', () => {
    const order = moveColumn([...COLUMN_KEYS], 'amount', -1)
    expect(parseColumnPreference(serialiseColumnPreference(order))).toEqual(order)
  })

  // Review fix: a column shown only because a filter is in force was written
  // into the saved preference by any move or toggle, because the handlers
  // persisted from the forced view. The preference is what is edited; a
  // forced-only column is on screen but never saved, and does not move.
  describe('columnControls — a filtered column is shown, never saved', () => {
    const PREF = ['checkNumber', 'amount', 'status', 'action'] as const
    const c = columnControls([...PREF], ['payeeName'])

    it('shows the forced column', () => {
      expect(c.visible).toEqual(['checkNumber', 'payeeName', 'amount', 'status', 'action'])
    })
    it('moves within the preference, and the forced column is not persisted', () => {
      expect(c.move('amount', 1)).toEqual(['checkNumber', 'status', 'amount', 'action'])
      expect(c.move('amount', -1)).toEqual(['amount', 'checkNumber', 'status', 'action'])
    })
    it('toggles within the preference, and the forced column is not persisted', () => {
      expect(c.toggle('amount')).toEqual(['checkNumber', 'status', 'action'])
      expect(c.toggle('bank')).toEqual(['checkNumber', 'bank', 'amount', 'status', 'action'])
    })
    it('a forced-only column cannot be moved', () => {
      expect(c.canMove('payeeName', -1)).toBe(false)
      expect(c.canMove('payeeName', 1)).toBe(false)
      expect(c.move('payeeName', 1)).toEqual([...PREF])
    })
    it('a column both saved and filtered moves like any other', () => {
      const d = columnControls([...PREF], ['amount'])
      expect(d.canMove('amount', 1)).toBe(true)
      expect(d.move('amount', 1)).toEqual(['checkNumber', 'status', 'amount', 'action'])
    })
  })

  it('keeps part B’s storage key', () => {
    expect(COLUMN_STORAGE_KEY).toBe('check-monitoring.columns.v2')
  })
})

describe('withColumnOrder', () => {
  it('writes the order onto the export link, without ACTION', () => {
    expect(withColumnOrder('/api/export?status=SIGNED', ['amount', 'checkNumber', 'status', 'action']))
      .toBe('/api/export?status=SIGNED&cols=amount%2CcheckNumber%2Cstatus')
    expect(withColumnOrder('/api/export', ['checkNumber', 'status', 'action']))
      .toBe('/api/export?cols=checkNumber%2Cstatus')
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
      .toEqual(['checkNumber', 'amount', 'status', 'bank', 'action'])
  })

  it('reads a stored preference back in the order it was stored', () => {
    expect(parseColumnPreference('["status","amount","checkNumber","action"]'))
      .toEqual(['status', 'amount', 'checkNumber', 'action'])
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
