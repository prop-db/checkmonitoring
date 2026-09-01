import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'

// Runs on the Node.js runtime, not the Edge runtime: `lib/auth.ts` pulls in
// the Credentials provider (Prisma + argon2, a native addon), neither of
// which can execute in the Edge runtime's restricted sandbox.
export const runtime = 'nodejs'

export default auth((req: NextRequest & { auth: unknown }) => {
  const isLoggedIn = Boolean(req.auth)
  const { pathname } = req.nextUrl
  const isPublic = pathname.startsWith('/login') || pathname.startsWith('/api/auth')
  if (!isLoggedIn && !isPublic) {
    return NextResponse.redirect(new URL('/login', req.nextUrl))
  }
  return NextResponse.next()
})

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
