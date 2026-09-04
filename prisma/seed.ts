import { PrismaClient, type Role } from '@prisma/client'
import { hashPassword } from '../lib/password'
import { classifyEligibility } from '../lib/domain/eligibility'
import { SEEDED_TEST_ACCOUNT_EMAILS, type SeededTestAccountEmail } from '../lib/admin/users'
import { COMPANIES, CASH_ACCOUNTS, CHECK_BOOKS } from './reference-data'

const prisma = new PrismaClient()

/**
 * The development accounts, keyed by the address `/admin/users` flags.
 *
 * `Record<SeededTestAccountEmail, …>` is doing real work: TypeScript requires
 * an entry for every address in `SEEDED_TEST_ACCOUNT_EMAILS` and refuses any
 * that is not in it. A third seeded account therefore cannot be added here
 * without also appearing on the admin screen flagged as one — which is the only
 * thing that gets these retired before go-live. Do not loosen this to a plain
 * array; the drift it prevents is a live known-password FINANCE_ADMIN nobody
 * was told about.
 *
 * The plaintexts live here and nowhere else. `lib/admin/users.ts` knows the
 * addresses; it must never know the passwords.
 */
const SEED_ACCOUNTS: Record<SeededTestAccountEmail, { name: string; password: string; role: Role }> = {
  'admin@rcl.test':   { name: 'Finance Admin', password: 'Adm1n!Passw0rd',   role: 'FINANCE_ADMIN' },
  'finance@rcl.test': { name: 'Finance User',  password: 'F1nance!Passw0rd', role: 'FINANCE_USER' },
}

const BANKS = [
  { code: 'BPI', name: 'Bank of the Philippine Islands' },
  { code: 'MBTC', name: 'Metropolitan Bank and Trust Company' },
  { code: 'BDO', name: 'BDO Unibank' },
]

// Twelve fixture checks covering every status so the dashboard has something
// meaningful to render before the importer exists (Plan 2). Payees, amounts and
// check numbers are drawn from the real workbooks.
//
// NOTE: every upsert below passes `update: {}` — deliberately, so re-running the
// seed is idempotent. The consequence is that **editing a fixture here and
// re-running `npm run db:seed` does nothing**: the row already exists and is
// left untouched. To pick up an edit, delete the affected rows first.
const FIXTURES = [
  { n: '6000329924', payee: 'HENKEL PHILIPPINES INC.',              amt: '197715.42', acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SIGNATURE_PENDING', apv: 'AP-ST040284', po: 'PO-ST-028143' },
  { n: '6000330768', payee: 'Hoxin Builders & Construction Supply', amt: '32500.00',  acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SIGNATURE_PENDING', apv: 'AP-ST040955', po: 'PO-ST-030072' },
  { n: '1791379619', payee: 'GDSM MARKETING',                       amt: '22300.00',  acct: 'MBTC P&P', cat: 'LOCAL SUPPLIER', status: 'SIGNED',            apv: 'AP-A1033419', po: 'PO-A1-025543' },
  { n: '6000339150', payee: 'ASIAQUEST VENTURES CORPORATION',       amt: '9240.00',   acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SIGNED',            apv: 'AP-ST041373', po: 'PO-ST-030215' },
  { n: '6000339589', payee: 'AJZ Paint Center',                     amt: '7500.00',   acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SIGNED',            apv: 'AP-ST041597', po: 'PO-ST-030378' },
  { n: '1791379613', payee: 'Kimiki Solutions Incorporated',        amt: '10138.66',  acct: 'MBTC P&P', cat: 'LOCAL SUPPLIER', status: 'READY_FOR_RELEASE', apv: 'AP-A1032167', po: 'PO-A1-024234' },
  { n: '6000339288', payee: 'Heatwave Industrial Sales',            amt: '27750.00',  acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'READY_FOR_RELEASE', apv: 'AP-ST041485', po: 'PO-ST-029574' },
  { n: '6000338178', payee: 'BELELIE ROBSON TRADING CORP.',         amt: '287520.50', acct: 'BPI STK',  cat: 'LOCAL SUPPLIER', status: 'SCHEDULED',         apv: 'AP-ST042627', po: 'PO-ST-030484' },
  { n: '6000306443', payee: 'Easytrip Services Corporation',        amt: '80552.41',  acct: 'BPI P&P',  cat: 'LOCAL SUPPLIER', status: 'RELEASED',          apv: 'AP-ST042946', po: 'PO-ST-031230' },
  { n: '6000308611', payee: 'STARKSON PACKAGING INC.',              amt: '1471800.00', acct: 'BPI STK', cat: 'PAYROLL',        status: 'SIGNED',            apv: 'AP-ST036371', po: 'PO-ST-027539' },
  { n: '1791259536', payee: 'STARKSON PACKAGING INC.',              amt: '9600000.00', acct: 'MBTC A1+', cat: 'FUND TRANSFER', status: 'SIGNED',            apv: 'AP-ST037609', po: '26XFT-0020'   },
  { n: '174602',     payee: 'A1+ MULTINATIONAL PACKAGING INC.',     amt: '16888.52',  acct: 'BDO A1',   cat: 'PAYROLL',        status: 'CANCELLED',         apv: 'AP-A1030465', po: 'PO-A1-023450' },
] as const

// Seed the reference data ONLY — companies, banks, cash accounts, checkbooks —
// and none of the demo cheques or known-password accounts.
//
// This is the mode a real production database is seeded with. The twelve
// fixtures below carry INVENTED statuses against REAL cheque numbers, which is
// harmless in development and actively misleading in production: `upsertCheck`
// never changes a status on re-import (decision D4), so a fixture marked
// READY_FOR_RELEASE keeps that status permanently even after the register says
// otherwise — and lands at the top of the dashboard, in the panel Finance reads
// first. Four of them also proved undeletable once they had audit history,
// which is `AuditLog`'s missing cascade working exactly as intended.
//
// Bootstrap the first admin with `scripts/create-admin.mjs`, which asks for a
// password at the terminal rather than shipping one in this file.
const REFERENCE_ONLY = process.argv.includes('--reference-only')

async function main() {
  // This seed creates known-password accounts. Guessing at "production" via
  // NODE_ENV doesn't work: `npm run db:seed` runs with NODE_ENV unset, so that
  // guard never fired even though the script always connects to whatever
  // DATABASE_URL points at. Instead, detect real data directly: if the target
  // database already holds checks that aren't one of our twelve fixtures, this
  // is not a fresh dev/test database and we refuse to touch it.
  const fixtureNumbers = FIXTURES.map((f) => f.n)
  const nonFixtureCount = await prisma.check.count({
    where: { checkNumber: { notIn: fixtureNumbers } },
  })
  if (nonFixtureCount > 0 && process.env.ALLOW_SEED_OVER_REAL_DATA !== 'true') {
    throw new Error(
      `Refusing to seed: the target database contains ${nonFixtureCount} checks that are not fixtures.\n` +
      'This looks like real data. Set ALLOW_SEED_OVER_REAL_DATA=true only if you are\n' +
      'certain, and never against production.',
    )
  }
  if (!REFERENCE_ONLY) console.warn(
    '\n  Seeding development accounts with known passwords:\n' +
    SEEDED_TEST_ACCOUNT_EMAILS
      .map((e) => `    ${e} / ${SEED_ACCOUNTS[e].password}  (${SEED_ACCOUNTS[e].role})\n`)
      .join('') +
    '  These MUST be retired before any production deployment. They are flagged on\n' +
    '  /admin/users; retire each one by pressing DEACTIVATE there, once a real\n' +
    '  Finance Admin exists. Never delete them: a user row carries the attribution\n' +
    '  on every cheque it signed or released.\n',
  )

  const companies = new Map<string, string>()
  for (const c of COMPANIES) {
    const row = await prisma.company.upsert({
      where: { code: c.code }, update: {}, create: c,
    })
    companies.set(c.code, row.id)
  }

  const banks = new Map<string, string>()
  for (const b of BANKS) {
    const row = await prisma.bank.upsert({ where: { code: b.code }, update: {}, create: b })
    banks.set(b.code, row.id)
  }

  const accounts = new Map<string, string>()
  for (const a of CASH_ACCOUNTS) {
    const row = await prisma.cashAccount.upsert({
      where: { code: a.code }, update: {},
      create: { code: a.code, bankId: banks.get(a.bank)!, companyId: companies.get(a.company)! },
    })
    accounts.set(a.code, row.id)
  }

  for (const cb of CHECK_BOOKS) {
    await prisma.checkBook.upsert({
      where: { code: cb.code }, update: {},
      create: { code: cb.code, bankId: banks.get(cb.bank)!, companyId: companies.get(cb.company)! },
    })
  }

  const ownNames = COMPANIES.flatMap((c) => c.legalNames)

  for (const email of REFERENCE_ONLY ? [] : SEEDED_TEST_ACCOUNT_EMAILS) {
    const account = SEED_ACCOUNTS[email]
    // `update: {}` like every other upsert here, and for the same reason — but
    // note the second consequence on this one specifically: re-seeding will NOT
    // reactivate an account somebody has retired from /admin/users. That is
    // deliberate. A seed run must not quietly re-open a known-password admin.
    await prisma.user.upsert({
      where: { email }, update: {},
      create: {
        email, name: account.name,
        passwordHash: await hashPassword(account.password), role: account.role,
      },
    })
  }

  for (const f of REFERENCE_ONLY ? [] : FIXTURES) {
    const accountCode = f.acct
    const company = CASH_ACCOUNTS.find((a) => a.code === accountCode)!.company
    const { eligibility } = classifyEligibility({
      payeeName: f.payee, category: f.cat, ownCompanyNames: ownNames,
    })
    const companyId = companies.get(company)!
    await prisma.check.upsert({
      where: { companyId_checkNumber: { companyId, checkNumber: f.n } },
      update: {},
      create: {
        companyId,
        cashAccountId: accounts.get(accountCode)!,
        checkNumber: f.n,
        checkDate: new Date('2026-09-01'),
        amount: f.amt,
        payeeName: f.payee,
        category: f.cat,
        eligibility,
        status: f.status,
        availablePickupDate:
          f.status === 'READY_FOR_RELEASE' || f.status === 'SCHEDULED' || f.status === 'RELEASED'
            ? new Date('2026-09-03') : null,
        scheduledPickupDate: f.status === 'SCHEDULED' ? new Date('2026-09-03') : null,
        releasedAt: f.status === 'RELEASED' ? new Date('2026-09-03T10:05:00+08:00') : null,
        cancelReason: f.status === 'CANCELLED' ? 'Spoiled check' : null,
        bills: { create: [{ apvNumber: f.apv, poNumber: f.po, amount: f.amt }] },
      },
    })
  }

  console.log(REFERENCE_ONLY
    ? `Seeded reference data only: ${COMPANIES.length} companies, ${CASH_ACCOUNTS.length} cash accounts, ` +
      `${CHECK_BOOKS.length} checkbooks.\nNo demo cheques and no accounts were created. ` +
      `Bootstrap the first admin with:\n  node scripts/create-admin.mjs`
    : `Seeded ${COMPANIES.length} companies, ${FIXTURES.length} checks`)
}

main().finally(() => prisma.$disconnect())
