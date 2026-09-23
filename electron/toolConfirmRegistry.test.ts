import { describe, expect, it, vi } from 'vitest'
import {
  isPendingMemoryTier,
  isPendingConfirm,
  prepareToolConfirm,
  submitToolConfirmResponse,
  waitForToolConfirm
} from './toolConfirmRegistry'
import { reserveToolConfirmResponse, cancelReservedToolConfirm, restoreReservedToolConfirm, isToolConfirmCommitAllowed } from './toolConfirmRegistry'
import type { CacheKey } from '../src/shared/confirmation/types'

const sessionTierKey: CacheKey = { kind: 'domain', domain: 'example.com', level: 'domain-any-action', sessionId: 's1' }
const persistentTierKey: CacheKey = { kind: 'shell-command', verb: 'git status', level: 'exact' }

describe('toolConfirmRegistry', () => {
  it('prepare 在任何确认卡片发布前建立 pending，且后续 wait 复用同一 promise', async () => {
    const prepared = prepareToolConfirm('req-prepared', 'tool-prepared', undefined, { toolName: 'write_file', lane: 'desktop' }, 1000)
    expect(isPendingConfirm('req-prepared', 'tool-prepared')).toBe(true)
    const waited = waitForToolConfirm('req-prepared', 'tool-prepared')
    expect(waited).toBe(prepared)
    expect(submitToolConfirmResponse('req-prepared', 'tool-prepared', false).accepted).toBe(true)
    await expect(prepared).resolves.toBe('rejected')
  })
  it('defers confirm resolve to the next event-loop turn', async () => {
    let resolvedSync = false
    const pending = waitForToolConfirm('req-defer', 'tool-1')
    void pending.then(() => {
      resolvedSync = true
    })
    submitToolConfirmResponse('req-defer', 'tool-1', true)
    expect(resolvedSync).toBe(false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(resolvedSync).toBe(true)
    await expect(pending).resolves.toBe('approved')
  })

  it('accepts a memory tier that belongs to the pending confirm decision', async () => {
    const pending = waitForToolConfirm('req-tier', 'tool-2', [
      { key: sessionTierKey, label: '本会话' },
      { key: persistentTierKey, label: '永久' }
    ])
    // 字段顺序不同的等价键同样命中（规范化 JSON 比较）
    expect(
      isPendingMemoryTier('req-tier', 'tool-2', {
        level: 'domain-any-action',
        kind: 'domain',
        sessionId: 's1',
        domain: 'example.com'
      } as CacheKey)
    ).toBe(true)
    expect(isPendingMemoryTier('req-tier', 'tool-2', persistentTierKey)).toBe(true)
    // 不在档位内的键（含无 sessionId 的持久变体）一律拒绝
    expect(
      isPendingMemoryTier('req-tier', 'tool-2', { kind: 'domain', domain: 'example.com', level: 'domain-any-action' })
    ).toBe(false)
    expect(
      isPendingMemoryTier('req-tier', 'tool-2', { kind: 'shell-command', verb: 'rm -rf /', level: 'exact' })
    ).toBe(false)
    submitToolConfirmResponse('req-tier', 'tool-2', true)
    await pending
  })

  it('rejects tiers when no pending confirm exists or confirm already resolved', async () => {
    expect(isPendingMemoryTier('req-none', 'tool-x', persistentTierKey)).toBe(false)
    const pending = waitForToolConfirm('req-gone', 'tool-3', [{ key: persistentTierKey, label: '永久' }])
    submitToolConfirmResponse('req-gone', 'tool-3', true)
    expect(isPendingMemoryTier('req-gone', 'tool-3', persistentTierKey)).toBe(false)
    await pending
  })

  it('取消或撤销 committing 确认进入 cancelled 并阻止后续提交', async () => {
    const pending = waitForToolConfirm('req-commit', 'tool-commit')
    expect(reserveToolConfirmResponse('req-commit', 'tool-commit')).toBe(true)
    expect(isToolConfirmCommitAllowed('req-commit', 'tool-commit')).toBe(true)
    expect(cancelReservedToolConfirm('req-commit', 'tool-commit')).toBe(true)
    await expect(pending).resolves.toBe('cancelled')
    expect(isToolConfirmCommitAllowed('req-commit', 'tool-commit')).toBe(false)
    expect(submitToolConfirmResponse('req-commit', 'tool-commit', true)).toEqual({ accepted: false, outcome: 'missing' })
  })

  it('事务回滚时恢复 committing waiter，允许同一确认重试', async () => {
    const pending = waitForToolConfirm('req-retry', 'tool-retry', undefined, undefined, 1000)
    const { getPendingConfirmRevision } = await import('./toolConfirmRegistry')
    const firstRevision = getPendingConfirmRevision('req-retry', 'tool-retry')
    expect(reserveToolConfirmResponse('req-retry', 'tool-retry')).toBe(true)
    expect(restoreReservedToolConfirm('req-retry', 'tool-retry')).toBe(true)
    expect(isPendingConfirm('req-retry', 'tool-retry')).toBe(true)
    expect(getPendingConfirmRevision('req-retry', 'tool-retry')).toBe((firstRevision ?? 0) + 1)
    expect(submitToolConfirmResponse('req-retry', 'tool-retry', true).accepted).toBe(true)
    await expect(pending).resolves.toBe('approved')
  })

  it('信任校验保留 argv 边界，且不为复合命令登记范围', async () => {
    const simple = waitForToolConfirm('req-argv', 'tool-simple', undefined, {
      toolName: 'run_shell', lane: 'desktop', trustCommands: [JSON.stringify(['echo', 'a b'])]
    })
    const { isPendingTrust } = await import('./toolConfirmRegistry')
    expect(isPendingTrust('req-argv', 'tool-simple', 'command', 'echo "a b"')).toBe(true)
    expect(isPendingTrust('req-argv', 'tool-simple', 'command', 'echo a b')).toBe(false)
    submitToolConfirmResponse('req-argv', 'tool-simple', false)
    await simple
  })

  it('returns an explicit ACK for accepted and expired submissions', async () => {
    expect(submitToolConfirmResponse('req-missing', 'tool-missing', true)).toEqual({ accepted: false, outcome: 'missing' })
    const pending = waitForToolConfirm('req-ack', 'tool-ack')
    expect(submitToolConfirmResponse('req-ack', 'tool-ack', true)).toEqual({ accepted: true, outcome: 'approved' })
    expect(submitToolConfirmResponse('req-ack', 'tool-ack', true)).toEqual({ accepted: false, outcome: 'missing' })
    await pending
  })

  it('rejects all tiers when the pending confirm was registered without memory tiers', async () => {
    const pending = waitForToolConfirm('req-notiers', 'tool-4')
    expect(isPendingMemoryTier('req-notiers', 'tool-4', persistentTierKey)).toBe(false)
    submitToolConfirmResponse('req-notiers', 'tool-4', false)
    await pending
  })

  it('only rejects confirmations in the matching lane and tool scope', async () => {
    const desktopWrite = waitForToolConfirm('req-a', 'u-a', undefined, { lane: 'desktop', toolName: 'write_file' })
    const remoteWrite = waitForToolConfirm('req-b', 'u-b', undefined, { lane: 'wechat', toolName: 'write_file' })
    const desktopRead = waitForToolConfirm('req-c', 'u-c', undefined, { lane: 'desktop', toolName: 'read_file' })
    const { rejectPendingConfirmsForTool, cancelAllPendingToolConfirms } = await import('./toolConfirmRegistry')
    expect(rejectPendingConfirmsForTool('desktop', 'write_file')).toBe(1)
    await expect(desktopWrite).resolves.toBe('cancelled')
    cancelAllPendingToolConfirms()
    await expect(remoteWrite).resolves.toBe('cancelled')
    await expect(desktopRead).resolves.toBe('cancelled')
  })

  it('P1-4 超时可配：timeoutMs 参数真实消费（自定义短超时到期 resolve timeout）', async () => {
    vi.useFakeTimers()
    const pending = waitForToolConfirm('req-timeout-custom', 'tool-t', undefined, undefined, 50)
    let settled: string | undefined
    void pending.then((v) => {
      settled = v
    })
    await vi.advanceTimersByTimeAsync(60)
    expect(settled).toBe('timeout')
    vi.useRealTimers()
  })

  it('P1-4 缺省超时仍为 CONFIRM_MS=5min（user 回答者默认不回归）', async () => {
    vi.useFakeTimers()
    const pending = waitForToolConfirm('req-timeout-default', 'tool-d')
    let settled: string | undefined
    void pending.then((v) => {
      settled = v
    })
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60 * 1000 + 10)
    expect(settled).toBe('timeout')
    vi.useRealTimers()
  })
})
