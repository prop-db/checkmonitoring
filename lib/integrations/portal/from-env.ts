import { createPortalClient, type PortalClient } from './client'
import { createPortalReleasesReader, type PortalReleasesReader } from './releases'

/**
 * The one place a live portal client is built from configuration, so the
 * worker, the cron and the admin action can be tested with an injected client.
 * Names the setting, never the value.
 */
export function createPortalClientFromEnv(): PortalClient {
  const baseUrl = process.env.PORTAL_BASE_URL ?? ''
  const token = process.env.PORTAL_TOKEN ?? ''
  if (!baseUrl) throw new Error('PORTAL_BASE_URL is not set, so the Supplier Portal cannot be reached.')
  if (!token) throw new Error('PORTAL_TOKEN is not set, so the Supplier Portal cannot be reached.')
  return createPortalClient({ baseUrl, token })
}

/** The releases reader from the same configuration as the outbox client. */
export function createPortalReleasesReaderFromEnv(): PortalReleasesReader {
  const baseUrl = process.env.PORTAL_BASE_URL ?? ''
  const token = process.env.PORTAL_TOKEN ?? ''
  if (!baseUrl) throw new Error('PORTAL_BASE_URL is not set, so the Supplier Portal cannot be reached.')
  if (!token) throw new Error('PORTAL_TOKEN is not set, so the Supplier Portal cannot be reached.')
  return createPortalReleasesReader({ baseUrl, token })
}
