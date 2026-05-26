import { describe, expect, it } from 'vitest'
import { runNpmCommand } from './npmCommandRunner'

describe('npmCommandRunner', () => {
  it('runs npm --version without EINVAL on Windows', async () => {
    const r = await runNpmCommand(['--version'], { timeoutMs: 30_000 })
    expect(r.stderr).not.toMatch(/EINVAL/)
    expect(r.success).toBe(true)
    expect(r.stdout.trim().length).toBeGreaterThan(0)
  })
})
