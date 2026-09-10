import { signIn } from '@/lib/auth'

/**
 * THE SIGN-IN PAGE.
 *
 * The first thing anybody sees, and until 2026-09-10 a bare form on white that
 * looked like a different product from the dashboard behind it. It now sits on
 * the same tinted ground, in the same white card with the same hairline ring,
 * under the same navy.
 *
 * **Presentation only.** Nothing about authentication changed here and nothing
 * about it should: the `signIn` call, the field names, the generic error and
 * the throttle note below are all load-bearing and are reproduced exactly as
 * they were. In particular the error says the same thing whatever went wrong —
 * see the comment on the throttle note.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams

  const field =
    'h-11 w-full rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 ' +
    'placeholder:text-slate-400 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

  return (
    <main className="flex min-h-screen items-center justify-center bg-ground p-6">
      <div className="w-full max-w-sm space-y-5">
        <div className="text-center">
          {/* A mark, not a logo: this system has no brand asset and inventing
              one would put a fake company badge on a finance screen. Navy
              square, the product's initials, nothing claimed. */}
          <span
            aria-hidden="true"
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-navy text-sm font-semibold tracking-widest text-white"
          >
            CR
          </span>
          <h1 className="mt-4 text-lg font-semibold tracking-wide text-navy">
            CHECK RELEASE MONITORING
          </h1>
          <p className="mt-1 text-[11px] font-semibold tracking-widest text-slate-400">
            FINANCE USERS ONLY
          </p>
        </div>

        <form
          className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-hairline"
          action={async (formData: FormData) => {
            'use server'
            await signIn('credentials', {
              email: formData.get('email'),
              password: formData.get('password'),
              redirectTo: '/',
            })
          }}
        >
          {error && (
            // The palette's danger tone: a pale ground with dark ink, like every
            // other refusal in this application. The WORDS are unchanged and
            // must stay unchanged — see the note below.
            <p className="mb-5 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger-ink">
              Invalid email or password.
            </p>
          )}

          <label
            htmlFor="login-email"
            className="mb-1.5 block text-[11px] font-semibold tracking-widest text-slate-400"
          >
            EMAIL
          </label>
          <input
            id="login-email" name="email" type="email" required autoComplete="username"
            className={`${field} mb-4`}
          />

          <label
            htmlFor="login-password"
            className="mb-1.5 block text-[11px] font-semibold tracking-widest text-slate-400"
          >
            PASSWORD
          </label>
          <input
            id="login-password" name="password" type="password" required autoComplete="current-password"
            className={`${field} mb-6`}
          />

          <button
            type="submit"
            className="h-11 w-full rounded-lg bg-navy text-sm font-medium tracking-wide text-white transition hover:bg-navy/90"
          >
            SIGN IN
          </button>
        </form>

        {/* Static, and shown to everybody on every visit — never conditional on
            whether this visitor is actually being throttled.

            A refused sign-in says only "Invalid email or password", whether the
            password was wrong, the account is deactivated, the address is
            unknown, or the login throttle is refusing a correct password. That
            sameness is the point: a message that said "your account is locked"
            would confirm the account exists, which is precisely what
            `authorize` spends an argon2 hash per rejection to avoid revealing.

            But a Finance user who mistypes at eight in the morning and then
            gets refused with the RIGHT password deserves to understand why, so
            the explanation lives here, where it is a fact about the system
            rather than a fact about them. Do not make this appear only after a
            lockout — that would leak exactly what the generic error hides.

            Moved OUTSIDE the card in the 2026-09-10 restyle, and nothing else
            about it changed. It is a standing fact about the system, not part
            of the form, and outside the card is where it reads as one. */}
        <p className="px-2 text-xs leading-relaxed text-slate-500">
          After several failed attempts, sign-in is refused for a few minutes even if the password
          is correct. It clears on its own — wait a moment and try again. Nobody needs to unlock
          anything.
        </p>
      </div>
    </main>
  )
}
