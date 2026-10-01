import { describe, expect, it } from 'vitest'
import { definePlannedTool } from './plannedToolRegistry'
import { PreparedInvocationStore, PreparedInvocationStoreError } from './preparedInvocationStore'

async function planned() {
  const tool = definePlannedTool({
    name: 'lookup',
    parseInput: (raw) => raw as { query: string },
    plan: async (input) => ({ query: input.query, revision: 4 }),
    facts: (plan) => ({ target: plan.query }),
    execute: async () => 'ok'
  })
  return tool.begin({ query: 'weather' }, { requestId: 'req', toolUseId: 'tc' })
}

describe('PreparedInvocationStore', () => {
  it('在异步 plan 前快照 canonical input，等待期间替换输入不能和旧执行计划重新绑定', async () => {
    let markPlanning!: () => void
    let releasePlanning!: () => void
    const planningStarted = new Promise<void>((resolve) => { markPlanning = resolve })
    const planningBarrier = new Promise<void>((resolve) => { releasePlanning = resolve })
    const rawInput = { query: 'approved' }
    const tool = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string },
      plan: async (input) => {
        const plannedQuery = input.query
        markPlanning()
        await planningBarrier
        return { query: plannedQuery }
      },
      execute: async () => 'ok'
    })
    const planning = tool.beginPlanning(rawInput, { requestId: 'req', toolUseId: 'tc' })
    await planningStarted
    rawInput.query = 'replaced-during-plan'
    releasePlanning()
    const handle = await planning.result
    const store = new PreparedInvocationStore()

    expect(() => store.put(handle.prepared, {
      turnId: 'turn', canonicalInput: rawInput,
      inputMappingVersion: 'lookup-input-v1', targetVersion: 'target-v1'
    })).toThrow(expect.objectContaining({ reason: 'INPUT_SNAPSHOT_MISMATCH' }))
  })

  it('constructs expected permit bindings only from its private prepared record', async () => {
    const handle = await planned()
    const store = new PreparedInvocationStore()
    store.put(handle.prepared, { turnId: 'turn', canonicalInput: { query: 'weather' }, inputMappingVersion: 'lookup-input-v1', targetVersion: 'target-v1' })

    expect(store.resolveExpected({
      invocationId: handle.prepared.invocationId, requestId: 'req', turnId: 'turn', toolCallId: 'tc', toolName: 'lookup',
      canonicalInput: { query: 'weather' }, targetVersion: 'target-v1', authorizationVersion: 'auth-v1', phase: 'recheck'
    })).toMatchObject({
      requestId: 'req', turnId: 'turn', invocationId: handle.prepared.invocationId, toolCallId: 'tc', capabilityId: 'lookup',
      planDigest: handle.prepared.planDigest, factsDigest: handle.prepared.factsDigest, authorizationVersion: 'auth-v1', phase: 'recheck'
    })
  })

  it('rejects changed input, target, authorization, and cross-call bindings', async () => {
    const handle = await planned()
    const store = new PreparedInvocationStore()
    store.put(handle.prepared, { turnId: 'turn', canonicalInput: { query: 'weather' }, inputMappingVersion: 'lookup-input-v1', targetVersion: 'target-v1' })
    const base = {
      invocationId: handle.prepared.invocationId, requestId: 'req', turnId: 'turn', toolCallId: 'tc', toolName: 'lookup',
      canonicalInput: { query: 'weather' }, targetVersion: 'target-v1', authorizationVersion: 'auth-v1', phase: 'recheck' as const
    }
    expect(() => store.resolveExpected({ ...base, canonicalInput: { query: 'other' } })).toThrow(expect.objectContaining({ code: 'prepared-invocation-rejected', reason: 'INPUT_SNAPSHOT_MISMATCH' }))
    expect(() => store.resolveExpected({ ...base, targetVersion: 'target-v2' })).toThrow(expect.objectContaining({ reason: 'TARGET_VERSION_CHANGED' }))
    expect(store.resolveExpected({ ...base, authorizationVersion: 'auth-v2' })).toMatchObject({ authorizationVersion: 'auth-v2' })
    expect(() => store.resolveExpected({ ...base, toolCallId: 'other-call' })).toThrow(expect.objectContaining({ reason: 'BINDING_MISMATCH' }))
  })

  it('invalidates prepared records and releases them after dispatch settles', async () => {
    const handle = await planned()
    const store = new PreparedInvocationStore()
    store.put(handle.prepared, { turnId: 'turn', canonicalInput: { query: 'weather' }, inputMappingVersion: 'lookup-input-v1', targetVersion: 'target-v1' })
    store.invalidate(handle.prepared.invocationId)
    expect(() => store.resolveExpected({
      invocationId: handle.prepared.invocationId, requestId: 'req', turnId: 'turn', toolCallId: 'tc', toolName: 'lookup',
      canonicalInput: { query: 'weather' }, targetVersion: 'target-v1', authorizationVersion: 'auth-v1', phase: 'recheck'
    })).toThrow(PreparedInvocationStoreError)
    expect(() => store.put(handle.prepared, { turnId: 'turn', canonicalInput: { query: 'weather' }, inputMappingVersion: 'lookup-input-v1', targetVersion: 'target-v1' })).toThrow('DUPLICATE_PREPARED_INVOCATION')
    store.settle(handle.prepared.invocationId)
    expect(store.has(handle.prepared.invocationId)).toBe(false)
  })

  it('returns a frozen canonical snapshot only for the registered mapping version', async () => {
    const handle = await planned()
    const store = new PreparedInvocationStore()
    store.put(handle.prepared, { turnId: 'turn', canonicalInput: { query: 'weather' }, inputMappingVersion: 'lookup-input-v1', targetVersion: 'target-v1' })
    expect(() => store.readCanonicalInput(handle.prepared.invocationId, 'lookup-input-v2')).toThrow(PreparedInvocationStoreError)
    const snapshot = store.readCanonicalInput(handle.prepared.invocationId, 'lookup-input-v1') as { query: string }
    expect(snapshot).toEqual({ query: 'weather' })
    snapshot.query = 'changed-in-caller'
    expect(store.readCanonicalInput(handle.prepared.invocationId, 'lookup-input-v1')).toEqual({ query: 'weather' })
  })
})
