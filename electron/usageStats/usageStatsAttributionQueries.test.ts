import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { insertUsageStepFact, upsertUsageTurnFact } from '../database/operations'
import { buildStepAttribution, emptyTurnToolDimension, accumulateToolResultVolume, summarizeToolDeclarations } from '../../src/shared/usageAttribution'
import type { AppDatabase } from '../database'
import { queryAttributionComposition, queryAttributionDaily, queryAttributionOutputSplit, queryToolAttributionBreakdown } from './usageStatsQueries'

function day(n: number): string {
  return `2026-09-${String(n).padStart(2, '0')}`
}

function insertAttributedStep(
  db: AppDatabase,
  opts: { stepId: string; day: string; inputTokens: number; outputTokens?: number; estimatorVersion?: string | null; attribution?: boolean | 'legacy' }
): void {
  let attributionJson: string | null = null
  let estimatorVersion: string | null = null
  let systemTokens: number | null = null
  let toolsTokens: number | null = null
  let messageTokens: number | null = null
  if (opts.attribution === true) {
    const attribution = buildStepAttribution({
      system: 'sys',
      tools: [{ name: 'grep' }],
      messages: [
        { role: 'user', content: 'hello world' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'grep', input: { p: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'result-text' }] }
      ],
      outputContent: [{ type: 'text', text: 'answer' }]
    })
    const { threeSources, ...json } = attribution
    attributionJson = JSON.stringify(json)
    estimatorVersion = opts.estimatorVersion !== undefined ? opts.estimatorVersion : threeSources.estimatorVersion
    systemTokens = threeSources.systemTokens
    toolsTokens = threeSources.toolsTokens
    messageTokens = threeSources.messageTokens
  }
  insertUsageStepFact(db, {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    stepId: opts.stepId,
    createdAt: 1758000000000,
    day: opts.day,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens ?? 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    source: 'api',
    systemTokens,
    toolsTokens,
    messageTokens,
    estimatorVersion,
    attributionJson
  })
}

describe('queryAttributionComposition（构成快照 + 归因覆盖率）', () => {
  it('可归因行按精确总量归一化，Σcategories == attributableInputTokens（AT7/AT14 恒等式）', () => {
    const db = createMemoryAppDb()
    insertAttributedStep(db, { stepId: 's1', day: day(1), inputTokens: 10000, attribution: true })
    insertAttributedStep(db, { stepId: 's2', day: day(1), inputTokens: 5000, attribution: true })
    const result = queryAttributionComposition(db, { from: day(1), to: day(2), estimatorVersion: 'block-v1' })
    const sum = Object.values(result.categories).reduce((a, b) => a + b, 0)
    expect(sum).toBe(result.attributableInputTokens)
    expect(result.attributableInputTokens).toBe(15000)
    expect(result.totalInputTokens).toBe(15000)
    expect(result.attributionCoverage).toBe(1)
    db.close()
  })

  it('无归因行进入分母但不进分子——覆盖率 < 100%，恒等式只对可归面子集承诺（AT8/AT16/I7）', () => {
    const db = createMemoryAppDb()
    insertAttributedStep(db, { stepId: 's1', day: day(1), inputTokens: 10000, attribution: true })
    insertAttributedStep(db, { stepId: 's2', day: day(1), inputTokens: 5000, attribution: false })
    const result = queryAttributionComposition(db, { from: day(1), to: day(2), estimatorVersion: 'block-v1' })
    expect(result.totalInputTokens).toBe(15000)
    expect(result.attributableInputTokens).toBe(10000)
    expect(result.attributionCoverage).toBeCloseTo(2 / 3)
    const sum = Object.values(result.categories).reduce((a, b) => a + b, 0)
    expect(sum).toBe(result.attributableInputTokens)
    db.close()
  })

  it('估算器版本不一致的行排除出归因（I1 不得混算），仍留在分母', () => {
    const db = createMemoryAppDb()
    insertAttributedStep(db, { stepId: 's1', day: day(1), inputTokens: 10000, attribution: true })
    insertAttributedStep(db, { stepId: 's2', day: day(1), inputTokens: 5000, attribution: true, estimatorVersion: 'future-v2' })
    const result = queryAttributionComposition(db, { from: day(1), to: day(2), estimatorVersion: 'block-v1' })
    expect(result.attributableInputTokens).toBe(10000)
    expect(result.totalInputTokens).toBe(15000)
    db.close()
  })

  it('区间无任何请求时覆盖率为 null（空态，AT16）', () => {
    const db = createMemoryAppDb()
    const result = queryAttributionComposition(db, { from: day(9), to: day(9), estimatorVersion: 'block-v1' })
    expect(result.totalInputTokens).toBe(0)
    expect(result.attributionCoverage).toBeNull()
    db.close()
  })
})

describe('queryAttributionDaily（构成漂移，视图②）', () => {
  it('按天产出构成，各天恒等式独立成立', () => {
    const db = createMemoryAppDb()
    insertAttributedStep(db, { stepId: 'a', day: day(1), inputTokens: 8000, attribution: true })
    insertAttributedStep(db, { stepId: 'b', day: day(2), inputTokens: 12000, attribution: true })
    const points = queryAttributionDaily(db, { from: day(1), to: day(2), estimatorVersion: 'block-v1' })
    expect(points).toHaveLength(2)
    for (const point of points) {
      const sum = Object.values(point.categories).reduce((a, b) => a + b, 0)
      expect(sum).toBe(point.attributableInputTokens)
    }
    expect(points[0]!.attributableInputTokens).toBe(8000)
    expect(points[1]!.attributableInputTokens).toBe(12000)
    db.close()
  })
})

describe('queryToolAttributionBreakdown（明细排行 + 未使用工具，SRC-B2–B4 / SRC-C1–C2）', () => {
  it('跨 turn 合并声明与返回体量；未使用 = 有声明无调用', () => {
    const db = createMemoryAppDb()
    const dim1 = emptyTurnToolDimension()
    Object.assign(dim1, summarizeToolDeclarations([
      { name: 'grep', description: 'g' },
      { name: 'mcp_x_search', description: 'xxxx' }
    ]))
    accumulateToolResultVolume(dim1, 'grep', 'abcde')
    upsertUsageTurnFact(db, {
      turnId: 't1', sessionId: 'sess-1', createdAt: 1758000000000, day: day(1),
      stepCount: 1, toolCallCount: 1, toolErrorCount: 0, toolSkippedCount: 0, outcome: 'completed',
      toolAttributionJson: JSON.stringify(dim1)
    })
    const dim2 = emptyTurnToolDimension()
    Object.assign(dim2, summarizeToolDeclarations([
      { name: 'grep', description: 'g' },
      { name: 'mcp_x_search', description: 'xxxx' }
    ]))
    accumulateToolResultVolume(dim2, 'grep', 'xyz')
    accumulateToolResultVolume(dim2, 'read_file', 'long-result')
    upsertUsageTurnFact(db, {
      turnId: 't2', sessionId: 'sess-1', createdAt: 1758000001000, day: day(1),
      stepCount: 1, toolCallCount: 2, toolErrorCount: 0, toolSkippedCount: 0, outcome: 'completed',
      toolAttributionJson: JSON.stringify(dim2)
    })

    const result = queryToolAttributionBreakdown(db, { from: day(1), to: day(1) })
    const grep = result.used.find((t) => t.name === 'grep')
    expect(grep).toMatchObject({ source: 'builtin', calls: 2, resultChars: 8 })
    expect(grep!.declaredChars).toBeGreaterThan(0)
    const unused = result.unused.find((t) => t.name === 'mcp_x_search')
    expect(unused).toMatchObject({ source: 'mcp', calls: null })
    // read_file 有返回但声明在 2 个 turn 都存在（merge 后 calls=1）
    const readFile = result.used.find((t) => t.name === 'read_file')
    expect(readFile).toMatchObject({ calls: 1, resultChars: 'long-result'.length })
    db.close()
  })

  it('工具维度列缺失的老行被跳过，不报错（AT8 降级）', () => {
    const db = createMemoryAppDb()
    upsertUsageTurnFact(db, {
      turnId: 't1', sessionId: 'sess-1', createdAt: 1, day: day(1),
      stepCount: 1, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0, outcome: 'completed'
    })
    const result = queryToolAttributionBreakdown(db, { from: day(1), to: day(1) })
    expect(result.used).toEqual([])
    expect(result.unused).toEqual([])
    db.close()
  })
})

describe('queryAttributionOutputSplit（输出侧三类，SRC-D1）', () => {
  it('三类按 output_tokens 摊回，Σ == attributableOutputTokens', () => {
    const db = createMemoryAppDb()
    insertAttributedStep(db, { stepId: 's1', day: day(1), inputTokens: 1000, outputTokens: 292827, attribution: true })
    insertAttributedStep(db, { stepId: 's2', day: day(1), inputTokens: 1000, outputTokens: 71, attribution: false })
    const result = queryAttributionOutputSplit(db, { from: day(1), to: day(1), estimatorVersion: 'block-v1' })
    expect(result.totalOutputTokens).toBe(292898)
    expect(result.attributableOutputTokens).toBe(292827)
    const sum = result.categories.thinking + result.categories.text + result.categories.toolUseArgs
    expect(sum).toBe(result.attributableOutputTokens)
    db.close()
  })
})

describe('归因行防御（评审 P1-1 / P2 输出侧恒等式）', () => {
  it('schemaVersion 缺失或为未来版本的行按「无归因数据」降级——留分母不进分子（AD7）', () => {
    const db = createMemoryAppDb()
    // 正常行
    insertAttributedStep(db, { stepId: 'ok', day: day(1), inputTokens: 10000, attribution: true })
    // schemaVersion=99 的未来格式行
    const future = buildStepAttribution({ system: 's', tools: [], messages: [{ role: 'user', content: 'x' }] })
    const { threeSources, ...futureJson } = future
    insertUsageStepFact(db, {
      sessionId: 'sess-1', turnId: 'turn-1', stepId: 'future', createdAt: 1758000001000, day: day(1),
      inputTokens: 5000, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, source: 'api',
      systemTokens: threeSources.systemTokens, toolsTokens: threeSources.toolsTokens, messageTokens: threeSources.messageTokens,
      estimatorVersion: threeSources.estimatorVersion,
      attributionJson: JSON.stringify({ ...futureJson, schemaVersion: 99 })
    })
    const result = queryAttributionComposition(db, { from: day(1), to: day(1), estimatorVersion: 'block-v1' })
    expect(result.totalInputTokens).toBe(15000)
    expect(result.attributableInputTokens).toBe(10000)
    const sum = Object.values(result.categories).reduce((a, b) => a + b, 0)
    expect(sum).toBe(result.attributableInputTokens)
    db.close()
  })

  it('cache_read > 0 的行：可归因量按三档和锚定（recorder 已把 input_tokens 归一为三档和，此处锁定列语义）', () => {
    const db = createMemoryAppDb()
    const attribution = buildStepAttribution({ system: 's', tools: [], messages: [{ role: 'user', content: 'x' }] })
    const { threeSources, ...json } = attribution
    // input_tokens=1000 为三档和（cache_read=25000 已并入）；三档拆分仅作场景真实感
    insertUsageStepFact(db, {
      sessionId: 'sess-1', turnId: 'turn-1', stepId: 'cached', createdAt: 1758000000000, day: day(1),
      inputTokens: 26000, outputTokens: 100, cacheReadTokens: 25000, cacheCreationTokens: 0,
      cacheSemantics: 'additive', source: 'api',
      systemTokens: threeSources.systemTokens, toolsTokens: threeSources.toolsTokens, messageTokens: threeSources.messageTokens,
      estimatorVersion: threeSources.estimatorVersion, attributionJson: JSON.stringify(json)
    })
    const result = queryAttributionComposition(db, { from: day(1), to: day(1), estimatorVersion: 'block-v1' })
    expect(result.attributableInputTokens).toBe(26000)
    const sum = Object.values(result.categories).reduce((a, b) => a + b, 0)
    expect(sum).toBe(26000)
    expect(result.attributionCoverage).toBe(1)
    db.close()
  })

  it('有 blocks 无 output 段的行不进输出侧可归因子集，Σcategories == attributableOutputTokens 不被破坏', () => {
    const db = createMemoryAppDb()
    insertAttributedStep(db, { stepId: 'with-output', day: day(1), inputTokens: 1000, outputTokens: 500, attribution: true })
    // 有归因 JSON 但无 output 段（旧格式/异常行）
    const noOutput = buildStepAttribution({ system: 's', tools: [], messages: [{ role: 'user', content: 'x' }] })
    const { threeSources, ...noOutputJson } = noOutput
    delete (noOutputJson as { output?: unknown }).output
    insertUsageStepFact(db, {
      sessionId: 'sess-1', turnId: 'turn-1', stepId: 'no-output', createdAt: 1758000001000, day: day(1),
      inputTokens: 1000, outputTokens: 700, cacheReadTokens: 0, cacheCreationTokens: 0, source: 'api',
      systemTokens: threeSources.systemTokens, toolsTokens: threeSources.toolsTokens, messageTokens: threeSources.messageTokens,
      estimatorVersion: threeSources.estimatorVersion, attributionJson: JSON.stringify(noOutputJson)
    })
    const result = queryAttributionOutputSplit(db, { from: day(1), to: day(1), estimatorVersion: 'block-v1' })
    expect(result.totalOutputTokens).toBe(1200)
    expect(result.attributableOutputTokens).toBe(500)
    const sum = result.categories.thinking + result.categories.text + result.categories.toolUseArgs
    expect(sum).toBe(500)
    db.close()
  })

  it('逐名显式来源（toolSources）优先于 mcp_ 前缀推断', () => {
    const db = createMemoryAppDb()
    const dim = emptyTurnToolDimension()
    dim.tools['forwarded_name'] = 300
    dim.toolSources['forwarded_name'] = 'mcp'
    dim.toolResults['forwarded_name'] = { calls: 2, chars: 10 }
    upsertUsageTurnFact(db, {
      turnId: 't-explicit', sessionId: 'sess-1', createdAt: 1758000000000, day: day(1),
      stepCount: 1, toolCallCount: 2, toolErrorCount: 0, toolSkippedCount: 0, outcome: 'completed',
      toolAttributionJson: JSON.stringify(dim)
    })
    const result = queryToolAttributionBreakdown(db, { from: day(1), to: day(1) })
    const entry = result.used.find((t) => t.name === 'forwarded_name')
    expect(entry?.source).toBe('mcp')
    db.close()
  })
})
