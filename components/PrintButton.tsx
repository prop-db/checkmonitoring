'use client'

/**
 * Opens the browser's own print dialog.
 *
 * An enhancement, and nothing depends on it: the print view is a complete
 * server-rendered page with a `@media print` stylesheet, so Ctrl+P produces the
 * same sheet whether this button loaded or not. The line beside it says so, for
 * the reader whose bundle never arrived and who is looking at a button that
 * does nothing.
 *
 * `.print-hide` so the button does not print itself onto the sheet.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="print-hide rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white"
    >
      PRINT
    </button>
  )
}
