import { describe, expect, it } from 'vitest'
import { createDesktopAgentRuntime } from './desktopAgentRuntime'
import { setDefaultAgentRuntime, getDefaultAgentRuntime } from './agentRuntimeDefaults'
import { getToolExecutor, getRegisteredTool } from '../tools/builtinExecutors'
import { allocateConfirmId, isConfirmIdInUse } from '../remote/confirmId'

/**
 * 生产装配 smoke(P0 修复验收,评审 batch3-runtime-admission-sdk-review):
 * 断言桌面组装的组件是真实行为而非 no-op 桩——本文件**不依赖** testSetup 的装配
 * (直接构造 createDesktopAgentRuntime 并覆盖槽位),生产路径 main.ts 用的同一工厂。
 */
describe('createDesktopAgentRuntime(生产装配 smoke)', () => {
  it('builtinRegistry 可解析真实内置工具(非 EMPTY_REGISTRY 未知工具分支)', () => {
    const rt = createDesktopAgentRuntime()
    expect(rt.builtinRegistry.getLegacyExecutor('run_shell')).toBeDefined()
    expect(rt.builtinRegistry.get('run_shell')).toBeDefined()
    expect(rt.instanceId).toBeTruthy()
  })

  it('槽位覆盖后,兼容转发链(getToolExecutor/getRegisteredTool)解析到同一真实注册表', () => {
    const rt = createDesktopAgentRuntime()
    setDefaultAgentRuntime(rt)
    expect(getRegisteredTool('run_shell')).toBe(rt.builtinRegistry.get('run_shell'))
    expect(getToolExecutor('run_shell')?.name).toBe('run_shell')
    resetSlot()
  })

  it('confirmIds 分配非空 id 且占用语义生效(非空串桩)', () => {
    const rt = createDesktopAgentRuntime()
    const id = rt.confirmIds.allocate()
    expect(id).not.toBe('')
    expect(rt.confirmIds.isInUse(id)).toBe(true)
    // 兼容转发链同样真实
    setDefaultAgentRuntime(rt)
    const legacyId = allocateConfirmId()
    expect(legacyId).not.toBe('')
    expect(isConfirmIdInUse(legacyId)).toBe(true)
    resetSlot()
  })

  it('chatCancels.register 返回真实可中止 signal(非永不 abort 桩)', () => {
    const rt = createDesktopAgentRuntime()
    const signal = rt.chatCancels.register('smoke-req')
    rt.chatCancels.signalChatCancel('smoke-req')
    expect(signal.aborted).toBe(true)
    resetSlot()
  })

  it('toolRevocations 撤回事实生效(非恒 false 桩)', () => {
    const rt = createDesktopAgentRuntime()
    rt.toolRevocations.registerToolRevocationRequest('rev-req', 'desktop')
    rt.toolRevocations.revokeToolForLane('desktop', 'run_shell')
    expect(rt.toolRevocations.isToolRevoked('rev-req', 'run_shell')).toBe(true)
    resetSlot()
  })
})

function resetSlot(): void {
  // 恢复 testSetup 的装配,避免影响同文件后续用例(逐文件独立进程,防御性即可)
  try {
    setDefaultAgentRuntime(getDefaultAgentRuntime())
  } catch {
    // 未装配则不管
  }
}
