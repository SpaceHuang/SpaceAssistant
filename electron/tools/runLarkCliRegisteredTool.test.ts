import { describe, expect, it, vi } from 'vitest'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { createRunLarkCliRegisteredTool } from './runLarkCliRegisteredTool'
import { runLarkCliExecutor } from './runLarkCliExecutor'
import type { ToolExecutionContext } from './types'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { createPermitBoundCoordinatorDispatch } from './permitBoundCoordinatorDispatch'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { TypedToolRegistry } from './plannedToolRegistry'
import { createRegisteredAgentTurnTools } from './registeredAgentTurnTools'

function setup() {
  let executable = '/approved/lark-cli'
  const run = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }))
  const context: ToolExecutionContext = {
    workDir: '/workspace', userDataDir: '/data', requestId: 'r', toolUseId: 'u', sessionId: 's',
    sendProgress: () => undefined, signal: new AbortController().signal,
    fileStateCache: new Map() as never, toolsConfig: {} as never,
    feishuConfig: { cliPath: '/configured/lark-cli', larkCliDefaultTimeoutSec: 45, larkCliWriteRequiresConfirm: true } as never,
    lane: 'feishu',
    remoteContext: { source: 'feishu', messageId: 'm1', confirmPolicy: {} as never, authOwner: 'owner', authorizationGeneration: 7 },
    larkCliRunner: { resolveExecutable: () => executable, run } as never
  }
  return { context, run, setExecutable: (next: string) => { executable = next } }
}

describe('run_lark_cli planned registration', () => {
  it('确认期间 executable 漂移会在 dispatch 前拒绝', async () => {
    const { context, run, setExecutable } = setup()
    let dispatched = false
    await expect(executeRegisteredTool(createRunLarkCliRegisteredTool(runLarkCliExecutor), { args: ['doc', 'get'] }, {
      requestId: 'r', toolUseId: 'u', signal: context.signal, executionContext: context
    }, {
      confirm: async () => { setExecutable('/changed/lark-cli'); return true },
      dispatch: async (_handle, _context, execute) => { dispatched = true; return execute(new AbortController().signal) }
    })).rejects.toThrow('LARK_CLI_PREPARED_AUTHORIZATION_CHANGED')
    expect(dispatched).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('使用计划冻结的 executable、规范化 argv 与有效 timeout 执行', async () => {
    const { context, run } = setup()
    await expect(executeRegisteredTool(createRunLarkCliRegisteredTool(runLarkCliExecutor), { args: ['doc', 'get'] }, {
      requestId: 'r', toolUseId: 'u', signal: context.signal, executionContext: context
    }, {
      confirm: async () => true,
      dispatch: async (_handle, _context, execute) => execute(new AbortController().signal)
    })).resolves.toMatchObject({ success: true })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      args: ['doc', 'get'], resolvedExecutable: '/approved/lark-cli', timeoutSec: 45
    }))
  })

  it('Feishu run_lark_cli 在 permit 已消费但 claim 等待时撤权，不进入 CLI runner', async () => {
    const { context, run } = setup()
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('r', 'feishu')
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const barrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (permitId: string, binding: Parameters<typeof ledger.markPermitConsumed>[1]) => ledger.markPermitConsumed(permitId, binding),
      beginDispatch: async (...args: Parameters<typeof ledger.beginDispatch>) => {
        reachedClaim()
        await barrier
        return ledger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (permitId: string) => ledger.settle(permitId)
    }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'r', turnId: 'turn', canonicalInput: { args: ['doc', 'get'] },
      authorizationVersion: 'rule-v1', targetVersion: 'feishu-cli-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !revocations.isToolRevoked('r', 'run_lark_cli'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'feishu-cli-v1', factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) },
      toolRevocations: revocations, admission
    })
    const result = executeRegisteredTool(createRunLarkCliRegisteredTool(runLarkCliExecutor), { args: ['doc', 'get'] }, {
      requestId: 'r', toolUseId: 'u', signal: context.signal, executionContext: context
    }, { confirm: async () => true, dispatch })

    await atClaim
    expect(run).not.toHaveBeenCalled()
    expect(revocations.revokeToolForLane('feishu', 'run_lark_cli')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(run).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('r')).toBe(0)
  })

  it('Feishu run_lark_cli claim 后撤权会向运行中的 CLI 发送取消并释放 lease', async () => {
    const { context, run } = setup()
    let observedSignal: AbortSignal | undefined
    let enteredRunner!: () => void
    const atRunner = new Promise<void>((resolve) => { enteredRunner = resolve })
    let finishRunner!: (value: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }) => void
    const runnerResult = new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => { finishRunner = resolve })
    run.mockImplementation(async (options: { signal?: AbortSignal }) => {
      observedSignal = options.signal
      enteredRunner()
      return runnerResult
    })
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('r', 'feishu')
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'r', turnId: 'turn', canonicalInput: { args: ['doc', 'get'] },
      authorizationVersion: 'rule-v1', targetVersion: 'feishu-cli-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !revocations.isToolRevoked('r', 'run_lark_cli'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'feishu-cli-v1', factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) },
      toolRevocations: revocations, admission: ledger
    })
    const result = executeRegisteredTool(createRunLarkCliRegisteredTool(runLarkCliExecutor), { args: ['doc', 'get'] }, {
      requestId: 'r', toolUseId: 'u', signal: context.signal, executionContext: context
    }, { confirm: async () => true, dispatch })

    await atRunner
    expect(observedSignal?.aborted).toBe(false)
    expect(revocations.revokeToolForLane('feishu', 'run_lark_cli')).toBe(1)
    expect(observedSignal?.aborted).toBe(true)
    finishRunner({ exitCode: 143, stdout: '', stderr: 'terminated', timedOut: false })
    await expect(result).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    expect(ledger.activeLeaseCount('r')).toBe(0)
  })

  it('Hosted Feishu SDK turn 在 claim 前撤权时不调用生产 RegisteredTool executor', async () => {
    const { context, run } = setup()
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('r', 'feishu')
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const barrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (permitId: string, binding: Parameters<typeof ledger.markPermitConsumed>[1]) => ledger.markPermitConsumed(permitId, binding),
      beginDispatch: async (...args: Parameters<typeof ledger.beginDispatch>) => {
        reachedClaim()
        await barrier
        return ledger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (permitId: string) => ledger.settle(permitId),
      activeLeaseCount: (requestId: string) => ledger.activeLeaseCount(requestId)
    }
    const registered = createRunLarkCliRegisteredTool(runLarkCliExecutor)
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(registered)
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId: 'r', turnId: 'turn', registry: toolRegistry, permits, admission,
      toolRevocations: revocations,
      createExecutionContext: () => ({ runtimeContext: context }),
      resolveAuthorizationVersion: () => 'rule-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-feishu', ['run_lark_cli'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' })
    } })
    const providers = new ModelProviderRegistry()
    const route = { routeId: 'feishu-hosted-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    async function* chunks(...values: StreamChunk[]) { yield* values }
    const responses = [
      chunks({ type: 'tool-call', toolCallId: 'lark-hosted-call', toolName: 'run_lark_cli', input: { args: ['doc', 'get'] } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      chunks({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let providerCalls = 0
    providers.register(route, { providerId: 'feishu-hosted-fake', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()
    const turn = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId: 'inv-feishu', turnId: 'turn',
      request: { messages: [{ role: 'user', content: 'read the Feishu doc' }], maxTokens: 100, tools: [{ name: 'run_lark_cli', description: 'run Feishu CLI', inputSchema: { type: 'object' } }] },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await atClaim
    expect(run).not.toHaveBeenCalled()
    expect(revocations.revokeToolForLane('feishu', 'run_lark_cli')).toBe(1)
    releaseClaim()
    await expect(turn).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount('r')).toBe(0)
    expect((await history.read('inv-feishu')).events).toContainEqual(expect.objectContaining({ kind: 'invocation-failed' }))
  })

  it.each(['revoke', 'cancel'] as const)('Hosted Feishu SDK turn 在 CLI 已启动后%s时以 unknown-after-dispatch 收尾', async (invalidation) => {
    const { context, run } = setup()
    let observedSignal: AbortSignal | undefined
    let enteredRunner!: () => void
    const atRunner = new Promise<void>((resolve) => { enteredRunner = resolve })
    run.mockImplementation(async (options: { signal?: AbortSignal }) => {
      observedSignal = options.signal
      enteredRunner()
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { exitCode: 143, stdout: '', stderr: 'terminated', timedOut: false }
    })
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('r', 'feishu')
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const registered = createRunLarkCliRegisteredTool(runLarkCliExecutor)
    const registry = new TypedToolRegistry()
    registry.register(registered)
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId: 'r', turnId: 'turn', registry, permits, admission,
      toolRevocations: {
        registerToolRevocationRequest: revocations.registerToolRevocationRequest.bind(revocations),
        revokeToolForLane: revocations.revokeToolForLane.bind(revocations),
        revokeToolForAllLanes: revocations.revokeToolForAllLanes.bind(revocations),
        isToolRevoked: revocations.isToolRevoked.bind(revocations),
        clearToolRevocationRequest: revocations.clearToolRevocationRequest.bind(revocations),
        onRevocation: revocations.onRevocation.bind(revocations),
        getRegisteredTool: (name) => registry.get(name)
      },
      createExecutionContext: () => context,
      resolveAuthorizationVersion: () => 'rule-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-feishu-claim-revoke', ['run_lark_cli'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' })
    } })
    const providers = new ModelProviderRegistry()
    const route = { routeId: 'feishu-hosted-claim-revoke', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    async function* chunks(...values: StreamChunk[]) { yield* values }
    const responses = [
      chunks({ type: 'tool-call', toolCallId: 'lark-hosted-claim-revoke', toolName: 'run_lark_cli', input: { args: ['doc', 'get'] } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      chunks({ type: 'text-delta', text: '飞书命令已取消。' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    let providerCalls = 0
    providers.register(route, { providerId: 'feishu-hosted-claim-revoke-fake', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()
    const controller = new AbortController()
    const running = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId: 'inv-feishu-claim-revoke', turnId: 'turn',
      request: { messages: [{ role: 'user', content: '读取飞书文档' }], maxTokens: 100, signal: controller.signal, tools: [{ name: 'run_lark_cli', description: 'run Feishu CLI', inputSchema: { type: 'object' } }] },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    const reachedOrFailed = await Promise.race([
      atRunner.then(() => undefined),
      running.then((result) => new Error(`Hosted turn completed before reaching the Feishu CLI runner: ${JSON.stringify(result)}`), (error: unknown) => error)
    ])
    if (reachedOrFailed instanceof Error) throw reachedOrFailed
    expect(observedSignal?.aborted).toBe(false)
    if (invalidation === 'revoke') {
      expect(revocations.revokeToolForLane('feishu', 'run_lark_cli')).toBe(1)
    } else {
      controller.abort()
    }
    expect(observedSignal?.aborted).toBe(true)
    await expect(running).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount('r')).toBe(0)
    const events = (await history.read('inv-feishu-claim-revoke')).events
    expect(events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: 'lark-hosted-claim-revoke' })
    expect(events.some((event) => event.kind === 'tool-call-finished')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
  })

  it('Hosted Feishu SDK turn 在 permit consume 后授权版本变化时不调用生产 RegisteredTool executor', async () => {
    const { context, run } = setup()
    let authorizationVersion = 'rule-v1'
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const barrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (permitId: string, binding: Parameters<typeof ledger.markPermitConsumed>[1]) => ledger.markPermitConsumed(permitId, binding),
      beginDispatch: async (...args: Parameters<typeof ledger.beginDispatch>) => {
        reachedClaim()
        await barrier
        return ledger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (permitId: string) => ledger.settle(permitId),
      activeLeaseCount: (requestId: string) => ledger.activeLeaseCount(requestId)
    }
    const registered = createRunLarkCliRegisteredTool(runLarkCliExecutor)
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(registered)
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId: 'r', turnId: 'turn', registry: toolRegistry, permits, admission,
      createExecutionContext: () => ({ runtimeContext: context }),
      resolveAuthorizationVersion: () => authorizationVersion
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-feishu-auth-change', ['run_lark_cli'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async () => ({ kind: 'allow' as const, authorizationVersion })
    } })
    const providers = new ModelProviderRegistry()
    const route = { routeId: 'feishu-auth-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    async function* chunks(...values: StreamChunk[]) { yield* values }
    const responses = [chunks(
      { type: 'tool-call', toolCallId: 'lark-auth-change', toolName: 'run_lark_cli', input: { args: ['doc', 'get'] } },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
    )]
    let providerCalls = 0
    providers.register(route, { providerId: 'feishu-auth-fake', stream: () => { providerCalls += 1; return responses.shift()! } })
    const history = new MemoryHistory()
    const turn = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId: 'inv-feishu-auth-change', turnId: 'turn',
      request: { messages: [{ role: 'user', content: 'read the Feishu doc' }], maxTokens: 100, tools: [{ name: 'run_lark_cli', description: 'run Feishu CLI', inputSchema: { type: 'object' } }] },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await atClaim
    expect(run).not.toHaveBeenCalled()
    authorizationVersion = 'rule-v2'
    releaseClaim()
    await expect(turn).rejects.toThrow('AUTHORIZATION_STALE')
    expect(run).not.toHaveBeenCalled()
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount('r')).toBe(0)
    expect((await history.read('inv-feishu-auth-change')).events).toContainEqual(expect.objectContaining({ kind: 'invocation-failed' }))
  })
})
