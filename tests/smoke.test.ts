import { describe, it, expect, afterEach } from 'vitest'
import { register } from '@/instrumentation'

describe('instrumentation', () => {
  const original = process.env.TZ

  afterEach(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })

  it('pins the timezone to Asia/Manila when none is configured', async () => {
    delete process.env.TZ
    await register()
    expect(process.env.TZ).toBe('Asia/Manila')
  })

  it('leaves an explicitly configured timezone alone', async () => {
    process.env.TZ = 'UTC'
    await register()
    expect(process.env.TZ).toBe('UTC')
  })
})
