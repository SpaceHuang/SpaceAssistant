import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession, openDatabase, updateSession } from '../database'
import { createWorkDirManager } from '../workDirManager'
import { switchSessionExecutor } from './remoteSessionExecutors'
import { createSwitchSessionRegisteredTool } from './remoteSessionRegisteredTools'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { createPermitBoundCoordinatorDispatch } from './permitBoundCoordinatorDispatch'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { TypedToolRegistry } from './plannedToolRegistry'
import { createRegisteredAgentTurnTools } from './registeredAgentTurnTools'
import { requestRendererSessionSwitch } from '../remote/requestRendererSessionSwitch'
import type { ToolExecutionContext } from './types'
import {
  releaseRemoteSession,
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from '../remote/remoteAgentRegistry'
import {
  REMOTE_SESSION_SWITCH_BUSY_CALLER,
  REMOTE_SESSION_SWITCH_DENIED_MESSAGE
} from '../remote/remoteSessionGuardMessages'
import {
  beginLlm,
  beginTool,
  resetRemoteSessionSwitchStateForTests
} from '../remote/remoteSessionSwitchState'
import { remoteWriteGrantRegistry } from '../remote/remoteWriteGrantRegistry'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'

vi.mock('../remote/requestRendererSessionSwitch', () => ({
  requestRendererSessionSwitch: vi.fn().mockResolvedValue({ desktopSwitched: true, viewChanged: true })
}))

vi.mock('../windowRef', () => ({
  getMainWindow: () => ({ webContents: { id: 1, isDestroyed: () => false } })
}))

const feishuCliEvents: Array<{ level: string; event: string; payload: Record<string, unknown> }> = []
vi.mock('../feishu/feishuCliLogger', () => ({
  logFeishuCliEvent: (level: string, event: string, payload: Record<string, unknown>) => {
    feishuCliEvents.push({ level, event, payload })
  },
  logFeishuAuditMirror: () => undefined
}))

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rse-'))
}

describe('switchSessionExecutor', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  afterEach(() => {
    resetRunningRemoteAgentRegistryForTests()
    resetRemoteSessionSwitchStateForTests()
    feishuCliEvents.length = 0
    vi.clearAllMocks()
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function setup() {
    const dir = tempDir()
    dirs.push(dir)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dir,
      setWorkDir: () => undefined
    })
    return { db, manager, dir }
  }

  function makeCtx(
    db: ReturnType<typeof openDatabase>,
    manager: ReturnType<typeof createWorkDirManager>,
    callerId: string,
    remoteContext: ToolExecutionContext['remoteContext'],
    requestId = 'req-1'
  ) {
    return {
      workDir: manager.getActiveWorkDir(),
      userDataDir: tempDir(),
      requestId,
      toolUseId: 'tu-1',
      sessionId: callerId,
      sendProgress: () => undefined,
      signal: new AbortController().signal,
      fileStateCache: {} as ToolExecutionContext['fileStateCache'],
      toolsConfig: { enabled: true, allowedTools: [], deniedTools: [] },
      appDatabase: db,
      sessionQueries: createSqliteSessionStorage(db).queries,
      sessionCommands: createSqliteSessionStorage(db).commands,
      workDirManager: manager,
      remoteContext
    } satisfies ToolExecutionContext
  }

  it('rejects without remoteContext (B2)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller' })
    const result = await switchSessionExecutor.execute({ session_id: caller.id }, makeCtx(db, manager, caller.id, undefined))
    expect(result.success).toBe(false)
    expect(result.error).toContain('远程会话')
  })

  it('switches to matching feishu session (B1)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller' })
    const target = createSession(db, {
      name: 'target',
      metadata: { source: 'feishu', feishuChatId: 'chat-1' }
    })
    const auditEntries: unknown[] = []
    const remoteContext = {
      source: 'feishu' as const,
      messageId: 'm1',
      confirmPolicy: 'always' as const,
      chatId: 'chat-1',
      appendSessionSwitchAudit: (entry: unknown) => {
        auditEntries.push(entry)
      }
    }
    const revoked: Array<[string, string]> = []
    const unregister = remoteWriteGrantRegistry.onRevokeByOriginSession((originSessionId, reason) => {
      revoked.push([originSessionId, reason])
    })
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(db, manager, caller.id, remoteContext)
    )
    unregister()
    expect(result.success).toBe(true)
    expect(remoteContext.outboundSessionId).toBe(target.id)
    const data = result.data as { sessionId: string; desktopSwitched: boolean }
    expect(data.sessionId).toBe(target.id)
    expect(data.desktopSwitched).toBe(true)
    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0]).toMatchObject({ kind: 'success', targetSessionId: target.id })
    expect(feishuCliEvents.some((e) => e.event === 'feishu.session.switch')).toBe(true)
    // switch_session never migrates the origin lease; any write grant scoped to it is revoked.
    expect(revoked).toEqual([[caller.id, 'session_switch']])
  })

  it('确认后目标会话的远程身份变化时在 dispatch 前拒绝切换', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller' })
    const target = createSession(db, {
      name: 'target',
      metadata: { source: 'feishu', feishuChatId: 'chat-1' }
    })
    const remoteContext = {
      source: 'feishu' as const,
      messageId: 'm1',
      confirmPolicy: 'always' as const,
      chatId: 'chat-1'
    }
    const ctx = makeCtx(db, manager, caller.id, remoteContext)
    const readSession = vi.fn(ctx.sessionQueries!.readSession)
    ctx.sessionQueries = { ...ctx.sessionQueries!, readSession }
    const tool = createSwitchSessionRegisteredTool(switchSessionExecutor)
    const executor = vi.spyOn(switchSessionExecutor, 'execute')
    let dispatched = false

    await expect(executeRegisteredTool(tool, { session_id: target.id }, {
      requestId: ctx.requestId!, toolUseId: 'call-session-switch', signal: ctx.signal,
      executionContext: ctx as never
    }, {
      confirm: async () => {
        updateSession(db, target.id, { metadata: { source: 'feishu', feishuChatId: 'chat-other' } })
        return true
      },
      dispatch: async (_handle, _context, run) => {
        dispatched = true
        return run(new AbortController().signal)
      }
    })).rejects.toThrow('REMOTE_SESSION_PREPARED_IDENTITY_CHANGED')

    expect(dispatched).toBe(false)
    expect(executor).not.toHaveBeenCalled()
    expect(readSession).toHaveBeenCalledWith(target.id)
    executor.mockRestore()
  })

  it('switch_session 在 claim barrier 中授权版本变化时不切换 session 或撤销 grants', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'version-caller', metadata: { source: 'feishu', feishuChatId: 'chat-1' } })
    const target = createSession(db, { name: 'version-target', metadata: { source: 'feishu', feishuChatId: 'chat-1' } })
    const remoteContext = { source: 'feishu' as const, messageId: 'm1', confirmPolicy: 'always' as const, chatId: 'chat-1' }
    const ctx = makeCtx(db, manager, caller.id, remoteContext)
    const tool = createSwitchSessionRegisteredTool(switchSessionExecutor)
    const executor = vi.spyOn(switchSessionExecutor, 'execute')
    const audit: unknown[] = []
    remoteContext.outboundSessionId = caller.id
    remoteContext.appendSessionSwitchAudit = (entry: unknown) => audit.push(entry)
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(ctx.requestId!, 'feishu', ctx.requestId!)
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const barrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (...args: Parameters<typeof ledger.markPermitConsumed>) => ledger.markPermitConsumed(...args),
      beginDispatch: async (...args: Parameters<typeof ledger.beginDispatch>) => {
        reachedClaim()
        await barrier
        return ledger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (...args: Parameters<typeof ledger.settle>) => ledger.settle(...args)
    }
    let authorizationVersion = 'rule-v1'
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: ctx.requestId!, turnId: 'turn-session-switch', canonicalInput: { session_id: target.id },
      authorizationVersion, currentAuthorizationVersion: () => authorizationVersion,
      targetVersion: target.id, phase: 'recheck', initialFactsHash: 'facts-v1',
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: target.id, factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) },
      isAllowed: () => true, toolRevocations: revocations, admission
    })
    const result = executeRegisteredTool(tool, { session_id: target.id }, {
      requestId: ctx.requestId!, toolUseId: 'call-session-version', signal: ctx.signal,
      executionContext: ctx as never
    }, { confirm: async () => true, dispatch })
    try {
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      authorizationVersion = 'rule-v2'
      releaseClaim()
      await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
      expect(executor).not.toHaveBeenCalled()
      expect(requestRendererSessionSwitch).not.toHaveBeenCalled()
      expect(remoteContext.outboundSessionId).toBe(caller.id)
      expect(audit).toEqual([])
      expect(ledger.activeLeaseCount(ctx.requestId!)).toBe(0)
    } finally {
      releaseClaim()
      executor.mockRestore()
    }
  })

  it('switch_session 在 claim barrier 中取消时不切换 session、不审计且不撤销 grants', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'cancel-caller', metadata: { source: 'feishu', feishuChatId: 'chat-1' } })
    const target = createSession(db, { name: 'cancel-target', metadata: { source: 'feishu', feishuChatId: 'chat-1' } })
    const remoteContext = { source: 'feishu' as const, messageId: 'm1', confirmPolicy: 'always' as const, chatId: 'chat-1' }
    const ctx = makeCtx(db, manager, caller.id, remoteContext)
    const controller = new AbortController()
    ctx.signal = controller.signal
    const tool = createSwitchSessionRegisteredTool(switchSessionExecutor)
    const executor = vi.spyOn(switchSessionExecutor, 'execute')
    const revoke = vi.spyOn(remoteWriteGrantRegistry, 'revokeByOriginSession')
    const audit: unknown[] = []
    remoteContext.outboundSessionId = caller.id
    remoteContext.appendSessionSwitchAudit = (entry: unknown) => audit.push(entry)
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const barrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (...args: Parameters<typeof ledger.markPermitConsumed>) => ledger.markPermitConsumed(...args),
      beginDispatch: async (...args: Parameters<typeof ledger.beginDispatch>) => {
        reachedClaim()
        await barrier
        return ledger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (...args: Parameters<typeof ledger.settle>) => ledger.settle(...args)
    }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: ctx.requestId!, turnId: 'turn-session-cancel', canonicalInput: { session_id: target.id },
      authorizationVersion: 'rule-v1', targetVersion: target.id, phase: 'recheck', initialFactsHash: 'facts-v1',
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: target.id, factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) },
      isAllowed: () => true, toolRevocations: new ToolRevocationRegistry(), admission
    })
    const result = executeRegisteredTool(tool, { session_id: target.id }, {
      requestId: ctx.requestId!, toolUseId: 'call-session-cancel', signal: controller.signal,
      executionContext: ctx as never
    }, { confirm: async () => true, dispatch })
    try {
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      controller.abort(new Error('cancel before session switch claim'))
      releaseClaim()
      await expect(result).rejects.toThrow()
      expect(executor).not.toHaveBeenCalled()
      expect(requestRendererSessionSwitch).not.toHaveBeenCalled()
      expect(remoteContext.outboundSessionId).toBe(caller.id)
      expect(audit).toEqual([])
      expect(revoke).not.toHaveBeenCalled()
      expect(ledger.activeLeaseCount(ctx.requestId!)).toBe(0)
    } finally {
      releaseClaim()
      executor.mockRestore()
      revoke.mockRestore()
    }
  })

  it('rejects identity mismatch (B3)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller' })
    const target = createSession(db, {
      name: 'target',
      metadata: { source: 'feishu', feishuChatId: 'other-chat' }
    })
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(db, manager, caller.id, {
        source: 'feishu',
        messageId: 'm1',
        confirmPolicy: 'always',
        chatId: 'chat-1'
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe(REMOTE_SESSION_SWITCH_DENIED_MESSAGE)
    expect(feishuCliEvents.some((e) => e.event === 'feishu.session.switch_denied')).toBe(true)
  })

  it('rejects when caller has tool in-flight (B4)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    const target = createSession(db, { name: 'target', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    beginTool(caller.id, 'req-1', 'read_file')
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(db, manager, caller.id, {
        source: 'feishu',
        messageId: 'm1',
        confirmPolicy: 'always',
        chatId: 'c1'
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe(REMOTE_SESSION_SWITCH_BUSY_CALLER)
  })

  it('allows switch when caller only registry-claimed (94e44c4a regression)', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    const target = createSession(db, { name: 'target', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    tryClaimRemoteSession(caller.id, 'req-inbound', 4)
    beginLlm(caller.id, 'req-inbound')
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(
        db,
        manager,
        caller.id,
        {
          source: 'feishu',
          messageId: 'm1',
          confirmPolicy: 'always',
          chatId: 'c1'
        },
        'req-inbound'
      )
    )
    expect(result.success).toBe(true)
    releaseRemoteSession(caller.id, 'req-inbound')
  })

  it('rejects when caller has pending confirm via imChannel', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'caller', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    const target = createSession(db, { name: 'target', metadata: { source: 'feishu', feishuChatId: 'c1' } })
    const result = await switchSessionExecutor.execute(
      { session_id: target.id },
      makeCtx(db, manager, caller.id, {
        source: 'feishu',
        messageId: 'm1',
        confirmPolicy: 'always',
        chatId: 'c1',
        imChannel: { hasPendingForSession: (id: string) => id === caller.id } as NonNullable<
          ToolExecutionContext['remoteContext']
        >['imChannel']
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe(REMOTE_SESSION_SWITCH_BUSY_CALLER)
  })

  it('switch_session 的 renderer ack 丢失发生在 dispatch 后时禁止重试并记录未知结果', async () => {
    const { db, manager } = setup()
    const caller = createSession(db, { name: 'unknown-caller', metadata: { source: 'feishu', feishuChatId: 'chat-1' } })
    const target = createSession(db, { name: 'unknown-target', metadata: { source: 'feishu', feishuChatId: 'chat-1' } })
    const requestId = 'req-session-switch-unknown'
    const invocationId = 'inv-session-switch-unknown'
    const turnId = 'turn-session-switch-unknown'
    const remoteContext = { source: 'feishu' as const, messageId: 'm1', confirmPolicy: 'always' as const, chatId: 'chat-1', outboundSessionId: caller.id }
    const ctx = makeCtx(db, manager, caller.id, remoteContext, requestId)
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(requestId, 'feishu', requestId)
    let reachedRenderer!: () => void
    let rejectRenderer!: (error: Error) => void
    const rendererRequested = new Promise<void>((resolve) => { reachedRenderer = resolve })
    vi.mocked(requestRendererSessionSwitch).mockImplementation(() => new Promise((_resolve, reject) => {
      reachedRenderer()
      rejectRenderer = reject
    }))
    const registry = new TypedToolRegistry()
    registry.register(createSwitchSessionRegisteredTool(switchSessionExecutor))
    const permits = new InMemorySafetyPermitStore()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const registered = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission, toolRevocations: revocations,
      createExecutionContext: () => ({ ...ctx, runtimeContext: ctx } as never),
      resolveAuthorizationVersion: () => 'session-switch-policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['switch_session'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow' as const, authorizationVersion: binding.authorizationVersion })
    } })
    const route = { routeId: 'session-switch-unknown', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const providers = new ModelProviderRegistry()
    async function* chunks(...values: StreamChunk[]) { yield* values }
    let providerCalls = 0
    providers.register(route, { providerId: 'session-switch-unknown', stream: () => {
      providerCalls += 1
      return providerCalls === 1
        ? chunks({ type: 'tool-call', toolCallId: 'switch-session-unknown-call', toolName: 'switch_session', input: { session_id: target.id } }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' })
        : chunks({ type: 'text-delta', text: 'switch outcome uncertain' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    } })
    const history = new MemoryHistory()
    const running = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'switch to target session' }], maxTokens: 80, tools: [{ name: 'switch_session', description: 'switch', inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } }] },
      safetyGate, prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool,
      toolExecution: registered.toolExecution, maxModelTurns: 2, history
    })

    try {
      await rendererRequested
      expect(requestRendererSessionSwitch).toHaveBeenCalledOnce()
      expect(remoteContext.outboundSessionId).toBe(caller.id)
      expect(revocations.revokeToolForLane('feishu', 'switch_session')).toBe(1)
      rejectRenderer(new Error('renderer acknowledgement lost after request dispatch'))

      await expect(running).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
      const events = (await history.read(invocationId)).events
      expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
      expect(providerCalls).toBe(1)
      expect(remoteContext.outboundSessionId).toBe(caller.id)
      expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    } finally {
      rejectRenderer?.(new Error('test cleanup'))
      vi.mocked(requestRendererSessionSwitch).mockReset().mockResolvedValue({ desktopSwitched: true, viewChanged: true })
    }
  })
})
