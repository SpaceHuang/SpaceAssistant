import { describe, expect, it } from 'vitest'
import {
  isPendingMemoryTier,
  submitToolConfirmResponse,
  waitForToolConfirm
} from './toolConfirmRegistry'
import type { CacheKey } from '../src/shared/confirmation/types'

const sessionTierKey: CacheKey = { kind: 'domain', domain: 'example.com', level: 'domain-any-action', sessionId: 's1' }
const persistentTierKey: CacheKey = { kind: 'shell-command', verb: 'git status', level: 'exact' }

describe('toolConfirmRegistry', () => {
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

  it('rejects all tiers when the pending confirm was registered without memory tiers', async () => {
    const pending = waitForToolConfirm('req-notiers', 'tool-4')
    expect(isPendingMemoryTier('req-notiers', 'tool-4', persistentTierKey)).toBe(false)
    submitToolConfirmResponse('req-notiers', 'tool-4', false)
    await pending
  })
})
