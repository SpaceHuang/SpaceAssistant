import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, type AgentRuntime } from './agentRuntime'
import { ConfirmIdSpace } from '../remote/confirmId'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { McpConcurrencyGate } from '../mcp/mcpToolExecutor'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'
import {
  getDefaultAgentRuntime,
  resetDefaultAgentRuntimeForTests,
  setDefaultAgentRuntime
} from './agentRuntimeDefaults'
import { getSecurityAuditLog, resetSecurityAuditLogForTests } from '../confirmation/audit'
import {
  allocateConfirmId as legacyAllocateConfirmId,
  isConfirmIdInUse as legacyIsConfirmIdInUse,
  releaseConfirmId as legacyReleaseConfirmId
} from '../remote/confirmId'
import {
  registerChatCancel as legacyRegisterChatCancel,
  signalChatCancel as legacySignalChatCancel,
  throwIfChatCancelled
} from '../chatCancelRegistry'
import { registerToolRevocationRequest as legacyRegisterToolRevocationRequest } from '../toolRevocationRegistry'
import { getToolExecutor as legacyGetToolExecutor } from '../tools/builtinExecutors'

/**
 * A2(偏差 18):同进程两个 runtime 实例并存、互不串状态;
 * 桌面宿主装配默认 runtime 后,旧全局注册函数(兼容转发)打到同一实例(行为等价)。
 */

/** 桌面组装同款组件注入(纯工厂化后组件不再由工厂缺省构造)。 */
function makeAuditStub(): import('./agentRuntime').RuntimeAudit {
  return { record: () => undefined, setRetentionDays: () => undefined, getRetentionDays: () => 180 }
}

function assembleComponents(overrides: Parameters<typeof createAgentRuntime>[0] = {}): Parameters<typeof createAgentRuntime>[0] {
  return {
    audit: makeAuditStub(),
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    mcpGate: new McpConcurrencyGate(),
    builtinRegistry: createBuiltinToolRegistry(),
    ...overrides
  }
}

beforeEach(() => {
  setDefaultAgentRuntime(createAgentRuntime(assembleComponents()))
})

afterEach(() => {
  resetDefaultAgentRuntimeForTests()
  resetSecurityAuditLogForTests()
  vi.restoreAllMocks()
})

describe('createAgentRuntime(偏差 18:模块级状态 → 实例)', () => {
  it('两次创建得到独立实例:instanceId 不同、六类状态组件互不共享', () => {
    const a = createAgentRuntime(assembleComponents())
    const b = createAgentRuntime(assembleComponents())
    expect(a.instanceId).not.toBe(b.instanceId)
    expect(a.confirmIds).not.toBe(b.confirmIds)
    expect(a.chatCancels).not.toBe(b.chatCancels)
    expect(a.toolRevocations).not.toBe(b.toolRevocations)
    expect(a.mcpGate).not.toBe(b.mcpGate)
    expect(a.builtinRegistry).not.toBe(b.builtinRegistry)
  })

  it('confirmId 空间互不串:a 实例分配的 id 在 b 实例未占用,一次性消费语义各自独立', () => {
    const a = createAgentRuntime(assembleComponents())
    const b = createAgentRuntime(assembleComponents())
    const idA = a.confirmIds.allocate()
    expect(a.confirmIds.isInUse(idA)).toBe(true)
    expect(b.confirmIds.isInUse(idA)).toBe(false)
    a.confirmIds.release(idA)
    expect(a.confirmIds.isInUse(idA)).toBe(false)
  })

  it('取消注册表互不串:a 实例的请求不因 b 实例 cancelAll 而中止', () => {
    const a = createAgentRuntime(assembleComponents())
    const b = createAgentRuntime(assembleComponents())
    const signalA = a.chatCancels.register('req-a')
    b.chatCancels.register('req-b')
    b.chatCancels.cancelAllActiveChats()
    expect(signalA.aborted).toBe(false)
    a.chatCancels.signalChatCancel('req-a')
    expect(signalA.aborted).toBe(true)
    expect(() => throwIfChatCancelled(signalA)).toThrow()
  })

  it('工具撤回注册表互不串:a 实例登记的请求不受 b 实例撤回影响', () => {
    const a = createAgentRuntime(assembleComponents())
    const b = createAgentRuntime(assembleComponents())
    a.toolRevocations.registerToolRevocationRequest('req-a', 'desktop')
    b.toolRevocations.registerToolRevocationRequest('req-b', 'desktop')
    b.toolRevocations.revokeToolForAllLanes('run_shell')
    expect(a.toolRevocations.isToolRevoked('req-a', 'run_shell')).toBe(false)
    expect(b.toolRevocations.isToolRevoked('req-b', 'run_shell')).toBe(true)
  })

  it('MCP 并发闸语义随实例走:双实例各自闸控、互不计数', async () => {
    const a = createAgentRuntime(assembleComponents())
    const b = createAgentRuntime(assembleComponents())
    const job = (gate: AgentRuntime['mcpGate']) =>
      gate.run('srv', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return 'done'
      })
    expect(await Promise.all([job(a.mcpGate), job(b.mcpGate), job(a.mcpGate)])).toEqual(['done', 'done', 'done'])
    // 每服务闸按 serverId 键控、随实例持有
    expect(a.mcpGate.globalConcurrency).toBe(b.mcpGate.globalConcurrency)
  })

  it('内置执行器注册表随实例走:双实例各自能解析同一批内置工具', () => {
    const a = createAgentRuntime(assembleComponents())
    const b = createAgentRuntime(assembleComponents())
    for (const rt of [a, b]) {
      expect(rt.builtinRegistry.getLegacyExecutor('run_shell')).toBeDefined()
      expect(rt.builtinRegistry.get('run_shell')).toBeDefined()
    }
  })
})

describe('默认 runtime 装配与兼容转发(行为等价)', () => {
  it('setDefaultAgentRuntime 后:旧全局 confirmId / chatCancel / revocation 函数打到同一实例', () => {
    const rt = createAgentRuntime(assembleComponents())
    setDefaultAgentRuntime(rt)

    const id = legacyAllocateConfirmId()
    expect(rt.confirmIds.isInUse(id)).toBe(true)
    expect(legacyIsConfirmIdInUse(id)).toBe(true)
    legacyReleaseConfirmId(id)
    expect(rt.confirmIds.isInUse(id)).toBe(false)

    const signal = legacyRegisterChatCancel('req-legacy')
    legacySignalChatCancel('req-legacy')
    expect(signal.aborted).toBe(true)

    legacyRegisterToolRevocationRequest('req-legacy', 'desktop')
    expect(rt.toolRevocations.isToolRevoked('req-legacy', 'run_shell')).toBe(false)
  })

  it('setDefaultAgentRuntime 后:getSecurityAuditLog 返回 runtime 的审计实例', () => {
    const rt = createAgentRuntime(assembleComponents())
    setDefaultAgentRuntime(rt)
    expect(getSecurityAuditLog()).toBe(rt.audit)
    resetDefaultAgentRuntimeForTests()
  })

  it('未装配时 getDefaultAgentRuntime fail-loud;装配后稳定返回同一实例', () => {
    resetDefaultAgentRuntimeForTests()
    expect(() => getDefaultAgentRuntime()).toThrow()
    const rt = createAgentRuntime(assembleComponents())
    setDefaultAgentRuntime(rt)
    expect(getDefaultAgentRuntime()).toBe(rt)
  })

  it('旧 getToolExecutor 经默认 runtime 解析内置工具(行为等价)', () => {
    setDefaultAgentRuntime(createAgentRuntime(assembleComponents()))
    expect(legacyGetToolExecutor('run_shell')).toBeDefined()
  })
})
