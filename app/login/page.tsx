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
      </form>
    </main>
  )
}
