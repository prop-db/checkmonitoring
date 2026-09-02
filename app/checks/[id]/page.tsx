import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { formatPhp } from '@/lib/money'
import { StatusPill } from '@/components/StatusPill'
import { AuditTrail } from '@/components/AuditTrail'
import { ReadyForReleaseForm } from '@/components/ReadyForReleaseForm'
import { ActionForm } from '@/components/ActionForm'
import { signAction, releaseAction } from '../actions'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const fmtDateTime = (d: Date | null) =>
  d ? d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  )
}

export default async function CheckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser()
  const { id } = await params

  const check = await prisma.check.findUnique({
    where: { id },
    include: {
      company: true, cashAccount: true, checkBook: true,
      bills: { orderBy: { apvNumber: 'asc' } },
      signedBy: true, readyBy: true, releasedBy: true,
      auditLogs: { include: { user: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!check) notFound()

  const today = new Date().toISOString().slice(0, 10)

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <Link href="/" className="text-sm text-slate-500 underline underline-offset-2">← BACK TO DASHBOARD</Link>

      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-wide">CHECK {check.checkNumber}</h1>
          <p className="text-sm text-slate-500">{check.payeeName}</p>
        </div>
        <StatusPill status={check.status} />
      </header>

      {check.eligibility === 'INTERNAL' && (
        <p className="rounded-2xl bg-slate-100 p-4 text-sm text-slate-700">
          <strong>NOT PORTAL-ELIGIBLE.</strong> This is an internal payment (payroll, tax,
          fund transfer or inter-company). It is tracked here but is never sent to the Supplier Portal.
        </p>
      )}

      <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <h2 className="mb-4 text-sm font-semibold tracking-wide">CHECK INFORMATION</h2>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label="CHECK NUMBER" value={check.checkNumber} />
          <Field label="CV NUMBER" value={check.cvNumber ?? '—'} />
          {/* Every bill, matching the dashboard table: a multi-bill check must not
              display one arbitrary APV as though it were the only one. */}
          <Field label="APV NUMBER" value={check.bills.length ? check.bills.map((b) => b.apvNumber).join(', ') : '—'} />
          <Field label="PAYEE" value={check.payeeName} />
          <Field label="COMPANY" value={check.company.code} />
          <Field label="CHECK DATE" value={fmtDate(check.checkDate)} />
          <Field label="AMOUNT" value={formatPhp(check.amount)} />
          <Field label="CASH ACCOUNT" value={check.cashAccount?.code ?? '—'} />
          <Field label="CHECK BOOK" value={check.checkBook?.code ?? '—'} />
          <Field label="CURRENCY" value={check.currency} />
          <Field label="CATEGORY" value={check.category ?? '—'} />
          <Field label="ELIGIBILITY" value={check.eligibility} />
        </dl>
      </section>

      <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <h2 className="mb-4 text-sm font-semibold tracking-wide">RELEASE MONITORING</h2>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label="SIGNED BY" value={check.signedBy?.name ?? '—'} />
          <Field label="SIGNED DATE/TIME" value={fmtDateTime(check.signedAt)} />
          <Field label="READY BY" value={check.readyBy?.name ?? '—'} />
          <Field label="READY DATE/TIME" value={fmtDateTime(check.readyAt)} />
          <Field label="AVAILABLE PICKUP DATE" value={fmtDate(check.availablePickupDate)} />
          <Field label="SUPPLIER PICKUP SCHEDULE" value={fmtDate(check.scheduledPickupDate)} />
          <Field label="RELEASED BY" value={check.releasedBy?.name ?? '—'} />
          <Field label="RELEASED DATE/TIME" value={fmtDateTime(check.releasedAt)} />
          <Field label="CLEARING STATUS" value={check.clearingStatus} />
          <Field label="CR NUMBER" value={check.crNumber ?? '—'} />
          <Field label="REMARKS" value={check.remarks ?? '—'} />
        </dl>
      </section>

      <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <h2 className="mb-4 text-sm font-semibold tracking-wide">ACTIONS</h2>

        {check.status === 'SIGNATURE_PENDING' && (
          <ActionForm
            action={signAction}
            checkId={check.id}
            label="MARK SIGNED"
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          />
        )}

        {check.status === 'SIGNED' && (
          <ReadyForReleaseForm checkId={check.id} defaultDate={today} />
        )}

        {(check.status === 'READY_FOR_RELEASE' || check.status === 'SCHEDULED') && (
          <ActionForm
            action={releaseAction}
            checkId={check.id}
            label="MARK RELEASED"
            className="block rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <label className="block text-xs font-medium tracking-wide text-slate-600">REMARKS</label>
            <input name="remarks" placeholder="Picked up by supplier"
              className="w-96 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </ActionForm>
        )}

        {check.status === 'RELEASED' && (
          <p className="text-sm text-slate-500">This check has been released.</p>
        )}
        {check.status === 'CANCELLED' && (
          <p className="text-sm text-rose-700">CANCELLED — {check.cancelReason}</p>
        )}
      </section>

      <AuditTrail rows={check.auditLogs} />
    </main>
  )
}
