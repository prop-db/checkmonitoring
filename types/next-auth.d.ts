import type { DefaultSession } from 'next-auth'

// Module augmentation: next-auth's built-in User/Session/JWT types don't know
// about our `role` field. Without this, auth.config.ts fails to typecheck
// under strict mode when it reads/writes `role` on the session, JWT token,
// and the object returned from `authorize()`.
//
// `role` is typed as the literal union, never `string`: typing it loosely
// would defeat the entire point of this augmentation, since a typo like
// `role === 'FINANCE_ADMN'` would compile clean and silently deny every
// admin. With the union, that typo is a build error.
declare module 'next-auth' {
  interface User {
    role: 'FINANCE_USER' | 'FINANCE_ADMIN'
  }

  interface Session {
    user: {
      id: string
      role: 'FINANCE_USER' | 'FINANCE_ADMIN'
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string
    role?: 'FINANCE_USER' | 'FINANCE_ADMIN'
  }
}

// `next-auth/jwt` re-exports its JWT type from `@auth/core/jwt` via `export *`,
// which does not merge declaration augmentation for consumers that resolve the
// type through that path (e.g. `NextAuthConfig["callbacks"]`, used internally
// by `auth.config.ts`). Augmenting the underlying module directly is required
// for `token.role` to carry the literal union there too.
declare module '@auth/core/jwt' {
  interface JWT {
    uid?: string
    role?: 'FINANCE_USER' | 'FINANCE_ADMIN'
  }
}
