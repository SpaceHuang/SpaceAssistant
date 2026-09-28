import { describe, expect, it, vi } from 'vitest'
import { installProcessSafetyNet } from './processSafetyNet'

describe('installProcessSafetyNet', () => {
  it('捕获 unhandledRejection 并记日志（Error reason 记 stack/message）', () => {
    const log = vi.fn()
    const uninstall = installProcessSafetyNet(log)
    try {
      const boom = new Error('escaped rejection')
      process.emit('unhandledRejection', boom, Promise.resolve())
      expect(log).toHaveBeenCalledWith('process.unhandled_rejection', { error: expect.stringContaining('escaped rejection') })
    } finally {
      uninstall()
    }
  })

  it('非 Error 的 reason 被字符串化记录', () => {
    const log = vi.fn()
    const uninstall = installProcessSafetyNet(log)
    try {
      process.emit('unhandledRejection', 'raw-string-reason', Promise.resolve())
      expect(log).toHaveBeenCalledWith('process.unhandled_rejection', { error: 'raw-string-reason' })
    } finally {
      uninstall()
    }
  })

  it('卸载函数移除监听器，之后的事件不再进入日志', () => {
    const log = vi.fn()
    const uninstall = installProcessSafetyNet(log)
    uninstall()
    process.emit('unhandledRejection', new Error('after uninstall'), Promise.resolve())
    expect(log).not.toHaveBeenCalled()
  })
})
