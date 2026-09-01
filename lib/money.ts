import { Prisma } from '@prisma/client'

// Amounts are Decimal end to end. Never convert to a JS number for arithmetic;
// this helper is presentation-only and formats from the decimal string.
export function formatPhp(value: string | number | Prisma.Decimal): string {
  const asString = typeof value === 'string' ? value : value.toString()
  const [whole, fraction = ''] = asString.split('.')
  const negative = whole.startsWith('-')
  const digits = negative ? whole.slice(1) : whole
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cents = (fraction + '00').slice(0, 2)
  return `${negative ? '-' : ''}₱${grouped}.${cents}`
}
