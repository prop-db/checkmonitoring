import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getStagedSummary } from '@/lib/admin/staged-queue'
import { ImportWorkbookForm } from '@/components/ImportWorkbookForm'

const n = (v: number) => v.toLocaleString('en-PH')

export default async function ImportPage() {
  await requireAdmin()
  const staged = await getStagedSummary(prisma)

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-6 ring-1 ring-slate-200">
        <h2 className="text-sm font-semibold tracking-wide">IMPORT A WORKBOOK</h2>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Nothing is written until you have seen the report and confirmed it. Import brings in what
          the workbook knows — amounts, dates, payees, cash accounts. It never changes whether a
          cheque has been signed, made available, released or cancelled: the register does not know
          those, and neither does Acumatica.
        </p>
        {/* The one-time 12,227-row load is a CLI job with a dry run, not a
            browser upload: it writes rows one at a time inside a single request
            and a timeout half way through leaves a partial import. Harmless —
            re-running finishes it — but worth saying out loud rather than
            leaving somebody to discover. */}
        <p className="mt-2 max-w-3xl text-sm text-slate-500">
          For the one-time historical load of the full register, use{' '}
          <code className="rounded bg-slate-100 px-1">npx tsx scripts/import-workbook.ts &lt;path&gt; --dry-run</code>{' '}
          first. It prints the same accounting and writes nothing.
        </p>
      </section>

      {staged.total > 0 && (
        <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">
          {n(staged.total)} row(s) are already held for review — {n(staged.live)} of them cheques
          still in the release workflow.{' '}
          <Link href="/admin/staged" className="underline underline-offset-2">
            OPEN THE STAGED QUEUE
          </Link>
        </p>
      )}

      <ImportWorkbookForm />
    </div>
  )
}
