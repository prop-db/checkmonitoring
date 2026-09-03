// A compile-time proof that the domain's hand-written status unions and Prisma's
// generated enums agree. They are deliberately separate: `lib/domain/*` must not
// import from `@prisma/client`, so the domain declares its own unions. The cost
// of that separation is that they can drift silently — which they did when
// `VOIDED` was added to the database enum and the transition table, keyed on
// the domain union, gained no entry for it. The call sites bridge with
// `as CheckStatus`, so nothing failed to compile; the first voided cheque would
// simply have crashed.
//
// These lines fail to compile if either side gains a value the other lacks.
// This file has no runtime import and no exports that matter — its whole job is
// to be type-checked.
import type { CheckStatus as PrismaCheckStatus, ClearingStatus as PrismaClearingStatus } from '@prisma/client'
import type { CheckStatus as DomainCheckStatus, ClearingStatus as DomainClearingStatus } from './domain/check-status'

type AssertNever<T extends never> = T

// If Prisma has a status the domain does not model, this errors.
export type _PrismaHasNoUnmodelledStatus = AssertNever<Exclude<PrismaCheckStatus, DomainCheckStatus>>
// If the domain models a status the database cannot store, this errors.
export type _DomainHasNoUnstorableStatus = AssertNever<Exclude<DomainCheckStatus, PrismaCheckStatus>>

// Same proof for ClearingStatus, which has the identical shape and the identical risk.
export type _PrismaHasNoUnmodelledClearingStatus = AssertNever<Exclude<PrismaClearingStatus, DomainClearingStatus>>
export type _DomainHasNoUnstorableClearingStatus = AssertNever<Exclude<DomainClearingStatus, PrismaClearingStatus>>
