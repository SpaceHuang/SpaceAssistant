import { describe, expect, it } from 'vitest'
import { computeMessagePrefixStats, digestSurfaceItems } from './requestContext'

/**
 * P0-1 messages 面埋点（agent-context-token-cost-optimization-plan §5.2.3-1 / §7.1 场景 1–7）。
 * 比较「本次请求 vs 上一次请求」的规范化消息序列（canonicalizeSurfaceMessages 口径，
 * 剥离 cache_control），给出首个分歧 item 下标与分歧原因。
 * prev 口径为 digestSurfaceItems 产出的 digest 列表（调用方只需保存上一请求的 digests）。
 */

const A = { role: 'user', content: 'first question' }
const B = { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }
const C = { role: 'user', content: 'second question' }
const D = { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] }

describe('computeMessagePrefixStats（§7.1 messages 面 1–7）', () => {
  it('场景 1：纯追加 → divergedReason=appended，firstDivergedIndex === prevItemCount', () => {
    const stats = computeMessagePrefixStats([A, B, C], digestSurfaceItems([A, B]))
    expect(stats.divergedReason).toBe('appended')
    expect(stats.firstDivergedIndex).toBe(2)
    expect(stats.prevItemCount).toBe(2)
    expect(stats.itemCount).toBe(3)
    expect(stats.commonPrefixItems).toBe(2)
  })

  it('场景 2：原地替换 → divergedReason=replaced，firstDivergedIndex === N，prevItemDigest !== currItemDigest', () => {
    const stats = computeMessagePrefixStats([A, { role: 'assistant', content: 'REWRITTEN' }, C], digestSurfaceItems([A, B, C]))
    expect(stats.divergedReason).toBe('replaced')
    expect(stats.firstDivergedIndex).toBe(1)
    expect(stats.prevItemDigest).not.toBe(stats.currItemDigest)
  })

  it('场景 3：截断（中间裁剪）→ divergedReason=truncated，commonPrefixItems < min(prevItemCount, itemCount)', () => {
    const stats = computeMessagePrefixStats([A, D], digestSurfaceItems([A, B, C, D]))
    expect(stats.divergedReason).toBe('truncated')
    expect(stats.commonPrefixItems).toBeLessThan(Math.min(stats.prevItemCount!, stats.itemCount))
  })

  it('场景 3b：尾部裁剪同样是 truncated', () => {
    const stats = computeMessagePrefixStats([A, B], digestSurfaceItems([A, B, C, D]))
    expect(stats.divergedReason).toBe('truncated')
    expect(stats.firstDivergedIndex).toBe(2)
  })

  it('场景 4：仅位置变化（内容相同）→ prevItemDigest === currItemDigest', () => {
    const stats = computeMessagePrefixStats([C, B, A], digestSurfaceItems([A, B, C]))
    expect(stats.divergedReason).toBe('reordered')
    expect(stats.prevItemDigest).toBe(stats.currItemDigest)
  })

  it('场景 5：带 cache_control 的消息不影响 messages 面比较（canonicalize 口径）', () => {
    const withCacheControl = [
      { role: 'user', content: [{ type: 'text', text: 'first question', cache_control: { type: 'ephemeral' } }] }
    ]
    const plain = [{ role: 'user', content: 'first question' }]
    const stats = computeMessagePrefixStats(plain, digestSurfaceItems(withCacheControl))
    // 两侧在规范化后是同一语义内容 → 完全一致（不因 cache_control 报 replaced）
    expect(stats.divergedReason).toBeNull()
    expect(stats.firstDivergedIndex).toBeNull()
  })

  it('场景 6：首请求（无上一请求）→ 观测字段为 null，不报错', () => {
    const stats = computeMessagePrefixStats([A], null)
    expect(stats.itemCount).toBe(1)
    expect(stats.prevItemCount).toBeNull()
    expect(stats.commonPrefixItems).toBeNull()
    expect(stats.firstDivergedIndex).toBeNull()
    expect(stats.divergedReason).toBeNull()
    expect(stats.prevItemDigest).toBeNull()
    expect(stats.currItemDigest).toBeNull()
  })

  it('场景 6b：完全一致的序列 → 无分歧', () => {
    const stats = computeMessagePrefixStats([A, B], digestSurfaceItems([A, B]))
    expect(stats.divergedReason).toBeNull()
    expect(stats.firstDivergedIndex).toBeNull()
    expect(stats.commonPrefixItems).toBe(2)
  })
})
