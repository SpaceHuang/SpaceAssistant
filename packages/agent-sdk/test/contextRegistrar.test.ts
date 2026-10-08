import { describe, expect, it } from 'vitest'
import type { ContextFrame, ContextScope } from '../src/context'
import { createContextRegistrar } from '../src/context'

const scope: ContextScope = { kind: 'invocation', sessionId: 'session-a', invocationId: 'invocation-a' }
const baseFrame: ContextFrame = {
  items: [
    { replayIdentity: 'user-a', sourceMessageIds: ['message-a'], message: { role: 'user', id: 'message-a', content: 'task' }, sourceData: {} },
    { replayIdentity: 'assistant-a', sourceMessageIds: ['message-b'], message: { role: 'assistant', id: 'message-b', content: 'old response' }, sourceData: {} }
  ],
  system: 'system prompt', windowId: 'window-a', pendingTools: [],
  requiredUser: { id: 'message-a', message: { role: 'user', id: 'message-a', content: 'task' } }
}

describe('ContextRegistrar', () => {
  it('issues an immutable snapshot and accepts only a transformation bound to that exact snapshot', () => {
    const registrar = createContextRegistrar()
    const base = registrar.captureFrame({ scope, frame: baseFrame, binding: { kind: 'invocation', phase: 'preflight', epoch: 1, expectedHistoryVersion: 4 } })
    expect(registrar.readBinding(base)).toEqual({ kind: 'invocation', phase: 'preflight', epoch: 1, expectedHistoryVersion: 4 })
    const output: ContextFrame = { ...baseFrame, items: [baseFrame.items[0]!], windowId: 'window-b' }
    const candidate = registrar.registerTransformation({
      base, output,
      proof: {
        historyPayload: { compactionId: 'compact-a' },
        sourceBindings: [{ outputIdentity: 'user-a', inputIdentities: ['user-a'] }],
        checkpoint: { checkpointId: 'checkpoint-a' }, shadowedRanges: [{ start: 'user-a', end: 'assistant-a' }]
      }
    })

    expect(candidate.base).toEqual(base)
    expect(candidate.output).toEqual(output)
    expect(Object.isFrozen(candidate.base)).toBe(true)
    expect(() => registrar.registerTransformation({ base: { ...base, frame: { ...base.frame, system: 'forged' } }, output, proof: {
      historyPayload: {}, sourceBindings: [{ outputIdentity: 'user-a', inputIdentities: ['user-a'] }], checkpoint: {}, shadowedRanges: []
    } })).toThrow('CONTEXT_BASE_NOT_REGISTERED')
  })

  it('rejects output source mappings that omit or invent source identities', () => {
    const registrar = createContextRegistrar()
    const base = registrar.captureFrame({ scope, frame: baseFrame, binding: { kind: 'invocation', phase: 'boundary', epoch: 2, expectedHistoryVersion: 5 } })
    const merged: ContextFrame = { ...baseFrame, items: [{
      replayIdentity: 'merged', sourceMessageIds: ['message-a', 'missing-message'],
      message: { role: 'user', content: 'merged content' }, sourceData: {}
    }] }

    expect(() => registrar.registerTransformation({ base, output: merged, proof: {
      historyPayload: {}, sourceBindings: [{ outputIdentity: 'merged', inputIdentities: ['user-a'] }], shadowedRanges: []
    } })).toThrow('CONTEXT_SOURCE_BINDING_MISMATCH')
  })

  it('rejects an invented required user when the captured frame has none', () => {
    const registrar = createContextRegistrar()
    const frameWithoutRequiredUser: ContextFrame = { ...baseFrame, requiredUser: undefined }
    const base = registrar.captureFrame({ scope, frame: frameWithoutRequiredUser, binding: { kind: 'invocation', phase: 'preflight', epoch: 7, expectedHistoryVersion: 9 } })
    const output: ContextFrame = {
      ...frameWithoutRequiredUser,
      requiredUser: { id: 'message-a', message: { role: 'user', id: 'message-a', content: 'task' } }
    }

    expect(() => registrar.registerTransformation({ base, output, proof: {
      historyPayload: {},
      sourceBindings: output.items.map((item) => ({ outputIdentity: item.replayIdentity, inputIdentities: [item.replayIdentity] })),
      shadowedRanges: []
    } })).toThrow('CONTEXT_REQUIRED_USER_MISMATCH')
  })

  it('requires checkpoint evidence for output items without source messages and releases registered evidence', () => {
    const registrar = createContextRegistrar()
    const base = registrar.captureFrame({ scope, frame: baseFrame, binding: { kind: 'invocation', phase: 'preflight', epoch: 3, expectedHistoryVersion: 6 } })
    const checkpointed: ContextFrame = { ...baseFrame, items: [{ replayIdentity: 'checkpoint-output', sourceMessageIds: [], message: { role: 'user', content: 'checkpoint' }, sourceData: {} }] }
    const proof = { historyPayload: {}, sourceBindings: [], shadowedRanges: [] }

    expect(() => registrar.registerTransformation({ base, output: checkpointed, proof })).toThrow('CONTEXT_CHECKPOINT_EVIDENCE_REQUIRED')
    const candidate = registrar.registerTransformation({ base, output: checkpointed, proof: { ...proof, checkpoint: {
      identity: 'checkpoint-output', checkpointMessage: { role: 'user', content: 'checkpoint' }
    } } })
    registrar.release(candidate)
    expect(() => registrar.readEvidence(candidate)).toThrow('CONTEXT_EVIDENCE_NOT_REGISTERED')
    expect(() => registrar.readBinding(base)).toThrow('CONTEXT_BASE_NOT_REGISTERED')
  })

  it('rejects source-free output whose checkpoint evidence names a different replay identity', () => {
    const registrar = createContextRegistrar()
    const base = registrar.captureFrame({ scope, frame: baseFrame, binding: { kind: 'invocation', phase: 'preflight', epoch: 8, expectedHistoryVersion: 10 } })
    const checkpointed: ContextFrame = { ...baseFrame, items: [{ replayIdentity: 'unrelated-output', sourceMessageIds: [], message: { role: 'user', content: 'invented' }, sourceData: {} }] }

    expect(() => registrar.registerTransformation({ base, output: checkpointed, proof: {
      historyPayload: {}, sourceBindings: [], shadowedRanges: [],
      checkpoint: { identity: 'actual-checkpoint', checkpointMessage: { role: 'user', content: 'invented' } }
    } })).toThrow('CONTEXT_CHECKPOINT_EVIDENCE_MISMATCH')
  })
})
