import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { isPublicPath } from '@/lib/public-paths'

// Runs on the Node.js runtime, not the Edge runtime: `lib/auth.ts` pulls in
// the Credentials provider (Prisma + argon2, a native addon), neither of
// which can execute in the Edge runtime's restricted sandbox.
//
// DOES THIS FILE RUN? Locally, no: a clean `next build` leaves the middleware
// manifest empty. On Vercel, YES — measured 2026-09-11, when production
// answered `/api/cron/sync` with a 307 to /login and NextAuth's cookies. That
// is why the public list lives in lib/public-paths.ts with a test: what this
// file waves through is a production control, and a machine-called route
// missing from that list silently becomes a login page. The page guards remain
// the primary control either way.
export const runtime = 'nodejs'

export default auth((req: NextRequest & { auth: unknown }) => {
  const isLoggedIn = Boolean(req.auth)
  const { pathname } = req.nextUrl
  const isPublic = isPublicPath(pathname)
  if (!isLoggedIn && !isPublic) {
    // The bare URL is the one an anonymous visitor types; it gets the landing
    // page. A deep link to any other page gets the form, as before — somebody
    // following a link to a cheque wants to sign in, not to read a brochure.
    // `requireUser()` still sends everyone to /login; this is a courtesy for
    // the front door, not a control.
    const target = pathname === '/' ? '/welcome' : '/login'
    return NextResponse.redirect(new URL(target, req.nextUrl))
  }
  return NextResponse.next()
})

export const config = {
  // `dancing.mp4` is the landing page's presentation clip (temporary,
  // 2026-09-27); like favicon.ico it is a static file in public/ with nothing
  // to protect, and redirected to /login it simply fails to load. Remove it
  // from here when the block in app/welcome/page.tsx goes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|dancing.mp4).*)'],
}
