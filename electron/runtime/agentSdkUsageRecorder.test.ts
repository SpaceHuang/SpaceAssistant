import { describe, expect, it, vi } from 'vitest'
import { createAgentSdkUsageRecorder } from './agentSdkUsageRecorder'
import { buildStepAttribution } from '../../src/shared/usageAttribution'

describe('createAgentSdkUsageRecorder', () => {
  it('maps accepted and discarded attempt usage to distinct existing usage-step facts', () => {
    const recordStepUsage = vi.fn()
    const record = createAgentSdkUsageRecorder({
      requestId: 'req-1', sessionId: 'session-1', turnId: 'turn-1', model: 'claude-test', llmServiceId: 'service-1',
      modelId: 'catalog-1', providerModelName: 'vendor/model-x', routeIdentity: 'route-1', baseUrl: 'https://gateway.test', recordStepUsage
    })
    record({ invocationId: 'inv-1', modelTurn: 2, attempt: 1, routeId: 'route-1', usage: { inputTokens: 100, outputTokens: 4, cacheReadInputTokens: 11, cacheCreationInputTokens: 5 }, finishReason: 'stop', disposition: 'discarded' })
    record({ invocationId: 'inv-1', modelTurn: 2, attempt: 2, routeId: 'route-1', usage: { inputTokens: 70, outputTokens: 3 }, finishReason: 'stop', disposition: 'accepted' })
    expect(recordStepUsage).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1', turnId: 'turn-1', stepId: 'req-1:model:2:attempt:1',
      usage: { input_tokens: 100, output_tokens: 4, cache_read_input_tokens: 11, cache_creation_input_tokens: 5 }, baseUrl: 'https://gateway.test', model: 'claude-test', llmServiceId: 'service-1',
      modelId: 'catalog-1', providerModelName: 'vendor/model-x', routeIdentity: 'route-1'
    })
    expect(recordStepUsage).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1', turnId: 'turn-1', stepId: 'req-1:model:2:attempt:2',
      usage: { input_tokens: 70, output_tokens: 3 }, baseUrl: 'https://gateway.test', model: 'claude-test', llmServiceId: 'service-1',
      modelId: 'catalog-1', providerModelName: 'vendor/model-x', routeIdentity: 'route-1'
    })
  })

  it('ignores malformed provider usage rather than writing invalid step facts', () => {
    const recordStepUsage = vi.fn()
    const record = createAgentSdkUsageRecorder({ requestId: 'r', sessionId: 's', turnId: 't', recordStepUsage })
    record({ modelTurn: 0, attempt: -1, usage: { inputTokens: -1, outputTokens: 2 } })
    expect(recordStepUsage).not.toHaveBeenCalled()
  })

  it('attaches an estimator-versioned snapshot from the current prepared request material', () => {
    const recordStepUsage = vi.fn()
    const record = createAgentSdkUsageRecorder({ requestId: 'r', sessionId: 's', turnId: 't', recordStepUsage })
    const attributionInput = { system: 'system template', tools: [{ name: 'grep' }], messages: [{ role: 'user', content: 'hello' }] }
    record({ modelTurn: 1, attempt: 1, usage: { inputTokens: 10, outputTokens: 1 }, attributionInput })
    expect(recordStepUsage).toHaveBeenCalledWith(expect.objectContaining({ attribution: expect.objectContaining({
      ...buildStepAttribution(attributionInput), attributionJson: JSON.stringify((( { threeSources: _sources, ...snapshot }) => snapshot)(buildStepAttribution(attributionInput)))
    }) }))
  })

  it('projects actual attempt usage into the desktop session ledger and usage fact, including discarded overflow', async () => {
    const recordStepUsage = vi.fn()
    const emitSessionEvent = vi.fn(async () => undefined)
    const emitFactEvent = vi.fn()
    const record = createAgentSdkUsageRecorder({
      requestId: 'req-usage', sessionId: 'session-usage', turnId: 'turn-usage', baseUrl: 'https://api.anthropic.com', recordStepUsage,
      emitSessionEvent, emitFactEvent
    } as never)
    await record({
      invocationId: 'req-usage', modelTurn: 2, attempt: 1, routeId: 'route-1',
      usage: { inputTokens: 100, outputTokens: 8, cacheReadInputTokens: 20 }, finishReason: 'stop',
      disposition: 'discarded', reasonCode: 'SILENT_CONTEXT_OVERFLOW'
    })

    expect(emitSessionEvent).toHaveBeenCalledWith({ type: 'request_usage', payload: {
      schemaVersion: 1, requestId: 'req-usage:round:2', turnId: 'turn-usage', source: 'api',
      usage: { input_tokens: 100, output_tokens: 8, cache_read_input_tokens: 20, cacheSemantics: 'additive' },
      resultDisposition: 'discarded_overflow'
    } })
    expect(emitFactEvent).toHaveBeenCalledWith({ type: 'usage-updated', usage: {
      input_tokens: 100, output_tokens: 8, cache_read_input_tokens: 20, cacheSemantics: 'additive'
    } })
    expect(recordStepUsage).toHaveBeenCalledOnce()
  })

  it('uses a distinct SessionEvent request id for a retried provider attempt in the same model turn', async () => {
    const emitSessionEvent = vi.fn(async () => undefined)
    const record = createAgentSdkUsageRecorder({ requestId: 'req-usage', sessionId: 'session-usage', turnId: 'turn-usage', emitSessionEvent })
    await record({ invocationId: 'req-usage', modelTurn: 1, attempt: 1, usage: { inputTokens: 100, outputTokens: 8 }, disposition: 'discarded', reasonCode: 'SILENT_CONTEXT_OVERFLOW' })
    await record({ invocationId: 'req-usage', modelTurn: 1, attempt: 2, usage: { inputTokens: 70, outputTokens: 3 }, disposition: 'completed' })

    expect(emitSessionEvent.mock.calls.map(([event]) => event.payload.requestId)).toEqual([
      'req-usage:round:1', 'req-usage:round:1:attempt:2'
    ])
  })
})
