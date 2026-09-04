// Create the first FINANCE_ADMIN on a fresh database.
//
// /admin/users can create every account after this one, but it is admin-gated,
// so a brand-new database has no way in. This is the bootstrap, and nothing
// else. It is deliberately NOT a general user-management tool: accounts are
// created, retired and re-roled on the admin screen, where every change writes
// an audit row.
//
// The password is typed at this terminal with echo suppressed. It is never
// passed as an argument (argv is visible to `ps` on a shared machine), never
// written to a file, never logged, and never stored anywhere but as an argon2id
// hash. Nobody — including whoever runs this — can read it back afterwards.
//
// Usage:  node scripts/create-admin.mjs

import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'

const { PrismaClient } = await import('@prisma/client')
const { hashPassword, validatePasswordStrength } = await import('../lib/password.ts')

const rl = createInterface({ input: stdin, output: stdout })
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())))

// readline echoes everything, so the password prompt mutes the output stream
// and restores it afterwards. Without this the password sits in the scrollback
// of whoever is watching the screen.
function askHidden(q) {
  return new Promise((res) => {
    const onData = (ch) => {
      // Ctrl-C during a muted prompt would otherwise leave the terminal muted.
      if (ch.toString() === '') { rl.output.muted = false; stdout.write('\n'); process.exit(130) }
    }
    stdin.on('data', onData)
    rl.output.muted = false
    rl.question(q, (a) => {
      rl.output.muted = false
      stdin.off('data', onData)
      stdout.write('\n')
      res(a)
    })
    rl.output.muted = true
  })
}

const realWrite = rl.output.write.bind(rl.output)
rl.output.write = function (chunk, ...rest) {
  if (rl.output.muted) return true
  return realWrite(chunk, ...rest)
}

const db = new PrismaClient()

try {
  const existingAdmins = await db.user.count({ where: { role: 'FINANCE_ADMIN', active: true } })
  if (existingAdmins > 0) {
    // Refusing here is the point. Once an admin exists, accounts belong on
    // /admin/users, where the last-admin guard and the audit trail apply. A
    // script that quietly kept creating admins would be a way around both.
    console.error(
      `\nThis database already has ${existingAdmins} active FINANCE_ADMIN account(s).\n` +
      'Create further accounts from ADMINISTRATION -> USERS, where every change is audited.\n',
    )
    process.exit(1)
  }

  console.log('\nCreating the first FINANCE_ADMIN.\n')

  const name = await ask('Full name        : ')
  if (!name) throw new Error('A name is required.')

  // Lowercased and trimmed to match what `authorize` does before its lookup.
  // An account stored as J.Cruz@RCL.com.ph could never be signed into.
  const email = (await ask('Email address    : ')).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`Not an email address: ${email}`)
  if (await db.user.findUnique({ where: { email } })) throw new Error(`${email} already exists.`)

  const password = await askHidden('Password         : ')
  const again = await askHidden('Confirm password : ')
  if (password !== again) throw new Error('The two passwords do not match.')

  const strength = validatePasswordStrength(password)
  if (!strength.ok) throw new Error(strength.message)

  const user = await db.user.create({
    data: { name, email, passwordHash: await hashPassword(password), role: 'FINANCE_ADMIN', active: true },
  })

  console.log(`\nCreated ${user.email} as FINANCE_ADMIN.`)
  console.log('The password is not recoverable. Tell the person directly, and')
  console.log('create their colleagues from ADMINISTRATION -> USERS.\n')
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
} finally {
  rl.close()
  await db.$disconnect()
}
