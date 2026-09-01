import { defineConfig } from 'vitest/config'
import { config } from 'dotenv'

// Vitest does not put .env into process.env on its own. Without this, every
// database test reads `undefined` for DATABASE_URL_TEST — and Prisma silently
// falls back to the schema's DATABASE_URL, aiming a suite that truncates every
// table at the application database.
// `quiet` suppresses dotenv's startup banner, which includes rotating
// promotional tips. Test output must stay pristine so real warnings are visible.
config({ quiet: true })

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // All test files share one external Neon database with no per-file
    // isolation. `resetDb()` truncates shared tables from `beforeEach`, so
    // running files in parallel lets one file's reset race another file's
    // fixture inserts (observed as a spurious FK-violation failure once the
    // suite grew large enough for the windows to overlap). Files still run
    // in one process; only cross-file concurrency is disabled.
    fileParallelism: false,
  },
})
