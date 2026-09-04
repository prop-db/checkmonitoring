import { createAcumaticaClient, type AcumaticaClient } from './client'
import type { AcumaticaTenant } from './companies'

/**
 * The one place a live Acumatica client is built from configuration.
 *
 * Separated from `createAcumaticaClient` so that everything above it — the sync
 * service, the admin action, the tests — can be exercised without credentials
 * being present at all. `tests/admin/actions.test.ts` replaces this module
 * wholesale; no test in this repo has ever needed the real feed.
 *
 * The two tenants are separate Acumatica instances on separate base URLs. They
 * share a service account, which is why only the URL differs below — do not
 * infer from that that they are one system: they reuse branch codes for
 * different companies, and that is the whole reason `SyncRun.tenant` exists.
 */
export const TENANT_URL_SETTING: Readonly<Record<AcumaticaTenant, string>> = {
  GOLIVE: 'ACUMATICA_ODATA_URL',
  MANUFACTURING: 'ACUMATICA_ODATA_URL_MFG',
}

export function createClientForTenant(tenant: AcumaticaTenant): AcumaticaClient {
  const setting = TENANT_URL_SETTING[tenant]
  const baseUrl = process.env[setting] ?? ''

  // Names the setting, never the value — an error from this path is read on an
  // admin screen and pasted into a ticket. `createAcumaticaClient` holds to the
  // same rule for the credentials themselves.
  if (!baseUrl) throw new Error(`${setting} is not set, so the ${tenant} tenant cannot be read.`)

  return createAcumaticaClient({
    baseUrl,
    user: process.env.ACUMATICA_ODATA_USER ?? '',
    password: process.env.ACUMATICA_ODATA_PASSWORD ?? '',
  })
}
