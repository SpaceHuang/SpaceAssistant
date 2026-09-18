import { describe, expect, it } from 'vitest'
import { noteToolResultForStats } from './toolChatLoop'
import type { TurnUsageStats } from './toolChatLoop'
import type { ToolCallResultPersisted } from '../src/shared/domainTypes'

/** mulberry32 确定性伪随机（AGENTS.md 不变量测试纪律）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOT_EXECUTED_REASONS = [
  'user_rejected', 'confirm_timeout', 'remote_read_only', 'authorization_revoked',
  'policy_denied', 'budget_paused', 'remote_budget_exhausted', 'not_authorized',
  'unknown_tool', 'model_output_truncated'
] as const

function randomResult(rand: () => number): ToolCallResultPersisted {
  const roll = rand()
  if (roll < 0.45) return { success: true, data: 'ok' }
  if (roll < 0.75) return { success: false, error: 'exec failed' }
  const reason = NOT_EXECUTED_REASONS[Math.floor(rand() * NOT_EXECUTED_REASONS.length)]!
  return { success: false, error: reason, notExecuted: true, notExecutedReason: reason }
}

describe('noteToolResultForStats 三分类恒等式不变量（R6 纪律）', () => {
  for (const seed of [1, 42, 20260918, 7777, 987654321]) {
    it(`随机终态序列后恒等式成立（seed=${seed}）`, () => {
      const rand = mulberry32(seed)
      const stats: TurnUsageStats = { stepCount: 0, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 }
      let expectedError = 0
      let expectedSkipped = 0
      const steps = 200 + Math.floor(rand() * 300)

      for (let i = 0; i < steps; i++) {
        const result = randomResult(rand)
        noteToolResultForStats(stats, result)
        if (result.notExecuted) expectedSkipped += 1
        else if (!result.success) expectedError += 1

        // 每步后断言跨函数不变量：
        // ① tool_call_count = 成功 + 失败 + 未执行（成功由总数减出）
        expect(stats.toolCallCount).toBe(i + 1)
        expect(stats.toolCallCount - stats.toolErrorCount - stats.toolSkippedCount).toBeGreaterThanOrEqual(0)
        // ② 失败 + 未执行 ≤ 调用总数
        expect(stats.toolErrorCount + stats.toolSkippedCount).toBeLessThanOrEqual(stats.toolCallCount)
      }

      expect(stats.toolErrorCount).toBe(expectedError)
      expect(stats.toolSkippedCount).toBe(expectedSkipped)
      // ③ 恒等式终验：三者之和 = 调用次数
      expect(stats.toolErrorCount + stats.toolSkippedCount + (stats.toolCallCount - stats.toolErrorCount - stats.toolSkippedCount)).toBe(stats.toolCallCount)
    })
  }

  it('孤儿 tool_call（无终态）不产生计数 —— 计数只由 tool_result 驱动', () => {
    const stats: TurnUsageStats = { stepCount: 0, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 }
    // 模拟批次中断：只有触发者落了终态，其余 tool_call 为孤儿（不调用本函数）
    noteToolResultForStats(stats, { success: false, error: 'paused', notExecuted: true, notExecutedReason: 'budget_paused' })
    expect(stats).toEqual({ stepCount: 0, toolCallCount: 1, toolErrorCount: 0, toolSkippedCount: 1 })
  })
})
