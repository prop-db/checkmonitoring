// Guards the most destructive mistake available in this repo: running a suite
// that truncates every table against the application database. Vitest does not
// load .env into process.env by default, and Prisma treats an `undefined` url as
// "use the schema's DATABASE_URL" — so an unset test URL fails silently and
// destructively rather than loudly.
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST
  if (!url) {
    throw new Error(
      'DATABASE_URL_TEST is not set. Tests truncate every table and must never run against ' +
      'the application database. Check that .env exists and that vitest.config.mts loads it.',
    )
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL_TEST is identical to DATABASE_URL. Refusing to run a destructive suite ' +
      'against the application database.',
    )
  }
  return url
}
