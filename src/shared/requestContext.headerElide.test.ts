import { describe, expect, it } from 'vitest'
import { buildRequestContextPayload, buildRequestHeaderPayload, elideConstantHeaderFields } from './requestContext'
import { computeContextPressureFromEvents } from './contextMeter'

/**
 * P1-3(b) request_header 的 system/tools 去重（agent-context-token-cost-optimization-plan §5.1.4 / §7.2 断言 6–9）。
 * system/tools 全程恒定（实测两指纹跨 146 请求不变），每请求重复写全量 ≈93 KB。
 * 方案：首见写全量；指纹未变仅省略全量字段（指纹本就随 surfaceSnapshot 落盘，可作回填引用）；
 * 指纹变化重写全量。读取方 computeContextPressureFromEvents 只读 requestId + surfaceSnapshot（§5.1.4 N5）。
 */

const SYSTEM = 'you are an assistant'
const TOOLS = [{ name: 'read_file', description: 'read a file' }]

function buildHeader(requestId: string, system = SYSTEM, tools = TOOLS) {
  return buildRequestHeaderPayload({ requestId, system, tools, messages: [{ role: 'user', content: 'hi' }] })
}

describe('elideConstantHeaderFields（§7.2 断言 6–9）', () => {
  it('断言 8（首见）：指纹首次出现时写全量，并返回新指纹', () => {
    const header = buildHeader('req-1')
    const { elided, fingerprints } = elideConstantHeaderFields(header, null)
    expect(elided.system).toBe(SYSTEM)
    expect(elided.tools).toEqual(TOOLS)
    expect(fingerprints?.system).toBe(header.surfaceSnapshot.systemFingerprint)
    expect(fingerprints?.tools).toBe(header.surfaceSnapshot.toolsFingerprint)
  })

  it('断言 7（指纹未变）：不写全量，仅留指纹引用（surfaceSnapshot 不受影响）', () => {
    const header = buildHeader('req-2')
    const prev = { system: header.surfaceSnapshot.systemFingerprint, tools: header.surfaceSnapshot.toolsFingerprint }
    const { elided } = elideConstantHeaderFields(header, prev)
    expect(elided.system).toBeUndefined()
    expect(elided.tools).toBeUndefined()
    // 指纹引用保留在 surfaceSnapshot 中，读取侧可据此回填
    expect(elided.surfaceSnapshot.systemFingerprint).toBe(header.surfaceSnapshot.systemFingerprint)
    expect(elided.surfaceSnapshot.toolsFingerprint).toBe(header.surfaceSnapshot.toolsFingerprint)
    expect(elided.surfaceSnapshot.systemTokens).toBe(header.surfaceSnapshot.systemTokens)
    expect(elided.surfaceSnapshot.toolsTokens).toBe(header.surfaceSnapshot.toolsTokens)
  })

  it('断言 8（指纹变化）：system 变更时重写全量', () => {
    const header = buildHeader('req-3', 'NEW SYSTEM PROMPT')
    const prev = { system: 'old-system-fp', tools: header.surfaceSnapshot.toolsFingerprint }
    const { elided, fingerprints } = elideConstantHeaderFields(header, prev)
    expect(elided.system).toBe('NEW SYSTEM PROMPT')
    expect(elided.tools).toEqual(TOOLS)
    expect(fingerprints?.system).toBe(header.surfaceSnapshot.systemFingerprint)
  })

  it('断言 7 回归：既有字段逐字段不变（除 system/tools 外）', () => {
    const header = buildHeader('req-4')
    const prev = { system: header.surfaceSnapshot.systemFingerprint, tools: header.surfaceSnapshot.toolsFingerprint }
    const { elided } = elideConstantHeaderFields(header, prev)
    expect(elided.schemaVersion).toBe(header.schemaVersion)
    expect(elided.requestId).toBe(header.requestId)
    expect(elided.stablePrefixFingerprint).toBe(header.stablePrefixFingerprint)
    expect(elided.requiredSurfaceSet).toEqual(header.requiredSurfaceSet)
    expect(elided.toolExecutionCheckpoint).toEqual(header.toolExecutionCheckpoint)
    expect(elided.surfaceSnapshot).toEqual(header.surfaceSnapshot)
  })

  it('断言 6/9：elide 后的 header 喂给 computeContextPressureFromEvents，用量锚定结果与全量版等价', () => {
    const full = buildHeader('req-5')
    const prev = { system: full.surfaceSnapshot.systemFingerprint, tools: full.surfaceSnapshot.toolsFingerprint }
    const { elided } = elideConstantHeaderFields(full, prev)
    const requestContext = buildRequestContextPayload({ requestId: 'req-5', provider: 'anthropic', model: 'claude-sonnet-4-20250514', contextWindow: 200_000, maxTokensEffective: 4_000, surfaceSnapshot: full.surfaceSnapshot })
    const usage = { schemaVersion: 1, requestId: 'req-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, source: 'api' }
    const makeEvents = (headerPayload: Record<string, unknown>) => [
      { seq: 1, time: 1, type: 'request_header', payload: { route: 'r', schemaVersion: 1, requestId: 'req-5', ...headerPayload } },
      { seq: 2, time: 2, type: 'request_context', payload: requestContext },
      { seq: 3, time: 3, type: 'request_usage', payload: usage }
    ]
    const input = {
      currentSurface: full.surfaceSnapshot,
      budget: requestContext.budget,
      contextWindow: requestContext.contextWindow.tokens,
      anchor: { requestId: 'req-5', surfaceTokens: full.surfaceSnapshot.surfaceTokens, surfaceFingerprint: full.surfaceSnapshot.fingerprint, systemFingerprint: full.surfaceSnapshot.systemFingerprint, toolsFingerprint: full.surfaceSnapshot.toolsFingerprint, provider: 'anthropic', model: 'claude-sonnet-4-20250514', estimatorVersion: requestContext.budget.estimatorVersion, serializationVersion: requestContext.budget.serializationVersion, realUsage: usage.usage, contextWindow: 200_000 }
    }
    const fromFull = computeContextPressureFromEvents(makeEvents({ surfaceSnapshot: full.surfaceSnapshot }) as never, input as never)
    const fromElided = computeContextPressureFromEvents(makeEvents({ surfaceSnapshot: elided.surfaceSnapshot }) as never, input as never)
    expect(fromElided).toEqual(fromFull)
  })
})
