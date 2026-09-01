import { describe, it, expect } from 'vitest'
import { register } from '@/instrumentation'

describe('instrumentation', () => {
  it('pins the timezone to Asia/Manila', async () => {
    await register()
    expect(process.env.TZ).toBe('Asia/Manila')
  })
})
