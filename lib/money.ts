import { Prisma } from '@prisma/client'

// Amounts are Decimal end to end. Never convert to a JS number for arithmetic;
// this helper is presentation-only and formats from the decimal string.

// Increments a non-negative integer string. Used for the carry when rounding
// 9.999 up to 10.00 — done on the string so a 16-digit peso amount cannot lose
// precision on the way through a float.
function incrementDigits(s: string): string {
  const d = s.split('')
  for (let i = d.length - 1; i >= 0; i--) {
    if (d[i] === '9') { d[i] = '0'; continue }
    d[i] = String(Number(d[i]) + 1)
    return d.join('')
  }
  return '1' + d.join('')
}

export function formatPhp(value: string | number | Prisma.Decimal): string {
  const asString = typeof value === 'string' ? value : value.toString()
  const negative = asString.startsWith('-')
  const abs = negative ? asString.slice(1) : asString
  const [rawWhole, fraction = ''] = abs.split('.')

  // Round half-up at the third decimal rather than truncating. A money
  // formatter that truncates understates every amount it touches, which is the
  // wrong direction to be wrong in for a Finance system.
  const padded = (fraction + '000').slice(0, 3)
  let whole = rawWhole === '' ? '0' : rawWhole
  let cents = padded.slice(0, 2)
  if (padded.charCodeAt(2) - 48 >= 5) {
    const bumped = Number(cents) + 1          // two digits only; safe
    if (bumped === 100) { whole = incrementDigits(whole); cents = '00' }
    else cents = String(bumped).padStart(2, '0')
  }

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}₱${grouped}.${cents}`
}
