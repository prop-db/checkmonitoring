/**
 * Apply the migrations in prisma/migrations to ONE named database.
 *
 *   node scripts/migrate.mjs test
 *   node scripts/migrate.mjs prod --confirm
 *
 * WHY THIS EXISTS. `npx prisma migrate dev` refuses to run in the
 * non-interactive shells this project is worked from, and the Neon connection
 * string carries `&` and `?`, which a shell interprets — pasting it on a command
 * line fails with "'channel_binding' is not recognized as an internal or
 * external command". Plans 1, 2 and 4 each rediscovered this by hand. The
 * answer, every time, was to spawn the Prisma CLI with the URL as an argv entry
 * and NO shell, from a script that loads .env itself. This is that script,
 * committed.
 *
 * `test` swaps the *_TEST variables in for the plain ones so `migrate deploy`
 * sees the test database as the database. `prod` uses the plain names — which
 * in .env ARE production — and refuses without --confirm, because a migration
 * against real money should never be one typo away from the test one.
 *
 * Prints the host and database it is about to touch, never the credentials.
 */
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const TARGETS = {
  test: { DATABASE_URL: 'DATABASE_URL_TEST', DIRECT_DATABASE_URL: 'DIRECT_DATABASE_URL_TEST' },
  prod: { DATABASE_URL: 'DATABASE_URL', DIRECT_DATABASE_URL: 'DIRECT_DATABASE_URL' },
}

const [target, ...flags] = process.argv.slice(2)
if (!TARGETS[target]) {
  console.error('usage: node scripts/migrate.mjs test | prod --confirm')
  process.exit(2)
}
if (target === 'prod' && !flags.includes('--confirm')) {
  console.error('Refusing to migrate PRODUCTION without --confirm.')
  process.exit(2)
}

const env = { ...process.env }
for (const [name, from] of Object.entries(TARGETS[target])) {
  const value = process.env[from]
  if (!value) {
    console.error(`${from} is not set in .env.`)
    process.exit(2)
  }
  env[name] = value
}

// Host and database only. The password is in the same string and stays there.
const where = new URL(env.DIRECT_DATABASE_URL)
console.log(`Migrating ${target.toUpperCase()}: ${where.hostname}${where.pathname}`)

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  process.execPath,
  [path.join(repo, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
  { cwd: repo, env, stdio: 'inherit' },
)
process.exit(result.status ?? 1)
