import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../lib/password'
import { classifyEligibility } from '../lib/domain/eligibility'

const prisma = new PrismaClient()

const COMPANIES = [
  { code: 'STK', name: 'Starkson Packaging Inc.', legalNames: ['STARKSON PACKAGING INC.', 'STARKSON INDUSTRIES'] },
  { code: 'A1+', name: 'A1+ Multinational Packaging Inc.', legalNames: ['A1+ MULTINATIONAL PACKAGING INC.'] },
  { code: 'P&P', name: 'Paper and Plastic', legalNames: [] },
]

const BANKS = [
  { code: 'BPI', name: 'Bank of the Philippine Islands' },
  { code: 'MBTC', name: 'Metropolitan Bank and Trust Company' },
  { code: 'BDO', name: 'BDO Unibank' },
]

const CASH_ACCOUNTS = [
  { code: 'BPI STK', bank: 'BPI', company: 'STK' },
  { code: 'BPI P&P', bank: 'BPI', company: 'P&P' },
  { code: 'BPI A1', bank: 'BPI', company: 'A1+' },
  { code: 'MBTC A1+', bank: 'MBTC', company: 'A1+' },
  { code: 'MBTC P&P', bank: 'MBTC', company: 'P&P' },
  { code: 'BDO A1', bank: 'BDO', company: 'A1+' },
]

const CHECK_BOOKS = [
  { code: 'BPI-S-4636', bank: 'BPI', company: 'STK' },
  { code: 'BPI-A-5713', bank: 'BPI', company: 'A1+' },
  { code: 'BPI-S-8879', bank: 'BPI', company: 'P&P' },
  { code: 'BPI-A-8879', bank: 'BPI', company: 'P&P' },
  { code: 'MBT-A-4155', bank: 'MBTC', company: 'A1+' },
  { code: 'MBT-A-9048', bank: 'MBTC', company: 'P&P' },
  { code: 'MBT-S-9048', bank: 'MBTC', company: 'P&P' },
  { code: 'MBT-S-1121', bank: 'MBTC', company: 'STK' },
  { code: 'BDO-A-3838', bank: 'BDO', company: 'A1+' },
]

// Twelve fixture checks covering every status so the dashboard has something
// meaningful to render before the importer exists (Plan 2). Payees, amounts and
// check numbers are drawn from the real workbooks.
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

async function main() {
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

  await prisma.user.upsert({
    where: { email: 'admin@rcl.test' }, update: {},
    create: {
      email: 'admin@rcl.test', name: 'Finance Admin',
      passwordHash: await hashPassword('Adm1n!Passw0rd'), role: 'FINANCE_ADMIN',
    },
  })
  await prisma.user.upsert({
    where: { email: 'finance@rcl.test' }, update: {},
    create: {
      email: 'finance@rcl.test', name: 'Finance User',
      passwordHash: await hashPassword('F1nance!Passw0rd'), role: 'FINANCE_USER',
    },
  })

  for (const f of FIXTURES) {
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

  console.log('Seeded', COMPANIES.length, 'companies,', FIXTURES.length, 'checks')
}

main().finally(() => prisma.$disconnect())
