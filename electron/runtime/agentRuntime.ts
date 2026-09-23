import { randomUUID } from 'crypto'
import type { AuditSink } from '../confirmation/audit'

/**
 * Agent Runtime 纯工厂(A2,偏差 18;P8 结构解环):本模块零业务 import——
 * 组件实现全部注入;桌面组装(六组件类 + 审计目录 + 内置注册表)集中在
 * agentRuntimeDefaults.ts(默认槽位所在,兼容转发打到这里)。
 * 环纪律:六原模块 → defaults → 本模块;本模块不回指(否则 CJS 加载环,
 * 已在 imChannel/confirmId 链实测「Class extends value undefined」)。
 */

/** runtime 持有的审计出口:真实 SecurityAuditLog 或 agentLogger 未初始化时的 NOOP。 */
export interface RuntimeAudit extends AuditSink {
  setRetentionDays(days: number): void
  getRetentionDays(fallback?: number): number
}

const AUDIT_NOOP: RuntimeAudit = {
  record: () => undefined,
  setRetentionDays: () => undefined,
  getRetentionDays: (fallback = 180) => fallback
}

export const DEFAULT_AUDIT_FALLBACK_RETENTION_DAYS = 180

/** 组件最小面(结构类型;桌面类/包纯核类均满足)。 */
export interface ConfirmIdSpaceLike {
  allocate(maxAttempts?: number): string
  release(id: string): void
  isInUse(id: string): boolean
  clear(): void
}

export interface ChatCancelRegistryLike {
  register(requestId: string): AbortSignal
  signalChatCancel(requestId: string): void
  clear(requestId: string): void
  throwIfCancelled(signal: AbortSignal): void
  cancelAllActiveChats(): void
}

export interface ToolRevocationRegistryLike {
  registerToolRevocationRequest(requestId: string, lane: string): void
  revokeToolForLane(lane: string, toolName: string): number
  revokeToolForAllLanes(toolName: string): number
  isToolRevoked(requestId: string, toolName: string): boolean
  clearToolRevocationRequest(requestId: string): void
}

export interface McpConcurrencyGateLike {
  run<T>(serverId: string, fn: () => Promise<T>): Promise<T>
}

export interface BuiltinRegistryLike {
  getLegacyExecutor(name: string): unknown
  get(name: string): unknown
}

export interface ApprovalAdmissionLike {
  acquire(request: { requestId: string; parentTaskId: string; deadlineAt?: number }): Promise<
    | { kind: 'granted'; release(): void }
    | { kind: 'rejected'; cause: string }
  >
  cancel(requestId: string): boolean
}

export interface InvocationRuntimeLike {
  acquireLease(invocationId: string): InvocationLeaseLike
  park(invocationId: string, lease: InvocationLeaseLike, checkpoint?: unknown): InvocationParkHandleLike | undefined
  resumeLease(handle: InvocationParkHandleLike): InvocationLeaseLike | undefined
}

export interface ResourceLockRegistryLike {
  acquire(keys: readonly string[], options?: { signal?: AbortSignal }): Promise<{ release(): void }>
}

export interface InvocationLeaseLike {
  runtimeId: string
  invocationId: string
  generation: number
  release(): void
}

export interface InvocationParkHandleLike {
  runtimeId: string
  invocationId: string
  generation: number
  checkpoint: unknown
}

export interface AgentRuntimeComponents {
  audit?: RuntimeAudit
  /** 桌面:审计惰性构造(agentLogger 目录未就绪时返回 null → NOOP);缺省 NOOP。 */
  auditFactory?: () => RuntimeAudit | null
  confirmIds?: ConfirmIdSpaceLike
  chatCancels?: ChatCancelRegistryLike
  toolRevocations?: ToolRevocationRegistryLike
  mcpGate?: McpConcurrencyGateLike
  builtinRegistry?: BuiltinRegistryLike
  approvalAdmission?: ApprovalAdmissionLike
  invocationRuntime?: InvocationRuntimeLike
  resourceLocks?: ResourceLockRegistryLike
  toolExecutionConcurrency?: number
}

export interface AgentRuntime {
  instanceId: string
  readonly audit: RuntimeAudit
  setAuditRetentionDays(days: number): void
  getAuditRetentionDays(fallback?: number): number
  resetAuditForTests(): void
  readonly confirmIds: ConfirmIdSpaceLike
  readonly chatCancels: ChatCancelRegistryLike
  readonly toolRevocations: ToolRevocationRegistryLike
  readonly mcpGate: McpConcurrencyGateLike
  readonly builtinRegistry: BuiltinRegistryLike
  readonly approvalAdmission: ApprovalAdmissionLike
  readonly invocationRuntime: InvocationRuntimeLike
  readonly resourceLocks: ResourceLockRegistryLike
  readonly toolExecutionConcurrency: number
}

const EMPTY_REGISTRY: BuiltinRegistryLike = {
  getLegacyExecutor: () => undefined,
  get: () => undefined
}

export function createAgentRuntime(components: AgentRuntimeComponents = {}): AgentRuntime {
  let auditInstance: RuntimeAudit | null = null
  let auditRetentionDays: number | null = null

  function ensureAudit(): RuntimeAudit {
    if (auditInstance) return auditInstance
    const built = components.audit ?? (components.auditFactory ? components.auditFactory() : null)
    auditInstance = built ?? AUDIT_NOOP
    if (auditRetentionDays != null) auditInstance.setRetentionDays(auditRetentionDays)
    return auditInstance
  }

  return {
    instanceId: randomUUID(),
    confirmIds: components.confirmIds ?? {
      allocate: () => '',
      release: () => undefined,
      isInUse: () => false,
      clear: () => undefined
    },
    chatCancels: components.chatCancels ?? {
      register: () => new AbortController().signal,
      signalChatCancel: () => undefined,
      clear: () => undefined,
      throwIfCancelled: () => undefined,
      cancelAllActiveChats: () => undefined
    },
    toolRevocations: components.toolRevocations ?? {
      registerToolRevocationRequest: () => undefined,
      revokeToolForLane: () => 0,
      revokeToolForAllLanes: () => 0,
      isToolRevoked: () => false,
      clearToolRevocationRequest: () => undefined
    },
    mcpGate: components.mcpGate ?? { run: (_serverId, fn) => fn() },
    builtinRegistry: components.builtinRegistry ?? EMPTY_REGISTRY,
    approvalAdmission: components.approvalAdmission ?? {
      // 纯契约/宿主迁移测试的兼容适配：不创建第二份配额账本；生产桌面 runtime 必须显式注入真实池。
      acquire: async () => ({ kind: 'granted' as const, release: () => undefined }),
      cancel: () => false
    },
    invocationRuntime: components.invocationRuntime ?? {
      acquireLease: (invocationId) => ({ runtimeId: 'noop', invocationId, generation: 0, release: () => undefined }),
      park: () => undefined,
      resumeLease: () => undefined
    },
    resourceLocks: components.resourceLocks ?? { acquire: async () => ({ release: () => undefined }) },
    toolExecutionConcurrency: components.toolExecutionConcurrency ?? 2,
    get audit() {
      return ensureAudit()
    },
    setAuditRetentionDays(days: number): void {
      if (Number.isFinite(days) && days > 0) auditRetentionDays = Math.floor(days)
      if (auditInstance) auditInstance.setRetentionDays(days)
    },
    getAuditRetentionDays(fallback: number = DEFAULT_AUDIT_FALLBACK_RETENTION_DAYS): number {
      if (auditInstance) return auditInstance.getRetentionDays()
      return auditRetentionDays ?? fallback
    },
    resetAuditForTests(): void {
      auditInstance = null
      auditRetentionDays = null
    }
  }
}
