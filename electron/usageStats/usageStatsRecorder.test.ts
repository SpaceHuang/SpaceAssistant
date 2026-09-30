import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

import { localDayString, recordStepUsage, recordTurnSummary, setUsageStatsAppVersion } from './usageStatsRecorder'
import type { SessionUsage } from '../../src/shared/sessionUsage'
import { buildStepAttribution, emptyTurnToolDimension, accumulateToolResultVolume, summarizeToolDeclarations } from '../../src/shared/usageAttribution'
import { createMemoryAppDb } from '../database/testHelpers'
import { getUsageStepFactsForTurn, getUsageTurnFact } from '../database/operations'
import { logAgentEvent } from '../agentLogger/agentLogger'
import type { AppDatabase } from '../database'

describe('localDayString 本地自然日', () => {
  it('按本地时区取 YYYY-MM-DD', () => {
    const ts = new Date(2026, 8, 16, 12, 30).getTime()
    expect(localDayString(ts)).toBe('2026-09-16')
  })

  it('本地日界前后落在不同的天', () => {
    const before = new Date(2026, 8, 16, 23, 59).getTime()
    const after = new Date(2026, 8, 17, 0, 1).getTime()
    expect(localDayString(before)).toBe('2026-09-16')
    expect(localDayString(after)).toBe('2026-09-17')
  })
})

describe('recordStepUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setUsageStatsAppVersion('0.1.5')
  })

  it('additive 语义归一化：输入总量含缓存命中（真实样本 T10 第 3 轮）', () => {
    const db = createMemoryAppDb()
    const usage: SessionUsage = {
      input_tokens: 4364,
      output_tokens: 760,
      cache_read_input_tokens: 46464,
      cache_creation_input_tokens: 0,
      cacheSemantics: 'additive'
    }
    recordStepUsage(db, {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      stepId: 'req-1:round:3',
      usage,
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro',
      llmServiceId: 'svc-a',
      now: new Date(2026, 8, 16, 10, 0).getTime()
    })
    const rows = getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      inputTokens: 50828,
      outputTokens: 760,
      cacheReadTokens: 46464,
      cacheCreationTokens: 0,
      cacheSemantics: 'additive',
      day: '2026-09-16',
      model: 'deepseek-v4-pro',
      llmServiceId: 'svc-a',
      appVersion: '0.1.5',
      source: 'api'
    })
    db.close()
  })

  it('subset 语义：输入总量即 prompt_tokens，缓存命中为子集', () => {
    const db = createMemoryAppDb()
    recordStepUsage(db, {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      stepId: 'req-1:round:1',
      usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 200, cacheSemantics: 'subset' },
      now: new Date(2026, 8, 16, 10, 0).getTime()
    })
    const rows = getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')
    expect(rows[0].inputTokens).toBe(1000)
    expect(rows[0].cacheReadTokens).toBe(200)
    db.close()
  })

  it('provider 未带 cacheSemantics 时按 baseUrl 推断并落库', () => {
    const db = createMemoryAppDb()
    recordStepUsage(db, {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      stepId: 'req-1:round:1',
      usage: { input_tokens: 500, output_tokens: 5, cache_read_input_tokens: 100 },
      baseUrl: 'https://api.deepseek.com/anthropic',
      now: new Date(2026, 8, 16, 10, 0).getTime()
    })
    const rows = getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')
    expect(rows[0].cacheSemantics).toBe('additive')
    expect(rows[0].inputTokens).toBe(600)
    db.close()
  })

  it('同 stepId 重复写覆盖不累加（幂等）', () => {
    const db = createMemoryAppDb()
    const base = {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      stepId: 'req-1:round:1',
      now: new Date(2026, 8, 16, 10, 0).getTime()
    }
    recordStepUsage(db, { ...base, usage: { input_tokens: 100, output_tokens: 5 } })
    recordStepUsage(db, { ...base, usage: { input_tokens: 300, output_tokens: 8 } })
    const rows = getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].inputTokens).toBe(300)
    db.close()
  })

  it('写入失败不抛出，重试后记 usageStats.write.failed 告警', () => {
    const brokenDb = createMemoryAppDb()
    brokenDb.close() // 连接关闭后写入必抛
    expect(() =>
      recordStepUsage(brokenDb, {
        sessionId: 'sess-1',
        turnId: 'turn-1',
        stepId: 'req-1:round:1',
        usage: { input_tokens: 100, output_tokens: 5 },
        now: 0
      })
    ).not.toThrow()
    expect(logAgentEvent).toHaveBeenCalledWith(
      'warn',
      'usageStats.write.failed',
      expect.objectContaining({ turnId: 'turn-1', stepId: 'req-1:round:1' })
    )
  })

  it('appDb 缺省时跳过写入（不抛错）', () => {
    expect(() =>
      recordStepUsage(undefined, {
        sessionId: 'sess-1',
        turnId: 'turn-1',
        stepId: 'req-1:round:1',
        usage: { input_tokens: 100, output_tokens: 5 },
        now: 0
      })
    ).not.toThrow()
  })

  it('带归因时写入三源真列 + estimator_version + 归因 JSON（blocks 与输出侧，§7.2/§7.4）', () => {
    const db = createMemoryAppDb()
    const attribution = buildStepAttribution({
      system: 'sys-prompt',
      tools: [{ name: 'grep' }],
      messages: [{ role: 'user', content: 'hello world' }],
      outputContent: [{ type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'hmm' }]
    })
    recordStepUsage(db, {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      stepId: 'req-1:round:1',
      usage: { input_tokens: 100, output_tokens: 5 },
      attribution,
      now: new Date(2026, 8, 16, 10, 0).getTime()
    })
    const rows = getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')
    expect(rows[0].estimatorVersion).toBe('block-v1')
    expect(rows[0].systemTokens).toBe(attribution.threeSources.systemTokens)
    expect(rows[0].toolsTokens).toBe(attribution.threeSources.toolsTokens)
    expect(rows[0].messageTokens).toBe(attribution.threeSources.messageTokens)
    const parsed = JSON.parse(rows[0].attributionJson!) as { schemaVersion: number; blocks: Record<string, unknown>; output?: Record<string, unknown> }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.blocks['user|text']).toEqual({ chars: 11, tokens: expect.any(Number) })
    expect(parsed.output).toBeDefined()
    // JSON 列内不含 estimatorVersion（AD18：版本号在独立真列，避免两份真相源）
    expect(rows[0].attributionJson!).not.toContain('block-v1')
    db.close()
  })

  it('不带归因时归因列为 null（无归因数据降级，AT8）', () => {
    const db = createMemoryAppDb()
    recordStepUsage(db, {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      stepId: 'req-1:round:1',
      usage: { input_tokens: 100, output_tokens: 5 },
      now: 0
    })
    const rows = getUsageStepFactsForTurn(db, 'sess-1', 'turn-1')
    expect(rows[0].estimatorVersion).toBeNull()
    expect(rows[0].attributionJson).toBeNull()
    expect(rows[0].systemTokens).toBeNull()
    db.close()
  })
})

describe('recordTurnSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('写入 Turn 汇总（计数与 outcome）', () => {
    const db = createMemoryAppDb()
    recordTurnSummary(db, {
      turnId: 'turn-1',
      sessionId: 'sess-1',
      outcome: 'completed',
      counts: { stepCount: 3, toolCallCount: 2, toolErrorCount: 1, toolSkippedCount: 0 },
      model: 'deepseek-v4-pro',
      llmServiceId: 'svc-a',
      now: new Date(2026, 8, 16, 10, 0).getTime()
    })
    const row = getUsageTurnFact(db, 'turn-1')
    expect(row).toMatchObject({
      turnId: 'turn-1',
      sessionId: 'sess-1',
      stepCount: 3,
      toolCallCount: 2,
      toolErrorCount: 1,
      toolSkippedCount: 0,
      outcome: 'completed',
      day: '2026-09-16'
    })
    db.close()
  })

  it('重复收口覆盖（恢复/重试场景幂等）', () => {
    const db = createMemoryAppDb()
    const base = {
      turnId: 'turn-1',
      sessionId: 'sess-1',
      now: new Date(2026, 8, 16, 10, 0).getTime()
    }
    recordTurnSummary(db, { ...base, outcome: 'failed', counts: { stepCount: 1, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 } })
    recordTurnSummary(db, { ...base, outcome: 'completed', counts: { stepCount: 3, toolCallCount: 2, toolErrorCount: 0, toolSkippedCount: 0 } })
    const row = getUsageTurnFact(db, 'turn-1')
    expect(row).toMatchObject({ outcome: 'completed', stepCount: 3 })
    db.close()
  })

  it('写入失败不抛出并记告警', () => {
    const brokenDb: AppDatabase = createMemoryAppDb()
    brokenDb.close()
    expect(() =>
      recordTurnSummary(brokenDb, {
        turnId: 'turn-1',
        sessionId: 'sess-1',
        outcome: 'completed',
        counts: { stepCount: 1, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 },
        now: 0
      })
    ).not.toThrow()
    expect(logAgentEvent).toHaveBeenCalledWith(
      'warn',
      'usageStats.write.failed',
      expect.objectContaining({ turnId: 'turn-1' })
    )
  })

  it('带工具维度时写入 tool_attribution_json（tools/toolSource/toolResults，AD24）', () => {
    const db = createMemoryAppDb()
    const dim = emptyTurnToolDimension()
    Object.assign(dim, summarizeToolDeclarations([{ name: 'grep', description: 'd' }, { name: 'mcp_x_search' }]))
    accumulateToolResultVolume(dim, 'grep', '12345')
    recordTurnSummary(db, {
      turnId: 'turn-1',
      sessionId: 'sess-1',
      outcome: 'completed',
      counts: { stepCount: 1, toolCallCount: 1, toolErrorCount: 0, toolSkippedCount: 0 },
      toolAttribution: dim,
      now: new Date(2026, 8, 16, 10, 0).getTime()
    })
    const parsed = JSON.parse(getUsageTurnFact(db, 'turn-1')!.toolAttributionJson!) as {
      tools: Record<string, number>
      toolSource: Record<string, number>
      toolResults: Record<string, { calls: number; chars: number }>
    }
    expect(Object.keys(parsed.tools).sort()).toEqual(['grep', 'mcp_x_search'])
    expect(parsed.toolSource.builtin).toBeGreaterThan(0)
    expect(parsed.toolSource.mcp).toBeGreaterThan(0)
    expect(parsed.toolResults.grep).toEqual({ calls: 1, chars: 5 })
  })

  it('不带工具维度时 tool_attribution_json 为 null', () => {
    const db = createMemoryAppDb()
    recordTurnSummary(db, {
      turnId: 'turn-2',
      sessionId: 'sess-1',
      outcome: 'completed',
      counts: { stepCount: 1, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 },
      now: 0
    })
    expect(getUsageTurnFact(db, 'turn-2')!.toolAttributionJson).toBeNull()
    db.close()
  })
})
