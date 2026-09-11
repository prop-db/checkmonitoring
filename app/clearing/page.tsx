import { requireUser } from '@/lib/auth'
import { AppHeader } from '@/components/AppHeader'
import { Panel } from '@/components/Panel'
import { ClearingPaste } from '@/components/ClearingPaste'

/**
 * BANK CLEARING, IN BULK — the cheque side of the bank reconciliation.
 *
 * Every one of the 9,594 released cheques stood at clearing NONE on
 * 2026-09-11, because nothing on any screen could record a clearing. This
 * page takes a statement's cheque lines pasted in, shows what each will do,
 * and on confirm marks each CLEARED through the same domain action as the
 * cheque page — one transaction and one audit row per cheque. What is
 * RELEASED and not CLEARED after this is the outstanding-cheques figure; the
 * report over it comes with the statement import (sub-project 4).
 */
export default async function ClearingPage() {
  const user = await requireUser()
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <AppHeader user={user} title="BANK CLEARING" back={{ href: '/', label: '← DASHBOARD' }} showClearingLink={false} />
      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        Paste the cheque lines from a bank statement. Each line is checked against the cheques here
        and you are shown what confirming will do before anything is written. Only a RELEASED cheque
        that is not yet cleared is marked; a number this system does not know, or that two companies
        share, is named and left alone. The reference and date are the bank&rsquo;s — a supplier&rsquo;s
        receipt is recorded on the cheque itself.
      </p>
      <Panel title="MARK CLEARED FROM A STATEMENT">
        <ClearingPaste />
      </Panel>
    </main>
  )
}
