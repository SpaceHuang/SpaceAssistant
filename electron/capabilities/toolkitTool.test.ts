import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { CapabilityDescriptor } from './types'
import { CapabilityRegistry } from './registry'
import { createToolkitFindExecutor, createToolkitCallExecutor, buildCapabilityContext } from './toolkitTool'
import { createToolkitCallTool, createToolkitFindTool } from './toolkitTool'
import { executeRegisteredTool } from '../tools/toolInvocationCoordinator'
import type { ToolExecutorResult } from '../tools/types'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { CapabilityRegistry as AgentCapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { TypedToolRegistry } from '../tools/plannedToolRegistry'
import { createRegisteredAgentTurnTools } from '../tools/registeredAgentTurnTools'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'

function desc(overrides: Partial<CapabilityDescriptor> & { id: string; summary: string }): CapabilityDescriptor {
  return {
    family: 'env',
    keywords: [],
    paramsSchema: z.object({}).passthrough(),
    paramsDoc: '{ "id": "env.x" }；无参数',
    returnsDoc: '{ os: string }',
    risk: 'read',
    handler: async () => ({}),
    ...overrides
  }
}

const registry = new CapabilityRegistry()
registry.register(desc({ id: 'env.system', summary: '获取操作系统信息', keywords: ['系统', 'os'], notes: ['结果缓存 10 分钟'] }))
registry.register(
  desc({
    id: 'action.mcp.add',
    summary: '添加 MCP 连接',
    keywords: ['mcp'],
    family: 'action',
    risk: 'act',
    paramsDoc: '{ "name": "string", "transport": "http" }'
  })
)

const findExecutor = createToolkitFindExecutor(registry)
const callExecutor = createToolkitCallExecutor(registry)

describe('toolkit.find 执行器', () => {
  it('命中时返回 matches（usage 由 paramsDoc 生成）与调用提示', async () => {
    const result = await findExecutor({ query: 'env.system' })
    expect(result.success).toBe(true)
    const data = result.data as { ok: boolean; matches: Array<{ id: string; usage: string; risk: string; notes: string[] }>; hint: string }
    expect(data.ok).toBe(true)
    expect(data.matches).toHaveLength(1)
    expect(data.matches[0]!.id).toBe('env.system')
    expect(data.matches[0]!.usage).toContain('toolkit.call 入参')
    expect(data.matches[0]!.risk).toBe('read')
    expect(data.matches[0]!.notes).toEqual(['结果缓存 10 分钟'])
    expect(data.hint).toContain('toolkit.call')
  })

  it('未命中时返回全量紧凑索引与重查提示', async () => {
    const result = await findExecutor({ query: '完全无关 quantum' })
    const data = result.data as { ok: boolean; matches: unknown[]; index: Array<{ id: string; summary: string }>; hint: string }
    expect(data.ok).toBe(true)
    expect(data.matches).toHaveLength(0)
    expect(data.index).toHaveLength(2)
    expect(data.hint).toContain('toolkit.find')
  })

  it('拒绝能力索引变化后的 toolkit.find 旧结果快照', async () => {
    const localRegistry = new CapabilityRegistry()
    localRegistry.register(desc({ id: 'env.snapshot-one', summary: 'snapshot one', keywords: ['needle'] }))
    const tool = createToolkitFindTool(localRegistry)
    const signal = new AbortController().signal
    const runtimeContext = {
      workDir: '/work', userDataDir: '/data', requestId: 'toolkit-find-snapshot-request', toolUseId: 'toolkit-find-snapshot-call',
      sessionId: 's1', sendProgress: () => undefined, signal, fileStateCache: new Map(), toolsConfig: {}, lane: 'desktop'
    }
    const handle = await tool.begin({ query: 'needle' }, {
      requestId: 'toolkit-find-snapshot-request', toolUseId: 'toolkit-find-snapshot-call', executionContext: runtimeContext as never
    })
    handle.awaitConfirmation()
    handle.confirm()
    handle.beginValidation()
    localRegistry.register(desc({ id: 'env.snapshot-two', summary: 'snapshot two', keywords: ['needle'] }))

    await expect(handle.validatePrepared({
      requestId: 'toolkit-find-snapshot-request', toolUseId: 'toolkit-find-snapshot-call', toolName: tool.name,
      runtimeContext: runtimeContext as never, signal
    })).rejects.toThrow('SNAPSHOT_READ_RESULT_CHANGED')
    handle.fail()
    handle.release()
  })

  it('family 过滤生效', async () => {
    const result = await findExecutor({ query: 'mcp', family: 'action' })
    const data = result.data as { matches: Array<{ id: string }> }
    expect(data.matches[0]!.id).toBe('action.mcp.add')
  })

  it('query 缺失返回失败结果', async () => {
    const result = await findExecutor({})
    expect(result.success).toBe(false)
  })
})

describe('toolkit.call 执行器', () => {
  const runtimeContext = {
    workDir: '/work',
    userDataDir: '/user',
    sessionId: 's1',
    requestId: 'r1',
    signal: new AbortController().signal
  } as unknown as import('../tools/types').ToolExecutionContext

  it('调用具体能力并封装结果', async () => {
    const localRegistry = new CapabilityRegistry()
    localRegistry.register(desc({ id: 'env.echo', summary: '回显', handler: async () => ({ got: true }) }))
    const executor = createToolkitCallExecutor(localRegistry)
    const result = await executor({ id: 'env.echo', params: {} }, runtimeContext)
    expect(result.success).toBe(true)
    const data = result.data as { ok: boolean; id: string }
    expect(data.ok).toBe(true)
    expect(data.id).toBe('env.echo')
  })

  it('未知能力返回结构化错误（含索引兜底）', async () => {
    const result = await callExecutor({ id: 'env.nope', params: {} }, runtimeContext)
    // 评审建议 11：业务失败以 success:false 回报（UI 显示失败），data 保留结构化结论供模型自纠
    expect(result.success).toBe(false)
    expect(result.error).toContain('未知能力')
    const data = result.data as { ok: boolean; error: { code: string; index: unknown[] } }
    expect(data.ok).toBe(false)
    expect(data.error.code).toBe('unknown-capability')
    expect(data.error.index).toHaveLength(2)
  })

  it('缺少运行时上下文返回失败', async () => {
    const result = await callExecutor({ id: 'env.system', params: {} })
    expect(result.success).toBe(false)
  })
})

describe('toolkit prepared registrations', () => {
  it('toolkit.find and toolkit.call are planned registrations', () => {
    expect(createToolkitFindTool(registry).kind).toBe('planned')
    expect(createToolkitCallTool(registry).kind).toBe('planned')
  })

  it('caller context drift after confirmation blocks handler dispatch', async () => {
    const localRegistry = new CapabilityRegistry()
    const handler = vi.fn(async () => ({ changed: false }))
    const descriptor = desc({ id: 'env.bound', summary: 'bound', handler })
    localRegistry.register(descriptor)
    const runtime = {
      workDir: '/work', userDataDir: '/user', requestId: 'r1', toolUseId: 'u1', sessionId: 's1',
      sendProgress: () => undefined, signal: new AbortController().signal,
      fileStateCache: new Map(), toolsConfig: {} as never, lane: 'desktop'
    } as unknown as import('../tools/types').ToolExecutionContext
    await expect(executeRegisteredTool(createToolkitCallTool(localRegistry), { id: 'env.bound', params: {} }, {
      requestId: 'r1', toolUseId: 'u1', signal: runtime.signal, executionContext: runtime
    }, {
      confirm: async () => { runtime.lane = 'wechat'; return true },
      dispatch: async (_handle, _context, execute) => execute(new AbortController().signal)
    })).rejects.toThrow('TOOLKIT_CALL_PREPARED_CAPABILITY_CHANGED')
    expect(handler).not.toHaveBeenCalled()
  })

  it('stable capability executes once with the confirmed runtime context', async () => {
    const localRegistry = new CapabilityRegistry()
    const handler = vi.fn(async (_params, context) => ({ confirmed: context.confirmedByUser === true }))
    localRegistry.register(desc({ id: 'env.bound', summary: 'bound', handler }))
    const runtime = {
      workDir: '/work', userDataDir: '/user', requestId: 'r1', toolUseId: 'u1', sessionId: 's1',
      sendProgress: () => undefined, signal: new AbortController().signal,
      fileStateCache: new Map(), toolsConfig: {} as never, lane: 'desktop', toolUserConfirmed: true
    } as unknown as import('../tools/types').ToolExecutionContext
    await expect(executeRegisteredTool(createToolkitCallTool(localRegistry), { id: 'env.bound', params: {} }, {
      requestId: 'r1', toolUseId: 'u1', signal: runtime.signal, executionContext: runtime
    }, {
      confirm: async () => true,
      dispatch: async (_handle, _context, execute) => execute(new AbortController().signal)
    })).resolves.toMatchObject({ success: true, data: { ok: true, data: { confirmed: true } } })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('permits the confirmed runtime flag to transition from false to true after approval', async () => {
    const localRegistry = new CapabilityRegistry()
    const handler = vi.fn(async (_params, context) => ({ confirmed: context.confirmedByUser === true }))
    localRegistry.register(desc({ id: 'action.confirmed-context', family: 'action', risk: 'act', summary: 'confirmed action', handler }))
    const runtime = {
      workDir: '/work', userDataDir: '/user', requestId: 'r-confirmed', toolUseId: 'u-confirmed', sessionId: 's-confirmed',
      sendProgress: () => undefined, signal: new AbortController().signal,
      fileStateCache: new Map(), toolsConfig: {} as never, lane: 'desktop', toolUserConfirmed: false
    } as unknown as import('../tools/types').ToolExecutionContext
    await expect(executeRegisteredTool(createToolkitCallTool(localRegistry), { id: 'action.confirmed-context', params: {} }, {
      requestId: 'r-confirmed', toolUseId: 'u-confirmed', signal: runtime.signal, executionContext: runtime
    }, {
      confirm: async () => { runtime.toolUserConfirmed = true; return true },
      dispatch: async (_handle, _context, execute) => execute(new AbortController().signal)
    })).resolves.toMatchObject({ success: true, data: { ok: true, data: { confirmed: true } } })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('Hosted toolkit.call 执行中撤权时把后台副作用记为 unknown-after-dispatch 且不请求下一轮模型', async () => {
    const capabilityRegistry = new CapabilityRegistry()
    let enteredHandler!: () => void
    let releaseHandler!: () => void
    const atHandler = new Promise<void>((resolve) => { enteredHandler = resolve })
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve })
    let sideEffectCompleted = false
    capabilityRegistry.register(desc({
      id: 'action.delayed-side-effect', summary: 'delayed action', family: 'action', risk: 'read',
      handler: async () => { enteredHandler(); await handlerGate; sideEffectCompleted = true; return { completed: true } }
    }))
    const typed = new TypedToolRegistry()
    typed.register(createToolkitCallTool(capabilityRegistry))
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('toolkit-revoke-request', 'desktop')
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const tools = createRegisteredAgentTurnTools({
      requestId: 'toolkit-revoke-request', turnId: 'toolkit-revoke-turn', registry: typed, permits, admission,
      toolRevocations: revocations,
      createExecutionContext: () => ({
        workDir: '/work', userDataDir: '/user', sessionId: 'session', requestId: 'toolkit-revoke-request',
        sendProgress: () => undefined, signal: new AbortController().signal, fileStateCache: new Map(),
        toolsConfig: {} as never, lane: 'desktop'
      }),
      resolveAuthorizationVersion: () => 'toolkit-policy-v1'
    })
    const permitsForTurn = new AgentCapabilityRegistry()
    permitsForTurn.define('toolkit-revoke-invocation', ['toolkit.call'])
    const safetyGate = new SafetyGate({ capabilities: permitsForTurn, permitStore: permits, policy: {
      evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'toolkit-policy-v1' })
    } })
    const route = { routeId: 'toolkit-revoke-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const providers = new ModelProviderRegistry()
    async function* chunks(...values: StreamChunk[]) { yield* values }
    let providerCalls = 0
    providers.register(route, { providerId: 'toolkit-revoke-test', stream: () => {
      providerCalls += 1
      return chunks({ type: 'tool-call', toolCallId: 'toolkit-revoke-call', toolName: 'toolkit.call', input: { id: 'action.delayed-side-effect', params: {} } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' })
    } })
    const history = new MemoryHistory()
    const turn = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId: 'toolkit-revoke-invocation', turnId: 'toolkit-revoke-turn',
      request: { messages: [{ role: 'user', content: 'run the delayed action' }], maxTokens: 80, tools: [{ name: 'toolkit.call', description: 'call capability', inputSchema: { type: 'object' } }] },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    try {
      await atHandler
      expect(revocations.revokeToolForLane('desktop', 'toolkit.call')).toBe(1)
      await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
      const events = (await history.read('toolkit-revoke-invocation')).events
      expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
      expect(providerCalls).toBe(1)
      expect(sideEffectCompleted).toBe(false)
      releaseHandler()
      await vi.waitFor(() => expect(sideEffectCompleted).toBe(true))
      expect(admission.activeLeaseCount('toolkit-revoke-request')).toBe(0)
    } finally {
      releaseHandler()
    }
  })
})

describe('buildCapabilityContext 适配（评审 S2）', () => {
  it('透传 requestLocale 与 lane 到能力上下文', () => {
    const ctx = buildCapabilityContext({
      workDir: '/w',
      userDataDir: '/u',
      sessionId: 's1',
      requestId: 'r1',
      signal: new AbortController().signal,
      requestLocale: 'zh-CN',
      lane: 'desktop'
    } as unknown as import('../tools/types').ToolExecutionContext)
    expect(ctx.locale).toBe('zh-CN')
    expect(ctx.lane).toBe('desktop')
  })
})
