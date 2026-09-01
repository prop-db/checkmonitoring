type Row = {
  id: string
  createdAt: Date
  actorType: string
  action: string
  remarks: string | null
  user: { name: string } | null
}

const fmt = (d: Date) =>
  d.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function AuditTrail({ rows }: { rows: Row[] }) {
  return (
    <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
      <h2 className="mb-4 text-sm font-semibold tracking-wide">AUDIT TRAIL</h2>
      <table className="w-full text-sm">
        <thead className="text-left text-xs tracking-wide text-slate-500">
          <tr>
            <th className="pb-2">DATE/TIME</th>
            <th className="pb-2">USER</th>
            <th className="pb-2">ACTION</th>
            <th className="pb-2">REMARKS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="py-2 text-slate-600">{fmt(r.createdAt)}</td>
              <td className="py-2">{r.actorType === 'SYSTEM' ? 'SYSTEM' : r.user?.name ?? '—'}</td>
              <td className="py-2">{r.action.replace(/_/g, ' ').toUpperCase()}</td>
              <td className="py-2 text-slate-600">{r.remarks ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
