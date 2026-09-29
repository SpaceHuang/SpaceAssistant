import { describe, expect, it, vi } from 'vitest'
import { installProcessSafetyNet } from './processSafetyNet'

/** 取出当前注册的安全网处理器直接调用断言——不经 process.emit 合成事件（评审 v2 N1）：
 * emit 会把 reason 同时投递给 vitest 自己的 unhandledRejection 监听器，每次全量固定产生
 * 一个 Unhandled Error 噪声。 */
function safetyNetHandler(): (reason: unknown) => void {
  const handlers = process.listeners('unhandledRejection') as Array<(reason: unknown) => void>
  expect(handlers.length).toBeGreaterThan(0)
  return handlers[handlers.length - 1]!
}

describe('installProcessSafetyNet', () => {
  it('捕获 unhandledRejection 并记日志（Error reason 记 stack/message）', () => {
    const log = vi.fn()
    const uninstall = installProcessSafetyNet(log)
    try {
      const handler = safetyNetHandler()
      handler(new Error('escaped rejection'))
      expect(log).toHaveBeenCalledWith('process.unhandled_rejection', { error: expect.stringContaining('escaped rejection') })
    } finally {
      uninstall()
    }
  })

  it('非 Error 的 reason 被字符串化记录', () => {
    const log = vi.fn()
    const uninstall = installProcessSafetyNet(log)
    try {
      safetyNetHandler()('raw-string-reason')
      expect(log).toHaveBeenCalledWith('process.unhandled_rejection', { error: 'raw-string-reason' })
    } finally {
      uninstall()
    }
  })

  it('卸载函数移除监听器', () => {
    const before = process.listenerCount('unhandledRejection')
    const uninstall = installProcessSafetyNet(vi.fn())
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1)
    uninstall()
    expect(process.listenerCount('unhandledRejection')).toBe(before)
  })
})
