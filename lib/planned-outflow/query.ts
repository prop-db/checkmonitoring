import type { PlannedOutflowStatus, Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

/** One planned line as the screen shows it. `amount` is a decimal STRING — rule 8. */
export type PlannedOutflowRow = {
  id: string
  date: Date
  amount: string
  currency: string
  bankId: string
  bankCode: string
  companyId: string
  companyCode: string
  description: string
  category: string | null
  status: PlannedOutflowStatus
  createdBy: string
  createdAt: Date
  paidBy: string | null
  paidAt: Date | null
  cancelledBy: string | null
  cancelledAt: Date | null
  cancelReason: string | null
}

const select = {
  id: true, date: true, amount: true, currency: true, bankId: true, companyId: true,
  description: true, category: true, status: true, createdAt: true, paidAt: true, cancelledAt: true, cancelReason: true,
  bank: { select: { code: true } }, company: { select: { code: true } },
  createdBy: { select: { name: true } }, paidBy: { select: { name: true } }, cancelledBy: { select: { name: true } },
} satisfies Prisma.PlannedOutflowSelect

type Picked = Prisma.PlannedOutflowGetPayload<{ select: typeof select }>

const toRow = (l: Picked): PlannedOutflowRow => ({
  id: l.id, date: l.date, amount: l.amount.toFixed(2), currency: l.currency,
  bankId: l.bankId, bankCode: l.bank.code, companyId: l.companyId, companyCode: l.company.code,
  description: l.description, category: l.category, status: l.status,
  createdBy: l.createdBy.name, createdAt: l.createdAt,
  paidBy: l.paidBy?.name ?? null, paidAt: l.paidAt,
  cancelledBy: l.cancelledBy?.name ?? null, cancelledAt: l.cancelledAt, cancelReason: l.cancelReason,
})

/** Open lines soonest first; then, on request, the closed ones newest first. */
export async function listPlannedOutflows(db: Db, opts: { includeClosed: boolean }): Promise<PlannedOutflowRow[]> {
  const open = await db.plannedOutflow.findMany({
    where: { status: 'PLANNED' }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }], select,
  })
  if (!opts.includeClosed) return open.map(toRow)
  const closed = await db.plannedOutflow.findMany({
    where: { status: { in: ['PAID', 'CANCELLED'] } }, orderBy: [{ updatedAt: 'desc' }], select,
  })
  return [...open, ...closed].map(toRow)
}

export async function listBanks(db: Db): Promise<{ id: string; code: string }[]> {
  return db.bank.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true } })
}
