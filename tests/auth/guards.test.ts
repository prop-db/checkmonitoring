import { describe, it, expect, vi, beforeEach } from 'vitest'

const redirect = vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`) })
const auth = vi.fn()

vi.mock('next/navigation', () => ({ redirect }))
vi.mock('next-auth', () => ({ default: () => ({ handlers: {}, auth, signIn: vi.fn(), signOut: vi.fn() }) }))
vi.mock('@/auth.config', () => ({ authConfig: {} }))

beforeEach(() => { redirect.mockClear(); auth.mockReset() })

describe('requireUser', () => {
  it('redirects an anonymous visitor to /login', async () => {
    auth.mockResolvedValue(null)
    const { requireUser } = await import('@/lib/auth')
    await expect(requireUser()).rejects.toThrow('REDIRECT:/login')
  })

  it('returns the session user when signed in', async () => {
    auth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'FINANCE_USER' } })
    const { requireUser } = await import('@/lib/auth')
    await expect(requireUser()).resolves.toMatchObject({ id: 'u1', role: 'FINANCE_USER' })
  })
})

describe('requireAdmin', () => {
  it('sends a non-admin back to the dashboard', async () => {
    auth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'FINANCE_USER' } })
    const { requireAdmin } = await import('@/lib/auth')
    await expect(requireAdmin()).rejects.toThrow('REDIRECT:/')
  })

  it('admits a Finance Admin', async () => {
    auth.mockResolvedValue({ user: { id: 'u2', email: 'x@y.z', name: 'B', role: 'FINANCE_ADMIN' } })
    const { requireAdmin } = await import('@/lib/auth')
    await expect(requireAdmin()).resolves.toMatchObject({ role: 'FINANCE_ADMIN' })
  })
})

/**
 * The predicate `requireUser` and the export route both ask. It exists so a
 * route handler — which has no perimeter in front of it, `middleware.ts` being
 * silently unregistered — can refuse with a 401 instead of a redirect without
 * inventing a second, weaker notion of "signed in".
 */
describe('getSessionUser', () => {
  it('answers null for an anonymous visitor rather than redirecting', async () => {
    auth.mockResolvedValue(null)
    const { getSessionUser } = await import('@/lib/auth')
    await expect(getSessionUser()).resolves.toBeNull()
    expect(redirect).not.toHaveBeenCalled()
  })

  // NextAuth keeps name and email optional on its own types. A session missing
  // either is not one this system's Credentials provider issued, and is treated
  // as no session rather than cast into shape.
  it('answers null for a half-formed session', async () => {
    for (const user of [
      { id: '', email: 'a@b.c', name: 'A', role: 'FINANCE_USER' },
      { id: 'u1', email: '', name: 'A', role: 'FINANCE_USER' },
      { id: 'u1', email: 'a@b.c', name: '', role: 'FINANCE_USER' },
    ]) {
      auth.mockResolvedValue({ user })
      const { getSessionUser } = await import('@/lib/auth')
      await expect(getSessionUser()).resolves.toBeNull()
    }
  })

  it('returns the user when signed in', async () => {
    auth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'FINANCE_ADMIN' } })
    const { getSessionUser } = await import('@/lib/auth')
    await expect(getSessionUser()).resolves.toEqual({
      id: 'u1', email: 'a@b.c', name: 'A', role: 'FINANCE_ADMIN',
    })
  })
})
