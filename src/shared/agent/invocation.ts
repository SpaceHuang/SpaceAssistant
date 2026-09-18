import type { AssistantFactEvent } from '../assistantFactAggregator'
import type { BrowserDetectContext } from '../browserTypes'
import type { FileTreeChangeEvent } from '../fileTreeSync'
import type { Session } from '../domainTypes'
import type {
  BrowserConfig,
  FeishuConfig,
  ShellConfig,
  ToolsConfig,
  WeChatConfig,
  WikiConfig
} from '../domainTypes'
import type { ExecutionLane } from '../confirmation/types'

/**
 * Agent 调用契约（基线 §6.2；本计划 P1 落形）。
 *
 * 契约只放可序列化数据与消息；宿主能力一律经 AgentHostPorts 接口注入（SDK 决策 §6
 * 硬约束 1「契约禁函数句柄」、2「端口一律接口」）。
 *
 * 本文件位于 shared，不能引用 electron 侧类型；electron 专属类型（消息块结构、
 * SessionEventInput、RemoteContext、WorkDirManager、AppDatabase、ContextMeter）在此以
 * unknown / 最小结构占位，由 electron 侧装配器（invocationAssembler）与 Core 展开层
 * 负责收窄——cast 集中在这两处，不进循环体。
 */

/** 请求追踪（requestId / turnId / windowId 归此）。 */
export interface AgentTraceContext {
  requestId: string
  /** 本回合真实 Turn ID；缺省回退 sessionId 占位。 */
  turnId?: string
  /** 宿主 UI 簿记（P2 后评估移出契约、由出口实现持有）。 */
  windowId?: string
}

/** 会话锚点：本期只承载既有会话 id（新建会话的归属声明随块 4 接入）。 */
export interface AgentSessionAnchor {
  sessionId: string
}

/** 可序列化消息（electron 侧为 ClaudeContentBlockMessage）。 */
export type AgentMessageLike = { role: 'user' | 'assistant'; content: unknown; id?: string }

/** 本次新增输入（历史不经此传入——P2 起经 loadContext 装载）。 */
export interface AgentMessagesSection {
  list: readonly AgentMessageLike[]
  /** 当轮 user 消息 id（tool loop 日志等）。 */
  currentUserMessageId?: string
  assistantMessageId?: string
  hasImageAttachments?: boolean
}

/** 模型档（解析结果冻结快照语义保留；P4 换 reasoning.effort 并移出 baseUrl）。 */
export interface AgentInvocationProfile {
  model: string
  /** 冻结执行配置里的 LLM 服务 ID（DIM3：同模型跨服务分开统计）。 */
  llmServiceId?: string
  contextWindow?: number
  /** P4 移出契约：网络目标与凭据留在宿主解析结果（ports.credentials）。 */
  baseUrl?: string
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  locale?: string
  projectMemoryEnabled?: boolean
  skillFragments?: string[]
  /** 宿主已解析的装配材料；P7 改造为按调用的能力集裁剪。 */
  tools: {
    toolsConfig: ToolsConfig
    browserConfig?: BrowserConfig
    shellConfig?: ShellConfig | null
    wikiConfig?: WikiConfig
    feishuConfig?: FeishuConfig
    wechatConfig?: WeChatConfig
    /** electron 侧为 LarkCliRunner。 */
    larkCliRunner?: unknown
  }
  /** 显式 lane（偏差 21）：缺省回退 driverContext 推导，最终 desktop。 */
  lane?: ExecutionLane
}

/**
 * 出口对象（分组事件出口；允许全 no-op）。
 * notify 取代 floatingNotificationManager 直传（基线 §5.5 收口，偏差 1 尾巴）。
 */
export interface AgentEventSink {
  /** 统一消息事实迁移端口（必填语义保留；无观察者时传 no-op）。 */
  onFact(event: AssistantFactEvent): void
  /** Core 事件台账写入口（必填语义保留；与 UI fact 通道分离）。 */
  onSessionEvent(event: unknown): void | Promise<void>
  /** 文件树失效通知出口；未传即 no-op。 */
  onFileTreeChanged?(event: FileTreeChangeEvent): void
  /** 会话标题落库完成后的界面通知出口；未传即 no-op（落库照常）。 */
  onTitleGenerated?(session: Session): void
  /** 浮动通知出口：宿主把 FloatingNotificationManager 包装为此实现。 */
  notify?(event: AgentNotifyEvent): void
}

/** 浮动通知出口载荷（宿主实现分发到 FloatingNotificationManager 对应方法）。 */
export type AgentNotifyEvent =
  | {
      kind: 'confirm-request'
      requestId: string
      sessionId: string
      sessionName: string
      toolUseId: string
      toolName: string
      input: unknown
    }
  | { kind: 'tool-result'; requestId: string; toolUseId: string }
  | { kind: 'request-all-cancelled'; requestId: string }

/** 单次调用内上界（跑道字段按需扩展：时长、token、调用内并发）。 */
export interface AgentInvocationLimits {
  /** 工具执行轮数上界（现 maxToolLoopRounds）；缺省不限。 */
  maxToolRounds?: number
}

/** Safety 协议字段：递归守卫标记（取值代码写死，不可配置——不可变集语义）。 */
export interface AgentInvocationSafety {
  /** 仅审批执行链传入 'approval-agent'。 */
  recursionGuard?: 'approval-agent'
}

/** 可寻址附加材料（键值对）。 */
export const AGENT_ADDITIONAL_CONTEXT_KEYS = {
  approvalTaskDigest: 'approval.taskDigest',
  historyFacts: 'facts.history'
} as const

/** 驱动源上下文（IM 来源等；electron 侧为 RemoteContext）。 */
export type AgentDriverContext = unknown

/** Agent 调用入参（基线 §6.2 形状；steering 按基线明确预留、本期不实现）。 */
export interface AgentInvocation {
  session: AgentSessionAnchor
  messages: AgentMessagesSection
  profile: AgentInvocationProfile
  events: AgentEventSink
  limits: AgentInvocationLimits
  /** 取消信号（跑道字段；本期由 chatCancelRegistry 承担）。 */
  signal?: { aborted: boolean }
  /** 幂等键（跑道字段；消费方随块 4 准入接入）。 */
  clientId?: string
  additionalContext: Readonly<Record<string, unknown>>
  trace: AgentTraceContext
  safety: AgentInvocationSafety
  driverContext?: AgentDriverContext
}

/** 宿主端口：workspace（工作区锚点）。 */
export interface AgentWorkspacePorts {
  workDir: string
  /** electron 侧为 WorkDirManager。 */
  workDirManager?: unknown
  resolveWorkDir?: () => string
  userDataDir: string
}

/** 宿主端口：凭据（接口方法，不是闭包——SDK 决策 §6 硬约束 2）。 */
export interface AgentCredentialsPorts {
  resolveApiKey(): Promise<string | null>
}

/** 宿主端口：上下文台账写（压缩事务；真相类，P2 正式归入 ports.storage）。 */
export interface AgentStoragePorts {
  appendCompactionTransaction?(start: Record<string, unknown>, summary: Record<string, unknown>): Promise<unknown>
}

/** 宿主端口集合（P1 立骨架，P2 起承接 storage / usage / tools 等实现）。 */
export interface AgentHostPorts {
  workspace: AgentWorkspacePorts
  credentials: AgentCredentialsPorts
  /**
   * P1 过渡例外（评审 N1）：appDb 原样透传给循环体内既有取用路径，
   * 是「端口一律接口」唯一声明的过渡豁免期；P2 删除并切换为 ports.storage 系列。
   *
   * @deprecated P2 删除
   */
  legacy?: { appDb?: unknown }
  hostFacts?: {
    getBrowserDetectContext?(): BrowserDetectContext
  }
  storage?: AgentStoragePorts
  /** electron 侧为 ContextMeter（Core 以 session event ledger 提供的测量适配器）。 */
  contextMeter?: unknown
  /** 成功完成 provider 请求后，在下一轮发送前执行 turn-boundary 规划。 */
  turnBoundary?: (input: unknown) => Promise<void>
}

/** 调用结果（本期先落形状：ok/cancelled 布尔的四态化在后续阶段收敛为 status）。 */
export type AgentInvocationResult =
  | { ok: true; content: unknown[]; stopReason: string; usage?: unknown; finalSurfaceSnapshot?: unknown; finalSurfaceMessages?: unknown[] }
  | { ok: false; error: string; usage?: unknown; cancelled?: boolean }
