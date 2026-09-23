/**
 * @spaceassistant/agent-core SDK 入口(A3,偏差 19):
 * exports 只暴露 createAgentRuntime 与契约类型(基线 §13)。
 * 契约层(src/shared/agent 与其纯逻辑闭包)经门面转发,物理文件暂留宿主树
 * (计划风险 #3 回退形态:宿主 CJS 直出构建链不经包名解析;护栏 CI 锁定本入口闭包零 electron)。
 */

// SDK runtime(纯 node 可用)
export {
  createAgentRuntime,
  NOOP_AUDIT,
  type AgentRuntime,
  type AgentRuntimeComponents,
  type RuntimeAudit,
  type BuiltinRegistryLike
} from './runtime/createAgentRuntime'
export {
  ConfirmIdSpace,
  ChatCancelRegistry,
  ChatCancelledError,
  CHAT_CANCELLED_MESSAGE,
  ToolRevocationRegistry,
  TOOL_REQUEST_LANES,
  type ConfirmIdSpaceLike,
  type ChatCancelRegistryLike,
  type ChatCancelLinks,
  type ToolRevocationRegistryLike
} from './runtime/components'
export { Semaphore, withSemaphore, McpConcurrencyGate } from './runtime/semaphore'
export * from './approval'
export * from './capacity'
export * from './scheduler'
export * from './resourceLock'
export * from './confirmationCommit'
export * from './history'
export * from './provider'

// 契约层(宿主树门面转发;闭包由 CI 护栏断言零 electron、零内嵌 sqlite 依赖)
export * from '../../../src/shared/agent/invocation'
