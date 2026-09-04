// Push this project's production environment variables to Vercel.
//
// Reads values from the local .env and pipes each straight into
// `vercel env add` over stdin. Values are never printed, never logged, and
// never written anywhere else — only variable NAMES and a status appear on
// screen, so this is safe to run with someone watching.
//
// Usage:   node scripts/set-vercel-env.mjs
//          node scripts/set-vercel-env.mjs --dry-run
//
// Requires `vercel link` to have been run in this directory already.

import { readFileSync, existsSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const DRY = process.argv.includes('--dry-run')
const TARGET = 'production'

// Copied from .env as-is.
const FROM_ENV = [
  'DATABASE_URL',
  'DIRECT_DATABASE_URL',
  'ACUMATICA_ODATA_URL',
  'ACUMATICA_ODATA_URL_MFG',
  'ACUMATICA_ODATA_USER',
  'ACUMATICA_ODATA_PASSWORD',
  'ACUMATICA_GI_NAME',
]

// NEVER copy these. They point at the database the test suite truncates on
// every run; production must have no way to reach it. `tests/helpers/db.ts`
// refuses to run when they are absent, which is the correct failure.
const NEVER = ['DATABASE_URL_TEST', 'DIRECT_DATABASE_URL_TEST']

// The Windows shim, because PowerShell's execution policy blocks npx.ps1.
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

if (!existsSync('.env')) {
  console.error('No .env in this directory. Run from the project root.')
  process.exit(1)
}

// A value may legitimately contain '=' (connection strings do), so split once.
const env = new Map()
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
  if (m) env.set(m[1], m[2].replace(/^["']|["']$/g, ''))
}

let existing = new Set()
try {
  const out = execFileSync(NPX, ['vercel', 'env', 'ls', TARGET], { encoding: 'utf8', shell: process.platform === 'win32' })
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+([A-Z_][A-Z0-9_]*)\s/.exec(line)
    if (m) existing.add(m[1])
  }
} catch {
  console.error('Could not list existing variables. Is `vercel link` done and are you logged in?')
  process.exit(1)
}

const plan = []
for (const name of FROM_ENV) {
  if (!env.has(name)) plan.push([name, 'MISSING from .env', null])
  else if (existing.has(name)) plan.push([name, 'already set — skipping', null])
  else plan.push([name, 'will set from .env', env.get(name)])
}

// AUTH_SECRET is generated fresh rather than copied. The development value sits
// in a local .env and in shell history; anyone holding it can forge a session
// cookie for a system that shows every cheque the group has issued. A new
// random 32 bytes costs nothing and removes that entirely.
if (existing.has('AUTH_SECRET')) plan.push(['AUTH_SECRET', 'already set — skipping', null])
else plan.push(['AUTH_SECRET', 'will GENERATE a new production secret', randomBytes(32).toString('base64')])

for (const [name, value] of [
  ['AUTH_URL', 'https://checkmonitoring.rclcompanies.com'],
  ['AUTH_TRUST_HOST', 'true'],
]) {
  if (existing.has(name)) plan.push([name, 'already set — skipping', null])
  else plan.push([name, `will set to ${value}`, value])
}

console.log(`\nTarget: ${TARGET}${DRY ? '   (DRY RUN — nothing will be sent)' : ''}\n`)
for (const [name, note] of plan) console.log(`  ${name.padEnd(26)} ${note}`)
for (const n of NEVER) console.log(`  ${n.padEnd(26)} deliberately NOT sent`)
console.log()

if (DRY) process.exit(0)

let ok = 0, failed = 0
for (const [name, , value] of plan) {
  if (value === null) continue
  // The value goes in over stdin, so it never appears in the process list —
  // on a shared machine an argv-passed secret is visible to `ps`.
  const r = spawnSync(NPX, ['vercel', 'env', 'add', name, TARGET], {
    input: value, encoding: 'utf8', shell: process.platform === 'win32',
  })
  if (r.status === 0) { console.log(`  set  ${name}`); ok++ }
  else { console.error(`  FAIL ${name}: ${(r.stderr || '').trim().split('\n').pop()}`); failed++ }
}

console.log(`\n${ok} set, ${failed} failed.`)
console.log(failed === 0
  ? '\nNow redeploy so the build picks them up:\n  npx.cmd vercel --prod\n'
  : '\nFix the failures above, then re-run. Already-set variables are skipped.\n')
