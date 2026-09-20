import { randomUUID } from 'crypto'
import { ConfirmIdSpace, ChatCancelRegistry, ToolRevocationRegistry } from './components'
import { McpConcurrencyGate } from './semaphore'

/**
 * createAgentRuntime(A2,偏差 18;A3,偏差 19):SDK 面的 runtime 工厂——
 * 纯 node 可用,不启动 Electron、不依赖宿主;全部跨调用可变状态随实例走
 * (SDK 决策 §6 硬约束 3:多实例 / instanceId)。
 * 组件可逐项覆盖注入(宿主绑定 SQLite 审计 / 内置工具注册表等桌面能力);
 * 缺省组件为纯核实现(确认空间 / 取消 / 撤回 / MCP 闸 / 空注册表 / no-op 审计)。
 */

export interface RuntimeAudit {
  record(event: { type?: string; [key: string]: unknown }): void
  setRetentionDays(days: number): void
  getRetentionDays(fallback?: number): number
}

export const NOOP_AUDIT: RuntimeAudit = {
  record: () => undefined,
  setRetentionDays: () => undefined,
  getRetentionDays: (fallback = 180) => fallback
}

/** 内置工具注册表最小面(宿主注入 TypedToolRegistry 或等价物;SDK 纯核缺省空实现)。 */
export interface BuiltinRegistryLike {
  getLegacyExecutor(name: string): unknown
  get(name: string): unknown
}

const EMPTY_REGISTRY: BuiltinRegistryLike = {
  getLegacyExecutor: () => undefined,
  get: () => undefined
}

export interface AgentRuntimeComponents {
  audit?: RuntimeAudit
  confirmIds?: ConfirmIdSpace
  chatCancels?: ChatCancelRegistry
  toolRevocations?: ToolRevocationRegistry
  mcpGate?: McpConcurrencyGate
  builtinRegistry?: BuiltinRegistryLike
}

export interface AgentRuntime {
  instanceId: string
  readonly audit: RuntimeAudit
  readonly confirmIds: ConfirmIdSpace
  readonly chatCancels: ChatCancelRegistry
  readonly toolRevocations: ToolRevocationRegistry
  readonly mcpGate: McpConcurrencyGate
  readonly builtinRegistry: BuiltinRegistryLike
}

export function createAgentRuntime(components: AgentRuntimeComponents = {}): AgentRuntime {
  const audit = components.audit ?? NOOP_AUDIT
  return {
    instanceId: randomUUID(),
    audit,
    confirmIds: components.confirmIds ?? new ConfirmIdSpace(),
    chatCancels: components.chatCancels ?? new ChatCancelRegistry(),
    toolRevocations: components.toolRevocations ?? new ToolRevocationRegistry(),
    mcpGate: components.mcpGate ?? new McpConcurrencyGate(),
    builtinRegistry: components.builtinRegistry ?? EMPTY_REGISTRY
  }
}
