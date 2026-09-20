import { createAgentRuntime } from './runtime/agentRuntime'
import { setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'

/**
 * electron 项目测试装配(P8):每个测试文件加载时装配默认 runtime——
 * 生产由 main.ts 装配(db 化准入状态等);测试组件为内联最小结构实现(零额外 import——
 * 本文件先于测试文件 mock 注册加载,任何业务链 import 都会把真实模块图抢先实例化,
 * 导致后续 vi.mock('electron') 对已实例化模块失效,实测 readAppLocale app undefined)。
 * 审计未注入 → agentLogger 未初始化时降级 NOOP。
 */
setDefaultAgentRuntime(
  createAgentRuntime({
    confirmIds: {
      allocate: () => Math.random().toString(36).slice(2, 6).toUpperCase(),
      release: () => undefined,
      isInUse: () => false,
      clear: () => undefined
    },
    chatCancels: {
      register: () => new AbortController().signal,
      signalChatCancel: () => undefined,
      clear: () => undefined,
      throwIfCancelled: () => undefined,
      cancelAllActiveChats: () => undefined
    },
    toolRevocations: {
      registerToolRevocationRequest: () => undefined,
      revokeToolForLane: () => 0,
      revokeToolForAllLanes: () => 0,
      isToolRevoked: () => false,
      clearToolRevocationRequest: () => undefined
    },
    mcpGate: { run: <T>(_serverId: string, fn: () => Promise<T>) => fn() }
  })
)
