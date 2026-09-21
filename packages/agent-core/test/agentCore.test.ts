import { describe, expect, it } from 'vitest'
import {
  createAgentRuntime,
  ConfirmIdSpace,
  ChatCancelRegistry,
  ChatCancelledError,
  ToolRevocationRegistry,
  McpConcurrencyGate,
  NOOP_AUDIT
} from '../src/index'
import type { AgentInvocation } from '../src/index'

/**
 * SDK 包级测试(A3,偏差 19):纯 node,不启动 Electron、不依赖宿主;
 * 断言 createAgentRuntime 的多实例语义与组件缺省/注入。
 */

describe('@spaceassistant/agent-core(纯 node,零宿主依赖)', () => {
  it('双 runtime 实例并存,状态互不串', () => {
    const a = createAgentRuntime()
    const b = createAgentRuntime()
    expect(a.instanceId).not.toBe(b.instanceId)
    const id = a.confirmIds.allocate()
    expect(a.confirmIds.isInUse(id)).toBe(true)
    expect(b.confirmIds.isInUse(id)).toBe(false)
  })

  it('组件可逐项注入覆盖', () => {
    const customAudit = { record: () => undefined, setRetentionDays: () => undefined, getRetentionDays: () => 42 }
    const rt = createAgentRuntime({ audit: customAudit, mcpGate: new McpConcurrencyGate(3, 2) })
    expect(rt.audit).toBe(customAudit)
    expect(rt.audit.getRetentionDays()).toBe(42)
    expect(rt.mcpGate.globalConcurrency).toBe(3)
  })

  it('confirmId 一次性消费语义', () => {
    const space = new ConfirmIdSpace()
    const id = space.allocate()
    expect(space.isInUse(id)).toBe(true)
    space.release(id)
    expect(space.isInUse(id)).toBe(false)
  })

  it('取消注册表:signal 中止 + throwIfCancelled 抛 ChatCancelledError', () => {
    const registry = new ChatCancelRegistry()
    const signal = registry.register('r1')
    expect(signal.aborted).toBe(false)
    registry.signalChatCancel('r1')
    expect(signal.aborted).toBe(true)
    expect(() => registry.throwIfCancelled(signal)).toThrow(ChatCancelledError)
  })

  it('撤回注册表:lane 撤回只影响该 lane 登记的请求', () => {
    const registry = new ToolRevocationRegistry()
    registry.registerToolRevocationRequest('d1', 'desktop')
    registry.registerToolRevocationRequest('w1', 'wechat')
    expect(registry.revokeToolForLane('desktop', 'run_shell')).toBe(1)
    expect(registry.isToolRevoked('d1', 'run_shell')).toBe(true)
    expect(registry.isToolRevoked('w1', 'run_shell')).toBe(false)
  })

  it('MCP 闸:每服务并发上限不被突破', async () => {
    const gate = new McpConcurrencyGate(8, 2)
    let running = 0
    let max = 0
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run('srv', async () => {
          running += 1
          max = Math.max(max, running)
          await new Promise((resolve) => setTimeout(resolve, 5))
          running -= 1
        })
      )
    )
    expect(max).toBeLessThanOrEqual(2)
  })

  it('缺省审计为 NOOP;契约类型随入口可用(类型引用可解析)', () => {
    const rt = createAgentRuntime()
    expect(rt.audit).toBe(NOOP_AUDIT)
    // 类型层消费(编译期验证入口暴露契约类型);不构造完整 invocation
    type TraceOk = AgentInvocation['trace'] extends { requestId: string } ? true : false
    const traceOk: TraceOk = true
    expect(traceOk).toBe(true)
  })
})
