import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createDebouncedDbSave } from './dbSaveScheduler'

describe('createDebouncedDbSave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces multiple schedule calls into one write', () => {
    const write = vi.fn()
    const { schedule } = createDebouncedDbSave(write, 100)
    schedule()
    schedule()
    schedule()
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('flushNow writes immediately even without prior schedule', () => {
    const write = vi.fn()
    const { flushNow } = createDebouncedDbSave(write, 100)
    flushNow()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('flushNow after schedule coalesces to one write before timer', () => {
    const write = vi.fn()
    const { schedule, flushNow } = createDebouncedDbSave(write, 100)
    schedule()
    flushNow()
    expect(write).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('suspends timer writes while keeping flushNow available (compaction copy window)', () => {
    const write = vi.fn()
    const { schedule, flushNow, setSuspended } = createDebouncedDbSave(write, 100)
    setSuspended(true)
    schedule()
    schedule()
    vi.advanceTimersByTime(500)
    expect(write).not.toHaveBeenCalled() // 挂起期间不安排任何 checkpoint 写入
    flushNow()
    expect(write).toHaveBeenCalledTimes(1) // 显式落盘不受挂起影响
    setSuspended(false)
    schedule()
    vi.advanceTimersByTime(100)
    expect(write).toHaveBeenCalledTimes(2) // 恢复后排程照常
  })
})
