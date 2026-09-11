import { describe, expect, it, vi } from 'vitest'
import { runAllShutdownCleanupTasks } from './shutdownCleanup'

describe('shutdown cleanup', () => {
  it('settles every resource and returns all failures', async () => {
    const calls: string[] = []
    const result = await runAllShutdownCleanupTasks([
      ['session-events', async () => { calls.push('session-events'); throw new Error('flush failed') }],
      ['stagehand', async () => { calls.push('stagehand') }],
      ['feishu', async () => { calls.push('feishu'); throw new Error('feishu failed') }],
      ['wechat', async () => { calls.push('wechat') }]
    ])

    expect(calls).toEqual(['session-events', 'stagehand', 'feishu', 'wechat'])
    expect(result.failures).toMatchObject([
      { task: 'session-events', error: new Error('flush failed') },
      { task: 'feishu', error: new Error('feishu failed') }
    ])
  })

  it('does not turn cleanup rejection into an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await runAllShutdownCleanupTasks([['failing', async () => { throw new Error('expected') }]])
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.removeListener('unhandledRejection', unhandled)
    }
  })
})
