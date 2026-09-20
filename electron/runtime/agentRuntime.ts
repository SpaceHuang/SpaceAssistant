import { randomUUID } from 'crypto'
import {
  createSecurityAuditLog,
  resolveSecurityAuditLogDir,
  type AuditSink
} from '../confirmation/audit'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { ConfirmIdSpace } from '../remote/confirmId'
import { McpConcurrencyGate } from '../mcp/mcpToolExecutor'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'

/**
 * Agent Runtime(A2,偏差 18):一个进程可多实例并存——全部跨调用可变状态随实例走,
 * 不再散落模块级单例(singleton / registry / semaphore 池 / confirmId 空间 / 取消与撤回注册表)。
 *
 * - SDK 入口:`createAgentRuntime(deps)`;桌面宿主在 main.ts 创建单例并
 *   `setDefaultAgentRuntime` 装配(行为等价:今天本来就是一个进程一个 runtime);
 * - 各原模块的旧全局函数是**兼容转发**(显式 @deprecated,一个发布周期,P8 评估删除):
 *   转发打到默认 runtime——宿主进程内旧消费方自动落到装配实例;
 * - 本模块的 default 槽位是兼容转发机制本身,不是新增业务全局态(基线 §5 纪律 4)。
 */

/** runtime 持有的审计出口:真实 SecurityAuditLog 或 agentLogger 未初始化时的 NOOP。 */
export interface RuntimeAudit extends AuditSink {
  setRetentionDays(days: number): void
  getRetentionDays(fallback?: number): number
}

const AUDIT_NOOP: RuntimeAudit = {
  record: () => undefined,
  setRetentionDays: () => undefined,
  getRetentionDays: () => DEFAULT_AUDIT_FALLBACK_RETENTION_DAYS
}

const DEFAULT_AUDIT_FALLBACK_RETENTION_DAYS = 180

export interface AgentRuntimeDeps {
  /** 审计日志目录;缺省复用 agentLogger 目录(未初始化时 audit 降级 NOOP,与原 singleton 语义一致)。 */
  auditLogDir?: string
}

export interface AgentRuntime {
  /** 实例标识(SDK 决策 §6 硬约束 3:多实例 / instanceId)。 */
  instanceId: string
  /** 确认审计(agentLogger 目录未就绪时为 NOOP;惰性构造,首次访问后固定)。 */
  readonly audit: RuntimeAudit
  /** 设置页调整审计保留天数(§5.6-1);实例未建时记录配置,构造时应用。 */
  setAuditRetentionDays(days: number): void
  /** 当前生效审计保留天数。 */
  getAuditRetentionDays(fallback?: number): number
  /** 仅供测试:丢弃已构造的审计实例与保留天数配置(下次访问惰性重建)。 */
  resetAuditForTests(): void
  /** confirmId 一次性消费空间(远程确认)。 */
  readonly confirmIds: ConfirmIdSpace
  /** 聊天取消注册表(取消传播)。 */
  readonly chatCancels: ChatCancelRegistry
  /** 工具撤回注册表(lane 撤回)。 */
  readonly toolRevocations: ToolRevocationRegistry
  /** MCP 并发闸(全局 + 每服务信号量)。 */
  readonly mcpGate: McpConcurrencyGate
  /** 内置工具执行器注册表。 */
  readonly builtinRegistry: ReturnType<typeof createBuiltinToolRegistry>
}

export function createAgentRuntime(deps: AgentRuntimeDeps = {}): AgentRuntime {
  let auditInstance: RuntimeAudit | null = null
  let auditRetentionDays: number | null = null

  function ensureAudit(): RuntimeAudit {
    if (auditInstance) return auditInstance
    const logDir = deps.auditLogDir ?? resolveSecurityAuditLogDir()
    if (!logDir) return AUDIT_NOOP
    auditInstance = createSecurityAuditLog({
      logDir,
      ...(auditRetentionDays != null ? { retentionDays: auditRetentionDays } : {})
    })
    return auditInstance
  }

  return {
    instanceId: randomUUID(),
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    mcpGate: new McpConcurrencyGate(),
    builtinRegistry: createBuiltinToolRegistry(),
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

let defaultRuntime: AgentRuntime | null = null

/** 默认 runtime(兼容转发打到它;桌面宿主 main.ts 装配,行为等价单 runtime)。 */
export function getDefaultAgentRuntime(): AgentRuntime {
  return defaultRuntime ??= createAgentRuntime()
}

/** 宿主装配入口(main.ts 启动时调用一次)。 */
export function setDefaultAgentRuntime(runtime: AgentRuntime): void {
  defaultRuntime = runtime
}

/** 仅供测试重置默认 runtime。 */
export function resetDefaultAgentRuntimeForTests(): void {
  defaultRuntime = null
}
