import { defineConfig } from 'vitest/config'
import { config } from 'dotenv'

// Vitest does not put .env into process.env on its own. Without this, every
// database test reads `undefined` for DATABASE_URL_TEST — and Prisma silently
// falls back to the schema's DATABASE_URL, aiming a suite that truncates every
// table at the application database.
config()

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
})
