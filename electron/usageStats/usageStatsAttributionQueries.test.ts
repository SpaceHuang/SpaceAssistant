import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { insertUsageStepFact, upsertUsageTurnFact } from '../database/operations'
import type { UsageStepFactInput, UsageTurnFactInput } from '../database/operations'
import { queryLatestUsageAttribution, queryUsageAttribution } from './usageStatsQueries'
import { buildStepAttribution } from '../../src/shared/usageAttribution'

const timestamp = new Date(2026, 8, 16, 12).getTime()
const day = '2026-09-16'
const dimensions = { tools: { grep: 30 }, toolSource: { builtin: 30 }, toolSources: { grep: 'builtin' }, toolResults: { grep: { calls: 1, chars: 12 } } }

function step(sessionId: string, turnId: string, inputTokens: number, options: Partial<UsageStepFactInput> = {}): UsageStepFactInput {
  return {
    sessionId, turnId, stepId: `${turnId}:step:1`, createdAt: timestamp, day,
    model: 'model-a', llmServiceId: 'service-a', appVersion: '1.0',
    inputTokens, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0,
    source: 'api', ...options
  }
}

function turn(sessionId: string, turnId: string, options: Partial<UsageTurnFactInput> = {}): UsageTurnFactInput {
  return {
    turnId, sessionId, createdAt: timestamp, day, model: 'model-a', llmServiceId: 'service-a', appVersion: '1.0',
    stepCount: 1, toolCallCount: 1, toolErrorCount: 0, toolSkippedCount: 0, outcome: 'completed', ...options
  }
}

function attributed(options: { system?: string; tools?: unknown[]; messages?: unknown[] } = {}) {
  const value = buildStepAttribution({ system: options.system ?? 'system', tools: options.tools ?? [{ name: 'grep', description: 'g' }], messages: options.messages ?? [{ role: 'user', content: 'hello world' }] })
  const { threeSources, ...snapshot } = value
  return {
    attributionJson: JSON.stringify(snapshot), estimatorVersion: threeSources.estimatorVersion,
    systemTokens: threeSources.systemTokens, toolsTokens: threeSources.toolsTokens,
    messageTokens: threeSources.messageTokens
  }
}

describe('usageStatsAttributionQueries', () => {
  it('returns the latest attributable step only within the requested session and omits unavailable attribution', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, step('session-a', 'older', 40, { createdAt: timestamp, ...attributed() }))
    insertUsageStepFact(db, step('session-a', 'newer', 100, { createdAt: timestamp + 1, ...attributed({ messages: [{ role: 'user', content: 'latest content' }] }) }))
    insertUsageStepFact(db, step('session-b', 'other', 900, { createdAt: timestamp + 2, ...attributed() }))
    insertUsageStepFact(db, step('session-a', 'legacy', 300, { createdAt: timestamp - 1 }))
    const result = queryLatestUsageAttribution(db, 'session-a')
    expect(result).toMatchObject({ exactInputTokens: 100, estimatorVersion: 'block-v1', attributableInputTokens: 100, unattributedInputTokens: 0, coverageRatio: 1 })
    expect(result?.composition.system + result!.composition.tools + Object.values(result!.composition.messageBlocks).reduce((a, b) => a + b, 0)).toBe(100)
    expect(queryLatestUsageAttribution(db, 'empty')).toBeNull()
    insertUsageStepFact(db, step('session-a', 'latest-legacy', 500, { createdAt: timestamp + 4 }))
    expect(queryLatestUsageAttribution(db, 'session-a')).toBeNull()
    db.close()
  })

  it('leaves pure multimodal exact input uncovered instead of assigning its tokens to system/tools', () => {
    const db = createMemoryAppDb()
    const imageOnly = attributed({
      system: 'stable system prompt',
      tools: [{ name: 'grep', description: 'search workspace', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'opaque' } }] }]
    })
    insertUsageStepFact(db, step('image-session', 'image-turn-small', 120, imageOnly))
    insertUsageStepFact(db, step('image-session', 'image-turn-large', 1200, imageOnly))

    expect(queryLatestUsageAttribution(db, 'image-session')).toBeNull()

    const summary = queryUsageAttribution(db, { from: day, to: day })
    expect(summary.exactInputTokens).toBe(1320)
    expect(summary.byEstimatorVersion).toEqual([])
    db.close()
  })

  it('uses the same filters and exact input denominator as the summary; old NULL facts remain uncovered', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, step('session-a', 'turn-a', 100, attributed()))
    insertUsageStepFact(db, step('session-a', 'turn-old', 50))
    insertUsageStepFact(db, step('session-b', 'turn-b', 40, { ...attributed(), appVersion: '2.0' }))
    insertUsageStepFact(db, step('session-a', 'turn-outside', 200, { ...attributed(), day: '2026-09-17' }))
    upsertUsageTurnFact(db, turn('session-a', 'turn-a', { toolAttributionJson: JSON.stringify(dimensions) }))
    upsertUsageTurnFact(db, turn('session-a', 'turn-old', { toolAttributionJson: JSON.stringify(dimensions) }))
    upsertUsageTurnFact(db, turn('session-b', 'turn-b', { toolAttributionJson: JSON.stringify({ ...dimensions, tools: { mcp_search: 500 } }) }))

    const args = { from: day, to: day, dimensions: { models: [{ model: 'model-a', llmServiceId: 'service-a' }], sessionIds: ['session-a'], appVersions: ['1.0'] } }
    const result = queryUsageAttribution(db, args)
    expect(result.exactInputTokens).toBe(150)
    expect(result.exactInputTokens).toBe(150) // same filtered KPI expected from queryUsageSummary
    expect(result.byEstimatorVersion).toHaveLength(1)
    expect(result.byEstimatorVersion[0]).toMatchObject({ estimatorVersion: 'block-v1', attributableInputTokens: 100, unattributedInputTokens: 50, coverageRatio: 2 / 3 })
    expect(result.byEstimatorVersion[0]!.composition.system + result.byEstimatorVersion[0]!.composition.tools + Object.values(result.byEstimatorVersion[0]!.composition.messageBlocks).reduce((a, b) => a + b, 0)).toBe(100)
    expect(result.toolDimensions).toMatchObject({ tools: { grep: 60 }, toolResults: { grep: { calls: 2, chars: 24 } } })
    expect(result.toolDimensions.tools).not.toHaveProperty('mcp_search')
    db.close()
  })

  it('joins tool dimensions by session_id and turn_id; shared request identity cannot cross sessions', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, step('deleted-session-a', 'unique-turn-a', 10, attributed()))
    insertUsageStepFact(db, step('deleted-session-b', 'unique-turn-b', 20, attributed()))
    upsertUsageTurnFact(db, turn('deleted-session-a', 'unique-turn-a', { toolAttributionJson: JSON.stringify({ ...dimensions, tools: { a: 1 } }) }))
    upsertUsageTurnFact(db, turn('deleted-session-b', 'unique-turn-b', { toolAttributionJson: JSON.stringify({ ...dimensions, tools: { b: 2 } }) }))
    const result = queryUsageAttribution(db, { from: day, to: day, dimensions: { sessionIds: ['deleted-session-a'] } })
    expect(result.exactInputTokens).toBe(10)
    expect(result.toolDimensions.tools).toEqual({ a: 1 })
    expect(result.toolDimensions.tools).not.toHaveProperty('b')
    db.close()
  })

  it('keeps estimator versions in separate attribution groups and returns an empty 0% result for legacy-only data', () => {
    const db = createMemoryAppDb()
    insertUsageStepFact(db, step('session-v', 'turn-v1', 10, { ...attributed(), estimatorVersion: 'block-v1' }))
    insertUsageStepFact(db, step('session-v', 'turn-v2', 20, { ...attributed(), estimatorVersion: 'block-v2' }))
    insertUsageStepFact(db, step('session-v', 'turn-old', 30))
    const result = queryUsageAttribution(db, { from: day, to: day })
    expect(result.exactInputTokens).toBe(60)
    expect(result.byEstimatorVersion.map((entry) => [entry.estimatorVersion, entry.attributableInputTokens, entry.unattributedInputTokens]))
      .toEqual([['block-v1', 10, 50], ['block-v2', 20, 40]])
    db.close()

    const legacyDb = createMemoryAppDb()
    insertUsageStepFact(legacyDb, step('legacy', 'legacy-turn', 40))
    expect(queryUsageAttribution(legacyDb, { from: day, to: day })).toMatchObject({ exactInputTokens: 40, byEstimatorVersion: [] })
    legacyDb.close()
  })
})
