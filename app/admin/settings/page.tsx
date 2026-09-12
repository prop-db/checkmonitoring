import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Panel } from '@/components/Panel'
import { SettingsForm } from '@/components/SettingsForm'
import { loadSettings, categoryUsage } from '@/lib/settings/read'
import { SETTINGS, type SettingGroup } from '@/lib/settings/registry'

/**
 * `/admin/settings`. FINANCE_ADMIN only — gated by the layout and again here.
 * Ten knobs, grouped; every one bounded by the registry; every change on the
 * audit trail. The LOGIN group can be tightened freely and loosened only to
 * the floor — the client's guardrail of 2026-09-12.
 */
const GROUPS: { group: SettingGroup; title: string; note?: string }[] = [
  { group: 'SYNC', title: 'ACUMATICA SYNC' },
  { group: 'CAPS', title: 'CAPS' },
  { group: 'LOGIN', title: 'SIGN-IN THROTTLE', note: 'These can be tightened freely; they cannot be loosened past the floor shown.' },
  { group: 'CATEGORIES', title: 'CATEGORIES', note: 'Removing a category does not change what is already recorded; it stops it being chosen from now on.' },
]

export default async function SettingsPage() {
  await requireAdmin()
  const [settings, usage] = await Promise.all([loadSettings(prisma), categoryUsage(prisma)])
  const usageList = [...usage.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, u]) => ({ name, ...u }))

  return (
    <div className="space-y-6">
      {GROUPS.map(({ group, title, note }) => (
        <Panel key={group} title={title} bodyClassName="divide-y divide-hairline p-0">
          {note && <p className="px-6 pt-4 text-sm text-slate-600">{note}</p>}
          {SETTINGS.filter((d) => d.group === group).map((def) => {
            const value = settings.values[def.key]
            const text = def.kind === 'int' ? String(value) : (value as readonly string[]).join('\n')
            return (
              <SettingsForm
                key={def.key}
                def={def}
                text={text}
                overridden={settings.overridden.has(def.key)}
                outOfBounds={settings.outOfBounds.has(def.key)}
                usage={def.kind === 'list' ? usageList : undefined}
              />
            )
          })}
        </Panel>
      ))}
    </div>
  )
}
