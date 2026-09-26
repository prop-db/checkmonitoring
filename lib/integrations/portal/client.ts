// The Supplier Portal client (spec 2026-09-26-check-monitoring-integration-
// design §2.2). One route, one bearer, one event per call. The body is built
// from the cheque AS IT STANDS at delivery time, not from the payload the
// outbox stored: the worker delivers the cheque's current truth (latest wins),
// so a stale MARK_AVAILABLE never announces a pickup date that has since moved.
//
// RULE 2, asserted here independently of portalRoute() at the outbox write
// site: an INTERNAL cheque (payroll, tax, fund transfers) must never reach a
// supplier-facing system. Two checks on purpose.
import type { Check, PortalEventKind } from '@prisma/client'
import { portalRoute, type Eligibility } from '@/lib/domain/eligibility'

export type PortalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export type CheckForPortal = Pick<
  Check, 'id' | 'checkNumber' | 'apvNumbers' | 'eligibility' | 'availablePickupDate' | 'releasedAt' | 'orNumber' | 'orDate'
> & {
  cashAccount: { bank: { code: string } } | null
  checkBook: { bank: { code: string } } | null
  bills: { apvNumber: string; poNumber: string | null }[]
}

export type PortalEventBody = {
  eventId: string
  kind: PortalEventKind
  apvs: string[]
  poNumbers: string[]
  checkNo: string
  bank: string
  availablePickupDate?: string
  releaseDate?: string
  orNumber?: string
  orDate?: string
}

export type PortalOutcome = 'applied' | 'already' | 'noop' | 'refused'
export type PortalDeliveryResult = {
  status: number
  body: {
    eventId: string
    replay: boolean
    results: { ref: string; domain: string; releaseId: number | null; outcome: PortalOutcome; reason?: string }[]
    unmatched: string[]
  } | null
}

export type PortalClient = { deliver(body: PortalEventBody): Promise<PortalDeliveryResult> }

/**
 * A defect in the payload the worker was about to send — never a delivery
 * failure. The worker parks the outbox row on this error instead of
 * retrying: an INTERNAL cheque or a missing required date does not fix
 * itself on the next attempt (spec 2026-09-26-check-monitoring-integration
 * §2.3).
 */
export class PortalPayloadError extends Error {
  constructor(public readonly code: 'INTERNAL' | 'MISSING_DATE', message: string) {
    super(message)
    this.name = 'PortalPayloadError'
  }
}

/** The Manila calendar day, as the portal's date fields expect (YYYY-MM-DD). */
export function manilaDay(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function buildPortalEventBody(event: { id: string; kind: PortalEventKind }, check: CheckForPortal): PortalEventBody {
  if (portalRoute(check.eligibility as Eligibility) === null) {
    throw new PortalPayloadError('INTERNAL', `INTERNAL cheque ${check.id} must never reach the portal.`)
  }
  // apvNumbers is the source's list; the bills are the same vouchers with
  // their PO numbers. A cheque imported before 2026-09-07 may carry only bills.
  const apvs = check.apvNumbers.length ? check.apvNumbers : check.bills.map((b) => b.apvNumber)
  const poByApv = new Map(check.bills.map((b) => [b.apvNumber, b.poNumber ?? '']))
  const body: PortalEventBody = {
    eventId: event.id,
    kind: event.kind,
    apvs,
    poNumbers: apvs.map((a) => poByApv.get(a) ?? ''),
    checkNo: check.checkNumber,
    bank: check.cashAccount?.bank.code ?? check.checkBook?.bank.code ?? '',
  }
  if (event.kind === 'MARK_AVAILABLE' || event.kind === 'RELEASE_REVERSED') {
    if (!check.availablePickupDate) {
      throw new PortalPayloadError('MISSING_DATE', `${event.kind} cheque ${check.id} has no availablePickupDate; the portal requires availablePickupDate`)
    }
    body.availablePickupDate = manilaDay(check.availablePickupDate)
  }
  if (event.kind === 'RELEASED') {
    if (!check.releasedAt) {
      throw new PortalPayloadError('MISSING_DATE', `RELEASED cheque ${check.id} has no releasedAt; the portal requires releaseDate`)
    }
    body.releaseDate = manilaDay(check.releasedAt)
    if (check.orNumber) body.orNumber = check.orNumber
    if (check.orDate) body.orDate = manilaDay(check.orDate)
  }
  return body
}

export function createPortalClient(opts: { baseUrl: string; token: string; fetchImpl?: PortalFetch }): PortalClient {
  const fetchImpl: PortalFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/integrations/check-monitoring/events`
  return {
    async deliver(body) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let parsed: PortalDeliveryResult['body'] = null
      try { parsed = JSON.parse(text) } catch { parsed = null }
      return { status: res.status, body: parsed }
    },
  }
}
