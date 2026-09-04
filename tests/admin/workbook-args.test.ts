import { describe, it, expect } from 'vitest'
import { parseArgs } from '@/scripts/workbook-args'

describe('parseArgs', () => {
  it('takes the workbook path as an argument', () => {
    expect(parseArgs(['./CHECK MONITORING 9.1.2026.xlsx'])).toEqual({
      path: './CHECK MONITORING 9.1.2026.xlsx', dryRun: false,
    })
  })

  it('recognises the dry run in either position', () => {
    expect(parseArgs(['--dry-run', 'a.xlsx'])).toEqual({ path: 'a.xlsx', dryRun: true })
    expect(parseArgs(['a.xlsx', '--dry-run'])).toEqual({ path: 'a.xlsx', dryRun: true })
  })

  it('refuses a flag it does not recognise instead of ignoring it', () => {
    // A typo'd `--dryrun` that silently performed a real 12,227-row import is
    // the one mistake this script must not make easy.
    expect(parseArgs(['a.xlsx', '--dryrun'])).toEqual({
      error: 'Unrecognised option(s): --dryrun',
    })
  })

  it('requires exactly one path, and never assumes one', () => {
    expect(parseArgs([])).toMatchObject({ error: expect.stringContaining('No workbook path') })
    expect(parseArgs(['--dry-run'])).toMatchObject({ error: expect.stringContaining('No workbook path') })
    expect(parseArgs(['a.xlsx', 'b.xlsx'])).toMatchObject({ error: expect.stringContaining('exactly one') })
  })
})
