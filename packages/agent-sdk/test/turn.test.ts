import { describe, expect, it, vi } from 'vitest'
import { runAgentTurn, runHostedAgentTurn, type AgentTurnHost } from '../src/turn'
import { ModelProviderRegistry, type CanonicalModelMessage, type StreamChunk } from '../src/model'
import { CapabilityRegistry } from '../src/capability'
import { InMemorySafetyPermitStore, type PermitBinding } from '../src/safetyPermit'
import { SafetyGate } from '../src/safetyGate'
import { InMemoryExecutionAdmissionCoordinator } from '../src/executionAdmission'
import { createPermitBoundToolExecutionPort } from '../src/toolExecutionPort'
import { InvocationHistoryWriter, MemoryHistory, rebuildInvocationStates, type HistoryEvent } from '../src/history'
import { ResourceLockRegistry } from '../src/resourceLock'

const route = { routeId: 'test', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
const toolBinding = { requestId: 'req', turnId: 'turn', invocationId: 'inv', toolCallId: 'tc1', capabilityId: 'lookup', inputSnapshotHash: 'input-hash', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'auth-v1', phase: 'initial-compat' as const }

async function* stream(...chunks: StreamChunk[]) { yield* chunks }

function toolExecutionPort(permits: InMemorySafetyPermitStore, execute: (call: { invocationId: string; toolCallId: string; toolName: string }, signal: AbortSignal) => Promise<{ output: unknown; replayContent?: unknown; isError?: boolean }>) {
  return createPermitBoundToolExecutionPort({
    permits,
    admission: new InMemoryExecutionAdmissionCoordinator(),
    allowedPhase: 'recheck',
    resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
    execute
  })
}

describe('runAgentTurn', () => {
  it('maintains dispatch and transcript invariants across 1000 deterministic randomized batches', async () => {
    let seed = 0x5eed1234
    const random = () => {
      seed |= 0
      seed = seed + 0x6d2b79f5 | 0
      let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
      value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
      return ((value ^ value >>> 14) >>> 0) / 4294967296
    }
    const categories = ['success', 'business', 'deny', 'fatal', 'idle'] as const
    for (let round = 0; round < 1000; round += 1) {
      const count = 1 + Math.floor(random() * 8)
      const outcomes = Array.from({ length: count }, () => categories[Math.floor(random() * categories.length)]!)
      const registry = new ModelProviderRegistry()
      registry.register(route, { providerId: `random-${round}`, stream: (call) => stream(
        ...(call.request.messages.some((message) => message.role === 'tool')
          ? [{ type: 'text-delta' as const, text: 'done' }, { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }, { type: 'finish' as const, reason: 'stop' as const }]
          : [...outcomes.map((_, index) => ({ type: 'tool-call' as const, toolCallId: `tc-${round}-${index}`, toolName: 'lookup', input: { index } })), { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }, { type: 'finish' as const, reason: 'tool-calls' as const }]
        )
      ) })
      const invocationId = `random-${round}`
      const capabilities = new CapabilityRegistry()
      capabilities.define(invocationId, ['lookup'])
      const permits = new InMemorySafetyPermitStore()
      const history = new MemoryHistory()
      const fatal = outcomes.some((outcome) => outcome === 'fatal')
      const execution = toolExecutionPort(permits, async (call) => {
        const index = Number(call.toolCallId.split('-')[2])
        const outcome = outcomes[index]
        if (outcome === 'fatal') throw new Error('random fatal')
        return { output: outcome === 'business' ? { error: 'business' } : 'ok', isError: outcome === 'business' }
      })
      const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => {
        const index = Number(binding.toolCallId.split('-')[2])
        return outcomes[index] === 'deny'
          ? { kind: 'deny', reasonCode: 'POLICY_DENY' }
          : { kind: 'allow', authorizationVersion: binding.authorizationVersion }
      } } })
      const ports = {
        registry, routeId: route.routeId, invocationId, history,
        request: { messages: [], maxTokens: 100 }, safetyGate,
        prepareTool: async (call: { invocationId: string; toolCallId: string; toolName: string }, stage: { kind: 'initial' | 'recheck' }) => ({
          ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName,
          phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const
        }),
        toolExecution: execution, maxModelTurns: 3, maxConcurrentTools: 2, toolResourceKeys: () => [], returnDeniedToolsToModel: true
      }
      let result: Awaited<ReturnType<typeof runAgentTurn>> | undefined
      let failure: unknown
      try { result = await runAgentTurn(ports) } catch (error) { failure = error }
      if (Boolean(failure) !== fatal) throw new Error(`random batch ${round} outcomes=${outcomes.join(',')} failed=${String(failure)}`)
      const snapshot = await history.read(invocationId)
      const toolCalls = snapshot.events.find(({ kind }) => kind === 'model-response-committed')?.payload as { message?: { toolCalls?: Array<{ id: string }> } } | undefined
      const proposedIds = toolCalls?.message?.toolCalls?.map(({ id }) => id) ?? []
      const results = snapshot.events.filter(({ kind }) => kind === 'tool-call-finished' || kind === 'tool-call-not-dispatched')
      const messages = result?.messages ?? []
      expect(messages.every((message) => message !== undefined && typeof message.role === 'string')).toBe(true)
      for (const id of proposedIds) {
        const messageCount = messages.filter((message) => message.role === 'tool' && message.toolCallId === id).length
        const eventCount = results.filter(({ payload }) => (payload as { toolCallId?: string }).toolCallId === id).length
        const started = snapshot.events.some((event) => event.kind === 'tool-call-started' && (event.payload as { toolCallId?: string }).toolCallId === id)
        const uncertain = snapshot.events.some((event) => event.kind === 'invocation-interrupted' && (event.payload as { reason?: string }).reason === 'unknown-after-dispatch')
        if (messageCount + eventCount === 0 && !(started && uncertain)) throw new Error(`random batch ${round} missing outcome for ${id}; outcomes=${outcomes.join(',')} failure=${String(failure)}`)
        expect(messageCount).toBeLessThanOrEqual(1)
        const notDispatchedCount = results.filter((event) => event.kind === 'tool-call-not-dispatched' && (event.payload as { toolCallId?: string }).toolCallId === id).length
        expect(notDispatchedCount).toBeLessThanOrEqual(1)
        if (messageCount === 0 && eventCount === 0 && !started) expect(notDispatchedCount).toBe(1)
      }
      const notDispatchedIds = results.filter(({ kind }) => kind === 'tool-call-not-dispatched').map(({ payload }) => (payload as { toolCallId: string }).toolCallId)
      if (notDispatchedIds.some((id) => !outcomes[Number(id.split('-')[2])] || outcomes[Number(id.split('-')[2])] !== 'deny')) expect(fatal).toBe(true)
      if (!fatal) expect(proposedIds.every((id) => outcomes[Number(id.split('-')[2])] === 'deny' || results.some(({ kind, payload }) => kind === 'tool-call-finished' && (payload as { toolCallId?: string }).toolCallId === id))).toBe(true)
    }
  }, 30000)
  it('派发前准入拒绝写入 not-dispatched 并回灌模型，且不触碰 executor', async () => {
    const registry = new ModelProviderRegistry()
    const requests: Array<readonly CanonicalModelMessage[]> = []
    registry.register(route, { providerId: 'dispatch-admission', stream: async function* (call) {
      requests.push(structuredClone(call.request.messages))
      if (requests.length === 1) {
        yield { type: 'tool-call', toolCallId: 'retry-write-1', toolName: 'edit_file', input: { path: '/tmp/a.md' } }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: '已停止重试并说明原因' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('dispatch-admission', ['edit_file'])
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'must not execute' }))
    const evaluate = vi.fn(async () => ({ kind: 'allow' as const, authorizationVersion: 'v1' }))
    const prepareTool = vi.fn(async (call: { invocationId: string; toolCallId: string; toolName: string }, stage: { kind: 'initial' | 'recheck' }) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }))
    const acquire = vi.fn(async () => ({ release: vi.fn() }))
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'dispatch-admission',
      request: { messages: [{ role: 'user', content: 'edit safely' }], maxTokens: 20 }, history,
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate } }),
      prepareTool, resourceLocks: { acquire },
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 2,
      beforeToolDispatch: () => ({ kind: 'reject', reasonCode: 'REPEATED_SEMANTIC_CALL', message: 'same edit already failed' })
    })

    expect(result.text).toBe('已停止重试并说明原因')
    expect(execute).not.toHaveBeenCalled()
    expect(prepareTool).not.toHaveBeenCalled()
    expect(evaluate).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    await expect(permits.consume('never-issued', toolBinding)).resolves.toEqual({ ok: false, reason: 'UNKNOWN' })
    expect(requests[1]).toContainEqual(expect.objectContaining({ role: 'tool', toolCallId: 'retry-write-1', content: 'same edit already failed', isError: true }))
    expect((await history.read('dispatch-admission')).events).toContainEqual(expect.objectContaining({
      kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'retry-write-1', reason: 'REPEATED_SEMANTIC_CALL', replayContent: 'same edit already failed' })
    }))
    expect((await history.read('dispatch-admission')).events.some((event) => event.kind === 'tool-call-started')).toBe(false)
  })

  it('30 个同响应不同目标的普通执行失败全部提交并按提案顺序回灌', async () => {
    const registry = new ModelProviderRegistry()
    const nextRequests: CanonicalModelMessage[][] = []
    registry.register(route, { providerId: 'thirty-failures', stream: async function* (call) {
      if (call.request.messages.some((message) => message.role === 'tool')) {
        nextRequests.push(structuredClone(call.request.messages) as CanonicalModelMessage[])
        yield { type: 'text-delta', text: '这些文件需要先读取。' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      for (let index = 0; index < 30; index += 1) yield { type: 'tool-call', toolCallId: `edit-${index}`, toolName: 'edit_file', input: { path: `/docs/${index}.md` } }
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'tool-calls' }
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('thirty-failures', ['edit_file'])
    const permits = new InMemorySafetyPermitStore()
    const executed: string[] = []
    const binding = { ...toolBinding, invocationId: 'thirty-failures', capabilityId: 'edit_file' }
    const execution = toolExecutionPort(permits, async (call) => {
      executed.push(call.toolCallId)
      return { output: { error: '文件尚未在本会话中通过 read_file 读取' }, replayContent: 'READ_REQUIRED', isError: true }
    })
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'thirty-failures', history,
      request: { messages: [{ role: 'user', content: 'edit 30 files' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (current) => ({ kind: 'allow' as const, authorizationVersion: current.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...binding, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 6
    })
    expect(result.text).toBe('这些文件需要先读取。')
    expect(executed).toHaveLength(30)
    expect(nextRequests[0]?.filter((message) => message.role === 'tool').map((message) => message.toolCallId)).toEqual(Array.from({ length: 30 }, (_, index) => `edit-${index}`))
    expect((await history.read('thirty-failures')).events.filter((event) => event.kind === 'tool-call-finished')).toHaveLength(30)
    expect((await history.read('thirty-failures')).events.at(-1)?.kind).toBe('invocation-completed')
  })

  it('跨响应重复保护在 executor 前拦截，拒绝结果回灌后仍允许模型总结', async () => {
    const registry = new ModelProviderRegistry()
    const requests: Array<readonly CanonicalModelMessage[]> = []
    registry.register(route, { providerId: 'semantic-retry-guard', stream: async function* (call) {
      const round = requests.length + 1
      requests.push(structuredClone(call.request.messages))
      if (round <= 5) {
        yield { type: 'tool-call', toolCallId: `same-${round}`, toolName: 'edit_file', input: { path: '/docs/a.md' } }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: '连续失败后已停止重复操作。' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('semantic-retry-guard', ['edit_file'])
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: { error: 'read required' }, replayContent: 'READ_REQUIRED', isError: true }))
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (current) => ({ kind: 'allow' as const, authorizationVersion: current.authorizationVersion }) } })
    const failures = new Map<string, number>()
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'semantic-retry-guard', history,
      request: { messages: [{ role: 'user', content: 'edit the file' }], maxTokens: 20 }, safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 6,
      afterToolResult: (call, toolResult, source) => {
        if (toolResult.isError) failures.set(call.toolCallId, source?.modelTurn ?? 0)
      },
      beforeToolDispatch: (call) => failures.size >= 3
        ? { kind: 'reject', reasonCode: 'REPEATED_SEMANTIC_CALL', message: 'Do not retry; explain the blocker.' }
        : { kind: 'dispatch' }
    })
    expect(result.text).toBe('连续失败后已停止重复操作。')
    expect(execute).toHaveBeenCalledTimes(3)
    expect(requests[4]).toContainEqual(expect.objectContaining({ role: 'tool', toolCallId: 'same-4', content: 'Do not retry; explain the blocker.', isError: true }))
    expect((await history.read('semantic-retry-guard')).events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ reason: 'REPEATED_SEMANTIC_CALL' }) }))
  })

  it('同一响应中完全相同的并行调用不会因完成顺序触发派发拦截', async () => {
    const registry = new ModelProviderRegistry()
    let requestCount = 0
    registry.register(route, { providerId: 'same-batch-calls', stream: async function* () {
      requestCount += 1
      if (requestCount === 1) {
        for (const toolCallId of ['same-a', 'same-b', 'same-c']) yield { type: 'tool-call', toolCallId, toolName: 'edit_file', input: { path: '/docs/a.md' } }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: '完成' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const permits = new InMemorySafetyPermitStore()
    const capabilities = new CapabilityRegistry()
    capabilities.define('same-batch-calls', ['edit_file'])
    const execute = vi.fn(async (call: { toolCallId: string }) => {
      await new Promise((resolve) => setTimeout(resolve, call.toolCallId === 'same-a' ? 15 : 1))
      return { output: { error: 'same error' }, isError: true }
    })
    const admission = vi.fn(() => ({ kind: 'dispatch' as const }))
    const history = new MemoryHistory()
    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'same-batch-calls', history,
      request: { messages: [{ role: 'user', content: 'edit once' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (current) => ({ kind: 'allow' as const, authorizationVersion: current.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 2, maxConcurrentTools: 3, beforeToolDispatch: admission
    })
    expect(execute).toHaveBeenCalledTimes(3)
    expect(admission).toHaveBeenCalledTimes(3)
    expect((await history.read('same-batch-calls')).events.filter((event) => event.kind === 'tool-call-finished')).toHaveLength(3)
  })

  it('普通失败已提交后 afterToolResult 观察异常只记诊断，失败结果仍回灌并完成 Turn', async () => {
    const registry = new ModelProviderRegistry()
    const requests: Array<readonly CanonicalModelMessage[]> = []
    registry.register(route, { providerId: 'after-observation-failure', stream: async function* (call) {
      requests.push(structuredClone(call.request.messages))
      if (requests.length === 1) {
        yield { type: 'tool-call', toolCallId: 'failing-read', toolName: 'read_file', input: { path: '/docs/a.md' } }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: '无法读取，已向用户说明。' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('after-observation-failure', ['read_file'])
    const permits = new InMemorySafetyPermitStore()
    const observationError = vi.fn()
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'after-observation-failure', history,
      request: { messages: [{ role: 'user', content: 'read it' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (current) => ({ kind: 'allow' as const, authorizationVersion: current.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      toolExecution: toolExecutionPort(permits, async () => ({ output: { errorCode: 'NOT_FOUND' }, replayContent: 'file not found', isError: true })),
      maxModelTurns: 2, afterToolResult: async () => { throw new Error('strategy observer failed') },
      observer: { onObservationError: observationError }
    })
    expect(result.text).toBe('无法读取，已向用户说明。')
    expect(requests[1]).toContainEqual(expect.objectContaining({ role: 'tool', toolCallId: 'failing-read', content: 'file not found', isError: true }))
    expect(observationError).toHaveBeenCalledWith(expect.objectContaining({ message: 'strategy observer failed' }), 'tool-finished')
    expect((await history.read('after-observation-failure')).events).toContainEqual(expect.objectContaining({ kind: 'tool-call-finished', payload: expect.objectContaining({ toolCallId: 'failing-read', isError: true, replayContent: 'file not found' }) }))
    const committedResult = (await history.read('after-observation-failure')).events.find((event) => event.kind === 'tool-call-finished')?.payload as { replayContent?: unknown; isError?: boolean }
    const providerResult = requests[1]?.find((message) => message.role === 'tool')
    expect(providerResult).toMatchObject({ content: committedResult.replayContent, isError: committedResult.isError })
    expect((await history.read('after-observation-failure')).events.at(-1)?.kind).toBe('invocation-completed')
  })

  it('在 tool-call-started 的异步 History 提交期间取消时不进入 executor', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'async-start-cancel', stream: () => stream(
      { type: 'tool-call', toolCallId: 'async-start-cancel-tool', toolName: 'lookup', input: { query: 'safe' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const backingHistory = new MemoryHistory()
    let releaseStartAppend!: () => void
    let reportStartAppend!: () => void
    const startAppend = new Promise<void>((resolve) => { reportStartAppend = resolve })
    const release = new Promise<void>((resolve) => { releaseStartAppend = resolve })
    const history = {
      read: (invocationId: string) => backingHistory.read(invocationId),
      appendBatch: async (events: readonly HistoryEvent[], expectedVersion: number) => {
        if (events.some((event) => event.kind === 'tool-call-started')) {
          reportStartAppend()
          await release
        }
        return backingHistory.appendBatch(events, expectedVersion)
      }
    }
    const capabilities = new CapabilityRegistry()
    capabilities.define('async-start-cancel', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const controller = new AbortController()
    const execute = vi.fn(async () => ({ output: 'must not execute' }))
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion }) } })
    const execution = createPermitBoundToolExecutionPort({
      permits, admission, allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, requestId: 'async-start-cancel', turnId: 'async-start-cancel-turn', invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' as const }),
      execute
    })
    const running = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'async-start-cancel', turnId: 'async-start-cancel-turn',
      request: { messages: [{ role: 'user', content: 'lookup safely' }], maxTokens: 20, signal: controller.signal }, history,
      safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, requestId: 'async-start-cancel', turnId: 'async-start-cancel-turn', invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      toolExecution: execution, maxModelTurns: 2
    })

    await startAppend
    controller.abort('cancel during History start commit')
    releaseStartAppend()
    await expect(running).rejects.toMatchObject({ code: 'TURN_CANCELLED' })

    expect(execute).not.toHaveBeenCalled()
    expect(admission.executorEntries).toBe(0)
    const events = (await backingHistory.read('async-start-cancel')).events
    expect(events.some((event) => event.kind === 'tool-call-started' && (event.payload as { toolCallId?: string }).toolCallId === 'async-start-cancel-tool')).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'async-start-cancel-tool', reason: 'REQUEST_CANCELLED' }) }))
    expect(events.some((event) => event.kind === 'tool-call-finished' && (event.payload as { toolCallId?: string }).toolCallId === 'async-start-cancel-tool')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
  })

  it('persists an explicitly timed out Hosted turn as timed_out rather than cancelled', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake-timeout', stream: async function* (call) {
      await new Promise<void>((resolve) => {
        if (call.request.signal?.aborted) resolve()
        else call.request.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { type: 'usage', inputTokens: 1, outputTokens: 0 } as const
      yield { type: 'finish', reason: 'cancelled' } as const
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('hosted-timeout', [])
    const permits = new InMemorySafetyPermitStore()
    const controller = new AbortController()
    const host: AgentTurnHost = { createPorts: async ({ invocationId, turnId, routeId, request }) => ({
      registry, routeId, invocationId, ...(turnId ? { turnId } : {}), request, history,
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'v1' }) } }),
      prepareTool: async () => toolBinding,
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      maxModelTurns: 1
    }) }
    const running = runHostedAgentTurn({
      host, invocationId: 'hosted-timeout', turnId: 'hosted-timeout-turn', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'timeout this turn' }], maxTokens: 10, signal: controller.signal }
    })
    setTimeout(() => controller.abort('agent-turn-timeout'), 0)

    await expect(running).rejects.toMatchObject({ code: 'TURN_TIMED_OUT' })
    expect((await history.read('hosted-timeout')).events.at(-1)).toMatchObject({
      kind: 'invocation-failed', payload: { status: 'failed', reason: 'timeout' }
    })
  })

  it('returns a rejected confirmation to the model without dispatching the tool', async () => {
    const registry = new ModelProviderRegistry()
    let modelTurn = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      modelTurn += 1
      return modelTurn === 1
        ? stream({ type: 'tool-call', toolCallId: 'rejected-script', toolName: 'run_script', input: { code: 'print(1)' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' })
        : stream({ type: 'text-delta', text: 'understood' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['run_script'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    const execute = vi.fn(async (_call: { invocationId: string; toolCallId: string; toolName: string }) => ({ output: 'must not execute' }))
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => binding.phase === 'initial-compat'
      ? { kind: 'ask', confirmationId: 'approval-script', answerer: 'user', reasonCode: 'script-confirm' }
      : { kind: 'allow', authorizationVersion: binding.authorizationVersion } } })

    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history, request: { messages: [], maxTokens: 20 }, safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      confirmation: async () => ({ kind: 'denied', cause: 'user-denied' }),
      toolExecution: toolExecutionPort(permits, async (call) => execute(call)), maxModelTurns: 2,
      returnDeniedToolsToModel: true
    })

    expect(result.text).toBe('understood')
    expect(result.messages).toContainEqual(expect.objectContaining({ role: 'tool', toolCallId: 'rejected-script', isError: true, content: expect.stringContaining('CONFIRMATION_DENIED') }))
    expect(result.messages.every((message) => message !== undefined && typeof message.role === 'string')).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    const snapshot = await history.read('inv')
    expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId: 'rejected-script', approved: false, outcome: 'denied', cause: 'user-denied' }) }))
    expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'rejected-script', reason: 'CONFIRMATION_DENIED', isError: true }) }))
    expect(snapshot.events.at(-1)).toMatchObject({ kind: 'invocation-completed' })
  })

  it('limits active confirmation channels to two while waiting for earlier approvals', async () => {
    const registry = new ModelProviderRegistry()
    const ids = ['read-1', 'read-2', 'read-3']
    let modelTurn = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      modelTurn += 1
      return modelTurn === 1
        ? stream(...ids.map((id) => ({ type: 'tool-call' as const, toolCallId: id, toolName: 'lookup', input: { query: id } })), { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' })
        : stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => binding.phase === 'initial-compat'
      ? { kind: 'ask', confirmationId: binding.toolCallId, answerer: 'user', reasonCode: 'read-confirm' }
      : { kind: 'allow', authorizationVersion: binding.authorizationVersion } } })
    const confirmations = new Map<string, (value: { kind: 'approved'; receipt: string }) => void>()
    const started: string[] = []
    const execute = vi.fn(async (call: { toolCallId: string }) => ({ output: call.toolCallId }))
    const running = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 100 }, safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      confirmation: ({ call }) => new Promise((resolve) => { started.push(call.toolCallId); confirmations.set(call.toolCallId, resolve) }),
      toolExecution: toolExecutionPort(permits, async (call) => execute(call)),
      maxConcurrentTools: 3, maxModelTurns: 2,
      toolResourceKeys: (call) => [call.toolCallId]
    })
    const waitFor = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 0))
    }

    await waitFor(() => started.length === 2)
    expect(started).toHaveLength(2)
    confirmations.get('read-1')?.({ kind: 'approved', receipt: 'receipt-1' })
    await waitFor(() => started.length === 3)
    expect(started).toHaveLength(3)
    confirmations.get('read-2')?.({ kind: 'approved', receipt: 'receipt-2' })
    confirmations.get('read-3')?.({ kind: 'approved', receipt: 'receipt-3' })
    await expect(running).resolves.toMatchObject({ text: 'done' })
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('settles active and capacity-queued approvals when the parent turn is cancelled', async () => {
    const registry = new ModelProviderRegistry()
    const ids = ['cancel-read-1', 'cancel-read-2', 'cancel-read-3']
    let modelTurn = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      modelTurn += 1
      return modelTurn === 1
        ? stream(...ids.map((id) => ({ type: 'tool-call' as const, toolCallId: id, toolName: 'lookup', input: { query: id } })), { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' })
        : stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const controller = new AbortController()
    const history = new MemoryHistory()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => binding.phase === 'initial-compat'
      ? { kind: 'ask', confirmationId: binding.toolCallId, answerer: 'user', reasonCode: 'read-confirm' }
      : { kind: 'allow', authorizationVersion: binding.authorizationVersion } } })
    const started: string[] = []
    const execute = vi.fn(async (call: { toolCallId: string }) => ({ output: call.toolCallId }))
    const running = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history, request: { messages: [], maxTokens: 100, signal: controller.signal }, safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      confirmation: ({ call, signal }) => new Promise((resolve) => {
        started.push(call.toolCallId)
        signal?.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true })
      }),
      toolExecution: toolExecutionPort(permits, async (call) => execute(call)),
      maxConcurrentTools: 3, maxModelTurns: 2, toolResourceKeys: (call) => [call.toolCallId]
    })
    for (let attempt = 0; attempt < 100 && started.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toHaveLength(2)

    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
    expect(execute).not.toHaveBeenCalled()
    const snapshot = await history.read('inv')
    for (const toolCallId of ids) {
      expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId, reason: 'REQUEST_CANCELLED' }) }))
    }
    for (const toolCallId of started) {
      expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId, approved: false, outcome: 'cancelled' }) }))
    }
    expect(snapshot.events.some(({ kind }) => kind === 'tool-call-started' || kind === 'tool-call-finished')).toBe(false)
    expect(snapshot.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
  })

  it('does not open a confirmation waiter when cancellation lands during approval history persistence', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'approval-persist-cancel', toolName: 'write_file', input: { path: 'a.txt', content: 'x' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['write_file'])
    const permits = new InMemorySafetyPermitStore()
    const controller = new AbortController()
    const history = new MemoryHistory()
    const append = history.appendBatch.bind(history)
    let waitingForPersistence!: () => void
    let releasePersistence!: () => void
    const persistenceEntered = new Promise<void>((resolve) => { waitingForPersistence = resolve })
    const persistenceRelease = new Promise<void>((resolve) => { releasePersistence = resolve })
    vi.spyOn(history, 'appendBatch').mockImplementation(async (events, version) => {
      if (events.some(({ kind }) => kind === 'approval-waiting')) {
        waitingForPersistence()
        await persistenceRelease
      }
      return append(events, version)
    })
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => binding.phase === 'initial-compat'
      ? { kind: 'ask', confirmationId: 'approval-persist-cancel', answerer: 'user', reasonCode: 'write-confirm' }
      : { kind: 'allow', authorizationVersion: binding.authorizationVersion } } })
    const confirmation = vi.fn(async () => ({ kind: 'approved' as const, receipt: 'receipt' }))
    const execute = vi.fn(async (_call: unknown) => ({ output: 'must not dispatch' }))
    const running = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history, request: { messages: [], maxTokens: 20, signal: controller.signal }, safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      confirmation, toolExecution: toolExecutionPort(permits, async (call) => execute(call)), maxModelTurns: 2
    })

    await persistenceEntered
    controller.abort()
    releasePersistence()
    await expect(running).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
    expect(confirmation).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    const snapshot = await history.read('inv')
    expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId: 'approval-persist-cancel', approved: false, outcome: 'cancelled' }) }))
    expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'approval-persist-cancel', reason: 'REQUEST_CANCELLED' }) }))
    expect(snapshot.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
  })

  it('compacts an over-budget request before provider dispatch and commits the replacement transcript first', async () => {
    const history = new MemoryHistory()
    const registry = new ModelProviderRegistry()
    const providerRequests: import('../src/model').CanonicalModelMessage[][] = []
    registry.register(route, { providerId: 'fake', stream: async function* (input) {
      providerRequests.push([...input.request.messages])
      yield { type: 'text-delta', text: 'answer' }
      yield { type: 'usage', inputTokens: 3, outputTokens: 1 }
      yield { type: 'finish', reason: 'stop' }
    } })
    const permits = new InMemorySafetyPermitStore()
    const oldMessage = { role: 'user' as const, content: 'old context' }
    const currentMessage = { role: 'user' as const, content: 'current question' }
    const preflightModelRequest = vi.fn(async () => ({
      messages: [currentMessage],
      windowId: 'window-reset'
    }))

    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'preflight-request', history,
      currentUserMessageId: 'user-current', requiredUserMessage: { id: 'user-current', message: currentMessage },
      request: { messages: [oldMessage, currentMessage], maxTokens: 32 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })), maxModelTurns: 1,
      preflightModelRequest
    })

    expect(preflightModelRequest).toHaveBeenCalledOnce()
    expect(providerRequests).toEqual([[currentMessage]])
    expect((await history.read('preflight-request')).events.map(({ kind }) => kind)).toEqual([
      'invocation-context-committed', 'transcript-compacted', 'model-request-started', 'model-response-committed', 'invocation-completed'
    ])
    expect((await history.read('preflight-request')).events[1]).toMatchObject({ payload: {
      messages: [currentMessage], requiredUserMessage: { id: 'user-current', message: currentMessage }
    } })
  })

  it('fails closed when the preflight planner leaves the request over budget', async () => {
    const history = new MemoryHistory()
    const providerStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'must not dispatch' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ))
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const permits = new InMemorySafetyPermitStore()
    const userMessage = { role: 'user' as const, content: 'question' }

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'preflight-reject', history,
      currentUserMessageId: 'user-current', requiredUserMessage: { id: 'user-current', message: userMessage },
      request: { messages: [userMessage], maxTokens: 32 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })), maxModelTurns: 1,
      observer: { prepareModelRequest: async () => ({ requestProjection: {
        budget: { totalInputBudget: 10 }, surfaceSnapshot: { surfaceTokens: 11 }, contextUsage: { projectedTokens: 11 }
      } }) },
      preflightModelRequest: vi.fn(async () => undefined)
    })).rejects.toMatchObject({ code: 'MODEL_PREFLIGHT_REJECTED', reason: 'OVER_BUDGET' })

    expect(providerStream).not.toHaveBeenCalled()
    expect((await history.read('preflight-reject')).events.map(({ kind }) => kind)).toContain('invocation-failed')
  })

  it('fails closed when the preflight adapter reports that the required user cannot fit', async () => {
    const history = new MemoryHistory()
    const providerStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'must not dispatch' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ))
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const permits = new InMemorySafetyPermitStore()
    const userMessage = { role: 'user' as const, content: 'question' }

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'preflight-adapter-reject', history,
      currentUserMessageId: 'user-current', requiredUserMessage: { id: 'user-current', message: userMessage },
      request: { messages: [userMessage], maxTokens: 32 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })), maxModelTurns: 1,
      preflightModelRequest: vi.fn(async () => ({ rejected: 'OVER_BUDGET' as const }))
    })).rejects.toMatchObject({ code: 'MODEL_PREFLIGHT_REJECTED', reason: 'OVER_BUDGET' })

    expect(providerStream).not.toHaveBeenCalled()
    expect((await history.read('preflight-adapter-reject')).events.map(({ kind }) => kind)).toContain('invocation-failed')
  })

  it('blocks a tool proposal after the configured tool rounds and records it as not dispatched', async () => {
    const registry = new ModelProviderRegistry()
    let modelCalls = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      modelCalls += 1
      return stream(
        { type: 'tool-call', toolCallId: `tc-limit-${modelCalls}`, toolName: 'lookup', input: { query: 'weather' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      )
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'result' }))

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', turnId: 'turn-limit',
      request: { messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 4, maxToolRounds: 2, history
    })).rejects.toMatchObject({ code: 'TOOL_LOOP_MAX_ROUNDS_EXCEEDED', maxToolRounds: 2 })

    expect(modelCalls).toBe(3)
    expect(execute).toHaveBeenCalledTimes(2)
    const events = (await history.read('inv')).events
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'tc-limit-3', reason: 'tool_loop_max_rounds_exceeded' }) }))
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'tool-call-started', payload: expect.objectContaining({ toolCallId: 'tc-limit-3' }) }))
  })

  it('continues an atomically committed session input with the canonical transcript before provider dispatch', async () => {
    const history = new MemoryHistory()
    await history.appendBatch([{
      invocationId: 'accepted-input', turnId: 'accepted-turn', sequence: 1, schemaVersion: 1,
      eventId: 'accepted-input:session-input', idempotencyKey: 'accepted-input:session-input',
      kind: 'session-input-committed', payload: { sessionId: 'session-a', messageId: 'user-a', role: 'user', inputFingerprint: 'sha256:input' }
    }], 0)
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'answer' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ) })
    const permits = new InMemorySafetyPermitStore()
    const issuePermit = vi.spyOn(permits, 'issue')
    const userMessage = { role: 'user' as const, content: 'hello' }

    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'accepted-input', turnId: 'accepted-turn', sessionId: 'session-a',
      currentUserMessageId: 'user-a', requiredUserMessage: { id: 'user-a', message: userMessage },
      request: { messages: [userMessage], maxTokens: 32 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, vi.fn()), history, maxModelTurns: 1
    })

    const events = (await history.read('accepted-input')).events
    expect(events.map(({ kind }) => kind)).toEqual([
      'session-input-committed', 'invocation-context-committed', 'model-request-started', 'model-response-committed', 'invocation-completed'
    ])
    expect(events[1]).toMatchObject({ sequence: 2, payload: { messages: [userMessage], requiredUserMessage: { id: 'user-a', message: userMessage } } })
  })

  it('rejects a session input marker owned by another session before provider dispatch', async () => {
    const history = new MemoryHistory()
    await history.appendBatch([{
      invocationId: 'accepted-input', turnId: 'accepted-turn', sequence: 1, schemaVersion: 1,
      eventId: 'accepted-input:session-input', idempotencyKey: 'accepted-input:session-input',
      kind: 'session-input-committed', payload: { sessionId: 'session-a', messageId: 'user-a', role: 'user', inputFingerprint: 'sha256:input' }
    }], 0)
    const providerStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'must not request' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ))
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const permits = new InMemorySafetyPermitStore()
    const userMessage = { role: 'user' as const, content: 'hello' }

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'accepted-input', turnId: 'accepted-turn', sessionId: 'session-b',
      currentUserMessageId: 'user-a', requiredUserMessage: { id: 'user-a', message: userMessage },
      request: { messages: [userMessage], maxTokens: 32 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, vi.fn()), history, maxModelTurns: 1
    })).rejects.toThrow('history base context is missing for a non-empty invocation')
    expect(providerStream).not.toHaveBeenCalled()
  })

  it('records a prepared-call mismatch as a replayable not-dispatched tool result', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-mismatch', toolName: 'lookup', input: { query: 'q' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const history = new MemoryHistory()
    const permits = new InMemorySafetyPermitStore()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'auth-v1' }) } }),
      prepareTool: async () => ({ ...toolBinding, toolCallId: 'wrong-call' }),
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'must not run' })), history, maxModelTurns: 2
    })).rejects.toMatchObject({ code: 'TOOL_DENIED', reasonCode: 'PREPARED_CALL_MISMATCH' })

    expect((await history.read('inv')).events).toContainEqual(expect.objectContaining({
      kind: 'tool-call-not-dispatched',
      payload: expect.objectContaining({ toolCallId: 'tc-mismatch', reason: 'PREPARED_CALL_MISMATCH', replayContent: 'Tool call was not dispatched (PREPARED_CALL_MISMATCH).', isError: true })
    }))
  })

  it('commits the canonical model request to History before entering the provider', async () => {
    const history = new MemoryHistory()
    const registry = new ModelProviderRegistry()
    let observedRequestEvent: unknown
    registry.register(route, { providerId: 'fake', stream: async function* () {
      const snapshot = await history.read('request-outbox')
      observedRequestEvent = snapshot.events.at(-1)
      yield { type: 'text-delta', text: 'answer' }
      yield { type: 'usage', inputTokens: 2, outputTokens: 1 }
      yield { type: 'finish', reason: 'stop' }
    } })
    const permits = new InMemorySafetyPermitStore()

    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'request-outbox', history,
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 32 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })), maxModelTurns: 1
    })

    expect(observedRequestEvent).toMatchObject({
      kind: 'model-request-started',
      payload: { modelTurn: 1, attempt: 1, routeId: route.routeId, requestSnapshot: { route, request: { maxTokens: 32 } } }
    })
    const events = (await history.read('request-outbox')).events
    expect(events.map(({ kind }) => kind)).toEqual([
      'invocation-context-committed', 'model-request-started', 'model-response-committed', 'invocation-completed'
    ])
  })

  it('commits prepared response projections in the same canonical response outbox event', async () => {
    const history = new MemoryHistory()
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'answer' }, { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ) })
    const permits = new InMemorySafetyPermitStore()
    const prepareModelResponseProjection = vi.fn(async () => ({ sessionLedger: {
      location: { workDir: '/workspace', sessionId: 'response-projection', createdAt: 123 },
      requestContext: { requestId: 'response-projection:round:1', attempt: 1, contextUsage: { pressureTokens: 3 } }
    } }))

    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'response-projection', history,
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 32 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })), maxModelTurns: 1,
      observer: { prepareModelResponseProjection }
    })

    expect(prepareModelResponseProjection).toHaveBeenCalledOnce()
    expect((await history.read('response-projection')).events.find((event) => event.kind === 'model-response-committed')?.payload).toMatchObject({
      sessionLedger: { requestContext: { requestId: 'response-projection:round:1', contextUsage: { pressureTokens: 3 } } }
    })
  })

  it('prepares accepted usage attribution once and records the snapshot with the model attempt', async () => {
    const history = new MemoryHistory()
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'answer' }, { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ) })
    const permits = new InMemorySafetyPermitStore()
    const prepareUsageAttribution = vi.fn(() => ({ contentTokens: 7 }))
    const recordProviderAttemptUsage = vi.fn()

    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'usage-attribution-once', history,
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 32 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })), maxModelTurns: 1,
      observer: { prepareUsageAttribution }, recordProviderAttemptUsage
    })

    expect(prepareUsageAttribution).toHaveBeenCalledOnce()
    expect(recordProviderAttemptUsage).toHaveBeenCalledOnce()
    expect(recordProviderAttemptUsage).toHaveBeenCalledWith(expect.objectContaining({
      disposition: 'completed', attributionInput: { contentTokens: 7 }
    }))
  })

  it('publishes provisional chunks from a failed provider attempt and reports turn failure for host rollback', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: async function* () {
      yield { type: 'text-delta', text: 'provisional' } as const
      yield { type: 'usage', inputTokens: 17, outputTokens: 4 } as const
      throw new Error('provider disconnected')
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', [])
    const permits = new InMemorySafetyPermitStore()
    const onModelChunk = vi.fn()
    const onTurnFailed = vi.fn()
    const recordProviderAttemptUsage = vi.fn()

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      maxModelTurns: 1, recordProviderAttemptUsage, observer: { onModelChunk, onTurnFailed }
    })).rejects.toThrow('provider disconnected')

    expect(onModelChunk).toHaveBeenCalledWith({ type: 'text-delta', text: 'provisional' })
    expect(recordProviderAttemptUsage).toHaveBeenCalledWith(expect.objectContaining({
      modelTurn: 1, attempt: 1, disposition: 'failed', usage: expect.objectContaining({ inputTokens: 17, outputTokens: 4 })
    }))
    expect(onTurnFailed).toHaveBeenCalledOnce()
  })

  it('retains the last accepted provider usage on the canonical failed terminal after tool execution fails', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-usage-failure', toolName: 'lookup', input: { query: 'fail' } },
      { type: 'usage', inputTokens: 1000, outputTokens: 50 },
      { type: 'finish', reason: 'tool-calls' }
    ) })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-usage-failure', ['lookup'])
    const permits = new InMemorySafetyPermitStore()

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-usage-failure', history,
      request: { messages: [{ role: 'user', content: 'run lookup' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'auth-v1' }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, async () => { throw new Error('tool failed') }),
      maxModelTurns: 2
    })).rejects.toThrow('tool failed')

    expect((await history.read('inv-usage-failure')).events.at(-1)).toMatchObject({
      kind: 'invocation-interrupted', payload: { usage: { inputTokens: 1000, outputTokens: 50 } }
    })
  })

  it('carries a turn-boundary reset window id to the next Hosted model request', async () => {
    const registry = new ModelProviderRegistry()
    let providerTurn = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      providerTurn += 1
      return providerTurn === 1
        ? stream({ type: 'tool-call', toolCallId: 'tc-window-reset', toolName: 'lookup', input: { query: 'weather' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' })
        : stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-window-reset', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    const boundaryCommitOrder: string[] = []
    let preparedBinding: PermitBinding | undefined
    const windows: string[] = []
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-window-reset', turnId: 'turn-window-reset', windowId: 'window-before-reset', history,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => {
        const binding = {
          ...toolBinding, requestId: 'inv-window-reset', turnId: 'turn-window-reset', invocationId: call.invocationId,
          toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const
        }
        preparedBinding = binding
        return binding
      },
      toolExecution: createPermitBoundToolExecutionPort({
        permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
        resolveExpected: async () => ({ ...preparedBinding!, phase: 'recheck' }),
        execute: async () => ({ output: 'found it' })
      }),
      maxModelTurns: 2,
      observer: { onModelRequest: ({ windowId }) => { windows.push(windowId ?? '') } },
      turnBoundary: async ({ messages, modelTurn }) => modelTurn === 1 ? ({
        messages, windowId: 'window-after-reset',
        historyPayload: { sessionLedger: { location: { workDir: '/workspace', sessionId: 'session', createdAt: 1 }, start: { compactionId: 'compaction' }, summary: { compactionId: 'compaction' } } },
        commitProjection: async () => {
          const snapshot = await history.read('inv-window-reset')
          boundaryCommitOrder.push(snapshot.events.at(-1)?.kind ?? 'missing')
        }
      }) : undefined
    })

    expect(result.text).toBe('done')
    expect(windows).toEqual(['window-before-reset', 'window-after-reset'])
    expect(boundaryCommitOrder).toEqual(['transcript-compacted'])
    expect((await history.read('inv-window-reset')).events.find((event) => event.kind === 'transcript-compacted')?.payload).toMatchObject({ sessionLedger: { location: { sessionId: 'session' } } })
  })

  it('keeps a canonical compaction repair record and stops before tools when boundary ledger commit fails', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-boundary-ledger', toolName: 'lookup', input: { query: 'weather' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-boundary-ledger', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    const execute = vi.fn(async () => ({ output: 'must not dispatch' }))
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion }) } })
    const prepared = { ...toolBinding, requestId: 'inv-boundary-ledger', turnId: 'turn', invocationId: 'inv-boundary-ledger', toolCallId: 'tc-boundary-ledger', capabilityId: 'lookup' }

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-boundary-ledger', turnId: 'turn',
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 }, safetyGate,
      prepareTool: async (_call, stage) => ({ ...prepared, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, async () => execute()), maxModelTurns: 2, history,
      turnBoundary: async ({ messages }) => ({
        messages,
        historyPayload: { sessionLedger: { location: { workDir: '/workspace', sessionId: 'session', createdAt: 1 }, start: { compactionId: 'compaction' }, summary: { compactionId: 'compaction' } } },
        commitProjection: async () => { throw new Error('session JSONL write failed') }
      })
    })).rejects.toThrow('turn boundary ledger projection failed: session JSONL write failed')

    const events = (await history.read('inv-boundary-ledger')).events
    expect(events.find((event) => event.kind === 'transcript-compacted')?.payload).toMatchObject({ sessionLedger: { location: { sessionId: 'session' } } })
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'turn-boundary-ledger-projection-failed' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rolls back provisional chunks when the canonical response cannot be committed to History', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'not durable' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'finish', reason: 'stop' }
    ) })
    const delegate = new MemoryHistory()
    const history = {
      appendBatch: async (events: readonly HistoryEvent[], version: number) => {
        if (events.some((event) => event.kind === 'model-response-committed')) throw new Error('injected response History failure')
        return delegate.appendBatch(events, version)
      },
      read: (id: string) => delegate.read(id)
    }
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', [])
    const permits = new InMemorySafetyPermitStore()
    const onModelChunk = vi.fn()
    const onTurnFailed = vi.fn()

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 1, observer: { onModelChunk, onTurnFailed }
    })).rejects.toThrow('injected response History failure')

    expect(onModelChunk).toHaveBeenCalledWith({ type: 'text-delta', text: 'not durable' })
    expect(onTurnFailed).toHaveBeenCalledOnce()
  })

  it('does not report turn completion when the terminal History commit fails', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'durable response, missing terminal' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ) })
    const delegate = new MemoryHistory()
    const history = {
      appendBatch: async (events: readonly HistoryEvent[], version: number) => {
        if (events.some((event) => event.kind === 'invocation-completed')) throw new Error('injected terminal History failure')
        return delegate.appendBatch(events, version)
      },
      read: (id: string) => delegate.read(id)
    }
    const onTurnFinished = vi.fn()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-terminal-fails', history,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      observer: { onTurnFinished }
    })).rejects.toThrow('injected terminal History failure')

    expect(onTurnFinished).not.toHaveBeenCalled()
    expect((await delegate.read('inv-terminal-fails')).events.at(-1)).toMatchObject({ kind: 'invocation-failed' })
  })

  it('confirms a terminal History commit when append acknowledgement is lost', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'committed answer' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ) })
    const delegate = new MemoryHistory()
    let loseCompletionAck = true
    const history = {
      appendBatch: async (events: readonly HistoryEvent[], version: number) => {
        const result = await delegate.appendBatch(events, version)
        if (loseCompletionAck && events.some((event) => event.kind === 'invocation-completed')) {
          loseCompletionAck = false
          throw new Error('completion acknowledgement lost')
        }
        return result
      },
      read: (id: string) => delegate.read(id)
    }
    const onTurnFinished = vi.fn()

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-terminal-ack-lost', history,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      sessionLedgerForInvocationTerminal: async () => ({ stepId: 'terminal-step' }),
      observer: { onTurnFinished }
    })).resolves.toMatchObject({ text: 'committed answer' })

    expect(onTurnFinished).toHaveBeenCalledOnce()
    expect((await delegate.read('inv-terminal-ack-lost')).events.filter((event) => event.kind === 'invocation-completed')).toHaveLength(1)
    expect((await delegate.read('inv-terminal-ack-lost')).events.some((event) => event.kind === 'invocation-failed')).toBe(false)
  })

  it('retries one failed provider attempt only after host recovery is committed to canonical History', async () => {
    const registry = new ModelProviderRegistry()
    const calls: number[] = []
    registry.register(route, { providerId: 'fake', stream: () => {
      calls.push(calls.length + 1)
      if (calls.length === 1) return (async function* () { throw Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' }) })()
      return stream({ type: 'text-delta', text: 'recovered' }, { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', [])
    const permits = new InMemorySafetyPermitStore()
    const order: string[] = []
    const recoverProviderAttempt = vi.fn(async ({ messages, error }: { messages: readonly CanonicalModelMessage[]; error?: unknown }) => error
      ? { reasonCode: 'CONTEXT_OVERFLOW', messages, retryEvent: { attempt: 1, code: 'provider_context_overflow' } }
      : undefined)
    const onModelRequest = vi.fn(({ attempt }: { attempt: number; modelTurn: number }) => { order.push(`request:${attempt}`) })
    const onProviderRetry = vi.fn(async () => {
      const events = (await history.read('inv')).events
      expect(events.some((event) => event.kind === 'transcript-compacted')).toBe(true)
      expect(events.some((event) => event.kind === 'provider-retry-scheduled')).toBe(true)
      order.push('retry-event')
    })

    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 1, recoverProviderAttempt, observer: {
        onModelRequest, onProviderRetry, criticalModelRequestProjection: true,
        onModelAttemptDiscarded: () => { order.push('attempt-discarded') }
      }
    })

    expect(calls).toEqual([1, 2])
    expect(recoverProviderAttempt).toHaveBeenCalledOnce()
    expect(onModelRequest.mock.calls.map(([request]) => ({ modelTurn: request.modelTurn, attempt: request.attempt }))).toEqual([
      { modelTurn: 1, attempt: 1 },
      { modelTurn: 1, attempt: 2 }
    ])
    expect(onProviderRetry).toHaveBeenCalledWith({ attempt: 1, modelTurn: 1, routeId: route.routeId, requestId: 'inv:round:1', code: 'provider_context_overflow' })
    expect(order).toEqual(['request:1', 'attempt-discarded', 'retry-event', 'request:2'])
    expect(result.text).toBe('recovered')
    const events = (await history.read('inv')).events
    expect(events.filter((event) => event.kind === 'transcript-compacted')).toHaveLength(1)
    expect(events.at(-1)?.kind).toBe('invocation-completed')
  })

  it('retries an unsupported effort request with effort removed and records the authorized request change', async () => {
    const registry = new ModelProviderRegistry()
    const providerRequests: Array<unknown> = []
    registry.register(route, { providerId: 'fake', stream: (call) => {
      providerRequests.push(call.request.thinking)
      if (providerRequests.length === 1) return (async function* () { throw Object.assign(new Error('unknown field output_config'), { status: 400 }) })()
      if (providerRequests.length === 2) return stream({ type: 'text-delta', text: 'partial ' }, { type: 'usage', inputTokens: 2, outputTokens: 5 }, { type: 'finish', reason: 'length' })
      return stream({ type: 'text-delta', text: 'fallback succeeded' }, { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-effort-fallback', [])
    const permits = new InMemorySafetyPermitStore()
    const order: string[] = []
    const recoverProviderAttempt = vi.fn(async ({ messages, error }: { messages: readonly CanonicalModelMessage[]; error?: unknown }) => error
      ? { reasonCode: 'EFFORT_UNSUPPORTED', messages, requestPatch: { thinking: { enabled: true } }, recordTranscriptCompaction: false, retryEvent: { attempt: 1, code: 'effort_unsupported' } }
      : undefined)

    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-effort-fallback', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10, thinking: { enabled: true, effort: 'high' } },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') }, toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 3, recoverProviderAttempt,
      recoverOutputLimit: async () => ({ continuation: { role: 'user', content: 'continue the original request' } }),
      observer: {
        onProviderRetry: async () => { order.push('retry-event') },
        onModelRequest: ({ attempt }) => { order.push(`request:${attempt}`) }
      }
    })

    expect(result.text).toBe('partial fallback succeeded')
    expect(result.finishReason).toBe('stop')
    expect(providerRequests).toEqual([{ enabled: true, effort: 'high' }, { enabled: true }, { enabled: true }])
    expect(order).toEqual(['request:1', 'retry-event', 'request:2', 'request:1'])
    const events = (await history.read('inv-effort-fallback')).events
    expect(events).toContainEqual(expect.objectContaining({ kind: 'model-attempt-discarded', payload: expect.objectContaining({ reasonCode: 'EFFORT_UNSUPPORTED', requestPatch: { thinking: { enabled: true } } }) }))
    expect(events.some((event) => event.kind === 'transcript-compacted')).toBe(false)
  })

  it('continues a max-token response from a host recovery message without treating it as a new user request', async () => {
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      providerCalls += 1
      return providerCalls === 1
        ? stream({ type: 'text-delta', text: 'partial ' }, { type: 'usage', inputTokens: 10, outputTokens: 10 }, { type: 'finish', reason: 'length' })
        : stream({ type: 'text-delta', text: 'complete' }, { type: 'usage', inputTokens: 12, outputTokens: 5 }, { type: 'finish', reason: 'stop' })
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-output-recovery', [])
    const permits = new InMemorySafetyPermitStore()
    const runtimeMessage: CanonicalModelMessage = { role: 'user', content: '[runtime output recovery] continue the original request' }
    const recoverOutputLimit = vi.fn(async () => ({ continuation: runtimeMessage }))
    const onOutputRecovery = vi.fn()

    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-output-recovery', request: { messages: [{ role: 'user', content: 'original request' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 2, recoverOutputLimit, observer: { onOutputRecovery }
    })

    expect(providerCalls).toBe(2)
    expect(recoverOutputLimit).toHaveBeenCalledWith(expect.objectContaining({ modelTurn: 1, attempt: 1, hadVisibleText: true, toolCalls: [] }))
    expect(onOutputRecovery).toHaveBeenCalledWith({ attempt: 1, modelTurn: 1, requestId: 'inv-output-recovery:round:1', toolCalls: [], willRetry: true, toolCallErrorContent: 'Tool call was not dispatched because the model output reached its limit.', sessionLedgerEvents: [] })
    expect(result.messages).toContainEqual(runtimeMessage)
    expect(result.finishReason).toBe('stop')
    expect((await history.read('inv-output-recovery')).events.map((event) => event.kind)).toContain('replay-message-committed')
  })

  it('continues a thinking-only max-token response without adding an empty assistant message', async () => {
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    const requests: Array<readonly CanonicalModelMessage[]> = []
    registry.register(route, { providerId: 'thinking-output-recovery-provider', stream: (call) => {
      providerCalls += 1
      requests.push(call.request.messages)
      return providerCalls === 1
        ? stream({ type: 'thinking-delta', text: 'private reasoning' }, { type: 'usage', inputTokens: 5, outputTokens: 10 }, { type: 'finish', reason: 'length' })
        : stream({ type: 'text-delta', text: 'recovered answer' }, { type: 'usage', inputTokens: 6, outputTokens: 3 }, { type: 'finish', reason: 'stop' })
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-thinking-output-recovery', [])
    const permits = new InMemorySafetyPermitStore()
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-thinking-output-recovery', request: { messages: [{ role: 'user', content: 'answer' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 2, recoverOutputLimit: async () => ({ continuation: { role: 'user', content: 'continue the original answer' } })
    })

    expect(providerCalls).toBe(2)
    expect(result.text).toBe('recovered answer')
    expect(requests[1]?.some((message) => message.role === 'assistant' && (message.content === '' || Array.isArray(message.content) && message.content.length === 0))).toBe(false)
  })

  it('retains accepted tool-round text before the tool card across a later max-token continuation', async () => {
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    const requests: Array<readonly CanonicalModelMessage[]> = []
    registry.register(route, { providerId: 'tool-then-output-recovery-provider', stream: (call) => {
      providerCalls += 1
      requests.push(call.request.messages)
      if (providerCalls === 1) return stream(
        { type: 'text-delta', text: 'A' }, { type: 'tool-call', toolCallId: 'read-before-truncation', toolName: 'lookup', input: { query: 'q' } },
        { type: 'usage', inputTokens: 3, outputTokens: 2 }, { type: 'finish', reason: 'tool-calls' }
      )
      if (providerCalls === 2) return stream(
        { type: 'text-delta', text: 'B' }, { type: 'usage', inputTokens: 4, outputTokens: 10 }, { type: 'finish', reason: 'length' }
      )
      return stream({ type: 'text-delta', text: 'C' }, { type: 'usage', inputTokens: 5, outputTokens: 2 }, { type: 'finish', reason: 'stop' })
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-tool-output-recovery', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'tool result' }))
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-tool-output-recovery', request: { messages: [{ role: 'user', content: 'answer with lookup' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      toolExecution: toolExecutionPort(permits, execute),
      history, maxModelTurns: 3, recoverOutputLimit: async () => ({ continuation: { role: 'user', content: 'continue the original answer' } })
    })

    expect(providerCalls).toBe(3)
    expect(execute).toHaveBeenCalledOnce()
    expect(result.text).toBe('ABC')
    expect(requests[2]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', toolCallId: 'read-before-truncation', content: 'tool result' }),
      expect.objectContaining({ role: 'user', content: 'continue the original answer' })
    ]))
  })

  it('fails after the bounded no-tool output recovery budget without completing the turn', async () => {
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    const requests: Array<readonly CanonicalModelMessage[]> = []
    registry.register(route, { providerId: 'exhausted-text-output-provider', stream: (call) => {
      providerCalls += 1
      requests.push(call.request.messages)
      return stream({ type: 'usage', inputTokens: 1, outputTokens: 2 }, { type: 'finish', reason: 'length' })
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-exhausted-text-output', [])
    const permits = new InMemorySafetyPermitStore()
    const recoverOutputLimit = vi.fn(async ({ attempt }: { attempt: number }) => attempt < 3
      ? { continuation: { role: 'user' as const, content: 'continue the original answer' } }
      : undefined)
    const onTurnFinished = vi.fn()
    const onOutputRecovery = vi.fn()

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-exhausted-text-output', request: { messages: [{ role: 'user', content: 'answer' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 4, recoverOutputLimit, observer: { onTurnFinished, onOutputRecovery }
    })).rejects.toMatchObject({ code: 'MODEL_OUTPUT_TOKEN_LIMIT_EXHAUSTED' })

    expect(providerCalls).toBe(3)
    expect(recoverOutputLimit).toHaveBeenCalledTimes(3)
    expect(onOutputRecovery.mock.calls.map(([recovery]) => (recovery as { willRetry: boolean }).willRetry)).toEqual([true, true, false])
    const emptyAssistantMessages = requests.slice(1).flatMap((messages) => messages.filter((message) => message.role === 'assistant' && (message.content === '' || Array.isArray(message.content) && message.content.length === 0)))
    expect(emptyAssistantMessages).toEqual([])
    expect(onTurnFinished).not.toHaveBeenCalled()
    expect((await history.read('inv-exhausted-text-output')).events.at(-1)?.kind).toBe('invocation-failed')
  })

  it('never dispatches truncated tool proposals and returns an error result before recovery', async () => {
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      providerCalls += 1
      return providerCalls === 1
        ? stream({ type: 'tool-call', toolCallId: 'partial-tool', toolName: 'write_file', input: { path: 'partial' } }, { type: 'usage', inputTokens: 10, outputTokens: 10 }, { type: 'finish', reason: 'length' })
        : stream({ type: 'text-delta', text: 'recovered safely' }, { type: 'usage', inputTokens: 12, outputTokens: 5 }, { type: 'finish', reason: 'stop' })
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-truncated-tool', ['write_file'])
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'should never execute' }))
    const sessionLedgerEvents: Array<{ kind: string; payload: Record<string, unknown> }> = []

    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-truncated-tool', request: { messages: [{ role: 'user', content: 'write file' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'auth-v1' }) } }),
      prepareTool: async () => toolBinding,
      toolExecution: toolExecutionPort(permits, execute),
      history, maxModelTurns: 2,
      recoverOutputLimit: async () => ({ continuation: { role: 'user', content: 'retry with a complete call' }, retryLocation: { workDir: '/workspace', sessionId: 'session', createdAt: 1 }, retryTurnId: 'turn-1', retryStepId: 'step-1' }),
      sessionLedgerForNotDispatched: (_call, _reason, result) => ({ location: { workDir: '/workspace', sessionId: 'session', createdAt: 1 }, stepId: 'step-1', result }),
      observer: { onOutputRecovery: ({ sessionLedgerEvents: events }) => { sessionLedgerEvents.push(...events.map((event) => ({ kind: event.kind, payload: event.payload as Record<string, unknown> }))) } }
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.messages).toContainEqual(expect.objectContaining({ role: 'tool', toolCallId: 'partial-tool', isError: true }))
    const events = (await history.read('inv-truncated-tool')).events
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'partial-tool', reason: 'MODEL_OUTPUT_TRUNCATED', sessionLedger: expect.objectContaining({ result: expect.objectContaining({ notExecutedReason: 'model_output_truncated' }) }) }) }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'provider-retry-scheduled', payload: expect.objectContaining({ requestId: 'inv-truncated-tool:round:1', code: 'model_output_token_limit', sessionLedger: expect.objectContaining({ requestRetry: expect.objectContaining({ turnId: 'turn-1', stepId: 'step-1' }) }) }) }))
    expect(sessionLedgerEvents.map(({ kind }) => kind)).toEqual(['tool-call-not-dispatched', 'provider-retry-scheduled'])
  })

  it('closes truncated tool calls in History when the host output-recovery budget is exhausted', async () => {
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      providerCalls += 1
      return stream({ type: 'tool-call', toolCallId: `truncated-${providerCalls}`, toolName: 'write_file', input: { path: 'partial' } }, { type: 'usage', inputTokens: 10, outputTokens: 10 }, { type: 'finish', reason: 'length' })
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-exhausted-output', ['write_file'])
    const permits = new InMemorySafetyPermitStore()
    const prepareTool = vi.fn(async () => toolBinding)

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-exhausted-output', request: { messages: [{ role: 'user', content: 'write file' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'auth-v1' }) } }),
      prepareTool, toolExecution: toolExecutionPort(permits, async () => ({ output: 'must not execute' })),
      history, maxModelTurns: 4,
      recoverOutputLimit: async ({ attempt }) => attempt < 3
        ? { continuation: { role: 'user', content: 'continue' }, toolCallErrorContent: 'truncated proposal was not executed' }
        : { toolCallErrorContent: 'recovery exhausted; proposal not executed' }
    })).rejects.toMatchObject({ code: 'MODEL_OUTPUT_TOKEN_LIMIT_EXHAUSTED' })

    expect(providerCalls).toBe(3)
    expect(prepareTool).not.toHaveBeenCalled()
    const events = (await history.read('inv-exhausted-output')).events
    expect(events.filter((event) => event.kind === 'tool-call-not-dispatched')).toHaveLength(3)
    expect(events.at(-1)?.kind).toBe('invocation-failed')
  })

  it('does not retry the provider when recovery transcript persistence fails', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => (async function* () { throw new Error('provider disconnected') })())
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const delegate = new MemoryHistory()
    const history = {
      appendBatch: async (events: readonly HistoryEvent[], version: number) => {
        if (events.some((event) => event.kind === 'transcript-compacted')) throw new Error('injected recovery History failure')
        return delegate.appendBatch(events, version)
      },
      read: (id: string) => delegate.read(id)
    }
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', [])
    const permits = new InMemorySafetyPermitStore()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 1,
      recoverProviderAttempt: async ({ messages }) => ({ reasonCode: 'CONTEXT_OVERFLOW', messages })
    })).rejects.toThrow('injected recovery History failure')
    expect(providerStream).toHaveBeenCalledOnce()
  })

  it('rejects recovery that drops the required current user before retrying', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => (async function* () { throw new Error('provider disconnected') })())
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', [])
    const permits = new InMemorySafetyPermitStore()
    const requiredUserMessage = { id: 'current', message: { role: 'user' as const, content: 'current question' } }
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', currentUserMessageId: 'current', requiredUserMessage,
      request: { messages: [requiredUserMessage.message], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      maxModelTurns: 1,
      recoverProviderAttempt: async () => ({ reasonCode: 'CONTEXT_OVERFLOW', messages: [] })
    })).rejects.toThrow('provider recovery omitted required user message')
    expect(providerStream).toHaveBeenCalledOnce()
  })

  it('honors cancellation while the host is preparing provider recovery before retry dispatch', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => (async function* () { throw new Error('provider disconnected') })())
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', [])
    const permits = new InMemorySafetyPermitStore()
    const controller = new AbortController()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10, signal: controller.signal },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 1,
      recoverProviderAttempt: async ({ messages }) => {
        controller.abort()
        return { reasonCode: 'CONTEXT_OVERFLOW', messages }
      }
    })).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
    expect(providerStream).toHaveBeenCalledOnce()
    expect((await history.read('inv')).events.some((event) => event.kind === 'transcript-compacted')).toBe(false)
  })

  it('does not ask the host for another recovery after the single retry also fails', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => (async function* () { throw new Error('provider remains unavailable') })())
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', [])
    const permits = new InMemorySafetyPermitStore()
    const recoverProviderAttempt = vi.fn(async ({ messages, error }: { messages: readonly CanonicalModelMessage[]; error?: unknown }) => error
      ? { reasonCode: 'CONTEXT_OVERFLOW', messages }
      : undefined)
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      maxModelTurns: 1, recoverProviderAttempt
    })).rejects.toThrow('provider remains unavailable')
    expect(providerStream).toHaveBeenCalledTimes(2)
    expect(recoverProviderAttempt).toHaveBeenCalledOnce()
  })

  it('lets the host discard a silent-overflow response before model History commit and retry once', async () => {
    const registry = new ModelProviderRegistry()
    const calls = vi.fn()
    registry.register(route, { providerId: 'fake', stream: () => {
      calls()
      return calls.mock.calls.length === 1
        ? stream({ type: 'usage', inputTokens: 80, outputTokens: 0, cacheReadInputTokens: 15, cacheCreationInputTokens: 6 }, { type: 'finish', reason: 'stop' })
        : stream({ type: 'text-delta', text: 'recovered answer' }, { type: 'usage', inputTokens: 70, outputTokens: 3 }, { type: 'finish', reason: 'stop' })
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', [])
    const permits = new InMemorySafetyPermitStore()
    const user = { role: 'user' as const, content: 'current question' }
    const recoverProviderAttempt = vi.fn(async ({ response, messages }: { response?: { usage: { inputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } }; messages: readonly CanonicalModelMessage[] }) =>
      response?.usage.cacheReadInputTokens === 15 ? { kind: 'retry' as const, reasonCode: 'SILENT_CONTEXT_OVERFLOW', messages } : undefined)
    const recordAttemptUsage = vi.fn()
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [user], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 1, recoverProviderAttempt, recordProviderAttemptUsage: recordAttemptUsage
    })
    const events = (await history.read('inv')).events
    expect(result.text).toBe('recovered answer')
    expect(calls).toHaveBeenCalledTimes(2)
    expect(recoverProviderAttempt).toHaveBeenCalledTimes(2)
    expect(recordAttemptUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ attempt: 1, disposition: 'discarded', usage: expect.objectContaining({ inputTokens: 80, outputTokens: 0, cacheReadInputTokens: 15, cacheCreationInputTokens: 6 }) }))
    expect(recordAttemptUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2, disposition: 'completed', usage: expect.objectContaining({ inputTokens: 70, outputTokens: 3 }) }))
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 3, cacheReadInputTokens: 15, cacheCreationInputTokens: 6 })
    expect(events.filter((event) => event.kind === 'transcript-compacted')).toHaveLength(1)
    expect(events.find((event) => event.kind === 'model-attempt-discarded')?.payload).toMatchObject({
      modelTurn: 1, attempt: 1, reasonCode: 'SILENT_CONTEXT_OVERFLOW', finishReason: 'stop', usage: expect.objectContaining({ inputTokens: 80, outputTokens: 0, cacheReadInputTokens: 15, cacheCreationInputTokens: 6 })
    })
    expect((events.find((event) => event.kind === 'model-response-committed')?.payload as { message: { content: string } }).message.content).toBe('recovered answer')
  })

  it('rejects a discarded silent-overflow response without committing it to model History', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'usage', inputTokens: 101, outputTokens: 0 }, { type: 'finish', reason: 'stop' }
    ) })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', [])
    const permits = new InMemorySafetyPermitStore()
    const recordProviderAttemptUsage = vi.fn()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'unused' })),
      history, maxModelTurns: 1,
      recordProviderAttemptUsage,
      recoverProviderAttempt: async () => ({ kind: 'reject', reasonCode: 'SILENT_CONTEXT_OVERFLOW_RETRY_LIMIT' })
    })).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_RECOVERY_REJECTED' })
    const events = (await history.read('inv')).events
    expect(events.some((event) => event.kind === 'model-response-committed')).toBe(false)
    expect(events.find((event) => event.kind === 'model-attempt-discarded')?.payload).toMatchObject({ reasonCode: 'SILENT_CONTEXT_OVERFLOW_RETRY_LIMIT', usage: { inputTokens: 101 } })
    expect(recordProviderAttemptUsage).toHaveBeenCalledWith(expect.objectContaining({ disposition: 'discarded', usage: expect.objectContaining({ inputTokens: 101, outputTokens: 0 }) }))
  })

  it('失败终态 observer 收到 denied，且 observer 异常不改变原始拒绝错误', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: { query: 'q' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const observedFailure = vi.fn(() => { throw new Error('observer failure') })
    const diagnostic = vi.fn()
    const history = new MemoryHistory()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: async (_call, stage) => ({ ...toolBinding, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'must not run' })),
      history, maxModelTurns: 2,
      observer: { onTurnFailed: observedFailure, onObservationError: diagnostic }
    })).rejects.toMatchObject({ code: 'TOOL_DENIED', reasonCode: 'POLICY_DENY' })
    expect(observedFailure).toHaveBeenCalledWith(expect.objectContaining({ status: 'denied', error: expect.objectContaining({ code: 'TOOL_DENIED' }) }))
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ message: 'observer failure' }), 'turn-failed')
    expect((await history.read('inv')).events.at(-1)?.payload).toEqual({
      status: 'denied', reason: 'POLICY_DENY', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 }
    })
  })

  it('History not-dispatched 写入失败时仍清理 prepared state，且清理异常不遮蔽持久化错误', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: { query: 'q' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const delegate = new MemoryHistory()
    const history = {
      appendBatch: async (events: readonly HistoryEvent[], version: number) => {
        if (events.some((event) => event.kind === 'tool-call-not-dispatched')) throw new Error('injected not-dispatched history failure')
        return delegate.appendBatch(events, version)
      },
      read: (id: string) => delegate.read(id)
    }
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const discardError = new Error('injected prepared cleanup failure')
    const discarded = vi.fn(async () => { throw discardError })
    const observerError = vi.fn()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: async (_call, stage) => ({ ...toolBinding, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      discardPreparedTool: discarded,
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'must not run' })),
      history, maxModelTurns: 2,
      observer: { onObservationError: observerError }
    })).rejects.toThrow('injected not-dispatched history failure')
    expect(discarded).toHaveBeenCalledOnce()
    expect(observerError).toHaveBeenCalledWith(discardError, 'prepared-tool-discard')
  })

  it('consumes a host-committed first response once and continues with the SDK provider loop', async () => {
    const registry = new ModelProviderRegistry()
    const firstProviderStream = vi.fn(() => stream({ type: 'text-delta', text: 'must not request first response again' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }))
    const nextProviderStream = vi.fn(() => stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'finish', reason: 'stop' }))
    registry.register(route, { providerId: 'fake', stream: (call) => call.request.messages.length === 1 ? firstProviderStream() : nextProviderStream() })
    const history = new MemoryHistory()
    const writer = new InvocationHistoryWriter(history, { invocationId: 'host-seeded', turnId: 'turn-seeded' })
    const userMessage = { role: 'user' as const, content: 'hello' }
    const assistantMessage = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'starting' }], toolCalls: [{ id: 'host-seeded-tool', name: 'lookup', input: { query: 'q' } }] }
    await writer.append([
      { kind: 'invocation-context-committed', payload: { messages: [userMessage] } },
      { kind: 'model-response-committed', payload: { message: assistantMessage, finishReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } } }
    ])
    const permits = new InMemorySafetyPermitStore()
    const capabilities = new CapabilityRegistry()
    capabilities.define('host-seeded', ['lookup'])
    const ports = {
      registry, routeId: route.routeId, invocationId: 'host-seeded', turnId: 'turn-seeded', history,
      request: { messages: [userMessage], maxTokens: 80 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call: { invocationId: string; toolCallId: string; toolName: string }, stage: { kind: 'initial' | 'recheck' }) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'tool result' })), maxModelTurns: 2
    }
    const host: AgentTurnHost = { createPorts: async () => ports }
    const observedChunks: unknown[] = []
    const committedResponses: unknown[] = []
    const result = await runHostedAgentTurn({
      host, invocationId: 'host-seeded', turnId: 'turn-seeded', routeId: route.routeId,
      request: { messages: [userMessage], maxTokens: 80 },
      observer: {
        onModelChunk: (chunk) => { observedChunks.push(chunk) },
        onModelResponseCommitted: (response) => { committedResponses.push(response) }
      },
      initialResponse: { message: assistantMessage, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 }, historyCommitted: true }
    })
    const snapshot = await history.read('host-seeded')
    expect(result.text).toBe('startingdone')
    expect(firstProviderStream).not.toHaveBeenCalled()
    expect(nextProviderStream).toHaveBeenCalledOnce()
    expect(observedChunks).toEqual([
      { type: 'text-delta', text: 'done' },
      { type: 'usage', inputTokens: 2, outputTokens: 1 }
    ])
    expect(committedResponses).toHaveLength(2)
    expect(snapshot.events.filter((event) => event.kind === 'model-response-committed')).toHaveLength(2)
    expect(snapshot.events.filter((event) => event.kind === 'model-response-committed').map((event) => (event.payload as { message: unknown }).message))
      .toEqual([assistantMessage, { role: 'assistant', content: 'done' }])
  })

  it('rejects a host response handoff without matching committed History before tool execution', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => stream({ type: 'text-delta', text: 'unused' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }))
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const seedEvents = [
      { kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'hello' }] } },
      { kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'different response' }, finishReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } } }
    ] as const
    for (const invocationId of ['host-seeded-mismatch', 'host-seeded-mismatch-finish', 'host-seeded-finish-mismatch', 'host-seeded-usage-mismatch', 'host-seeded-history-mismatch', 'host-seeded-response-mismatch']) {
      const writer = new InvocationHistoryWriter(history, { invocationId, turnId: 'turn-seeded' })
      await writer.append(seedEvents)
    }
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'should not execute' }))
    const capabilities = new CapabilityRegistry()
    capabilities.define('host-seeded-mismatch', ['lookup'])
    const host: AgentTurnHost = { createPorts: async ({ invocationId, turnId, routeId, request }) => ({
      registry, routeId, invocationId, ...(turnId ? { turnId } : {}), request, history,
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 2
    }) }

    await expect(runHostedAgentTurn({
      host, invocationId: 'host-seeded-mismatch', turnId: 'turn-seeded', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 80 },
      initialResponse: { message: { role: 'assistant', toolCalls: [{ id: 'seed-tool', name: 'lookup', input: { query: 'q' } }] }, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 }, historyCommitted: true }
    })).rejects.toThrow('does not match the latest canonical History event')
    await expect(runHostedAgentTurn({
      host, invocationId: 'host-seeded-mismatch-finish', turnId: 'turn-seeded', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 80 },
      initialResponse: { message: { role: 'assistant', toolCalls: [{ id: 'seed-tool', name: 'lookup', input: { query: 'q' } }] }, finishReason: 'stop', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 }, historyCommitted: true }
    })).rejects.toThrow('model finish reason does not match tool calls')
    await expect(runHostedAgentTurn({
      host, invocationId: 'host-seeded-usage-mismatch', turnId: 'turn-seeded', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 80 },
      initialResponse: { message: { role: 'assistant', content: 'answer' }, finishReason: 'stop', usage: { type: 'usage', inputTokens: -1, outputTokens: 1 }, historyCommitted: true }
    })).rejects.toThrow('host-committed model response has invalid usage')
    await expect(runHostedAgentTurn({
      host, invocationId: 'host-seeded-history-mismatch', turnId: 'turn-seeded', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 80 },
      initialResponse: { message: { role: 'assistant', content: 'different response' }, finishReason: 'length', usage: { type: 'usage', inputTokens: 2, outputTokens: 3 }, historyCommitted: true }
    })).rejects.toThrow('host-committed model response finish reason does not match History')
    await expect(runHostedAgentTurn({
      host, invocationId: 'host-seeded-response-mismatch', turnId: 'turn-seeded', routeId: route.routeId,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 80 },
      initialResponse: { message: { role: 'assistant', content: 'different response' }, finishReason: 'stop', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 }, historyCommitted: true }
    })).rejects.toThrow('host-committed model response usage does not match History')
    expect(execute).not.toHaveBeenCalled()
    expect(providerStream).not.toHaveBeenCalled()
  })

  it('refuses to re-dispatch a committed proposal after History already records tool start', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => stream({ type: 'text-delta', text: 'unused' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }))
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const writer = new InvocationHistoryWriter(history, { invocationId: 'host-seeded-started', turnId: 'turn-seeded' })
    const userMessage = { role: 'user' as const, content: 'hello' }
    const assistantMessage = { role: 'assistant' as const, toolCalls: [{ id: 'already-started', name: 'lookup', input: { query: 'q' } }] }
    await writer.append([
      { kind: 'invocation-context-committed', payload: { messages: [userMessage] } },
      { kind: 'model-response-committed', payload: { message: assistantMessage, finishReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } } },
      { kind: 'tool-call-started', payload: { toolCallId: 'already-started', toolName: 'lookup' } }
    ])
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'duplicate side effect' }))
    const capabilities = new CapabilityRegistry()
    capabilities.define('host-seeded-started-inv', ['lookup'])
    const host: AgentTurnHost = { createPorts: async ({ invocationId, turnId, routeId, request }) => ({
      registry, routeId, invocationId, turnId, request, history,
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 2
    }) }

    await expect(runHostedAgentTurn({
      host, invocationId: 'host-seeded-started-inv', turnId: 'turn-seeded', routeId: route.routeId,
      request: { messages: [userMessage], maxTokens: 80 },
      initialResponse: { message: assistantMessage, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 }, historyCommitted: true }
    })).rejects.toThrow('host-committed model response is not the latest History event')
    expect(execute).not.toHaveBeenCalled()
    expect(providerStream).not.toHaveBeenCalled()
  })

  it('runs hosted tool authorization through invocation-scoped initial and recheck policy resolutions', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream({ type: 'tool-call', toolCallId: 'hosted-dynamic', toolName: 'lookup', input: { query: 'q' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    registry.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define('hosted-dynamic-inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const policyBindings: string[] = []
    const execute = vi.fn(async () => ({ output: 'result' }))
    const host: AgentTurnHost = {
      createPorts: async ({ invocationId, routeId, request }) => ({
        registry, routeId, invocationId,
        request,
        safetyGate: new SafetyGate({
          capabilities,
          permitStore: permits,
          resolvePolicy: (binding) => ({ evaluate: async (current) => {
            policyBindings.push(`${binding.phase}:${current.phase}:${current.toolCallId}`)
            return { kind: 'allow', authorizationVersion: current.authorizationVersion }
          } })
        }),
        prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
        toolExecution: toolExecutionPort(permits, execute),
        maxModelTurns: 2
      })
    }

    const result = await runHostedAgentTurn({ host, invocationId: 'hosted-dynamic-inv', routeId: route.routeId, request: { messages: [{ role: 'user', content: 'find' }], maxTokens: 50 } })
    expect(result.text).toBe('done')
    expect(policyBindings).toEqual(['initial-compat:initial-compat:hosted-dynamic', 'recheck:recheck:hosted-dynamic'])
    expect(execute).toHaveBeenCalledOnce()
  })

  it('fails closed when the hosted policy resolver denies during recheck', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'hosted-recheck-deny', toolName: 'lookup', input: { query: 'q' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('hosted-recheck-deny-inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'must not execute' }))
    const phases: string[] = []
    const host: AgentTurnHost = {
      createPorts: async ({ invocationId, routeId, request }) => ({
        registry, routeId, invocationId,
        request,
        safetyGate: new SafetyGate({ capabilities, permitStore: permits, resolvePolicy: () => ({ evaluate: async (current) => {
          phases.push(current.phase)
          return current.phase === 'initial-compat'
            ? { kind: 'allow', authorizationVersion: current.authorizationVersion }
            : { kind: 'deny', reasonCode: 'POLICY_DENY' }
        } }) }),
        prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
        toolExecution: toolExecutionPort(permits, execute),
        maxModelTurns: 2
      })
    }

    await expect(runHostedAgentTurn({ host, invocationId: 'hosted-recheck-deny-inv', routeId: route.routeId, request: { messages: [{ role: 'user', content: 'find' }], maxTokens: 50 } }))
      .rejects.toMatchObject({ code: 'TOOL_DENIED', reasonCode: 'POLICY_DENY' })
    expect(phases).toEqual(['initial-compat', 'recheck'])
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps accepted responses in the transcript when the turn-boundary host does not compact', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream({ type: 'tool-call', toolCallId: 'tc-boundary-noop', toolName: 'lookup', input: { query: 'q' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let secondRequest: unknown[] = []
    registry.register(route, { providerId: 'fake', stream: (call) => {
      if (secondRequest.length) return rounds.shift()!
      if (rounds.length === 1) secondRequest = [...call.request.messages]
      return rounds.shift()!
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'find' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'result' })), maxModelTurns: 2,
      turnBoundary: async () => undefined
    })
    expect(secondRequest).toContainEqual({ role: 'assistant', toolCalls: [{ id: 'tc-boundary-noop', name: 'lookup', input: { query: 'q' } }] })
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'done' })
  })

  it('runs turn-boundary planning after a committed tool response and before dispatch', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream({ type: 'tool-call', toolCallId: 'tc-boundary', toolName: 'lookup', input: { query: 'q' } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    registry.register(route, { providerId: 'fake', stream: (call) => { requestMessages.push([...call.request.messages]); return rounds.shift()! } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    const order: string[] = []
    const requestMessages: unknown[][] = []
    let boundaryCount = 0

    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'find' }], maxTokens: 100 },
      history,
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, async () => { order.push('tool'); return { output: 'result' } }),
      maxModelTurns: 2,
      turnBoundary: async () => {
        boundaryCount += 1
        if (boundaryCount > 1) return
        order.push('boundary')
        const state = await history.read('inv')
        expect(state.events.at(-1)?.kind).toBe('model-response-committed')
        return { messages: [
          { role: 'user' as const, content: 'compacted input' },
          { role: 'assistant' as const, content: 'compacted response' },
          { role: 'assistant' as const, toolCalls: [{ id: 'tc-boundary', name: 'lookup', input: { query: 'q' } }] }
        ] }
      }
    })
    expect(order.slice(0, 2)).toEqual(['boundary', 'tool'])
    expect(requestMessages[1]).toEqual([
      { role: 'user', content: 'compacted input' }, { role: 'assistant', content: 'compacted response' },
      { role: 'assistant', toolCalls: [{ id: 'tc-boundary', name: 'lookup', input: { query: 'q' } }] },
      { role: 'tool', toolCallId: 'tc-boundary', content: 'result', isError: false }
    ])
    expect((await history.read('inv')).events.map(({ kind }) => kind)).toContain('transcript-compacted')
  })

  it('passes current-user identity bindings to the host before turn-boundary compaction', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ) })
    const requiredUserMessage = { id: 'user-current', message: { role: 'user' as const, content: 'current request' } }
    const turnBoundary = vi.fn(async () => undefined)
    const permits = new InMemorySafetyPermitStore()
    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', currentUserMessageId: requiredUserMessage.id, requiredUserMessage,
      request: { messages: [{ role: 'user', content: 'current request' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, vi.fn()), maxModelTurns: 1, turnBoundary
    })
    expect(turnBoundary).toHaveBeenCalledWith(expect.objectContaining({
      currentUserMessageId: 'user-current', requiredUserMessage
    }))
  })

  it('rejects turn-boundary compaction that drops a pending tool proposal before execution', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-dropped', toolName: 'lookup', input: { query: 'q' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'must not run' }))
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'find' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 2,
      turnBoundary: async () => ({ messages: [{ role: 'user', content: 'compacted without the tool call' }] })
    })).rejects.toThrow(/pending tool proposal/i)
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not dispatch tools when compacted transcript persistence fails', async () => {
    const registry = new ModelProviderRegistry()
    const history = new MemoryHistory()
    const originalAppend = history.appendBatch.bind(history)
    vi.spyOn(history, 'appendBatch').mockImplementation(async (events, version) => {
      if (events.some((event) => event.kind === 'transcript-compacted')) throw new Error('injected compaction history failure')
      return originalAppend(events, version)
    })
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-compact-fail', toolName: 'lookup', input: { query: 'q' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'must not run' }))

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history,
      request: { messages: [{ role: 'user', content: 'find' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 2,
      turnBoundary: async () => ({ messages: [
        { role: 'user', content: 'compacted' },
        { role: 'assistant', toolCalls: [{ id: 'tc-compact-fail', name: 'lookup', input: { query: 'q' } }] }
      ] })
    })).rejects.toThrow('injected compaction history failure')
    expect(execute).not.toHaveBeenCalled()
  })

  it('serializes SDK tool calls that share a host resource key', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream(
        { type: 'tool-call', toolCallId: 'tc-first', toolName: 'write', input: { path: 'shared.txt', content: 'first' } },
        { type: 'tool-call', toolCallId: 'tc-second', toolName: 'write', input: { path: 'shared.txt', content: 'second' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      ),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    registry.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['write'])
    const permits = new InMemorySafetyPermitStore()
    let active = 0
    let maximumActive = 0
    const execution = createPermitBoundToolExecutionPort<{ invocationId: string; toolCallId: string; toolName: string; signal?: AbortSignal }, { output: unknown }>({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return { output: 'ok' }
      }
    })
    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'write twice' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 2,
      resourceLocks: new ResourceLockRegistry(), toolResourceKeys: () => ['workspace:/project/shared.txt']
    })
    expect(maximumActive).toBe(1)
  })

  it('dispatches same-response tools concurrently and rebuilds their results in provider order', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream(
        { type: 'tool-call', toolCallId: 'tc-slow', toolName: 'lookup', input: { query: 'slow' } },
        { type: 'tool-call', toolCallId: 'tc-fast', toolName: 'lookup', input: { query: 'fast' } },
        { type: 'tool-call', toolCallId: 'tc-medium', toolName: 'lookup', input: { query: 'medium' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      ),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    const modelMessages: unknown[][] = []
    registry.register(route, { providerId: 'fake', stream: (call) => { modelMessages.push([...call.request.messages]); return rounds.shift()! } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    const observerFinishedIds: string[] = []
    const observerSawCommitted: boolean[] = []
    let active = 0
    let maximumActive = 0
    const execution = createPermitBoundToolExecutionPort<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }, { output: unknown }>({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (call) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, call.input.query === 'slow' ? 25 : call.input.query === 'medium' ? 5 : 1))
        active -= 1
        return { output: `${call.input.query}-result` }
      }
    })
    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'run tools' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 2, history,
      resourceLocks: new ResourceLockRegistry(),
      toolResourceKeys: (call) => [`workspace:/project/${String(call.input.query)}.txt`],
      observer: { onToolFinished: async (call) => {
        observerFinishedIds.push(call.toolCallId)
        const snapshot = await history.read('inv')
        observerSawCommitted.push(snapshot.events.some(({ kind, payload }) => kind === 'tool-call-finished' && (payload as { toolCallId?: string }).toolCallId === call.toolCallId))
      } }
    })
    expect(maximumActive).toBe(2)
    expect(modelMessages[1]?.filter((message) => (message as { role?: string }).role === 'tool')).toEqual([
      { role: 'tool', toolCallId: 'tc-slow', content: 'slow-result', isError: false },
      { role: 'tool', toolCallId: 'tc-fast', content: 'fast-result', isError: false },
      { role: 'tool', toolCallId: 'tc-medium', content: 'medium-result', isError: false }
    ])
    const finished = (await history.read('inv')).events.filter(({ kind }) => kind === 'tool-call-finished')
    expect(finished.map((event) => (event.payload as { toolCallId: string }).toolCallId)).toEqual(['tc-fast', 'tc-medium', 'tc-slow'])
    expect(observerFinishedIds).toEqual(['tc-fast', 'tc-medium', 'tc-slow'])
    expect(observerSawCommitted).toEqual([true, true, true])
  })

  it('serializes SDK tool calls that share a host resource key', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream(
        { type: 'tool-call', toolCallId: 'tc-first', toolName: 'write', input: { path: 'shared.txt', content: 'first' } },
        { type: 'tool-call', toolCallId: 'tc-second', toolName: 'write', input: { path: 'shared.txt', content: 'second' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      ),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    registry.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['write'])
    const permits = new InMemorySafetyPermitStore()
    let active = 0
    let maximumActive = 0
    const execution = createPermitBoundToolExecutionPort<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }, { output: unknown }>({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return { output: 'ok' }
      }
    })
    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'write twice' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 2,
      resourceLocks: new ResourceLockRegistry(), toolResourceKeys: () => ['workspace:/project/shared.txt']
    })
    expect(maximumActive).toBe(1)
  })

  it('rechecks facts only after acquiring a queued tool resource lock', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream(
        { type: 'tool-call', toolCallId: 'tc-lock-owner', toolName: 'write', input: { path: 'shared.txt' } },
        { type: 'tool-call', toolCallId: 'tc-lock-waiter', toolName: 'write', input: { path: 'shared.txt' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      ),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    registry.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['write'])
    const permits = new InMemorySafetyPermitStore()
    let ownerStarted!: () => void
    let waiterPrepared!: () => void
    let releaseOwner!: () => void
    const ownerStartedPromise = new Promise<void>((resolve) => { ownerStarted = resolve })
    const waiterPreparedPromise = new Promise<void>((resolve) => { waiterPrepared = resolve })
    const ownerReleasePromise = new Promise<void>((resolve) => { releaseOwner = resolve })
    let ownerSettled = false
    let waiterRecheckedAfterOwner = false
    let executorCalls = 0
    const execution = createPermitBoundToolExecutionPort<{ invocationId: string; toolCallId: string; toolName: string; signal?: AbortSignal }, { output: unknown }>({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (call) => {
        executorCalls += 1
        ownerStarted()
        await ownerReleasePromise
        ownerSettled = true
        return { output: call.toolCallId }
      }
    })
    const turn = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'write shared' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => {
        if (call.toolCallId === 'tc-lock-waiter' && stage.kind === 'initial') waiterPrepared()
        if (call.toolCallId === 'tc-lock-waiter' && stage.kind === 'recheck') waiterRecheckedAfterOwner = ownerSettled
        return {
          ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName,
          factsDigest: call.toolCallId === 'tc-lock-waiter' && stage.kind === 'recheck' ? 'changed-facts' : 'facts',
          phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck'
        }
      },
      toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 2,
      resourceLocks: new ResourceLockRegistry(), toolResourceKeys: () => ['workspace:/project/shared.txt']
    })
    await ownerStartedPromise
    await waiterPreparedPromise
    releaseOwner()
    await expect(turn).rejects.toThrow('STALE_AUTHORIZATION')
    expect(waiterRecheckedAfterOwner).toBe(true)
    expect(executorCalls).toBe(1)
  })

  it('commits executor error results and replays them to the next model turn without failing the invocation', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream(
        { type: 'tool-call', toolCallId: 'tc-error-result', toolName: 'lookup', input: { query: 'missing' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      ),
      stream({ type: 'text-delta', text: 'I can recover.' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    const requests: unknown[][] = []
    registry.register(route, { providerId: 'fake', stream: (call) => { requests.push([...call.request.messages]); return rounds.shift()! } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history,
      request: { messages: [{ role: 'user', content: 'find it' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, async () => ({ output: { errorCode: 'NOT_FOUND' }, replayContent: 'record not found', isError: true })),
      maxModelTurns: 2
    })
    const toolMessage = requests[1]?.find((message) => (message as { role?: string }).role === 'tool')
    expect(toolMessage).toEqual({ role: 'tool', toolCallId: 'tc-error-result', content: 'record not found', isError: true })
    const events = (await history.read('inv')).events
    expect(events.find(({ kind }) => kind === 'tool-call-finished')?.payload).toMatchObject({
      success: false, result: { errorCode: 'NOT_FOUND' }, replayContent: 'record not found', isError: true
    })
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-completed' })
  })

  it('waits for already-dispatched sibling tools to settle before recording an uncertain terminal', async () => {
    const registry = new ModelProviderRegistry()
    let modelCalls = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      modelCalls += 1
      return stream(
        { type: 'tool-call', toolCallId: 'tc-fails', toolName: 'lookup', input: { query: 'fail' } },
        { type: 'tool-call', toolCallId: 'tc-sibling', toolName: 'lookup', input: { query: 'slow' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      )
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    let siblingSettled = false
    const execution = createPermitBoundToolExecutionPort<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }, { output: unknown }>({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (call) => {
        if (call.input.query === 'fail') throw new Error('uncertain tool dispatch')
        await new Promise((resolve) => setTimeout(resolve, 20))
        siblingSettled = true
        return { output: 'sibling completed' }
      }
    })
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history, request: { messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execution, maxModelTurns: 2, toolResourceKeys: () => []
    })).rejects.toThrow('uncertain tool dispatch')
    expect(siblingSettled).toBe(true)
    expect(modelCalls).toBe(1)
    const events = (await history.read('inv')).events
    expect(events.filter(({ kind }) => kind === 'tool-call-finished')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
  })

  it('drains in-flight work after a denial and leaves queued tools undispatched on a fatal result', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-denied', toolName: 'lookup', input: { query: 'deny' } },
      { type: 'tool-call', toolCallId: 'tc-uncertain', toolName: 'lookup', input: { query: 'uncertain' } },
      { type: 'tool-call', toolCallId: 'tc-queued', toolName: 'lookup', input: { query: 'queued' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    let releaseUncertain!: () => void
    const uncertainGate = new Promise<void>((resolve) => { releaseUncertain = resolve })
    const started: string[] = []
    const dispatchDiagnostics: Array<{ modelTurn: number; reason: string; attemptedCount: number; undispatchedToolCallIds: readonly string[] }> = []
    const execution = createPermitBoundToolExecutionPort<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }, { output: unknown }>({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (call) => {
        started.push(call.toolCallId)
        if (call.input.query === 'uncertain') {
          await uncertainGate
          throw new Error('dispatch outcome unknown')
        }
        return { output: 'unexpected dispatch' }
      }
    })
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => {
      if (binding.toolCallId === 'tc-denied') {
        await vi.waitFor(() => expect(started).toContain('tc-uncertain'))
        return { kind: 'deny', reasonCode: 'POLICY_DENY' }
      }
      return { kind: 'allow', authorizationVersion: binding.authorizationVersion }
    } } })
    const turn = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history, request: { messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 2, toolResourceKeys: () => [],
      observer: { onDispatchStoppedWithPending: (event) => { dispatchDiagnostics.push(event) } }
    })
    await vi.waitFor(async () => expect((await history.read('inv')).events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'tc-denied' }) })))
    expect(started).toEqual(['tc-uncertain'])
    releaseUncertain()
    await expect(turn).rejects.toThrow('dispatch outcome unknown')
    expect(started).toEqual(['tc-uncertain'])
    const events = (await history.read('inv')).events
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'tc-queued', reason: 'TURN_STOPPED_BEFORE_DISPATCH' }) }))
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
    expect(dispatchDiagnostics).toEqual([{ modelTurn: 1, reason: 'ToolExecutionAfterDispatchError', attemptedCount: 2, undispatchedToolCallIds: ['tc-queued'] }])
  })

  it('resumes queued dispatch after a denial once all in-flight work settles', async () => {
    const registry = new ModelProviderRegistry()
    let modelTurn = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      modelTurn += 1
      return modelTurn === 1
        ? stream(
          { type: 'tool-call', toolCallId: 'tc-denied', toolName: 'lookup', input: { query: 'deny' } },
          { type: 'tool-call', toolCallId: 'tc-slow', toolName: 'lookup', input: { query: 'slow' } },
          { type: 'tool-call', toolCallId: 'tc-queued', toolName: 'lookup', input: { query: 'queued' } },
          { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
        )
        : stream({ type: 'text-delta', text: 'recovered' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('resume', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    const started: string[] = []
    const execution = createPermitBoundToolExecutionPort<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }, { output: unknown }>({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (call) => {
        started.push(call.toolCallId)
        if (call.input.query === 'slow') await slowGate
        return { output: call.toolCallId }
      }
    })
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => {
      if (binding.toolCallId === 'tc-denied') {
        await vi.waitFor(() => expect(started).toContain('tc-slow'))
        return { kind: 'deny', reasonCode: 'POLICY_DENY' }
      }
      return { kind: 'allow', authorizationVersion: binding.authorizationVersion }
    } } })
    const turn = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'resume', history, request: { messages: [], maxTokens: 100 }, safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 2, toolResourceKeys: () => [], returnDeniedToolsToModel: true
    })
    await vi.waitFor(async () => expect((await history.read('resume')).events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'tc-denied' }) })))
    expect(started).toEqual(['tc-slow'])
    releaseSlow()
    await expect(turn).resolves.toMatchObject({ text: 'recovered' })
    expect(started).toEqual(['tc-slow', 'tc-queued'])
    const snapshot = await history.read('resume')
    expect(snapshot.events.filter(({ kind }) => kind === 'tool-call-finished')).toHaveLength(2)
    expect(snapshot.events.filter(({ kind }) => kind === 'tool-call-not-dispatched').map(({ payload }) => (payload as { toolCallId: string }).toolCallId)).toEqual(['tc-denied'])
  })

  it('holds a multi-worker drain barrier until every claimed worker settles, then resumes without losing fatal errors', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      ...['deny', 'slow-a', 'slow-b', 'queued-a', 'queued-b'].map((query) => ({ type: 'tool-call' as const, toolCallId: `tc-${query}`, toolName: 'lookup', input: { query } })),
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('barrier', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    let releaseA!: () => void
    let releaseB!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const gateB = new Promise<void>((resolve) => { releaseB = resolve })
    const started: string[] = []
    const execution = createPermitBoundToolExecutionPort<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }, { output: unknown }>({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (call) => {
        started.push(call.toolCallId)
        if (call.input.query === 'slow-a') { await gateA; return { output: 'a' } }
        if (call.input.query === 'slow-b') { await gateB; throw new Error('fatal b') }
        throw new Error(`unexpected execution: ${call.toolCallId}`)
      }
    })
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => {
      if (binding.toolCallId === 'tc-deny') {
        await vi.waitFor(() => expect(started).toContain('tc-slow-b'))
        return { kind: 'deny', reasonCode: 'POLICY_DENY' }
      }
      return { kind: 'allow', authorizationVersion: binding.authorizationVersion }
    } } })
    const turn = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'barrier', history, request: { messages: [], maxTokens: 100 }, safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 3, toolResourceKeys: () => []
    })
    await vi.waitFor(async () => expect((await history.read('barrier')).events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'tc-deny' }) })))
    expect(started).toEqual(['tc-slow-a', 'tc-slow-b'])
    releaseA()
    await Promise.resolve()
    expect(started).toEqual(['tc-slow-a', 'tc-slow-b'])
    releaseB()
    await expect(turn).rejects.toThrow('fatal b')
    expect(started).toEqual(['tc-slow-a', 'tc-slow-b'])
    const events = (await history.read('barrier')).events
    expect(events.filter(({ kind }) => kind === 'tool-call-not-dispatched').map(({ payload }) => (payload as { toolCallId: string }).toolCallId)).toEqual(['tc-deny', 'tc-queued-a', 'tc-queued-b'])
  })

  it('preserves the primary turn error when writing the failed terminal history also fails', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream({ type: 'text-delta', text: 'partial' }) })
    const persisted: HistoryEvent[] = []
    const appendBatch = vi.fn(async (events: readonly HistoryEvent[]) => {
      if (events.some(({ kind }) => kind === 'invocation-failed')) throw new Error('history unavailable')
      persisted.push(...structuredClone(events))
      return { version: persisted.length, duplicate: false }
    })
    const history = {
      read: vi.fn(async () => ({ invocationId: 'inv', version: persisted.length, schemaVersion: 1, events: structuredClone(persisted) })),
      appendBatch
    }
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history
    })).rejects.toMatchObject({ code: 'INVALID_MODEL_STREAM' })
    expect(history.appendBatch).toHaveBeenCalledTimes(3)
  })

  it('fails closed and withholds turn completion when recording invocation completion fails', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream({ type: 'text-delta', text: 'answer' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }) })
    const historyEvents: HistoryEvent[] = []
    const history = {
      read: vi.fn(async () => ({ invocationId: 'inv', version: historyEvents.length, schemaVersion: 1, events: structuredClone(historyEvents) })),
      appendBatch: vi.fn(async (events: readonly HistoryEvent[], expectedVersion: number) => {
        if (events.some(({ kind }) => kind === 'invocation-completed')) throw new Error('history unavailable')
        if (expectedVersion !== historyEvents.length) throw new Error('stale history version')
        historyEvents.push(...structuredClone(events))
        return { version: historyEvents.length, duplicate: false }
      })
    }
    const onTurnFinished = vi.fn()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history,
      observer: { onTurnFinished }
    })).rejects.toThrow('history append failed (invocation-completed): history unavailable')
    expect(onTurnFinished).not.toHaveBeenCalled()
    expect(historyEvents.at(-1)).toMatchObject({ kind: 'invocation-failed' })
  })

  it('marks output projection failure interrupted and does not commit a completed History terminal', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream({ type: 'text-delta', text: 'answer' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }) })
    const history = new MemoryHistory()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'output-projection-fails', request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history,
      observer: { onTurnOutputReady: async () => { throw new Error('assistant checkpoint unavailable') } }
    })).rejects.toThrow('host response projection failed: assistant checkpoint unavailable')
    expect((await history.read('output-projection-fails')).events.at(-1)).toMatchObject({
      kind: 'invocation-interrupted', payload: { reason: 'host-projection-failed' }
    })
  })

  it('marks the turn interrupted when a dispatched tool result cannot be persisted', async () => {
    const registry = new ModelProviderRegistry()
    let modelCalls = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      modelCalls += 1
      return stream(
        { type: 'tool-call', toolCallId: 'tc-unknown', toolName: 'lookup', input: { query: 'weather' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 },
        { type: 'finish', reason: 'tool-calls' }
      )
    } })
    const persisted: Array<{ kind: HistoryEvent['kind']; payload: unknown }> = []
    const history = {
      read: vi.fn(async () => ({ invocationId: 'inv', version: persisted.length, schemaVersion: 1, events: persisted.map((event, index) => ({
        ...event, invocationId: 'inv', turnId: 'turn', eventId: `e${index + 1}`, idempotencyKey: `i${index + 1}`, sequence: index + 1, schemaVersion: 1
      })) })),
      appendBatch: vi.fn(async (events: readonly HistoryEvent[]) => {
        if (events.some(({ kind }) => kind === 'tool-call-finished')) throw new Error('history write failed after dispatch')
        persisted.push(...events)
        return { version: persisted.length, duplicate: false }
      })
    }
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const executed = vi.fn(async () => ({ output: 'side effect completed' }))

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', turnId: 'turn', request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, executed), maxModelTurns: 2, history
    })).rejects.toThrow('history write failed after dispatch')

    expect(executed).toHaveBeenCalledOnce()
    expect(modelCalls).toBe(1)
    expect(persisted.map(({ kind }) => kind)).toEqual(['invocation-context-committed', 'model-request-started', 'model-response-committed', 'tool-call-started', 'invocation-interrupted'])
    expect(persisted.at(-1)?.payload).toMatchObject({ status: 'interrupted', reason: 'unknown-after-dispatch' })
  })

  it('marks executor errors after dispatch as unknown and does not retry the tool', async () => {
    const registry = new ModelProviderRegistry()
    let modelCalls = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      modelCalls += 1
      return stream(
        { type: 'tool-call', toolCallId: 'tc-executor-error', toolName: 'lookup', input: { query: 'weather' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 },
        { type: 'finish', reason: 'tool-calls' }
      )
    } })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const executed = vi.fn(async () => { throw new Error('executor failed after partial side effect') })

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', turnId: 'turn', request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, executed), maxModelTurns: 2, history
    })).rejects.toThrow('executor failed after partial side effect')

    expect(executed).toHaveBeenCalledOnce()
    expect(modelCalls).toBe(1)
    const snapshot = await history.read('inv')
    expect(snapshot.events.map(({ kind }) => kind)).toEqual(['invocation-context-committed', 'model-request-started', 'model-response-committed', 'tool-call-started', 'invocation-interrupted'])
    expect(snapshot.events.at(-1)?.payload).toMatchObject({ status: 'interrupted', reason: 'unknown-after-dispatch' })
  })

  it('persists SDK tool dispatch, result, and invocation terminal history', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream({ type: 'tool-call', toolCallId: 'tc-history', toolName: 'lookup', input: { query: 'weather' } }, { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'sunny' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    registry.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()

    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', turnId: 'turn-history',
      request: { messages: [{ role: 'user', content: 'weather?' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'allow', authorizationVersion: 'auth-v1' }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'sunny' })),
      maxModelTurns: 2,
      history
    })

    const { events } = await history.read('inv')
    expect(events.map(({ kind }) => kind)).toEqual([
      'invocation-context-committed', 'model-request-started', 'model-response-committed', 'tool-call-started', 'tool-call-finished', 'model-request-started', 'model-response-committed', 'invocation-completed'
    ])
    expect(events[0]?.payload).toMatchObject({ messages: [{ role: 'user', content: 'weather?' }] })
    expect(events[2]?.payload).toMatchObject({ requestId: 'inv:turn:1', message: { role: 'assistant', toolCalls: [{ id: 'tc-history', name: 'lookup' }] }, finishReason: 'tool-calls', usage: { inputTokens: 2, outputTokens: 1 } })
    expect(events[3]?.payload).toMatchObject({ toolCallId: 'tc-history', toolName: 'lookup', inputHash: expect.any(String) })
    expect((events[3]?.payload as { inputHash: string; input?: unknown }).inputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(events[3]?.payload).not.toHaveProperty('input')
    expect(events[4]?.payload).toMatchObject({ toolCallId: 'tc-history', success: true, result: 'sunny' })
    expect(events[6]?.payload).toMatchObject({ requestId: 'inv:turn:2', message: { role: 'assistant', content: 'sunny' }, finishReason: 'stop' })
    expect(events[7]?.payload).toEqual({ status: 'completed', outputText: 'sunny', usage: { inputTokens: 3, outputTokens: 2 } })
  })

  it('commits provider tool-call thought signatures into canonical assistant history', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [stream(
      { type: 'tool-call', toolCallId: 'tc-signed', toolName: 'lookup', input: { query: 'x' }, thoughtSignature: 'provider-tool-signature' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ), stream(
      { type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    )]
    registry.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const history = new MemoryHistory()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'go' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'ok' })), maxModelTurns: 2, history
    })
    const snapshot = await history.read('inv')
    expect(snapshot.events.find(({ kind }) => kind === 'model-response-committed')?.payload).toMatchObject({
      message: { role: 'assistant', toolCalls: [{ id: 'tc-signed', thoughtSignature: 'provider-tool-signature' }] }
    })
  })

  it('publishes accepted model responses only after canonical history commit', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'accepted answer' },
      { type: 'usage', inputTokens: 3, outputTokens: 2 }, { type: 'finish', reason: 'stop' }
    ) })
    const history = new MemoryHistory()
    const observed: Array<{ committedKinds: string[]; message: unknown }> = []
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', turnId: 'turn',
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history,
      observer: { onModelResponseCommitted: async (response) => {
        const snapshot = await history.read('inv')
        observed.push({ committedKinds: snapshot.events.map(({ kind }) => kind), message: response.message })
      } }
    })
    expect(result.text).toBe('accepted answer')
    expect(observed).toEqual([{
      committedKinds: ['invocation-context-committed', 'model-request-started', 'model-response-committed'],
      message: { role: 'assistant', content: 'accepted answer' }
    }])
  })

  it('commits a credential-free exact model request snapshot beside each accepted response', async () => {
    const registry = new ModelProviderRegistry()
    const routeProfile = { ...route, endpoint: 'https://gateway.example/v1/messages' }
    registry.register(routeProfile, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'answer' }, { type: 'usage', inputTokens: 5, outputTokens: 2 }, { type: 'finish', reason: 'stop' }
    ) })
    const history = new MemoryHistory()
    const controller = new AbortController()
    const request = {
      messages: [
        { role: 'system' as const, content: 'Follow the safety policy.' },
        { role: 'user' as const, content: 'hello' }
      ],
      maxTokens: 96,
      credentials: { apiKey: 'must-not-be-persisted' },
      signal: controller.signal,
      tools: [{ name: 'lookup', description: 'Look up facts', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
      thinking: { enabled: true, effort: 'high' as const }
    }
    await runAgentTurn({
      registry, routeId: routeProfile.routeId, invocationId: 'inv-request-snapshot', request,
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history
    })

    const snapshot = await history.read('inv-request-snapshot')
    expect(snapshot.events[0]?.payload).toMatchObject({
      requestSnapshot: {
        route: routeProfile,
        request: {
          messages: request.messages,
          maxTokens: 96,
          tools: request.tools,
          thinking: { enabled: true, effort: 'high' }
        }
      }
    })
    expect(snapshot.events.find(({ kind }) => kind === 'model-response-committed')?.payload).toMatchObject({
      requestSnapshot: {
        route: routeProfile,
        request: {
          messages: request.messages,
          maxTokens: 96,
          tools: request.tools,
          thinking: { enabled: true, effort: 'high' }
        }
      }
    })
    expect(JSON.stringify(snapshot.events)).not.toContain('must-not-be-persisted')
  })

  it.each(['route', 'tools', 'thinking', 'maxTokens'] as const)('refuses to resume History when the persisted model %s identity changed', async (changed) => {
    const registry = new ModelProviderRegistry()
    const alternateRoute = changed === 'route' ? { ...route, routeId: 'other-route' } : route
    const providerStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'must not be requested' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ))
    registry.register(alternateRoute, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const writer = new InvocationHistoryWriter(history, { invocationId: 'inv-resume-snapshot', turnId: 'turn-resume-snapshot' })
    const userMessage = { role: 'user' as const, content: 'continue this invocation' }
    const originalRequest = {
      messages: [userMessage], maxTokens: 20,
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
      thinking: { enabled: true, effort: 'medium' as const }
    }
    const requestSnapshot = {
      route,
      request: { ...originalRequest }
    }
    await writer.append([
      { kind: 'invocation-context-committed', payload: { messages: [userMessage], requestSnapshot } },
      { kind: 'model-response-committed', payload: { requestSnapshot, message: { role: 'assistant', content: 'continue' }, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } }
    ])
    const request = {
      ...originalRequest,
      messages: [{ role: 'user' as const, content: 'continue this invocation' }, { role: 'assistant' as const, content: 'continue' }],
      ...(changed === 'tools' ? { tools: [{ name: 'different', description: 'Different', inputSchema: { type: 'object' } }] } : {}),
      ...(changed === 'thinking' ? { thinking: { enabled: false } } : {}),
      ...(changed === 'maxTokens' ? { maxTokens: 21 } : {})
    }
    await expect(runAgentTurn({
      registry, routeId: alternateRoute.routeId, invocationId: 'inv-resume-snapshot', request,
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history
    })).rejects.toThrow(/History request snapshot/)
    expect(providerStream).not.toHaveBeenCalled()
  })

  it.each([
    ['completed', 'invocation-completed', { status: 'completed' }],
    ['denied', 'invocation-failed', { status: 'denied', reason: 'POLICY_DENY' }],
    ['interrupted', 'invocation-interrupted', { status: 'interrupted', reason: 'process-restart' }]
  ] as const)('does not re-enter provider for an already %s invocation', async (_state, terminalKind, terminalPayload) => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'must not be requested' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ))
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const writer = new InvocationHistoryWriter(history, { invocationId: 'inv-terminal-reentry', turnId: 'turn-terminal-reentry' })
    await writer.append([
      { kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'original' }] } },
      { kind: terminalKind, payload: terminalPayload }
    ])
    const permits = new InMemorySafetyPermitStore()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-terminal-reentry', history,
      request: { messages: [{ role: 'user', content: 'try again as same invocation' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, vi.fn()), maxModelTurns: 1
    })).rejects.toThrow('History invocation is already terminal')
    expect(providerStream).not.toHaveBeenCalled()
    const after = await history.read('inv-terminal-reentry')
    expect(after.version).toBe(2)
    expect(after.events.at(-1)).toMatchObject({ kind: terminalKind, payload: terminalPayload })
  })

  it('does not start the provider until the initial request snapshot commits', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'must not be requested' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ))
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = {
      read: vi.fn(async () => ({ invocationId: 'inv', version: 0, schemaVersion: 1, events: [] })),
      appendBatch: vi.fn(async () => { throw new Error('request snapshot unavailable') })
    }

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 32 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history
    })).rejects.toMatchObject({ kinds: ['invocation-context-committed'] })
    expect(providerStream).not.toHaveBeenCalled()
  })

  it('binds the explicitly identified current user message even when auxiliary user context follows it', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'ok' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ) })
    const history = new MemoryHistory()
    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [
        { role: 'user', content: 'previous' }, { role: 'user', content: 'current request' }, { role: 'user', content: 'auxiliary skill context' }
      ], maxTokens: 100 }, currentUserMessageId: 'user-current',
      requiredUserMessage: { id: 'user-current', message: { role: 'user', content: 'current request' } },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history
    })
    const { events } = await history.read('inv')
    expect(events[0]?.payload).toMatchObject({
      messages: [{ content: 'previous' }, { content: 'current request' }, { content: 'auxiliary skill context' }],
      requiredUserMessage: { id: 'user-current', message: { role: 'user', content: 'current request' } }
    })
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
  })

  it('rejects current-user identity without an exact canonical message binding', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'must not run' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ) })
    const history = new MemoryHistory()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', currentUserMessageId: 'user-current',
      request: { messages: [{ role: 'user', content: 'request' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history
    })).rejects.toThrow('explicit canonical required user message')
    expect((await history.read('inv')).events.map(({ kind }) => kind)).toEqual(['invocation-failed'])
  })

  it('isolates a post-commit observer failure from the committed turn result', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'text-delta', text: 'committed' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ) })
    const history = new MemoryHistory()
    const onObservationError = vi.fn()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1, history,
      observer: {
        onModelResponseCommitted: async () => { throw new Error('UI projection failed') },
        onObservationError
      }
    })).resolves.toMatchObject({ text: 'committed', modelTurns: 1, finishReason: 'stop' })
    expect(onObservationError).toHaveBeenCalledWith(expect.objectContaining({ message: 'UI projection failed' }), 'model-response-committed')
    expect((await history.read('inv')).events.map(({ kind }) => kind)).toEqual([
      'invocation-context-committed', 'model-request-started', 'model-response-committed', 'invocation-completed'
    ])
  })

  it('halts before tool dispatch when a critical committed-response projection fails', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-projection', toolName: 'lookup', input: { query: 'weather' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const history = new MemoryHistory()
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'must not run' }))
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history,
      request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 1,
      observer: {
        onModelResponseCommitted: async () => { throw new Error('critical projection failed') },
        onObservationError: async () => { throw new Error('diagnostic sink failed') },
        criticalModelResponseProjection: true
      }
    })).rejects.toThrow('host response projection failed: critical projection failed')
    expect(execute).not.toHaveBeenCalled()
    expect((await history.read('inv')).events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'tc-projection', reason: 'HOST_PROJECTION_FAILED' }) }))
    expect((await history.read('inv')).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'host-projection-failed' } })
  })

  it('halts before tool dispatch when a critical tool-start projection fails', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-start-projection', toolName: 'lookup', input: { query: 'weather' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const history = new MemoryHistory()
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'must not run' }))
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-tool-start-projection', ['lookup'])

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-tool-start-projection', history,
      request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 2,
      observer: { criticalToolProjection: true, onToolStarted: async () => { throw new Error('tool start projection failed') }, onToolFinished: vi.fn() }
    })).rejects.toThrow('host tool projection failed: tool start projection failed')

    expect(execute).not.toHaveBeenCalled()
    expect((await history.read('inv-tool-start-projection')).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'tool-projection-failed' } })
  })

  it('halts before the next model request when a critical tool-finish projection fails', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn((call: { request: { messages: readonly CanonicalModelMessage[] } }) => call.request.messages.length === 0
      ? stream(
        { type: 'tool-call', toolCallId: 'tc-finish-projection', toolName: 'lookup', input: { query: 'weather' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      )
      : stream({ type: 'text-delta', text: 'must not request' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }))
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const permits = new InMemorySafetyPermitStore()
    const execute = vi.fn(async () => ({ output: 'already executed' }))
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-tool-finish-projection', ['lookup'])

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-tool-finish-projection', history,
      request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, execute), maxModelTurns: 2,
      observer: { criticalToolProjection: true, onToolStarted: vi.fn(), onToolFinished: async () => { throw new Error('tool finish projection failed') } }
    })).rejects.toThrow('host tool projection failed: tool finish projection failed')

    expect(execute).toHaveBeenCalledTimes(1)
    expect(providerStream).toHaveBeenCalledTimes(1)
    expect((await history.read('inv-tool-finish-projection')).events).toContainEqual(expect.objectContaining({ kind: 'tool-call-finished', payload: expect.objectContaining({ toolCallId: 'tc-finish-projection', result: 'already executed' }) }))
    expect((await history.read('inv-tool-finish-projection')).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'tool-projection-failed' } })
  })

  it('does not send a model request when critical request-ledger projection fails', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'must not be requested' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ))
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-request-projection-fails', history,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      observer: {
        onModelRequest: async () => { throw new Error('request ledger projection failed') },
        criticalModelRequestProjection: true
      }
    })).rejects.toThrow('request ledger projection failed')

    expect(providerStream).not.toHaveBeenCalled()
    expect((await history.read('inv-request-projection-fails')).events.at(-1)).toMatchObject({ kind: 'invocation-failed' })
  })

  it('does not commit a model response when critical completed-attempt usage projection fails', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'accepted answer' },
      { type: 'usage', inputTokens: 3, outputTokens: 2 }, { type: 'finish', reason: 'stop' }
    ))
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const recordProviderAttemptUsage = vi.fn(async () => { throw new Error('usage ledger projection failed') })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-critical-usage', [])

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-critical-usage', history,
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 50 },
      safetyGate: new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      recordProviderAttemptUsage,
      observer: { criticalModelAttemptUsageProjection: true }
    })).rejects.toThrow('usage ledger projection failed')

    expect(providerStream).toHaveBeenCalledOnce()
    expect(recordProviderAttemptUsage).toHaveBeenCalledOnce()
    expect((await history.read('inv-critical-usage')).events.some((event) => event.kind === 'model-response-committed')).toBe(false)
    expect((await history.read('inv-critical-usage')).events.at(-1)).toMatchObject({ kind: 'invocation-failed' })
  })

  it('does not retry after critical discarded-attempt usage projection fails', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => stream(
      { type: 'usage', inputTokens: 80, outputTokens: 0 }, { type: 'finish', reason: 'stop' }
    ))
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const recordProviderAttemptUsage = vi.fn(async () => { throw new Error('discarded usage ledger failed') })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-critical-discarded-usage', [])

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-critical-discarded-usage', history,
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 10 },
      safetyGate: new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      recordProviderAttemptUsage,
      observer: { criticalModelAttemptUsageProjection: true },
      recoverProviderAttempt: async () => ({ kind: 'retry', reasonCode: 'SILENT_CONTEXT_OVERFLOW', messages: [{ role: 'user', content: 'question' }] })
    })).rejects.toThrow('discarded usage ledger failed')

    expect(providerStream).toHaveBeenCalledOnce()
    expect(recordProviderAttemptUsage).toHaveBeenCalledWith(expect.objectContaining({ disposition: 'discarded', attempt: 1 }))
    expect((await history.read('inv-critical-discarded-usage')).events.some((event) => event.kind === 'model-response-committed')).toBe(false)
  })

  it('does not retry the provider when retry request-ledger projection fails', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => (async function* () {
      throw Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' })
    })())
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const onModelRequest = vi.fn(async ({ attempt }: { attempt: number }) => {
      if (attempt === 2) throw new Error('retry request ledger projection failed')
    })

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-retry-projection-fails', history,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      recoverProviderAttempt: async ({ messages }) => ({ reasonCode: 'CONTEXT_OVERFLOW', messages }),
      observer: { onModelRequest, criticalModelRequestProjection: true }
    })).rejects.toThrow('retry request ledger projection failed')

    expect(onModelRequest).toHaveBeenCalledTimes(2)
    expect(providerStream).toHaveBeenCalledOnce()
    expect((await history.read('inv-retry-projection-fails')).events.at(-1)).toMatchObject({ kind: 'invocation-failed' })
  })

  it('does not retry the provider when critical retry-ledger projection fails', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => (async function* () {
      throw Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' })
    })())
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-retry-event-fails', history,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      recoverProviderAttempt: async ({ messages }) => ({ reasonCode: 'CONTEXT_OVERFLOW', messages, retryEvent: { attempt: 1, code: 'provider_context_overflow' } }),
      observer: {
        onModelRequest: vi.fn(),
        onProviderRetry: async () => { throw new Error('retry ledger projection failed') },
        criticalModelRequestProjection: true
      }
    })).rejects.toThrow('retry ledger projection failed')

    expect(providerStream).toHaveBeenCalledOnce()
    expect((await history.read('inv-retry-event-fails')).events.at(-1)).toMatchObject({ kind: 'invocation-failed' })
  })

  it('requires a retry-ledger projection callback before a critical retry attempt', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => (async function* () {
      throw Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' })
    })())
    registry.register(route, { providerId: 'fake', stream: providerStream })

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-retry-event-callback-missing',
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      recoverProviderAttempt: async ({ messages }) => ({ reasonCode: 'CONTEXT_OVERFLOW', messages, retryEvent: { attempt: 1, code: 'provider_context_overflow' } }),
      observer: { onModelRequest: vi.fn(), criticalModelRequestProjection: true }
    })).rejects.toThrow('critical model request projection requires onProviderRetry')

    expect(providerStream).toHaveBeenCalledOnce()
  })

  it('rejects critical response projection mode without a projection callback before provider execution', async () => {
    const registry = new ModelProviderRegistry()
    const providerStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'must not be requested' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ))
    registry.register(route, { providerId: 'fake', stream: providerStream })
    const history = new MemoryHistory()
    const permits = new InMemorySafetyPermitStore()

    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-missing-critical-projection', history,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, vi.fn()), maxModelTurns: 1,
      observer: { criticalModelResponseProjection: true }
    })).rejects.toThrow('critical model response projection requires onModelResponseCommitted')

    expect(providerStream).not.toHaveBeenCalled()
    await expect(history.read('inv-missing-critical-projection')).resolves.toMatchObject({ version: 0, events: [] })
  })

  it('does not evaluate or dispatch tool calls when the accepted model response cannot be committed', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-history-fails', toolName: 'lookup', input: { query: 'weather' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const history = new MemoryHistory()
    const append = history.appendBatch.bind(history)
    vi.spyOn(history, 'appendBatch').mockImplementation(async (events, version) => {
      if (events.some(({ kind }) => kind === 'model-response-committed')) throw new Error('injected response history failure')
      return append(events, version)
    })
    const evaluate = vi.fn(async () => ({ kind: 'allow' as const, authorizationVersion: 'auth-v1' }))
    const execute = vi.fn(async () => ({ output: 'must not run' }))
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history,
      request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate } }),
      prepareTool: vi.fn(async (call, stage) => ({ ...toolBinding, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const })),
      toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), execute), maxModelTurns: 1
    })).rejects.toThrow('injected response history failure')
    expect(evaluate).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect((await history.read('inv')).events).toMatchObject([
      { kind: 'invocation-context-committed' },
      { kind: 'model-request-started' },
      { kind: 'invocation-failed', payload: { status: 'failed' } }
    ])
  })

  it('lets the SDK own a hosted invocation turn and rejects ports for another invocation', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }) })
    const gate = new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } })
    const permits = new InMemorySafetyPermitStore()
    const execution = toolExecutionPort(permits, vi.fn(async () => ({ output: null })))
    const resourceLocks = new ResourceLockRegistry()
    const ports = { registry, routeId: route.routeId, invocationId: 'inv', turnId: 'turn-1', request: { maxTokens: 100 }, safetyGate: gate, prepareTool: vi.fn(), toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 3, resourceLocks, toolResourceKeys: () => ['workspace:/hosted'] }
    const createPorts = vi.fn(async () => ports)
    const hostedRequest = { messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 100 }
    const requiredUserMessage = { id: 'user-1', message: hostedRequest.messages[0]! }
    await expect(runHostedAgentTurn({ host: { createPorts }, invocationId: 'inv', turnId: 'turn-1', currentUserMessageId: 'user-1', requiredUserMessage, routeId: route.routeId, request: hostedRequest })).resolves.toMatchObject({ text: 'done', modelTurns: 1, finishReason: 'stop' })
    expect(createPorts).toHaveBeenCalledOnce()
    expect(createPorts).toHaveBeenCalledWith({ invocationId: 'inv', turnId: 'turn-1', currentUserMessageId: 'user-1', requiredUserMessage, routeId: route.routeId, request: hostedRequest })
    const resolvedPorts = createPorts.mock.results[0]?.value as Promise<typeof ports>
    await expect(resolvedPorts).resolves.toMatchObject({ maxConcurrentTools: 3, resourceLocks })
    await expect(runHostedAgentTurn({ host: { createPorts: async () => ({ ...ports, invocationId: 'other' }) }, invocationId: 'inv', routeId: route.routeId, request: { messages: [], maxTokens: 100 } })).rejects.toThrow('different invocation')
    await expect(runHostedAgentTurn({ host: { createPorts: async () => ({ ...ports, turnId: 'other-turn' }) }, invocationId: 'inv', turnId: 'expected-turn', routeId: route.routeId, request: { messages: [], maxTokens: 100 } })).rejects.toThrow('different turn')
    await expect(runHostedAgentTurn({ host: { createPorts }, invocationId: 'inv', routeId: '', request: hostedRequest })).rejects.toThrow('routeId is required')
    await expect(runHostedAgentTurn({ host: { createPorts: async () => ({ ...ports, routeId: 'other-route' }) }, invocationId: 'inv', routeId: route.routeId, request: hostedRequest })).rejects.toThrow('different route')
  })

  it('freezes a cloned request before exposing it to the host resolver', async () => {
    const requestMessages: unknown[][] = []
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: (call) => {
      requestMessages.push([...call.request.messages])
      return stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const permits = new InMemorySafetyPermitStore()
    const turnBoundary = vi.fn(async () => undefined)
    const ports = {
      registry, routeId: route.routeId, invocationId: 'inv', request: { maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, vi.fn()), maxModelTurns: 1, turnBoundary
    }
    const original = { messages: [{ role: 'user' as const, content: 'original prompt' }], maxTokens: 100 }
    const requiredUserMessage = { id: 'user-current', message: { role: 'user' as const, content: 'original prompt' } }
    const createPorts = vi.fn(async (input: Parameters<AgentTurnHost['createPorts']>[0]) => {
      expect(input.request).not.toBe(original)
      expect(Object.isFrozen(input.request)).toBe(true)
      expect(Object.isFrozen(input.request.messages)).toBe(true)
      expect(Object.isFrozen(input.request.messages[0])).toBe(true)
      try { (input.request.messages[0] as { content: string }).content = 'mutated by host' } catch { /* frozen contract */ }
      try { (input.requiredUserMessage!.message as { content: string }).content = 'mutated user binding' } catch { /* frozen contract */ }
      return ports
    })
    await runHostedAgentTurn({ host: { createPorts }, invocationId: 'inv', currentUserMessageId: requiredUserMessage.id, requiredUserMessage, routeId: route.routeId, request: original })
    expect(original.messages[0]?.content).toBe('original prompt')
    expect(requestMessages[0]?.[0]).toEqual({ role: 'user', content: 'original prompt' })
    expect(turnBoundary).toHaveBeenCalledWith(expect.objectContaining({
      currentUserMessageId: 'user-current', requiredUserMessage: { id: 'user-current', message: { role: 'user', content: 'original prompt' } }
    }))
  })

  it('rejects invalid current-user bindings before hosted ports are resolved, even without HistoryPort', async () => {
    const createPorts = vi.fn()
    const host = { createPorts }
    const request = { messages: [{ role: 'user' as const, content: 'current request' }], maxTokens: 100 }
    await expect(runHostedAgentTurn({
      host, invocationId: 'inv', routeId: route.routeId, request,
      currentUserMessageId: 'user-current'
    })).rejects.toThrow('current user message id requires an explicit canonical required user message')
    await expect(runHostedAgentTurn({
      host, invocationId: 'inv', routeId: route.routeId, request,
      currentUserMessageId: 'user-current', requiredUserMessage: { id: 'other-user', message: request.messages[0]! }
    })).rejects.toThrow('current user message id does not match its required user message')
    await expect(runHostedAgentTurn({
      host, invocationId: 'inv', routeId: route.routeId, request,
      requiredUserMessage: { id: 'user-current', message: { role: 'user', content: 'not in request' } }
    })).rejects.toThrow('required user message must exactly match a request message')
    expect(createPorts).not.toHaveBeenCalled()
  })

  it('rejects a provider route replacement between model turns in one invocation', async () => {
    const registry = new ModelProviderRegistry()
    const routeA = { ...route, endpoint: 'https://gateway-a.example/v1/messages' }
    const routeB = { ...route, endpoint: 'https://gateway-b.example/v1/messages' }
    const replacementStream = vi.fn(() => stream(
      { type: 'text-delta', text: 'must not use the replacement route' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }
    ))
    registry.register(routeA, { providerId: 'provider-a', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-route', toolName: 'lookup', input: { query: 'q' } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const execute = toolExecutionPort(permits, async () => {
      registry.register(routeB, { providerId: 'provider-b', stream: replacementStream })
      return { output: 'tool result committed' }
    })

    await expect(runAgentTurn({
      registry, routeId: routeA.routeId, invocationId: 'inv', request: { messages: [{ role: 'user', content: 'go' }], maxTokens: 64 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execute, maxModelTurns: 2
    })).rejects.toMatchObject({ code: 'MODEL_ROUTE_CHANGED' })
    expect(replacementStream).not.toHaveBeenCalled()
  })


  it('publishes model, tool, usage and terminal facts through the observer in source order', async () => {
    const registry = new ModelProviderRegistry()
    const rounds = [
      stream({ type: 'text-delta', text: 'checking' }, { type: 'tool-call', toolCallId: 'tc-observe', toolName: 'lookup', input: { q: 'x' } }, { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    registry.register(route, { providerId: 'fake', stream: () => rounds.shift()! })
    const permits = new InMemorySafetyPermitStore()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const history = new MemoryHistory()
    const finishedHistoryAtObserver: string[][] = []
    const observer = {
      onModelChunk: vi.fn(), onToolStarted: vi.fn(), onToolFinished: vi.fn(), onTurnFinished: vi.fn()
    }
    observer.onToolFinished.mockImplementation(async () => {
      const snapshot = await history.read('inv')
      finishedHistoryAtObserver.push(snapshot.events.map(({ kind }) => kind))
    })
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history, request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: vi.fn(async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const })),
      toolExecution: createPermitBoundToolExecutionPort({ permits, admission: new InMemoryExecutionAdmissionCoordinator(), resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }), execute: async () => ({ output: 'result' }) }),
      maxModelTurns: 2, observer
    })
    expect(observer.onModelChunk.mock.calls.map(([chunk]) => (chunk as { type: string }).type)).toEqual(['text-delta', 'tool-call', 'usage', 'text-delta', 'usage'])
    expect(observer.onToolStarted).toHaveBeenCalledOnce()
    expect(observer.onToolFinished).toHaveBeenCalledOnce()
    expect(finishedHistoryAtObserver[0]).toContain('tool-call-finished')
    expect(finishedHistoryAtObserver[0]).not.toContain('invocation-completed')
    expect(observer.onTurnFinished).toHaveBeenCalledOnce()
    expect(observer.onTurnFinished).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputTokens: 3, outputTokens: 2 }, modelTurns: 2 }))
    expect(result.messages).toContainEqual(expect.objectContaining({ role: 'tool', content: 'result' }))
  })

  it('keeps observer delivery failures out of turn authorization and reports the observation failure', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream({ type: 'text-delta', text: 'ok' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }) })
    const reported = vi.fn()
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      observer: { onModelChunk: async () => { throw new Error('ui projection unavailable') }, onObservationError: reported }
    })
    expect(result.text).toBe('ok')
    expect(reported).toHaveBeenCalledWith(expect.any(Error), 'model-chunk')
  })

  it('keeps a failing observation error reporter from changing the model turn result', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream({ type: 'text-delta', text: 'still completed' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' }) })
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1,
      observer: { onModelChunk: async () => { throw new Error('UI unavailable') }, onObservationError: async () => { throw new Error('telemetry unavailable') } }
    })
    expect(result.text).toBe('still completed')
  })

  it('authorizes and executes streamed tools before requesting the next model turn', async () => {
    const registry = new ModelProviderRegistry()
    const streams = [
      stream({ type: 'text-delta', text: 'Checking. ' }, { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: { query: 'weather' } }, { type: 'usage', inputTokens: 2, outputTokens: 3 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'Sunny' }, { type: 'usage', inputTokens: 4, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    registry.register(route, { providerId: 'fake', stream: vi.fn(() => streams.shift()!) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const gate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'allow', authorizationVersion: 'auth-v1' }) } })
    const order: string[] = []
    const result = await runAgentTurn({
      registry,
      routeId: route.routeId,
      invocationId: 'inv',
      request: { messages: [{ role: 'user', content: 'weather?' }], maxTokens: 100 },
      safetyGate: gate,
      prepareTool: async (_call, stage) => { order.push(`prepare:${stage.kind}`); return { ...toolBinding, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' } },
      toolExecution: toolExecutionPort(permits, async (call, signal) => { order.push(`execute:${call.toolName}:${!signal.aborted}`); return { output: 'tool result' } }),
      maxModelTurns: 3
    })

    expect(order).toEqual(['prepare:initial', 'prepare:recheck', 'execute:lookup:true'])
    expect(result.text).toBe('Checking. Sunny')
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 4 })
    expect(result.messages).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking. ' }], toolCalls: [{ id: 'tc1', name: 'lookup', input: { query: 'weather' } }] },
      { role: 'tool', toolCallId: 'tc1', content: 'tool result', isError: false },
      { role: 'assistant', content: 'Sunny' }
    ])
  })

  it('retains canonical text and image blocks in the prepared provider request and returned transcript', async () => {
    const registry = new ModelProviderRegistry()
    const captured: unknown[] = []
    registry.register(route, { providerId: 'fake', stream: (call) => {
      captured.push(call.request.messages)
      return stream({ type: 'text-delta', text: 'I see the image' }, { type: 'usage', inputTokens: 2, outputTokens: 3 }, { type: 'finish', reason: 'stop' })
    } })
    const imageMessage = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Describe this picture' },
        { type: 'image' as const, mimeType: 'image/png' as const, data: 'aGVsbG8=' }
      ]
    }
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [imageMessage], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1
    })
    expect(captured[0]).toEqual([imageMessage])
    expect(result.messages[0]).toEqual(imageMessage)
  })

  it('confirms an ask, rebuilds the binding, rechecks policy, and dispatches only a recheck permit', async () => {
    const registry = new ModelProviderRegistry()
    const providerRequests: Array<readonly unknown[]> = []
    const streams = [
      stream({ type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: { query: 'weather' } }, { type: 'usage', inputTokens: 2, outputTokens: 3 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'Sunny' }, { type: 'usage', inputTokens: 4, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    registry.register(route, { providerId: 'fake', stream: (call) => { providerRequests.push(call.request.messages); return streams.shift()! } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    const approvalContext = { facts: { summary: 'safe read', targets: ['/workspace/a.txt'] }, approvedFactIds: [{ factId: 'fact-file' }] }
    const decisions = [
      { kind: 'ask' as const, confirmationId: 'confirm-1', answerer: 'user' as const, reasonCode: 'needs-confirmation', context: approvalContext },
      { kind: 'allow' as const, authorizationVersion: 'auth-v1' }
    ]
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => decisions.shift()! } })
    const events: string[] = []
    const execution = createPermitBoundToolExecutionPort({
      permits,
      admission: new InMemoryExecutionAdmissionCoordinator(),
      allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (_call, signal) => { events.push(`execute:${!signal.aborted}`); return { output: { storedFact: 'structured result' }, replayContent: 'tool result', auditRef: 'audit:approval-1' } }
    })

    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', turnId: 'turn', history,
      request: { messages: [{ role: 'user', content: 'weather?' }], maxTokens: 100 },
      safetyGate,
      prepareTool: async (_call, stage) => {
        events.push(`prepare:${stage.kind}`)
        return { ...toolBinding, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }
      },
      confirmation: async (call: { confirmationId: string; context?: unknown }) => { events.push(`confirm:${call.confirmationId}`); expect(call.context).toEqual(approvalContext); expect(call.context).not.toBe(approvalContext); return { kind: 'approved' as const, receipt: 'host-confirmation-receipt', answerer: 'user' as const, cause: 'user-approved' } },
      sessionLedgerForToolResult: (_call, result) => ({ location: { workDir: '/workspace', sessionId: 's', createdAt: 1 }, result: { auditRef: result.auditRef } }),
      toolExecution: execution,
      maxModelTurns: 3
    })

    expect(events).toEqual(['prepare:initial', 'confirm:confirm-1', 'prepare:recheck', 'execute:true'])
    expect(result.text).toBe('Sunny')
    const committedEvents = (await history.read('inv')).events
    expect(committedEvents.map(({ kind }) => kind)).toEqual([
      'invocation-context-committed', 'model-request-started', 'model-response-committed', 'approval-waiting', 'approval-resolved', 'tool-call-started', 'tool-call-finished', 'model-request-started', 'model-response-committed', 'invocation-completed'
    ])
    expect(committedEvents.find(({ kind }) => kind === 'approval-waiting')?.payload).toMatchObject({
      toolCallId: 'tc1', approvalId: 'confirm-1', answerer: 'user', reasonCode: 'needs-confirmation', requestedAt: expect.any(Number)
    })
    expect(committedEvents.find(({ kind }) => kind === 'approval-resolved')?.payload).toMatchObject({
      toolCallId: 'tc1', approved: true, outcome: 'approved', answerer: 'user', cause: 'user-approved', settledAt: expect.any(Number)
    })
    expect(committedEvents.find(({ kind }) => kind === 'tool-call-finished')?.payload).toMatchObject({
      toolCallId: 'tc1', result: { storedFact: 'structured result' }, replayContent: 'tool result', isError: false, auditRef: 'audit:approval-1',
      sessionLedger: { result: { auditRef: 'audit:approval-1' } }
    })
    expect(providerRequests[1]?.find((message) => (message as { role?: string }).role === 'tool')).toMatchObject({
      role: 'tool', toolCallId: 'tc1', content: 'tool result', isError: false
    })
  })

  it('keeps at most two write approval candidates scheduled until their tool nodes finish', async () => {
    const registry = new ModelProviderRegistry()
    const ids = ['write-1', 'write-2', 'write-3']
    let modelTurn = 0
    registry.register(route, { providerId: 'fake', stream: () => {
      modelTurn += 1
      return modelTurn === 1
        ? stream(...ids.map((id) => ({ type: 'tool-call' as const, toolCallId: id, toolName: 'custom_write', input: { path: `${id}.txt`, content: 'x' } })), { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' })
        : stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['custom_write'])
    const permits = new InMemorySafetyPermitStore()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => binding.phase === 'initial-compat'
      ? { kind: 'ask', confirmationId: binding.toolCallId, answerer: 'user', reasonCode: 'write-confirm', context: { facts: { actionClass: 'write' } } }
      : { kind: 'allow', authorizationVersion: binding.authorizationVersion } } })
    const releases = new Map<string, (value: { kind: 'approved'; receipt: string }) => void>()
    const executions = new Map<string, () => void>()
    const started: string[] = []
    const execute = vi.fn(async (call: { toolCallId: string }) => {
      await new Promise<void>((resolve) => executions.set(call.toolCallId, resolve))
      return { output: call.toolCallId }
    })
    const turnInput: Parameters<typeof runAgentTurn>[0] = {
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 100 }, safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' as const : 'recheck' as const }),
      confirmation: ({ call }) => new Promise((resolve) => { started.push(call.toolCallId); releases.set(call.toolCallId, resolve) }),
      toolExecution: toolExecutionPort(permits, async (call) => execute(call)),
      maxConcurrentTools: 3, maxModelTurns: 2,
      isApprovalCandidate: (call) => call.toolName === 'custom_write'
    }
    const running = runAgentTurn(turnInput)
    const waitForStarted = async (count: number) => {
      for (let attempt = 0; attempt < 50 && started.length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 0))
    }

    await waitForStarted(2)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toHaveLength(2)
    releases.get('write-1')?.({ kind: 'approved', receipt: 'receipt-1' })
    await waitForStarted(3)
    expect(started).toHaveLength(2)
    for (let attempt = 0; attempt < 50 && !executions.has('write-1'); attempt++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(executions.has('write-1'), `executor entry missing; started=${started.join(',')}; calls=${execute.mock.calls.length}`).toBe(true)
    executions.get('write-1')?.()
    await waitForStarted(3)
    expect(started).toHaveLength(3)
    releases.get('write-2')?.({ kind: 'approved', receipt: 'receipt-2' })
    releases.get('write-3')?.({ kind: 'approved', receipt: 'receipt-3' })
    for (let attempt = 0; attempt < 50 && !executions.has('write-2'); attempt++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(executions.has('write-2')).toBe(true)
    executions.get('write-2')?.()
    for (let attempt = 0; attempt < 50 && !executions.has('write-3'); attempt++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(executions.has('write-3')).toBe(true)
    executions.get('write-3')?.()
    await expect(running).resolves.toMatchObject({ text: 'done' })
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('does not dispatch when fresh policy denies after the user approved the initial ask', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: { query: 'weather' } },
      { type: 'usage', inputTokens: 2, outputTokens: 3 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    const decisions = [
      { kind: 'ask' as const, confirmationId: 'confirm-1', answerer: 'user' as const, reasonCode: 'needs-confirmation' },
      { kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }
    ]
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => decisions.shift()! } })
    const execute = vi.fn(async (_call: unknown, _signal: AbortSignal) => ({ output: 'must not run' }))
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', history, request: { messages: [], maxTokens: 10 }, safetyGate,
      prepareTool: async (_call, stage) => ({ ...toolBinding, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      confirmation: async () => ({ kind: 'approved', receipt: 'receipt-1' }),
      toolExecution: createPermitBoundToolExecutionPort({ permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
        resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
        execute: async (call, signal) => { execute(call, signal); return { output: 'must not run' } } }),
      maxModelTurns: 2
    })).rejects.toMatchObject({ code: 'TOOL_DENIED', reasonCode: 'POLICY_DENY' })
    expect(decisions).toHaveLength(0)
    expect(execute).not.toHaveBeenCalled()
    expect((await history.read('inv')).events.map(({ kind }) => kind)).toEqual([
      'invocation-context-committed', 'model-request-started', 'model-response-committed', 'approval-waiting', 'approval-resolved', 'tool-call-not-dispatched', 'invocation-failed'
    ])
    expect((await history.read('inv')).events.at(-1)?.payload).toEqual({
      status: 'denied', reason: 'POLICY_DENY', usage: { type: 'usage', inputTokens: 2, outputTokens: 3 }
    })
    expect(rebuildInvocationStates(await history.read('inv')).get('inv')).toMatchObject({ state: 'denied' })
  })

  it('rejects prepared binding drift before recheck policy or tool dispatch', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: { query: 'weather' } },
      { type: 'usage', inputTokens: 2, outputTokens: 3 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const evaluate = vi.fn(async () => ({ kind: 'allow' as const, authorizationVersion: 'auth-v1' }))
    const permits = new InMemorySafetyPermitStore()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate } })
    const execute = vi.fn(async (_call: unknown, _signal: AbortSignal) => ({ output: 'must not run' }))
    let prepareCount = 0
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10 }, safetyGate,
      prepareTool: async (_call, stage) => {
        prepareCount += 1
        return { ...toolBinding, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck', ...(stage.kind === 'recheck' ? { inputSnapshotHash: 'changed-input' } : {}) }
      },
      toolExecution: toolExecutionPort(permits, async (call, signal) => { execute(call, signal); return { output: 'must not run' } }),
      maxModelTurns: 2
    })).rejects.toMatchObject({ code: 'TOOL_DENIED', reasonCode: 'STALE_AUTHORIZATION' })
    expect(prepareCount).toBe(2)
    expect(evaluate).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
  })

  it('discards a freshly issued permit when cancellation wins during recheck', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: { query: 'weather' } },
      { type: 'usage', inputTokens: 2, outputTokens: 3 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const controller = new AbortController()
    const permits = new InMemorySafetyPermitStore()
    const settle = vi.spyOn(permits, 'settle')
    const history = new MemoryHistory()
    const issuePermit = permits.issue.bind(permits)
    vi.spyOn(permits, 'issue').mockImplementation((binding, expiresAt) => {
      const permitId = issuePermit(binding, expiresAt)
      if (binding.phase === 'recheck') controller.abort()
      return permitId
    })
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'allow', authorizationVersion: 'auth-v1' }) } })
    const execute = vi.fn(async (_call: unknown, _signal: AbortSignal) => ({ output: 'must not run' }))
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10, signal: controller.signal }, safetyGate,
      prepareTool: async (_call, stage) => ({ ...toolBinding, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, async (call, signal) => { execute(call, signal); return { output: 'must not run' } }),
      maxModelTurns: 2, history
    })).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
    expect(settle).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    const snapshot = await history.read('inv')
    expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'tc1', reason: 'REQUEST_CANCELLED' }) }))
    expect(snapshot.events.map(({ kind }) => kind)).not.toContain('tool-call-started')
    expect(rebuildInvocationStates(snapshot).get('inv')).toMatchObject({ state: 'cancelled' })
  })

  it('propagates cancellation after dispatch into the execution lease and settles the turn', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: { query: 'weather' } },
      { type: 'usage', inputTokens: 2, outputTokens: 3 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'allow', authorizationVersion: 'auth-v1' }) } })
    const controller = new AbortController()
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const toolExecution = createPermitBoundToolExecutionPort({
      permits, admission, allowedPhase: 'recheck',
      resolveExpected: async (call) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: 'recheck' }),
      execute: async (_call, signal) => {
        markEntered()
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('executor cancelled')), { once: true }))
      }
    })
    const history = new MemoryHistory()
    const turn = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10, signal: controller.signal }, safetyGate,
      prepareTool: async (_call, stage) => ({ ...toolBinding, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution, maxModelTurns: 2, history
    })
    await entered
    controller.abort()
    const outcome = await Promise.race([turn.then(() => 'completed', (error: unknown) => error), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 25))])
    expect(outcome).toMatchObject({ code: 'TOOL_EXECUTION_UNKNOWN_AFTER_DISPATCH' })
    expect(admission.activeLeaseCount('req')).toBe(0)
    expect([...admission.closedOutcomes.values()]).toEqual(['unknown-after-dispatch'])
    const interruptedSnapshot = await history.read('inv')
    expect(interruptedSnapshot.events.map(({ kind }) => kind)).toEqual(['invocation-context-committed', 'model-request-started', 'model-response-committed', 'tool-call-started', 'invocation-interrupted'])
    expect(rebuildInvocationStates(interruptedSnapshot).get('inv')).toMatchObject({ state: 'interrupted' })
  })

  it('fails closed and never executes when policy denies a tool', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: {} },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const gate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } })
    const executeTool = vi.fn()
    await expect(runAgentTurn({ registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10 }, safetyGate: gate,
      prepareTool: async () => toolBinding, toolExecution: toolExecutionPort(permits, executeTool), maxModelTurns: 2 })).rejects.toMatchObject({ code: 'TOOL_DENIED', reasonCode: 'POLICY_DENY' })
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('rejects duplicate tool call identities before preparing or executing either call', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'same', toolName: 'lookup', input: {} },
      { type: 'tool-call', toolCallId: 'same', toolName: 'lookup', input: {} },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const safetyGate = new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } })
    const prepareTool = vi.fn()
    await expect(runAgentTurn({ registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10 }, safetyGate,
      prepareTool, toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1 })).rejects.toThrow('empty or duplicate tool-call id')
    expect(prepareTool).not.toHaveBeenCalled()
  })

  it('does not dispatch a tool when no model turn remains to consume its result', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: {} },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const executeTool = vi.fn()
    const safetyGate = new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } })
    const history = new MemoryHistory()
    await expect(runAgentTurn({ registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10 }, safetyGate,
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), executeTool), maxModelTurns: 1, history })).rejects.toMatchObject({ code: 'MODEL_TURN_LIMIT' })
    expect(executeTool).not.toHaveBeenCalled()
    const events = (await history.read('inv')).events
    expect(events.filter(({ kind, payload }) => kind === 'tool-call-not-dispatched' && (payload as { toolCallId?: string }).toolCallId === 'tc1')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-failed', payload: { status: 'failed' } })
  })

  it('settles committed tool proposals and fails the invocation when turn-boundary planning throws', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-boundary-error', toolName: 'lookup', input: {} },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const history = new MemoryHistory()
    const permits = new InMemorySafetyPermitStore()
    const safetyGate = new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } })
    const executeTool = vi.fn()

    await expect(runAgentTurn({ registry, routeId: route.routeId, invocationId: 'inv-boundary-error', request: { messages: [], maxTokens: 10 }, safetyGate,
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(permits, executeTool), maxModelTurns: 2, history,
      turnBoundary: async () => { throw new Error('boundary failed') } })).rejects.toThrow('boundary failed')

    expect(executeTool).not.toHaveBeenCalled()
    const events = (await history.read('inv-boundary-error')).events
    expect(events.filter(({ kind, payload }) => kind === 'tool-call-not-dispatched' && (payload as { toolCallId?: string }).toolCallId === 'tc-boundary-error')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-failed', payload: { status: 'failed' } })
  })

  it('stops after cancellation during tool preparation before issuing or executing a permit', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'lookup', input: {} },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const controller = new AbortController()
    const evaluate = vi.fn(async () => ({ kind: 'allow' as const, authorizationVersion: 'auth-v1' }))
    const executeTool = vi.fn()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate } })
    const history = new MemoryHistory()
    await expect(runAgentTurn({ registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10, signal: controller.signal }, safetyGate,
      prepareTool: async () => { controller.abort(); return toolBinding }, toolExecution: toolExecutionPort(permits, executeTool), maxModelTurns: 2, history })).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
    expect(evaluate).not.toHaveBeenCalled()
    expect(executeTool).not.toHaveBeenCalled()
    const cancelledSnapshot = await history.read('inv')
    expect(cancelledSnapshot.events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'tc1', reason: 'REQUEST_CANCELLED' }) }))
    expect(cancelledSnapshot.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
    expect(rebuildInvocationStates(cancelledSnapshot).get('inv')).toMatchObject({ state: 'cancelled' })
  })

  it('does not issue or dispatch a recheck permit when cancellation wins during policy evaluation', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'tool-call', toolCallId: 'tc-policy-cancel', toolName: 'lookup', input: {} },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    ) })
    const controller = new AbortController()
    let releasePolicy!: () => void
    let markRecheckEntered!: () => void
    const recheckEntered = new Promise<void>((resolve) => { markRecheckEntered = resolve })
    const policyRelease = new Promise<void>((resolve) => { releasePolicy = resolve })
    const evaluate = vi.fn(async (binding: PermitBinding) => {
      if (binding.phase === 'recheck') {
        markRecheckEntered()
        await policyRelease
      }
      return { kind: 'allow' as const, authorizationVersion: binding.authorizationVersion }
    })
    const executeTool = vi.fn(async () => ({ output: 'must not execute' }))
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const issuePermit = vi.spyOn(permits, 'issue')
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate } })
    const turn = runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 10, signal: controller.signal }, safetyGate,
      prepareTool: async (call, stage) => ({ ...toolBinding, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, executeTool), maxModelTurns: 2
    })

    await recheckEntered
    controller.abort()
    releasePolicy()

    await expect(turn).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(issuePermit).not.toHaveBeenCalled()
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('preserves thinking text and signatures in assistant history without mixing them into the user-visible answer', async () => {
    const registry = new ModelProviderRegistry()
    const captured: unknown[] = []
    const rounds = [
      stream(
        { type: 'thinking-delta', text: 'reasoning' },
        { type: 'thinking-signature', signature: 'sig-123' },
        { type: 'tool-call', toolCallId: 'tc-thinking', toolName: 'lookup', input: { q: 'x' } },
        { type: 'usage', inputTokens: 2, outputTokens: 1 },
        { type: 'finish', reason: 'tool-calls' }
      ),
      stream(
        { type: 'text-delta', text: 'answer' },
        { type: 'usage', inputTokens: 3, outputTokens: 1 },
        { type: 'finish', reason: 'stop' }
      )
    ]
    registry.register(route, { providerId: 'fake', stream: (call) => { captured.push(call.request.messages); return rounds.shift()! } })
    const permits = new InMemorySafetyPermitStore()
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['lookup'])
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...toolBinding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: toolExecutionPort(permits, async () => ({ output: 'tool-result' })),
      maxModelTurns: 2
    })

    expect(result.text).toBe('answer')
    expect(result.messages[0]).toEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning', thinkingSignature: 'sig-123' }], toolCalls: [{ id: 'tc-thinking', name: 'lookup', input: { q: 'x' } }] })
    expect(captured[1]).toContainEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning', thinkingSignature: 'sig-123' }], toolCalls: [{ id: 'tc-thinking', name: 'lookup', input: { q: 'x' } }] })
  })

  it('does not retain thinking text when the provider marks its signature redacted', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: () => stream(
      { type: 'thinking-delta', text: 'private reasoning' },
      { type: 'thinking-signature', signature: 'opaque-digest', redacted: true },
      { type: 'text-delta', text: 'public answer' },
      { type: 'usage', inputTokens: 1, outputTokens: 2 },
      { type: 'finish', reason: 'stop' }
    ) })
    const result = await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv', request: { messages: [], maxTokens: 100 },
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) } }),
      prepareTool: vi.fn(), toolExecution: toolExecutionPort(new InMemorySafetyPermitStore(), vi.fn()), maxModelTurns: 1
    })

    expect(result.text).toBe('public answer')
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: [
      { type: 'thinking', thinking: '', thinkingSignature: 'opaque-digest', redacted: true },
      { type: 'text', text: 'public answer' }
    ] })
  })

  it('settles provider cancellation once and persists only usage actually observed before cancellation', async () => {
    for (const observedUsage of [undefined, { type: 'usage' as const, inputTokens: 0, outputTokens: 0 }]) {
      const invocationId = observedUsage ? 'cancel-with-real-zero-usage' : 'cancel-without-usage'
      const registry = new ModelProviderRegistry()
      const controller = new AbortController()
      const dispatch = vi.fn(async function* () {
        controller.abort()
        yield { type: 'tool-call' as const, toolCallId: 'cancelled-tool-proposal', toolName: 'lookup', input: { query: 'must not dispatch' } }
        if (observedUsage) yield observedUsage
        yield { type: 'finish' as const, reason: 'cancelled' as const }
      })
      registry.register(route, { providerId: 'cancel-provider', stream: dispatch })
      const history = new MemoryHistory()
      const recordProviderAttemptUsage = vi.fn()
      const sessionLedgerForAttemptUsage = vi.fn(() => ({ location: { sessionId: invocationId } }))
      const recoverProviderAttempt = vi.fn(async () => undefined)
      const executeTool = vi.fn(async () => ({ output: 'must not execute' }))
      const permits = new InMemorySafetyPermitStore()
      const capabilities = new CapabilityRegistry()
      capabilities.define(invocationId, ['lookup'])
      const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion }) } })

      await expect(runAgentTurn({
        registry, routeId: route.routeId, invocationId, turnId: `${invocationId}-turn`,
        request: { messages: [{ role: 'user', content: 'lookup this' }], maxTokens: 20, signal: controller.signal },
        history, safetyGate,
        prepareTool: vi.fn(async () => toolBinding),
        toolExecution: toolExecutionPort(permits, executeTool),
        recordProviderAttemptUsage, sessionLedgerForAttemptUsage, recoverProviderAttempt,
        maxModelTurns: 2
      })).rejects.toMatchObject({ code: 'TURN_CANCELLED' })

      expect(dispatch).toHaveBeenCalledOnce()
      expect(recoverProviderAttempt).not.toHaveBeenCalled()
      expect(recordProviderAttemptUsage).toHaveBeenCalledTimes(observedUsage ? 1 : 0)
      expect(sessionLedgerForAttemptUsage).toHaveBeenCalledTimes(observedUsage ? 1 : 0)
      expect(executeTool).not.toHaveBeenCalled()
      const terminalEvents = (await history.read(invocationId)).events.filter((event) =>
        ['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(event.kind)
      )
      expect(terminalEvents).toHaveLength(1)
      expect(terminalEvents[0]).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
      if (observedUsage) {
        expect(recordProviderAttemptUsage).toHaveBeenCalledWith(expect.objectContaining({
          invocationId, modelTurn: 1, attempt: 1, usage: { type: 'usage', inputTokens: 0, outputTokens: 0 }, finishReason: 'cancelled'
        }))
        expect(terminalEvents[0]?.payload).toMatchObject({ usage: observedUsage })
      } else {
        expect(terminalEvents[0]?.payload).not.toHaveProperty('usage')
      }
    }

    const invocationId = 'cancel-before-provider-dispatch'
    const controller = new AbortController()
    controller.abort()
    const registry = new ModelProviderRegistry()
    const dispatch = vi.fn(async function* () {
      yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish' as const, reason: 'stop' as const }
    })
    registry.register(route, { providerId: 'pre-cancel-provider', stream: dispatch })
    const history = new MemoryHistory()
    const recordProviderAttemptUsage = vi.fn()
    const sessionLedgerForAttemptUsage = vi.fn()
    const permits = new InMemorySafetyPermitStore()
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId,
      request: { messages: [{ role: 'user', content: 'already cancelled' }], maxTokens: 10, signal: controller.signal },
      history,
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: vi.fn(async () => toolBinding), toolExecution: toolExecutionPort(permits, vi.fn()),
      recordProviderAttemptUsage, sessionLedgerForAttemptUsage, maxModelTurns: 1
    })).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(recordProviderAttemptUsage).not.toHaveBeenCalled()
    expect(sessionLedgerForAttemptUsage).not.toHaveBeenCalled()
    expect((await history.read(invocationId)).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
  })

  it('does not recover an iterator error that races after abort, while un-aborted network errors still fail', async () => {
    for (const aborted of [true, false]) {
      const invocationId = aborted ? 'iterator-error-after-abort' : 'iterator-error-without-abort'
      const registry = new ModelProviderRegistry()
      const controller = new AbortController()
      const dispatch = vi.fn(async function* () {
        if (aborted) controller.abort()
        throw new Error('network reset')
      })
      registry.register(route, { providerId: 'throwing-provider', stream: dispatch })
      const history = new MemoryHistory()
      const recoverProviderAttempt = vi.fn(async () => undefined)
      const permits = new InMemorySafetyPermitStore()
      const input = {
        registry, routeId: route.routeId, invocationId,
        request: { messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 20, signal: controller.signal },
        history, safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
        prepareTool: vi.fn(async () => toolBinding),
        toolExecution: toolExecutionPort(permits, vi.fn(async () => ({ output: 'unused' }))),
        recoverProviderAttempt, maxModelTurns: 1
      }

      if (aborted) await expect(runAgentTurn(input)).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
      else await expect(runAgentTurn(input)).rejects.toThrow('network reset')

      expect(dispatch).toHaveBeenCalledOnce()
      expect(recoverProviderAttempt).toHaveBeenCalledTimes(aborted ? 0 : 1)
      const events = (await history.read(invocationId)).events
      expect(events.filter((event) => ['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(event.kind))).toHaveLength(1)
      expect(events.at(-1)).toMatchObject(aborted
        ? { kind: 'invocation-interrupted', payload: { status: 'cancelled' } }
        : { kind: 'invocation-failed', payload: { status: 'failed' } })
    }
  })

  it('cancels only turn A when different sessions share requestId and keeps B confirmation, tool, and History alive', async () => {
    const sharedRequestId = 'shared-cross-session-request'
    const sessionA = { sessionId: 'session-a', invocationId: 'invocation-a', turnId: 'turn-a', userText: 'A' }
    const sessionB = { sessionId: 'session-b', invocationId: 'invocation-b', turnId: 'turn-b', userText: 'B' }
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId)
    expect(sessionA.turnId).not.toBe(sessionB.turnId)
    expect(sharedRequestId).toBe('shared-cross-session-request')
    const controllers = { A: new AbortController(), B: new AbortController() }
    const registries = new ModelProviderRegistry()
    const providerDispatches: string[] = []
    registries.register(route, { providerId: 'shared-request-provider', stream: async function* (call) {
      const owner = call.request.messages.find((message) => message.role === 'user')?.content
      const session = owner === 'A' ? sessionA : sessionB
      providerDispatches.push(session.turnId)
      const hasToolResult = call.request.messages.some((message) => message.role === 'tool')
      if (hasToolResult) {
        yield { type: 'text-delta' as const, text: `${session.userText} completed` }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'stop' as const }
      } else {
        yield { type: 'tool-call' as const, toolCallId: `tool-${session.userText}`, toolName: 'run_shell', input: { command: `echo ${session.userText}` } }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'tool-calls' as const }
      }
    } })
    const makeBinding = (session: typeof sessionA, toolCallId: string, phase: PermitBinding['phase']): PermitBinding => ({
      requestId: sharedRequestId, turnId: session.turnId, invocationId: session.invocationId,
      toolCallId, capabilityId: 'run_shell', inputSnapshotHash: `hash-${toolCallId}`,
      planDigest: `plan-${toolCallId}`, factsDigest: `facts-${toolCallId}`, authorizationVersion: 'auth-v1', phase
    })
    const histories = { A: new MemoryHistory(), B: new MemoryHistory() }
    const permits = { A: new InMemorySafetyPermitStore(), B: new InMemorySafetyPermitStore() }
    const executions = vi.fn(async (call: { invocationId: string }, signal: AbortSignal) => ({ output: `${call.invocationId}-tool-result` }))
    let enteredConfirmationCount = 0
    let markConfirmationsEntered!: () => void
    const confirmationsEntered = new Promise<void>((resolve) => { markConfirmationsEntered = resolve })
    let resolveBConfirmation!: (result: { kind: 'approved'; receipt: string; answerer: 'user' }) => void
    const confirmation = vi.fn(({ call, signal }: { call: { invocationId: string }; signal?: AbortSignal }) => {
      enteredConfirmationCount += 1
      if (enteredConfirmationCount === 2) markConfirmationsEntered()
      if (call.invocationId === sessionA.invocationId) {
        return new Promise<{ kind: 'cancelled' }>((resolve) => {
          signal?.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true })
        })
      }
      return new Promise<{ kind: 'approved'; receipt: string; answerer: 'user' }>((resolve) => { resolveBConfirmation = resolve })
    })
    const createTurn = (session: typeof sessionA, key: 'A' | 'B') => {
      const capabilityRegistry = new CapabilityRegistry()
      capabilityRegistry.define(session.invocationId, ['run_shell'])
      const permitsForTurn = permits[key]
      const safetyGate = new SafetyGate({
        capabilities: capabilityRegistry, permitStore: permitsForTurn,
        policy: { evaluate: async (binding) => binding.phase === 'initial-compat'
          ? { kind: 'ask' as const, confirmationId: `${session.turnId}-approval`, answerer: 'user' as const, reasonCode: 'shell-confirm' }
          : { kind: 'allow' as const, authorizationVersion: binding.authorizationVersion }
        }
      })
      const admission = new InMemoryExecutionAdmissionCoordinator()
      const toolExecution = createPermitBoundToolExecutionPort({
        permits: permitsForTurn, admission, allowedPhase: 'recheck',
        resolveExpected: async (call) => makeBinding(session, call.toolCallId, 'recheck'),
        execute: async (call, signal) => executions(call, signal)
      })
      return runAgentTurn({
        registry: registries, routeId: route.routeId, invocationId: session.invocationId, turnId: session.turnId,
        sessionId: session.sessionId,
        request: { messages: [{ role: 'user', content: session.userText }], maxTokens: 20, signal: controllers[key].signal },
        history: histories[key], safetyGate,
        prepareTool: async (call, stage) => makeBinding(session, call.toolCallId, stage.kind === 'initial' ? 'initial-compat' : 'recheck'),
        confirmation,
        toolExecution,
        maxModelTurns: 2,
        isApprovalCandidate: () => true
      })
    }

    const turnA = createTurn(sessionA, 'A')
    const turnB = createTurn(sessionB, 'B')
    await confirmationsEntered
    controllers.A.abort()
    await expect(turnA).rejects.toMatchObject({ code: 'TURN_CANCELLED' })

    expect(controllers.B.signal.aborted).toBe(false)
    expect(resolveBConfirmation).toBeTypeOf('function')
    expect(executions).not.toHaveBeenCalled()
    expect((await histories.B.read(sessionB.invocationId)).events.some((event) => event.kind === 'approval-resolved')).toBe(false)

    resolveBConfirmation({ kind: 'approved', receipt: 'turn-b-approved', answerer: 'user' })
    await expect(turnB).resolves.toMatchObject({ text: 'B completed' })
    expect(executions).toHaveBeenCalledOnce()
    expect(executions).toHaveBeenCalledWith(expect.objectContaining({ invocationId: sessionB.invocationId }), expect.objectContaining({ aborted: false }))
    expect(providerDispatches).toEqual(['turn-a', 'turn-b', 'turn-b'])
    expect((await histories.A.read(sessionA.invocationId)).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })
    expect((await histories.B.read(sessionB.invocationId)).events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
    expect((await histories.B.read(sessionB.invocationId)).events.find((event) => event.kind === 'approval-resolved')).toMatchObject({
      kind: 'approval-resolved', payload: { toolCallId: 'tool-B', approved: true, outcome: 'approved' }
    })
  })
})
