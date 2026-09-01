import type { DefaultSession } from 'next-auth'

// Module augmentation: next-auth's built-in User/Session/JWT types don't know
// about our `role` field. Without this, auth.config.ts fails to typecheck
// under strict mode when it reads/writes `role` on the session, JWT token,
// and the object returned from `authorize()`.
declare module 'next-auth' {
  interface User {
    role: string
  }

  interface Session {
    user: {
      id: string
      role: string
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string
    role?: string
  }
}
