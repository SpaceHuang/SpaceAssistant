import { describe, expect, it, vi } from 'vitest'
import { measureStartupPhase } from './startupTiming'

describe('measureStartupPhase', () => {
  it('reports duration when startup work succeeds and returns its value', async () => {
    let time = 10
    const report = vi.fn()
    await expect(measureStartupPhase('database-open', async () => { time = 18; return 'db' }, report, () => time - 8)).resolves.toBe('db')
    expect(report).toHaveBeenCalledWith({ phase: 'database-open', durationMs: 8, outcome: 'ok' })
  })

  it('reports a failed phase and preserves the original error', async () => {
    const error = new Error('migration failed')
    const report = vi.fn()
    await expect(measureStartupPhase('migration', () => { throw error }, report, () => 5)).rejects.toBe(error)
    expect(report).toHaveBeenCalledWith({ phase: 'migration', durationMs: 0, outcome: 'failed' })
  })
})
