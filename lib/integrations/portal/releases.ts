/**
 * Supplier Portal -> Check Monitoring, the ONE read back from the portal (rule 12, rewritten
 * 2026-10-19): checks released on the portal (spec 2026-10-19-portal-releases-read-back-design.md).
 * GET only, with the outbox's bearer. Pure mapper; the client is the only network code.
 */
export type ReleasesFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export type PortalRelease = {
  domain: 'LOCAL' | 'BROKER'
  releaseId: number
  checkNumber: string
  apvNumbers: string[]
  releaseDate: string | null
  releasedAt: Date | null
  orNumber: string | null
  orDate: string | null
  releasedByName: string | null
  releasedByService: boolean
  updatedAt: Date
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null)
const instant = (v: unknown) => { const s = str(v); if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d }

export function mapPortalRelease(raw: unknown): PortalRelease | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const domain = str(r.domain)
  const checkNumber = str(r.checkNumber)
  const updatedAt = instant(r.updatedAt)
  const releaseId = Number(r.releaseId)
  // A release id keys the look list (lib/sync/portal-releases.ts), so a row without a usable one is refused too.
  if ((domain !== 'LOCAL' && domain !== 'BROKER') || !checkNumber || !updatedAt || !Number.isSafeInteger(releaseId) || releaseId <= 0) return null
  return {
    domain,
    releaseId,
    checkNumber,
    apvNumbers: Array.isArray(r.apvNumbers) ? r.apvNumbers.map((a) => str(a).toUpperCase()).filter(Boolean) : [],
    releaseDate: day(r.releaseDate),
    releasedAt: instant(r.releasedAt),
    orNumber: str(r.orNumber) || null,
    orDate: day(r.orDate),
    releasedByName: str(r.releasedByName) || null,
    releasedByService: r.releasedByService === true,
    updatedAt,
  }
}

/** A row mapPortalRelease refused, named by what the portal sent (final review 2026-10-19). */
export type RejectedRelease = { releaseId: string; domain: string }
export type PortalReleasesPage = { rows: PortalRelease[]; next: Date | null; rejected?: RejectedRelease[] }
export type PortalReleasesReader = { list(since: Date, limit: number): Promise<PortalReleasesPage> }

const named = (raw: unknown): RejectedRelease => {
  const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const show = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 40) : '?')
  return { releaseId: show(r.releaseId), domain: show(r.domain) }
}

export function createPortalReleasesReader(opts: { baseUrl: string; token: string; fetchImpl?: ReleasesFetch; timeoutMs?: number }): PortalReleasesReader {
  const fetchImpl: ReleasesFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/integrations/check-monitoring/releases`
  return {
    async list(since, limit) {
      const url = `${base}?since=${encodeURIComponent(since.toISOString())}&limit=${limit}`
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      })
      const text = await res.text()
      if (res.status !== 200) throw new Error(`The Supplier Portal answered ${res.status} to the releases read: ${text.slice(0, 200)}`)
      let body: { rows?: unknown; next?: unknown }
      try {
        body = JSON.parse(text) as { rows?: unknown; next?: unknown }
      } catch {
        throw new Error(`The Supplier Portal's releases read answered ${res.status} with a body that is not JSON: ${text.slice(0, 200)}`)
      }
      if (body === null || typeof body !== 'object' || !Array.isArray(body.rows)) {
        throw new Error(`The Supplier Portal's releases read answered ${res.status} without a rows array: ${text.slice(0, 200)}`)
      }
      const rows: PortalRelease[] = []
      const rejected: RejectedRelease[] = []
      for (const raw of body.rows) {
        const m = mapPortalRelease(raw)
        if (m) rows.push(m)
        else rejected.push(named(raw))
      }
      return { rows, next: instant(body.next), rejected }
    },
  }
}
