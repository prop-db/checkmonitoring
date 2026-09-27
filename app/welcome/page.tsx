import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth'
import { CashRegister, ChequeRegister } from '@/components/MoneyMachines'
import { PresentationPlayer } from '@/components/PresentationPlayer'

/**
 * THE LANDING PAGE.
 *
 * What an anonymous visitor sees at the bare URL: a cash register on the left
 * and a cheque register on the right, both running, and one thing to do —
 * SIGN IN. It is public (`isPublicPath`), so it reads no data and shows no
 * figure: everything on it is the name of the system and where a cheque goes.
 *
 * A signed-in visitor has no business here and is sent to the dashboard. The
 * machines are for people who are not yet in; that is the brief.
 *
 * Rule 1 still holds — this is not a supplier page. It names the system and
 * asks for a Finance sign-in, nothing else.
 */
export default async function WelcomePage() {
  if (await getSessionUser()) redirect('/')

  return (
    <main className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-navy text-xs font-semibold tracking-widest text-white shadow-sm"
          >
            CR
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-wide text-navy">CHECK RELEASE MONITORING</p>
            <p className="text-[10px] font-semibold tracking-widest text-slate-400">RCL FINANCE · INTERNAL</p>
          </div>
        </div>
        <Link
          href="/login"
          className="shrink-0 whitespace-nowrap rounded-lg bg-navy px-5 py-2.5 text-sm font-medium tracking-wide text-white shadow-sm transition hover:bg-navy/90"
        >
          SIGN IN
        </Link>
      </header>

      <section className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-6 py-8 lg:grid-cols-[1fr_1.15fr_1fr]">
        <div className="order-2 lg:order-1">
          <CashRegister className="mx-auto w-full max-w-xs" />
          <p className="mt-2 text-center text-[11px] font-semibold tracking-widest text-slate-400">CASH REGISTER</p>
        </div>

        <div className="order-1 text-center lg:order-2">
          <h1 className="text-2xl font-semibold tracking-wide text-navy sm:text-3xl">CHECK RELEASE MONITORING</h1>
          <p className="mt-2 text-[11px] font-semibold tracking-[0.3em] text-slate-400">FINANCE USERS ONLY</p>

          {/* TEMPORARY — for the presentation (2026-09-27), to be removed
              afterwards on the user's own word. Their photo, dancing to a
              chorus-tempo loop (`mm-dance` in globals.css): a sway, a bounce
              and a pulse of light, with notes floating up. No audio — the song
              is not ours to ship. Delete this block and public/presenter.jpg
              together. */}
          <div className="relative mx-auto mt-8 h-72 w-56">
            <div aria-hidden="true" className="mm-glow absolute inset-0 rounded-[2rem] bg-gradient-to-br from-lavender-bg via-sky-bg to-success-bg blur-xl" />
            {['-0.2s', '-0.7s', '-1.2s'].map((delay, i) => (
              <span
                key={delay}
                aria-hidden="true"
                className="mm-notefloat absolute select-none text-2xl font-bold text-lavender-ink"
                style={{ animationDelay: delay, left: `${[-8, 92, 40][i]}%`, bottom: `${[40, 55, 90][i]}%` }}
              >
                {i % 2 === 0 ? '♪' : '♫'}
              </span>
            ))}
            <img
              src="/presenter.jpg"
              alt="The presenter"
              className="mm-dancer relative h-full w-full rounded-[2rem] object-cover object-top shadow-lg ring-4 ring-white"
            />
          </div>
          <p className="mt-3 text-[11px] font-semibold tracking-[0.25em] text-lavender-ink">♪ PWEDE NANG MANGARAP ♪</p>
          {/* The clip is supplied by the user at public/chorus.mp3. If it is
              the full song, set `start` and `end` (seconds) to the chorus and
              only that part loops. */}
          {/* The file really is an mp4 (Windows hid the extension when it was
              renamed); browsers play its audio track. */}
          <PresentationPlayer src="/chorus.mp3.mp4" />


          <Link
            href="/login"
            className="mt-8 inline-flex h-12 items-center justify-center rounded-xl bg-navy px-8 text-sm font-medium tracking-wide text-white shadow-md transition hover:bg-navy/90"
          >
            SIGN IN TO CONTINUE
          </Link>

          <ol className="mx-auto mt-10 flex max-w-lg flex-wrap items-center justify-center gap-2 text-[11px] font-semibold tracking-wide">
            <li className="rounded-full bg-sky-bg px-3 py-1.5 text-sky-ink ring-1 ring-sky-ink/15">ACUMATICA</li>
            <li aria-hidden="true" className="text-slate-300">→</li>
            <li className="rounded-full bg-navy px-3 py-1.5 text-white">CHECK RELEASE MONITORING</li>
            <li aria-hidden="true" className="text-slate-300">→</li>
            <li className="rounded-full bg-success-bg px-3 py-1.5 text-success-ink ring-1 ring-success-ink/15">FINANCE CONFIRMATION</li>
            <li aria-hidden="true" className="text-slate-300">→</li>
            <li className="rounded-full bg-lavender-bg px-3 py-1.5 text-lavender-ink ring-1 ring-lavender-ink/15">SUPPLIER PORTAL</li>
          </ol>
        </div>

        <div className="order-3">
          <ChequeRegister className="mx-auto w-full max-w-xs" />
          <p className="mt-2 text-center text-[11px] font-semibold tracking-widest text-slate-400">CHEQUE REGISTER</p>
        </div>
      </section>

      <footer className="mx-auto w-full max-w-6xl px-6 py-6 text-center text-xs text-slate-400">
        Internal Finance system of the RCL group. Authorised users only.
      </footer>
    </main>
  )
}
