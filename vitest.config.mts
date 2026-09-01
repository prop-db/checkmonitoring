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
  },
})
