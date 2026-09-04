import { signIn } from '@/lib/auth'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50">
      <form
        className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200"
        action={async (formData: FormData) => {
          'use server'
          await signIn('credentials', {
            email: formData.get('email'),
            password: formData.get('password'),
            redirectTo: '/',
          })
        }}
      >
        <h1 className="mb-1 text-lg font-semibold tracking-wide">CHECK RELEASE MONITORING</h1>
        <p className="mb-6 text-sm text-slate-500">FINANCE USERS ONLY</p>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            Invalid email or password.
          </p>
        )}

        <label className="mb-1 block text-xs font-medium tracking-wide text-slate-600">EMAIL</label>
        <input name="email" type="email" required autoComplete="username"
          className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <label className="mb-1 block text-xs font-medium tracking-wide text-slate-600">PASSWORD</label>
        <input name="password" type="password" required autoComplete="current-password"
          className="mb-6 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <button type="submit"
          className="w-full rounded-lg bg-slate-900 py-2 text-sm font-medium text-white hover:bg-slate-800">
          SIGN IN
        </button>

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
            lockout — that would leak exactly what the generic error hides. */}
        <p className="mt-6 text-xs leading-relaxed text-slate-500">
          After several failed attempts, sign-in is refused for a few minutes even if the password
          is correct. It clears on its own — wait a moment and try again. Nobody needs to unlock
          anything.
        </p>
      </form>
    </main>
  )
}
