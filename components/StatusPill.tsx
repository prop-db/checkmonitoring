const STYLES: Record<string, string> = {
  GENERATED:         'bg-slate-100 text-slate-700',
  SIGNATURE_PENDING: 'bg-amber-50 text-amber-800',
  SIGNED:            'bg-sky-50 text-sky-800',
  READY_FOR_RELEASE: 'bg-emerald-50 text-emerald-800',
  SCHEDULED:         'bg-indigo-50 text-indigo-800',
  RELEASED:          'bg-violet-50 text-violet-800',
  CANCELLED:         'bg-rose-50 text-rose-800',
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium tracking-wide ${STYLES[status] ?? STYLES.GENERATED}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}
