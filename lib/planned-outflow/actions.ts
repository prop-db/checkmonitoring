import type { PlannedOutflow, Prisma, PrismaClient } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { dayToDate, isIsoDay, isoDay } from '@/lib/domain/details'
import {
  checkPlannedOutflowInput, normalisePlannedOutflow, diffPlannedOutflow,
  type PlannedOutflowInput, type PlannedOutflowValues,
} from '@/lib/domain/planned-outflow'
import { loadSettings } from '@/lib/settings/read'

/**
 * The four things that happen to a planned line. Each is one transaction that
 * writes the row and its audit row together, as `lib/domain/actions.ts` does
 * for a cheque. The audit table keys on cheques, so these rows carry
 * `checkId` null and the line's id in `details` — `/admin/audit` shows them as
 * detached rows with the description alongside.
 *
 * No delete, and no way out of PAID or CANCELLED: a wrong PAID is a new line.
 */

const TX = { timeout: 30_000, maxWait: 15_000 } as const

async function loadLine(tx: Prisma.TransactionClient, id: string): Promise<PlannedOutflow> {
  const line = await tx.plannedOutflow.findUnique({ where: { id } })
  if (!line) throw new DomainError('NOT_FOUND', 'Planned outflow not found.')
  return line
}

function assertPlanned(line: PlannedOutflow): void {
  if (line.status !== 'PLANNED') {
    throw new DomainError('NOT_PLANNED', `This line is ${line.status}; a closed line is not changed. Add a new line instead.`)
  }
}

function valuesOf(line: PlannedOutflow): PlannedOutflowValues {
  return {
    date: isoDay(line.date)!, amount: line.amount.toFixed(2), currency: line.currency,
    bankId: line.bankId, companyId: line.companyId, description: line.description, category: line.category,
  }
}

async function assertRefsExist(tx: Prisma.TransactionClient, v: PlannedOutflowValues): Promise<void> {
  if (!(await tx.bank.findUnique({ where: { id: v.bankId }, select: { id: true } }))) {
    throw new DomainError('UNKNOWN_BANK', 'That bank does not exist.')
  }
  if (!(await tx.company.findUnique({ where: { id: v.companyId }, select: { id: true } }))) {
    throw new DomainError('UNKNOWN_COMPANY', 'That company does not exist.')
  }
}

function validated(input: PlannedOutflowInput, categories: readonly string[]): PlannedOutflowValues {
  const guard = checkPlannedOutflowInput(input, { categories })
  if (!guard.ok) throw new DomainError(guard.code, guard.message)
  return normalisePlannedOutflow(input)
}

export async function createPlannedOutflow(
  db: PrismaClient, args: { input: PlannedOutflowInput; userId: string; now: Date },
): Promise<PlannedOutflow> {
  return db.$transaction(async (tx) => {
    const { values } = await loadSettings(tx)
    const v = validated(args.input, values.categories)
    await assertRefsExist(tx, v)
    const line = await tx.plannedOutflow.create({
      data: {
        date: dayToDate(v.date), amount: v.amount, currency: v.currency,
        bankId: v.bankId, companyId: v.companyId, description: v.description, category: v.category,
        createdById: args.userId,
      },
    })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'planned_outflow_created',
      details: { plannedOutflowId: line.id, ...v },
    })
    return line
  }, TX)
}

export async function updatePlannedOutflow(
  db: PrismaClient, args: { id: string; input: PlannedOutflowInput; userId: string; now: Date },
): Promise<PlannedOutflow> {
  return db.$transaction(async (tx) => {
    const { values } = await loadSettings(tx)
    const line = await loadLine(tx, args.id)
    assertPlanned(line)
    // The line's own category stays allowed even if the list dropped it —
    // removing a category must not freeze the lines that carry it.
    const after = validated(args.input, line.category ? [...values.categories, line.category] : values.categories)
    const changes = diffPlannedOutflow(valuesOf(line), after)
    if (Object.keys(changes).length === 0) return line
    await assertRefsExist(tx, after)
    const updated = await tx.plannedOutflow.update({
      where: { id: line.id },
      data: {
        date: dayToDate(after.date), amount: after.amount, currency: after.currency,
        bankId: after.bankId, companyId: after.companyId, description: after.description, category: after.category,
      },
    })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'planned_outflow_updated',
      details: { plannedOutflowId: line.id, description: updated.description, changes },
    })
    return updated
  }, TX)
}

export async function markPlannedOutflowPaid(
  db: PrismaClient, args: { id: string; paidOn: string; userId: string; now: Date },
): Promise<PlannedOutflow> {
  const paidOn = args.paidOn.trim()
  if (!isIsoDay(paidOn)) throw new DomainError('INVALID_DATE', 'PAID ON must be a day, YYYY-MM-DD.')
  return db.$transaction(async (tx) => {
    const line = await loadLine(tx, args.id)
    assertPlanned(line)
    const updated = await tx.plannedOutflow.update({
      where: { id: line.id },
      data: { status: 'PAID', paidAt: dayToDate(paidOn), paidById: args.userId },
    })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'planned_outflow_paid',
      details: { plannedOutflowId: line.id, description: line.description, amount: line.amount.toFixed(2), paidOn },
    })
    return updated
  }, TX)
}

export async function cancelPlannedOutflow(
  db: PrismaClient, args: { id: string; reason: string; userId: string; now: Date },
): Promise<PlannedOutflow> {
  const reason = args.reason.trim()
  if (reason === '') throw new DomainError('REASON_REQUIRED', 'A reason is required to cancel a planned outflow.')
  return db.$transaction(async (tx) => {
    const line = await loadLine(tx, args.id)
    assertPlanned(line)
    const updated = await tx.plannedOutflow.update({
      where: { id: line.id },
      data: { status: 'CANCELLED', cancelledAt: args.now, cancelledById: args.userId, cancelReason: reason },
    })
    await writeAudit(tx, {
      actorType: 'USER', userId: args.userId, action: 'planned_outflow_cancelled', remarks: reason,
      details: { plannedOutflowId: line.id, description: line.description, amount: line.amount.toFixed(2) },
    })
    return updated
  }, TX)
}
