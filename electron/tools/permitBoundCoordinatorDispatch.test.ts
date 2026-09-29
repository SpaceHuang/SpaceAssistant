import { describe, expect, it, vi } from 'vitest'
import { definePlannedTool } from './plannedToolRegistry'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { createPermitBoundCoordinatorDispatch } from './permitBoundCoordinatorDispatch'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { ToolExecutionAfterDispatchError } from '../../packages/agent-sdk/src/toolExecutionPort'
import { createRegisteredMcpTool } from '../mcp/registeredMcpTool'
import { createBuiltinToolRegistry, editFileExecutor, runScriptExecutor, writeFileExecutor } from './builtinExecutors'
import { createReadRegisteredTools } from './readRegisteredTools'
import { buildReadExecutionPermit } from '../confirmation/readExecutionPermit'
import { createWeChatOutboundRegisteredTools } from './wechatOutboundRegisteredTools'
import { browserExecutor } from './browserExecutor'
import { DEFAULT_BROWSER_CONFIG } from '../../src/shared/domainTypes'
import { buildWriteExecutionPermit } from '../confirmation/writeExecutionPermit'

const allowPolicy = (authorizationVersion = 'rule-v1') => ({ evaluate: async () => ({ kind: 'allow' as const, authorizationVersion }) })

function setup() {
  const toolRevocations = new ToolRevocationRegistry()
  toolRevocations.registerToolRevocationRequest('req', 'desktop')
  const tool = definePlannedTool({
    name: 'lookup', parseInput: (raw) => raw as { query: string },
    plan: async (input) => ({ query: input.query }),
    execute: async (_plan, context) => { expect(context.signal.aborted).toBe(false); return 'result' }
  })
  const dispatch = createPermitBoundCoordinatorDispatch({
    requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
    authorizationVersion: 'rule-v1', targetVersion: 'target-v1',
    phase: 'recheck', initialFactsHash: 'facts-v1',
    recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
    safetyPolicy: allowPolicy(),
    isAllowed: () => !toolRevocations.isToolRevoked('req', 'lookup'), toolRevocations
  })
  return { tool, toolRevocations, dispatch }
}

function permittedWriteContext(input: Record<string, unknown>, toolUseId: string, signal: AbortSignal, toolName: 'write_file' | 'edit_file' = 'write_file') {
  const rawPath = String(input.path)
  return {
    requestId: 'req', toolUseId, signal, workDir: '/workspace',
    writeExecutionPermit: buildWriteExecutionPermit({
      requestId: 'req', toolUseId, toolName, input,
      decisionRuleId: 'rule-v1', approval: 'confirmed',
      target: {
        rawPath, normalizedPath: `/workspace/${rawPath}`, zone: 'workdir-normal', targetKind: 'missing', parentReal: '/workspace',
        parentIdentity: { dev: 1, ino: 1, mode: 0o40755, size: 0, mtimeMs: 1, nlink: 2 }
      }
    })
  }
}

describe('permit-bound coordinator dispatch adapter', () => {
  it('canonical input 与 RegisteredTool 实际冻结输入不一致时在 executor 前拒绝', async () => {
    const { toolRevocations } = setup()
    let sideEffects = 0
    const registered = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string },
      plan: async (input) => ({ query: input.query }),
      execute: async () => { sideEffects += 1; return 'executed' }
    })
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'authorized-input' },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations
    })

    await expect(executeRegisteredTool(registered, { query: 'different-executor-input' }, {
      requestId: 'req', toolUseId: 'input-mapping-mismatch', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })).rejects.toMatchObject({
      name: 'PreparedInvocationStoreError', reason: 'INPUT_SNAPSHOT_MISMATCH'
    })
    expect(sideEffects).toBe(0)
  })

  it('共享 runtime admission 中撤权先于 claim 时 executor 不进入', async () => {
    const { tool, toolRevocations } = setup()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' }, authorizationVersion: 'rule-v1', targetVersion: 'target-v1',
      phase: 'recheck', initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    let entered = false
    const registered = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string },
      plan: async (input) => ({ query: input.query }), execute: async () => { entered = true; return 'unexpected' }
    })
    await expect(executeRegisteredTool(registered, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'tc', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch: async (...args) => {
      admission.invalidate({ requestId: 'req', invocationId: args[0].prepared.invocationId }, 'revoked')
      return dispatch(...args)
    } })).rejects.toThrow('REVOKED')
    expect(entered).toBe(false)
    expect(admission.activeLeaseCount('req')).toBe(0)
  })

  it('真实 permit-bound executor 不响应 lease abort 时等待 settle 并以 unknown-after-dispatch 关闭 prepared handle', async () => {
    const { toolRevocations } = setup()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' }, authorizationVersion: 'rule-v1', targetVersion: 'target-v1',
      phase: 'recheck', initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const controller = new AbortController()
    let handleRef: import('./plannedToolRegistry').InvocationHandle | undefined
    let entered!: () => void
    const atExecutor = new Promise<void>((resolve) => { entered = resolve })
    let settle!: (result: string) => void
    const neverUntilSettled = new Promise<string>((resolve) => { settle = resolve })
    let leaseSignal: AbortSignal | undefined
    const tool = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string },
      plan: async (input) => ({ query: input.query }),
      execute: async (_plan, context) => { leaseSignal = context.signal; entered(); return neverUntilSettled }
    })
    let completed = false
    const pending = executeRegisteredTool(tool, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'non-cooperative', signal: controller.signal
    }, { confirm: async (handle) => { handleRef = handle; return true }, dispatch }).then((value) => { completed = true; return value })

    await atExecutor
    expect(admission.activeLeaseCount('req')).toBe(1)
    controller.abort(new Error('cancel after dispatch claim'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(leaseSignal?.aborted).toBe(true)
    expect(completed).toBe(false)
    expect(handleRef?.state).toBe('executing')
    expect(admission.activeLeaseCount('req')).toBe(1)

    settle('settled after abort')
    await expect(pending).rejects.toBeInstanceOf(ToolExecutionAfterDispatchError)
    expect(handleRef?.state).toBe('settled')
    await expect(handleRef?.execute({ requestId: 'req', toolUseId: 'non-cooperative', signal: new AbortController().signal } as never)).rejects.toThrow('INVOCATION_ALREADY_EXECUTED')
    expect(admission.activeLeaseCount('req')).toBe(0)
  })

  it('permit consume 后、dispatch claim barrier 中撤权时 executor 副作用为零', async () => {
    const { toolRevocations } = setup()
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
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    let effectCount = 0
    const sideEffectTool = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string },
      plan: async (input) => ({ query: input.query }), execute: async () => { effectCount += 1; return 'unexpected' }
    })
    const result = executeRegisteredTool(sideEffectTool, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'barrier-call', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(effectCount).toBe(0)
    expect(toolRevocations.revokeToolForLane('desktop', 'lookup')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(effectCount).toBe(0)
    expect(ledger.activeLeaseCount('req')).toBe(0)
  })

  it('真实 MCP registered adapter 在 permit consume 后撤权时不进入 MCP executor', async () => {
    const { toolRevocations } = setup()
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
    let sideEffects = 0
    const registered = createRegisteredMcpTool({
      name: 'lookup', execute: async () => { sideEffects += 1; return { success: true, data: 'unexpected' } }
    } as never)
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const result = executeRegisteredTool(registered, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'mcp-barrier-call', signal: new AbortController().signal,
      executionContext: { requestId: 'req', toolUseId: 'mcp-barrier-call', signal: new AbortController().signal } as never
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(sideEffects).toBe(0)
    expect(toolRevocations.revokeToolForLane('desktop', 'lookup')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(sideEffects).toBe(0)
    expect(ledger.activeLeaseCount('req')).toBe(0)
  })

  it('真实 MCP registered adapter 在 permit consume 后、claim 前授权版本变化时不执行', async () => {
    const { toolRevocations } = setup()
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
    let authorizationVersion = 'rule-v1'
    let sideEffects = 0
    const registered = createRegisteredMcpTool({
      name: 'lookup', execute: async () => { sideEffects += 1; return { success: true, data: 'must not dispatch' } }
    } as never)
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', currentAuthorizationVersion: () => authorizationVersion,
      targetVersion: 'target-v1', phase: 'recheck', initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const signal = new AbortController().signal
    const result = executeRegisteredTool(registered, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'mcp-version-barrier', signal,
      executionContext: { requestId: 'req', toolUseId: 'mcp-version-barrier', signal } as never
    }, { confirm: async () => true, dispatch })

    await atClaim
    expect(sideEffects).toBe(0)
    authorizationVersion = 'rule-v2'
    releaseClaim()
    await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
    expect(sideEffects).toBe(0)
    expect(ledger.activeLeaseCount('req')).toBe(0)
  })

  it('真实 WeChat outbound adapter 在 permit consume 后、claim 前撤权时不发送消息', async () => {
    const toolRevocations = new ToolRevocationRegistry()
    toolRevocations.registerToolRevocationRequest('wechat-req', 'wechat')
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
    let sends = 0
    const [registered] = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: async () => { sends += 1; return { success: true } } } as never,
      reply: { name: 'wechat_reply', execute: vi.fn() } as never
    })
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'wechat-req', turnId: 'wechat-turn', canonicalInput: { userId: 'recipient-1', text: 'hello' },
      authorizationVersion: 'rule-v1', targetVersion: 'wechat-owner-1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !toolRevocations.isToolRevoked('wechat-req', 'wechat_send'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'wechat-owner-1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const context = {
      requestId: 'wechat-req', toolUseId: 'wechat-send-1', signal: new AbortController().signal,
      executionContext: {
        workDir: '/work', userDataDir: '/user-data', sessionId: 'wechat-session', requestId: 'wechat-req',
        toolUseId: 'wechat-send-1', signal: new AbortController().signal,
        lane: 'wechat', wechatConfig: { enabled: true },
        remoteContext: { source: 'wechat', messageId: 'inbound-1', userId: 'owner-1', authOwner: 'owner-1', authorizationGeneration: 1 }
      }
    } as never
    const result = executeRegisteredTool(registered!, { userId: 'recipient-1', text: 'hello' }, context, {
      confirm: async () => true,
      dispatch
    })
    await atClaim
    expect(sends).toBe(0)
    expect(toolRevocations.revokeToolForLane('wechat', 'wechat_send')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(sends).toBe(0)
    expect(ledger.activeLeaseCount('wechat-req')).toBe(0)
  })

  it('真实 WeChat outbound adapter 在 claim 后撤权并返回晚到确认时按未知结果关闭租约', async () => {
    const toolRevocations = new ToolRevocationRegistry()
    toolRevocations.registerToolRevocationRequest('wechat-live-req', 'wechat')
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { reachedExecutor = resolve })
    let observedSignal: AbortSignal | undefined
    let finishSend!: (result: { success: boolean; error: string }) => void
    const sendResult = new Promise<{ success: boolean; error: string }>((resolve) => { finishSend = resolve })
    const [registered] = createWeChatOutboundRegisteredTools({
      send: { name: 'wechat_send', execute: async (_input, context) => {
        observedSignal = context.signal
        reachedExecutor()
        return sendResult
      } } as never,
      reply: { name: 'wechat_reply', execute: vi.fn() } as never
    })
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'wechat-live-req', turnId: 'wechat-live-turn', canonicalInput: { userId: 'recipient-2', text: 'hello' },
      authorizationVersion: 'rule-v1', targetVersion: 'wechat-owner-2', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !toolRevocations.isToolRevoked('wechat-live-req', 'wechat_send'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'wechat-owner-2', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission: ledger
    })
    const signal = new AbortController().signal
    const context = {
      requestId: 'wechat-live-req', toolUseId: 'wechat-send-live', signal,
      executionContext: {
        workDir: '/work', userDataDir: '/user-data', sessionId: 'wechat-session', requestId: 'wechat-live-req',
        toolUseId: 'wechat-send-live', signal, lane: 'wechat', wechatConfig: { enabled: true },
        remoteContext: { source: 'wechat', messageId: 'inbound-2', userId: 'owner-2', authOwner: 'owner-2', authorizationGeneration: 2 }
      }
    } as never
    const result = executeRegisteredTool(registered!, { userId: 'recipient-2', text: 'hello' }, context, {
      confirm: async () => true,
      dispatch
    })
    await atExecutor
    expect(observedSignal?.aborted).toBe(false)
    expect(toolRevocations.revokeToolForLane('wechat', 'wechat_send')).toBe(1)
    expect(observedSignal?.aborted).toBe(true)
    finishSend({ success: false, error: 'WECHAT_CANCELLED' })
    await expect(result).rejects.toBeInstanceOf(ToolExecutionAfterDispatchError)
    expect(ledger.activeLeaseCount('wechat-live-req')).toBe(0)
  })

  it('真实 browser prepared adapter 在 permit consume 后、claim 前撤权时不进入浏览器 executor', async () => {
    const toolRevocations = new ToolRevocationRegistry()
    toolRevocations.registerToolRevocationRequest('browser-req', 'desktop')
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
    const registered = createBuiltinToolRegistry().get('browser')!
    const executor = vi.spyOn(browserExecutor, 'execute')
    const input = { action: 'navigate', url: 'https://example.com' }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'browser-req', turnId: 'browser-turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'browser-policy-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !toolRevocations.isToolRevoked('browser-req', 'browser'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'browser-policy-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const signal = new AbortController().signal
    const result = executeRegisteredTool(registered, input, {
      requestId: 'browser-req', toolUseId: 'browser-call', signal,
      executionContext: {
        workDir: '/work', userDataDir: '/user-data', sessionId: 'browser-session', requestId: 'browser-req',
        toolUseId: 'browser-call', signal, lane: 'desktop', browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true }
      }
    } as never, { confirm: async () => true, dispatch })
    await atClaim
    expect(executor).not.toHaveBeenCalled()
    expect(toolRevocations.revokeToolForLane('desktop', 'browser')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('browser-req')).toBe(0)
    executor.mockRestore()
  })

  it('真实 browser prepared adapter 在 claim barrier 中授权版本变化时不进入浏览器 executor', async () => {
    const toolRevocations = new ToolRevocationRegistry()
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
    const registered = createBuiltinToolRegistry().get('browser')!
    const executor = vi.spyOn(browserExecutor, 'execute')
    const input = { action: 'navigate', url: 'https://example.com' }
    let authorizationVersion = 'rule-v1'
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'browser-version-req', turnId: 'browser-version-turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', currentAuthorizationVersion: () => authorizationVersion,
      targetVersion: 'browser-policy-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'browser-policy-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const signal = new AbortController().signal
    const result = executeRegisteredTool(registered, input, {
      requestId: 'browser-version-req', toolUseId: 'browser-version-call', signal,
      executionContext: {
        workDir: '/work', userDataDir: '/user-data', sessionId: 'browser-version-session', requestId: 'browser-version-req',
        toolUseId: 'browser-version-call', signal, lane: 'desktop', browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true }
      }
    } as never, { confirm: async () => true, dispatch })

    await atClaim
    expect(executor).not.toHaveBeenCalled()
    authorizationVersion = 'rule-v2'
    releaseClaim()
    await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('browser-version-req')).toBe(0)
    executor.mockRestore()
  })

  it('真实 browser prepared adapter 在 claim 后撤权并收到晚到结果时按未知结果关闭租约', async () => {
    const toolRevocations = new ToolRevocationRegistry()
    toolRevocations.registerToolRevocationRequest('browser-live-req', 'desktop')
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const admission = {
      markPermitConsumed: (permitId: string, binding: Parameters<typeof ledger.markPermitConsumed>[1]) => ledger.markPermitConsumed(permitId, binding),
      beginDispatch: (...args: Parameters<typeof ledger.beginDispatch>) => {
        const lease = ledger.beginDispatch(...args)
        reachedClaim()
        return lease
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (permitId: string) => ledger.settle(permitId)
    }
    const registered = createBuiltinToolRegistry().get('browser')!
    const executor = vi.spyOn(browserExecutor, 'execute')
    let receivedSignal: AbortSignal | undefined
    let enteredExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { enteredExecutor = resolve })
    let finishExecution!: (result: { success: boolean; error?: string }) => void
    executor.mockImplementation(async (_input, context) => {
      receivedSignal = context.signal
      enteredExecutor()
      return await new Promise((resolve) => { finishExecution = resolve })
    })
    const input = { action: 'navigate', url: 'https://example.com' }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'browser-live-req', turnId: 'browser-live-turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'browser-policy-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !toolRevocations.isToolRevoked('browser-live-req', 'browser'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'browser-policy-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const signal = new AbortController().signal
    const result = executeRegisteredTool(registered, input, {
      requestId: 'browser-live-req', toolUseId: 'browser-call-live', signal,
      executionContext: {
        workDir: '/work', userDataDir: '/user-data', sessionId: 'browser-session', requestId: 'browser-live-req',
        toolUseId: 'browser-call-live', signal, lane: 'desktop', browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true }
      }
    } as never, { confirm: async () => true, dispatch })

    await atClaim
    await atExecutor
    expect(executor).toHaveBeenCalledTimes(1)
    expect(receivedSignal?.aborted).toBe(false)
    expect(toolRevocations.revokeToolForLane('desktop', 'browser')).toBe(1)
    expect(receivedSignal?.aborted).toBe(true)
    finishExecution({ success: false, error: 'BROWSER_CANCELLED' })
    await expect(result).rejects.toBeInstanceOf(ToolExecutionAfterDispatchError)
    expect(ledger.activeLeaseCount('browser-live-req')).toBe(0)
    executor.mockRestore()
  })

  it('真实 write_file prepared adapter 在 permit consume 后、claim 前撤权时不调用文件执行器', async () => {
    const { toolRevocations } = setup()
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
    const registered = createBuiltinToolRegistry().get('write_file')!
    const executor = vi.spyOn(writeFileExecutor, 'execute')
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { path: 'guarded.txt', content: 'must not write' },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const input = { path: 'guarded.txt', content: 'must not write' }
    const signal = new AbortController().signal
    const result = executeRegisteredTool(registered, input, {
      requestId: 'req', toolUseId: 'write-file-barrier', signal,
      executionContext: permittedWriteContext(input, 'write-file-barrier', signal) as never
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(executor).not.toHaveBeenCalled()
    expect(toolRevocations.revokeToolForLane('desktop', 'write_file')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('req')).toBe(0)
    executor.mockRestore()
  })

  it('真实 run_script prepared adapter 在 permit consume 后、claim 前撤权时不启动脚本 executor', async () => {
    const { toolRevocations } = setup()
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
    const registered = createBuiltinToolRegistry().get('run_script')!
    const executor = vi.spyOn(runScriptExecutor, 'execute')
    const input = { language: 'python', code: "print('must not execute')" }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'script-settings-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !toolRevocations.isToolRevoked('req', 'run_script'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'script-settings-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const controller = new AbortController()
    const result = executeRegisteredTool(registered, input, {
      requestId: 'req', toolUseId: 'run-script-barrier', signal: controller.signal,
      executionContext: {
        requestId: 'req', toolUseId: 'run-script-barrier', signal: controller.signal,
        workDir: '/workspace', userDataDir: '/data', toolsConfig: { scriptTimeout: 30 } as never
      } as never
    }, { confirm: async () => true, dispatch })

    await atClaim
    expect(executor).not.toHaveBeenCalled()
    expect(toolRevocations.revokeToolForLane('desktop', 'run_script')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('req')).toBe(0)
    executor.mockRestore()
  })

  it('真实 run_script prepared adapter 在 claim barrier 中授权版本变化时不启动脚本', async () => {
    const { toolRevocations } = setup()
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
    const registered = createBuiltinToolRegistry().get('run_script')!
    const executor = vi.spyOn(runScriptExecutor, 'execute')
    const input = { language: 'python', code: "print('unauthorized')" }
    let authorizationVersion = 'rule-v1'
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', currentAuthorizationVersion: () => authorizationVersion,
      targetVersion: 'script-settings-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'script-settings-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const controller = new AbortController()
    const result = executeRegisteredTool(registered, input, {
      requestId: 'req', toolUseId: 'run-script-version', signal: controller.signal,
      executionContext: {
        requestId: 'req', toolUseId: 'run-script-version', signal: controller.signal,
        workDir: '/workspace', userDataDir: '/data', toolsConfig: { scriptTimeout: 30 } as never
      } as never
    }, { confirm: async () => true, dispatch })

    await atClaim
    expect(executor).not.toHaveBeenCalled()
    authorizationVersion = 'rule-v2'
    releaseClaim()
    await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('req')).toBe(0)
    executor.mockRestore()
  })

  it('真实 run_script prepared adapter 在 claim 后撤权并收到晚到结果时按未知结果关闭租约', async () => {
    const { toolRevocations } = setup()
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const admission = {
      markPermitConsumed: (permitId: string, binding: Parameters<typeof ledger.markPermitConsumed>[1]) => ledger.markPermitConsumed(permitId, binding),
      beginDispatch: (...args: Parameters<typeof ledger.beginDispatch>) => {
        const lease = ledger.beginDispatch(...args)
        reachedClaim()
        return lease
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (permitId: string) => ledger.settle(permitId)
    }
    const registered = createBuiltinToolRegistry().get('run_script')!
    const executor = vi.spyOn(runScriptExecutor, 'execute')
    let receivedSignal: AbortSignal | undefined
    let enteredExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { enteredExecutor = resolve })
    let finishExecution!: (result: { success: boolean; data?: unknown }) => void
    executor.mockImplementation(async (_input, context) => {
      receivedSignal = context.signal
      enteredExecutor()
      return await new Promise((resolve) => { finishExecution = resolve })
    })
    const input = { language: 'python', code: "print('cooperative cancellation')" }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'script-settings-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !toolRevocations.isToolRevoked('req', 'run_script'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'script-settings-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const controller = new AbortController()
    const result = executeRegisteredTool(registered, input, {
      requestId: 'req', toolUseId: 'run-script-claimed', signal: controller.signal,
      executionContext: {
        requestId: 'req', toolUseId: 'run-script-claimed', signal: controller.signal,
        workDir: '/workspace', userDataDir: '/data', toolsConfig: { scriptTimeout: 30 } as never
      } as never
    }, { confirm: async () => true, dispatch })

    await atClaim
    await atExecutor
    expect(executor).toHaveBeenCalledTimes(1)
    expect(receivedSignal?.aborted).toBe(false)
    expect(toolRevocations.revokeToolForLane('desktop', 'run_script')).toBe(1)
    expect(receivedSignal?.aborted).toBe(true)
    finishExecution({ success: false, data: { status: 'cancelled' } })
    await expect(result).rejects.toBeInstanceOf(ToolExecutionAfterDispatchError)
    expect(ledger.activeLeaseCount('req')).toBe(0)
    executor.mockRestore()
  })

  it('真实 edit_file prepared adapter 在 permit consume 后、claim 前撤权时不调用编辑器', async () => {
    const { toolRevocations } = setup()
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
    const registered = createBuiltinToolRegistry().get('edit_file')!
    const executor = vi.spyOn(editFileExecutor, 'execute')
    const input = { path: 'guarded-edit.txt', old_string: 'before', new_string: 'after' }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const signal = new AbortController().signal
    const result = executeRegisteredTool(registered, input, {
      requestId: 'req', toolUseId: 'edit-file-barrier', signal,
      executionContext: permittedWriteContext(input, 'edit-file-barrier', signal, 'edit_file') as never
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(executor).not.toHaveBeenCalled()
    expect(toolRevocations.revokeToolForLane('desktop', 'edit_file')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('req')).toBe(0)
    executor.mockRestore()
  })

  it.each(['write_file', 'edit_file'] as const)(
    '真实 %s prepared adapter 在 claim barrier 中授权版本变化时不产生文件副作用',
    async (toolName) => {
      const { toolRevocations } = setup()
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
      const registered = createBuiltinToolRegistry().get(toolName)!
      const executor = vi.spyOn(toolName === 'write_file' ? writeFileExecutor : editFileExecutor, 'execute')
      const input = toolName === 'write_file'
        ? { path: 'version-drift.txt', content: 'unauthorized' }
        : { path: 'version-drift.txt', old_string: 'before', new_string: 'unauthorized' }
      let authorizationVersion = 'rule-v1'
      const dispatch = createPermitBoundCoordinatorDispatch({
        requestId: 'req', turnId: 'turn', canonicalInput: input,
        authorizationVersion: 'rule-v1', currentAuthorizationVersion: () => authorizationVersion,
        targetVersion: 'target-v1', phase: 'recheck', initialFactsHash: 'facts-v1', isAllowed: () => true,
        recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
        safetyPolicy: allowPolicy(), toolRevocations, admission
      })
      const signal = new AbortController().signal
      const toolUseId = `version-${toolName}`
      const result = executeRegisteredTool(registered, input, {
        requestId: 'req', toolUseId, signal,
        executionContext: permittedWriteContext(input, toolUseId, signal, toolName) as never
      }, { confirm: async () => true, dispatch })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      authorizationVersion = 'rule-v2'
      releaseClaim()
      await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
      expect(executor).not.toHaveBeenCalled()
      expect(ledger.activeLeaseCount('req')).toBe(0)
      executor.mockRestore()
    }
  )

  it.each(['write_file', 'edit_file'] as const)('真实 %s prepared adapter 在 permit consume 后、claim 前取消时不产生文件副作用', async (toolName) => {
    const { toolRevocations } = setup()
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
    const registered = createBuiltinToolRegistry().get(toolName)!
    const executor = vi.spyOn(toolName === 'write_file' ? writeFileExecutor : editFileExecutor, 'execute')
    const input = toolName === 'write_file'
      ? { path: 'cancelled-write.txt', content: 'must not write' }
      : { path: 'cancelled-edit.txt', old_string: 'before', new_string: 'must not edit' }
    const toolUseId = `cancel-${toolName}`
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const controller = new AbortController()
    const result = executeRegisteredTool(registered, input, {
      requestId: 'req', toolUseId, signal: controller.signal,
      executionContext: permittedWriteContext(input, toolUseId, controller.signal, toolName) as never
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(executor).not.toHaveBeenCalled()
    controller.abort(new Error('cancel before dispatch claim'))
    releaseClaim()
    await expect(result).rejects.toThrow()
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('req')).toBe(0)
    executor.mockRestore()
  })

  it.each([
    { toolName: 'write_file', cancelMode: 'request' },
    { toolName: 'edit_file', cancelMode: 'request' },
    { toolName: 'write_file', cancelMode: 'timeout' },
    { toolName: 'edit_file', cancelMode: 'timeout' }
  ] as const)('真实 $toolName prepared adapter 在 claim 后 $cancelMode 终止时向 executor 发 abort 并保留未知结果', async ({ toolName, cancelMode }) => {
    const { toolRevocations } = setup()
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    const registered = createBuiltinToolRegistry().get(toolName)!
    const executor = vi.spyOn(toolName === 'write_file' ? writeFileExecutor : editFileExecutor, 'execute')
    let receivedSignal: AbortSignal | undefined
    let enteredExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { enteredExecutor = resolve })
    let markAborted!: () => void
    const leaseAborted = new Promise<void>((resolve) => { markAborted = resolve })
    executor.mockImplementation(async (_input, context) => {
      receivedSignal = context.signal
      enteredExecutor()
      return await new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          markAborted()
          reject(new Error('write result unknown after cancellation'))
        }, { once: true })
      })
    })
    const input = toolName === 'write_file'
      ? { path: 'claimed-cancel-write.txt', content: 'must cancel' }
      : { path: 'claimed-cancel-edit.txt', old_string: 'before', new_string: 'after' }
    const toolUseId = `claimed-cancel-${toolName}`
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission: ledger
    })
    const controller = new AbortController()
    const result = executeRegisteredTool(registered, input, {
      requestId: 'req', toolUseId, signal: controller.signal,
      executionContext: permittedWriteContext(input, toolUseId, controller.signal, toolName) as never
    }, {
      confirm: async () => true,
      dispatch,
      ...(cancelMode === 'timeout' ? { phaseTimeoutMs: { execute: 50 } } : {})
    })

    try {
      await atExecutor
      expect(executor).toHaveBeenCalledOnce()
      expect(receivedSignal?.aborted).toBe(false)
      expect(ledger.activeLeaseCount('req')).toBe(1)
      if (cancelMode === 'request') controller.abort(new Error('cancel after dispatch claim'))
      else await leaseAborted
      expect(receivedSignal?.aborted).toBe(true)
      await expect(result).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
      expect(ledger.activeLeaseCount('req')).toBe(0)
    } finally {
      executor.mockRestore()
    }
  })

  it.each(['read_file', 'list_directory', 'grep', 'read_feishu_attachment'] as const)('%s prepared adapter 在 permit consume 后、claim 前撤权时不调用读取器', async (toolName) => {
    const { toolRevocations } = setup()
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
    const input = toolName === 'grep'
      ? { path: '/tmp/guarded-read.txt', pattern: 'needle' }
      : toolName === 'read_feishu_attachment' ? { attachmentId: 'attachment-1' } : { path: '/tmp/guarded-read.txt' }
    const toolUseId = `read-${toolName}-barrier`
    const normalizedPath = '/tmp/guarded-read.txt'
    const permit = buildReadExecutionPermit({
      requestId: 'req', toolUseId, toolName, input,
      facts: [{ factId: 'fact-read', decisionRuleId: 'read-rule', normalizedPath, zone: 'workdir-normal', targetKind: 'file', identity: { dev: 1, ino: 2, mode: 0o100644, size: 12, mtimeMs: 1 } }]
    })
    const executors = {
      readFile: vi.fn(async () => ({ success: true, data: 'must not read' })),
      listDirectory: vi.fn(async () => ({ success: true, data: 'must not read' })),
      grep: vi.fn(async () => ({ success: true, data: 'must not read' })),
      readFeishuAttachment: vi.fn(async () => ({ success: true, data: 'must not read' }))
    }
    const registered = createReadRegisteredTools({
      readFile: { name: 'read_file', execute: executors.readFile } as never,
      listDirectory: { name: 'list_directory', execute: executors.listDirectory } as never,
      grep: { name: 'grep', execute: executors.grep } as never,
      readFeishuAttachment: { name: 'read_feishu_attachment', execute: executors.readFeishuAttachment } as never
    }).find((tool) => tool.name === toolName)!
    const executor = executors[{ read_file: 'readFile', list_directory: 'listDirectory', grep: 'grep', read_feishu_attachment: 'readFeishuAttachment' }[toolName]]
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const controller = new AbortController()
    const result = executeRegisteredTool(registered, input, {
      requestId: 'req', toolUseId, signal: controller.signal,
      executionContext: { requestId: 'req', toolUseId, signal: controller.signal, readExecutionPermit: permit } as never
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(executor).not.toHaveBeenCalled()
    expect(toolRevocations.revokeToolForLane('desktop', toolName)).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('req')).toBe(0)
  })

  it.each(['read_file', 'list_directory', 'grep', 'read_feishu_attachment'] as const)(
    '真实 %s prepared adapter 在 permit consume 后、claim 前取消时不调用读取器',
    async (toolName) => {
      const { toolRevocations } = setup()
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
      const input = toolName === 'grep'
        ? { path: '/tmp/cancelled-read.txt', pattern: 'needle' }
        : toolName === 'read_feishu_attachment' ? { attachmentId: 'attachment-cancel' } : { path: '/tmp/cancelled-read.txt' }
      const toolUseId = `cancel-${toolName}`
      const targetKind = toolName === 'list_directory' ? 'directory' as const : 'file' as const
      const permit = buildReadExecutionPermit({
        requestId: 'req', toolUseId, toolName, input,
        facts: [{ factId: `fact-${toolName}`, decisionRuleId: 'read-rule', normalizedPath: '/tmp/cancelled-read.txt', zone: 'workdir-normal', targetKind, ...(targetKind === 'directory' ? { scope: 'direct-entries' as const } : {}), identity: { dev: 1, ino: 2, mode: targetKind === 'directory' ? 0o40755 : 0o100644, size: 12, mtimeMs: 1 } }]
      })
      const executors = {
        readFile: vi.fn(async () => ({ success: true, data: 'must not read' })),
        listDirectory: vi.fn(async () => ({ success: true, data: 'must not read' })),
        grep: vi.fn(async () => ({ success: true, data: 'must not read' })),
        readFeishuAttachment: vi.fn(async () => ({ success: true, data: 'must not read' }))
      }
      const registered = createReadRegisteredTools({
        readFile: { name: 'read_file', execute: executors.readFile } as never,
        listDirectory: { name: 'list_directory', execute: executors.listDirectory } as never,
        grep: { name: 'grep', execute: executors.grep } as never,
        readFeishuAttachment: { name: 'read_feishu_attachment', execute: executors.readFeishuAttachment } as never
      }).find((tool) => tool.name === toolName)!
      const executor = executors[{ read_file: 'readFile', list_directory: 'listDirectory', grep: 'grep', read_feishu_attachment: 'readFeishuAttachment' }[toolName]]
      const dispatch = createPermitBoundCoordinatorDispatch({
        requestId: 'req', turnId: 'turn', canonicalInput: input,
        authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
        initialFactsHash: 'facts-v1', isAllowed: () => true,
        recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
        safetyPolicy: allowPolicy(), toolRevocations, admission
      })
      const controller = new AbortController()
      const result = executeRegisteredTool(registered, input, {
        requestId: 'req', toolUseId, signal: controller.signal,
        executionContext: { requestId: 'req', toolUseId, signal: controller.signal, readExecutionPermit: permit } as never
      }, { confirm: async () => true, dispatch })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      controller.abort(new Error('cancel before dispatch claim'))
      releaseClaim()
      await expect(result).rejects.toThrow()
      expect(executor).not.toHaveBeenCalled()
      expect(ledger.activeLeaseCount('req')).toBe(0)
    }
  )

  it.each(['read_file', 'list_directory', 'grep', 'read_feishu_attachment'] as const)(
    '真实 %s prepared adapter 在 claim barrier 中授权版本变化时不调用读取器',
    async (toolName) => {
      const { toolRevocations } = setup()
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
      const input = toolName === 'grep'
        ? { path: '/tmp/versioned-read.txt', pattern: 'needle' }
        : toolName === 'read_feishu_attachment' ? { attachmentId: 'attachment-version' } : { path: '/tmp/versioned-read.txt' }
      const toolUseId = `version-${toolName}`
      const targetKind = toolName === 'list_directory' ? 'directory' as const : 'file' as const
      const permit = buildReadExecutionPermit({
        requestId: 'req', toolUseId, toolName, input,
        facts: [{ factId: `fact-${toolName}`, decisionRuleId: 'read-rule', normalizedPath: '/tmp/versioned-read.txt', zone: 'workdir-normal', targetKind, ...(targetKind === 'directory' ? { scope: 'direct-entries' as const } : {}), identity: { dev: 1, ino: 2, mode: targetKind === 'directory' ? 0o40755 : 0o100644, size: 12, mtimeMs: 1 } }]
      })
      const executors = {
        readFile: vi.fn(async () => ({ success: true, data: 'unauthorized read' })),
        listDirectory: vi.fn(async () => ({ success: true, data: 'unauthorized read' })),
        grep: vi.fn(async () => ({ success: true, data: 'unauthorized read' })),
        readFeishuAttachment: vi.fn(async () => ({ success: true, data: 'unauthorized read' }))
      }
      const registered = createReadRegisteredTools({
        readFile: { name: 'read_file', execute: executors.readFile } as never,
        listDirectory: { name: 'list_directory', execute: executors.listDirectory } as never,
        grep: { name: 'grep', execute: executors.grep } as never,
        readFeishuAttachment: { name: 'read_feishu_attachment', execute: executors.readFeishuAttachment } as never
      }).find((tool) => tool.name === toolName)!
      const executor = executors[{ read_file: 'readFile', list_directory: 'listDirectory', grep: 'grep', read_feishu_attachment: 'readFeishuAttachment' }[toolName]]
      let authorizationVersion = 'rule-v1'
      const dispatch = createPermitBoundCoordinatorDispatch({
        requestId: 'req', turnId: 'turn', canonicalInput: input,
        authorizationVersion: 'rule-v1', currentAuthorizationVersion: () => authorizationVersion,
        targetVersion: 'target-v1', phase: 'recheck', initialFactsHash: 'facts-v1', isAllowed: () => true,
        recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
        safetyPolicy: allowPolicy(), toolRevocations, admission
      })
      const result = executeRegisteredTool(registered, input, {
        requestId: 'req', toolUseId, signal: new AbortController().signal,
        executionContext: { requestId: 'req', toolUseId, readExecutionPermit: permit } as never
      }, { confirm: async () => true, dispatch })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      authorizationVersion = 'rule-v2'
      releaseClaim()
      await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
      expect(executor).not.toHaveBeenCalled()
      expect(ledger.activeLeaseCount('req')).toBe(0)
    }
  )

  it('共享 runtime ledger 下同 request 的并发工具分别消费和 settle permit', async () => {
    const { toolRevocations } = setup()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    let entered = 0
    const run = (toolName: string, callId: string) => {
      const tool = definePlannedTool({
        name: toolName, parseInput: (raw) => raw as { query: string },
        plan: async (input) => ({ query: input.query }), execute: async () => { entered += 1; return callId }
      })
      const dispatch = createPermitBoundCoordinatorDispatch({
        requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' }, authorizationVersion: 'rule-v1', targetVersion: 'target-v1',
        phase: 'recheck', initialFactsHash: 'facts-v1', isAllowed: () => true,
        recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
        safetyPolicy: allowPolicy(), toolRevocations, admission, permits
      })
      return executeRegisteredTool(tool, { query: 'weather' }, {
        requestId: 'req', toolUseId: callId, signal: new AbortController().signal
      }, { confirm: async () => true, dispatch })
    }
    await expect(Promise.all([run('lookup-a', 'call-a'), run('lookup-b', 'call-b')])).resolves.toEqual(['call-a', 'call-b'])
    expect(entered).toBe(2)
  })

  it('dispatch 已线性化后撤权经执行租约 signal 传入 executor，并在结算后释放租约', async () => {
    const { toolRevocations } = setup()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1',
      phase: 'recheck', initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const registered = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string },
      plan: async (input) => ({ query: input.query }),
      execute: async (_plan, context) => {
        markEntered()
        if (context.signal.aborted) return 'cancelled'
        return new Promise<string>((resolve) => {
          context.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
      }
    })

    const result = executeRegisteredTool(registered, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'tc-live', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })
    await entered
    expect(admission.activeLeaseCount('req')).toBe(1)
    expect(toolRevocations.revokeToolForLane('desktop', 'lookup')).toBe(1)
    await expect(result).rejects.toBeInstanceOf(ToolExecutionAfterDispatchError)
    expect(admission.activeLeaseCount('req')).toBe(0)
  })

  it('通过 SafetyGate、prepared binding、permit consume 和 dispatch claim 后执行', async () => {
    const { tool, dispatch } = setup()
    await expect(executeRegisteredTool(tool, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'tc', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })).resolves.toBe('result')
  })

  it('开始执行前撤权会让 permit dispatch fail closed', async () => {
    const { tool, toolRevocations } = setup()
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1',
      phase: 'recheck', isAllowed: () => true,
      initialFactsHash: 'facts-v1', recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations
    })
    let executed = false
    const handleTool = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string },
      plan: async (input) => ({ query: input.query }),
      execute: async () => { executed = true; return 'bad' }
    })
    await expect(executeRegisteredTool(handleTool, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'tc', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch: async (...args) => {
      toolRevocations.revokeToolForLane('desktop', 'lookup')
      return dispatch(...args)
    } })).rejects.toThrow('AUTHORIZATION_STALE')
    expect(executed).toBe(false)
  })

  it('策略授权版本在准备与 claim 之间变化时拒绝执行', async () => {
    const { tool, toolRevocations } = setup()
    let version = 'rule-v1'
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', currentAuthorizationVersion: () => version,
      targetVersion: 'target-v1', phase: 'recheck', initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations
    })
    await expect(executeRegisteredTool(tool, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'tc', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch: async (...args) => {
      const pending = dispatch(...args)
      version = 'rule-v2'
      return pending
    } })).rejects.toThrow('AUTHORIZATION_STALE')
  })

  it('permit consume 后、claim barrier 中策略版本更新时 executor 副作用为零', async () => {
    const { toolRevocations } = setup()
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
    let version = 'rule-v1'
    let sideEffects = 0
    const registered = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string },
      plan: async (input) => ({ query: input.query }), execute: async () => { sideEffects += 1; return 'unexpected' }
    })
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', currentAuthorizationVersion: () => version,
      targetVersion: 'target-v1', phase: 'recheck', initialFactsHash: 'facts-v1', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: allowPolicy(), toolRevocations, admission
    })
    const result = executeRegisteredTool(registered, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'version-barrier-call', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(sideEffects).toBe(0)
    version = 'rule-v2'
    releaseClaim()
    await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
    expect(sideEffects).toBe(0)
    expect(ledger.activeLeaseCount('req')).toBe(0)
  })

  it('recheck phase requires a fresh positive host policy decision before issuing a permit', async () => {
    const { tool, toolRevocations } = setup()
    let rechecks = 0
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      isAllowed: () => true,
      recheck: async () => { rechecks += 1; return { allowed: false, authorizationVersion: 'rule-v2', targetVersion: 'target-v2' } },
      safetyPolicy: allowPolicy(), toolRevocations
    })
    await expect(executeRegisteredTool(tool, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'tc', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })).rejects.toThrow('RECHECK_DENIED')
    expect(rechecks).toBe(1)
  })

  it('rejects facts or target drift in the fresh policy recheck', async () => {
    const { tool, toolRevocations } = setup()
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', initialFactsHash: 'facts-v1',
      phase: 'recheck', isAllowed: () => true,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v2' }),
      safetyPolicy: allowPolicy(), toolRevocations
    })
    await expect(executeRegisteredTool(tool, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'tc', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })).rejects.toThrow('BINDING_MISMATCH')
  })
})

describe('SDK safety policy at coordinator boundary', () => {
  it('真实 SafetyPolicy 拒绝时不调用 builtin executor', async () => {
    const { toolRevocations } = setup()
    const registered = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string },
      plan: async (input) => ({ query: input.query }), execute: async () => { throw new Error('executor must not run') }
    })
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => true, toolRevocations,
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'deny', reasonCode: 'POLICY_DENY' }) }
    })
    await expect(executeRegisteredTool(registered, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'blocked-call', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })).rejects.toThrow('SAFETY_GATE_DENY')
  })
})
