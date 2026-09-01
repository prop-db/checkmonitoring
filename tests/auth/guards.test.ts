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
