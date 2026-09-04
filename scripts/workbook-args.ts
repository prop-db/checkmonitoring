/**
 * Argument parsing for `scripts/import-workbook.ts`, in its own module so it
 * can be tested without the script's `main()` running as a side effect of the
 * import.
 *
 * The path is a required argument and there is deliberately no default. Both
 * workbooks hold the client's real supplier names and figures and are
 * gitignored; a hardcoded path is how one ends up committed, and a default is
 * how the wrong file ends up loaded.
 */
export type WorkbookArgs = { path: string; dryRun: boolean }

export function parseArgs(argv: readonly string[]): WorkbookArgs | { error: string } {
  const flags = argv.filter((a) => a.startsWith('--'))
  const rest = argv.filter((a) => !a.startsWith('--'))

  // An unrecognised flag is refused rather than ignored. A typo'd `--dryrun`
  // silently performing a real 12,227-row import is the one mistake this
  // script must not make easy.
  const unknown = flags.filter((f) => f !== '--dry-run')
  if (unknown.length > 0) return { error: `Unrecognised option(s): ${unknown.join(', ')}` }
  if (rest.length === 0) return { error: 'No workbook path was given.' }
  if (rest.length > 1) return { error: 'Give exactly one workbook path.' }

  return { path: rest[0], dryRun: flags.includes('--dry-run') }
}
