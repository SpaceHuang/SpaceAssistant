import { describe, expect, it, vi } from 'vitest'
import { createAgentSdkPreflightAdapter, createAgentSdkTurnBoundaryAdapter } from './agentSdkTurnBoundary'

const required = { id: 'user-current', message: { role: 'user' as const, content: 'current question' } }
const base = {
  invocationId: 'inv', modelTurn: 1, response: { role: 'assistant' as const, content: 'answer' },
  messages: [required.message, { role: 'assistant' as const, content: 'answer' }],
  toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 },
  currentUserMessageId: required.id, requiredUserMessage: required
}

describe('Agent SDK turn boundary host adapter', () => {
  it('reports an over-budget preflight that the host compaction planner cannot recover', async () => {
    const compact = vi.fn(async () => undefined)
    const preflight = createAgentSdkPreflightAdapter({ compact })
    const requestProjection = {
      requestId: 'inv:round:1', windowId: 'window-1', system: 'system', tools: [],
      surfaceSnapshot: { schemaVersion: 1 as const, fingerprint: 'surface', systemFingerprint: 'system', toolsFingerprint: 'tools', surfaceTokens: 120, systemTokens: 2, toolsTokens: 1, messageTokens: 117 },
      budget: { totalInputBudget: 90, bodyBudget: 87, inputBudget: 87, prefixTokens: 3, requiredTokens: 0, outputReserveTokens: 10, safetyReserveTokens: 0, triggerRatio: 0.9, targetBodyRatio: 0.8, estimatorVersion: 'default-v1', serializationVersion: 'anthropic-wire-v1' },
      contextUsage: { pressureTokens: 120, projectedTokens: 120, surfaceTokens: 120, hardFit: false, bodyFit: false },
      toolExecutionCheckpoint: { completedToolUseIds: [], replayForbidden: false }, requiredSurfaceSet: [required.id]
    }

    await expect(preflight({ ...base, request: { messages: base.messages, maxTokens: 32 }, requestProjection })).resolves.toMatchObject({ rejected: 'OVER_BUDGET' })
    expect(compact).toHaveBeenCalledOnce()
  })

  it('passes only a complete SDK boundary envelope to the legacy compaction adapter', async () => {
    const compact = vi.fn(async () => undefined)
    const boundary = createAgentSdkTurnBoundaryAdapter({ compact })
    const requestProjection = {
      requestId: 'inv:round:1', windowId: 'window-1', system: 'system', tools: [],
      surfaceSnapshot: { schemaVersion: 1, fingerprint: 'surface', systemFingerprint: 'system', toolsFingerprint: 'tools', surfaceTokens: 9, systemTokens: 2, toolsTokens: 1, messageTokens: 6 },
      budget: { totalInputBudget: 90, bodyBudget: 87, inputBudget: 87, prefixTokens: 3, requiredTokens: 0, outputReserveTokens: 10, safetyReserveTokens: 0, triggerRatio: 0.9, targetBodyRatio: 0.8, estimatorVersion: 'default-v1', serializationVersion: 'anthropic-wire-v1' },
      contextUsage: { pressureTokens: 7, projectedTokens: 9, surfaceTokens: 9, hardFit: true, bodyFit: true },
      toolExecutionCheckpoint: { completedToolUseIds: [], replayForbidden: false }, requiredSurfaceSet: [required.id]
    }
    await boundary({ ...base, requestProjection })
    expect(compact).toHaveBeenCalledWith(expect.objectContaining({
      messages: base.messages, toolCalls: [], requiredUserMessage: required,
      plannerInputs: requestProjection,
      legacyMessages: [{ role: 'user', id: 'user-current', content: 'current question' }, { role: 'assistant', content: 'answer' }]
    }))
  })

  it('does not ask legacy compaction to rewrite a transcript with pending tool proposals', async () => {
    const compact = vi.fn(async () => ({ messages: [{ role: 'user' as const, content: 'summary' }] }))
    const boundary = createAgentSdkTurnBoundaryAdapter({ compact })
    const result = await boundary({ ...base, toolCalls: [{ invocationId: 'inv', toolCallId: 'tc1', toolName: 'write', input: { path: 'a' } }] })
    expect(result).toBeUndefined()
    expect(compact).not.toHaveBeenCalled()
  })

  it('refuses a compaction result that omits the exact required current user message', async () => {
    const compact = vi.fn(async () => ({ messages: [{ role: 'user' as const, content: 'summary' }] }))
    const boundary = createAgentSdkTurnBoundaryAdapter({ compact })
    await expect(boundary(base)).resolves.toBeUndefined()
    expect(compact).toHaveBeenCalledOnce()
  })

  it('fails closed when current-user identity is supplied without its canonical message binding', async () => {
    const compact = vi.fn(async () => ({ messages: [{ role: 'assistant' as const, content: 'summary' }] }))
    const boundary = createAgentSdkTurnBoundaryAdapter({ compact })
    const result = await boundary({ ...base, requiredUserMessage: undefined })
    expect(result).toBeUndefined()
    expect(compact).not.toHaveBeenCalled()
  })

  it('returns a safe compacted transcript when the current user message is retained exactly', async () => {
    const compacted = { messages: [required.message, { role: 'assistant' as const, content: 'summary' }] }
    const boundary = createAgentSdkTurnBoundaryAdapter({ compact: async () => compacted })
    await expect(boundary(base)).resolves.toEqual(compacted)
  })
})
