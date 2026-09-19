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
import type { DecisionCacheView, ExecutionLane, PolicyRule } from '../confirmation/types'

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
    /** P7（偏差 16）：按调用裁剪——allow 封闭集（列表外无效）/ deny 收窄；只落工具集，不落提示词。 */
    trim?: { allow?: readonly string[]; deny?: readonly string[] }
  }
  /** 显式 lane（偏差 21）：缺省回退 driverContext 推导，最终 desktop。 */
  lane?: ExecutionLane
  /** P4（偏差 6）：思维强度分档；发起时解析、调用内冻结（兼容映射 true → 'medium'）。 */
  reasoning?: AgentReasoningProfile
}

/** 思维强度档位：off 为零成本档（子调用默认）。 */
export type AgentReasoningEffort = 'off' | 'low' | 'medium' | 'high'

export interface AgentReasoningProfile {
  effort: AgentReasoningEffort
  /** 宿主按定死规则降级的留痕（fail-loud 不静默换档）。 */
  degraded?: { from: AgentReasoningEffort; to: AgentReasoningEffort }
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
  /** P4（偏差 5）：网络目标留在宿主绑定，不进可序列化契约；可声明层只有模型意图。 */
  networkTarget?: { baseUrl?: string }
}

/** loadContext 装载的会话原始材料（只装载不装配；裁剪与注入留在 Core）。 */
export interface AgentLoadedSessionContext {
  /** electron 侧为 Session['metadata']。 */
  metadata?: unknown
}

/** 真相类持久化端口：失败 = 调用显式失败 + 可区分错误码 + 审计，不允许静默 no-op。 */
export interface AgentPersistPorts {
  /** 会话元数据写（recovery skill 激活等）。 */
  updateSessionMetadata?(sessionId: string, patch: Record<string, unknown>): void
  /** 标题建议生成与落库。 */
  scheduleTitleSuggestion?(input: Record<string, unknown>): void
  /** 人类确认后的会话级信任双写 decision_cache（browser navigate / act）。 */
  recordUserAnswerFromDecision?(input: Record<string, unknown>): void
}

/** 宿主存储端口（P2）：loadContext 材料 + 真相类写 + 压缩事务。 */
export interface AgentStoragePorts {
  /** 装配期 loadContext 装载的会话材料。 */
  loaded?: AgentLoadedSessionContext
  /** 现读通道（循环内消费点需要最新值，如浮动通知的会话名）。 */
  readSession?(sessionId: string): unknown
  persist?: AgentPersistPorts
  appendCompactionTransaction?(start: Record<string, unknown>, summary: Record<string, unknown>): Promise<unknown>
}

/** 暴露面规则（装配期解析；与门控 effectiveRules 同机制）。 */
export interface AgentExposurePorts {
  rules?: readonly PolicyRule[]
}

/** MCP 装配材料（P2）：快照装配期构建；执行器与连接管理走端口。 */
export interface AgentMcpPorts {
  /** electron 侧为 McpToolSnapshot；无库宿主为空快照。 */
  snapshot: unknown
  /** electron 侧为 (toolName, manager) => ToolExecutor | undefined。 */
  resolveExecutor?(toolName: string, manager: unknown): unknown
  /** 工具执行上下文的宿主库（工具实现的装配材料，非 Core 依赖）。 */
  executorDatabase?: unknown
}

/** 用量观察类端口：失败降级重试、不改执行结论，但不得静默。 */
export interface AgentUsagePorts {
  recordStepUsage?(input: Record<string, unknown>): void
  recordTurnSummary?(input: Record<string, unknown>): void
}

/** 诊断观察类端口（MCP 连接诊断）。 */
export interface AgentDiagnosticsPorts {
  append(serverId: string, entry: unknown): void
}

/** 回答者装配材料（P2 装配期解析；P5 接线 factsProvider 时收口）。 */
export interface AgentAnswererPorts {
  /** electron 侧为 LaneAnswererPolicy。 */
  policy?: unknown
  /** 审批子链的宿主库装配材料（子调用域，随块 4 收敛）。 */
  approvalDatabase?: unknown
}

/**
 * 门控端口材料（B1）：装配期解析注入；门控缺料 = 调用失败 + 审计（fail-loud）。
 * 无库宿主（内存端口）必须显式提供默认材料并留痕，不得依赖门控侧回退。
 */
export interface AgentPolicyPorts {
  effectiveRules: readonly PolicyRule[]
  /** electron 侧为 GateDecisionCache（lookup + 写/清理族的完整形状）。 */
  decisionCache: unknown
  shellPrecheck: { touchTrustedCommand: (command: string) => void }
  /** P3：规则来源标注（键 = 规则 id），随门控入参透传、落审计 ruleOrigin。 */
  policyOrigins?: Record<string, { source: 'builtin' | 'package' | 'user-override' | 'migration' }>
}

/** 宿主端口集合（P1 立骨架，P2 起承接 storage / usage / tools 等实现）。 */
export interface AgentHostPorts {
  /** P2（B1）：门控与暴露面规则的装配期材料。 */
  policy?: AgentPolicyPorts
  /** P2：loadContext / persist（真相类）。 */
  storage?: AgentStoragePorts
  /** P2：暴露面规则（装配期解析）。 */
  exposure?: AgentExposurePorts
  /** P2：MCP 快照与执行器（装配期构建）。 */
  mcp?: AgentMcpPorts
  /** P2：用量落库（观察类）。 */
  usage?: AgentUsagePorts
  /** P2：MCP 连接诊断（观察类）。 */
  diagnostics?: AgentDiagnosticsPorts
  /** P2：回答者策略与审批装配材料。 */
  answerer?: AgentAnswererPorts
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
  /** electron 侧为 ContextMeter（Core 以 session event ledger 提供的测量适配器）。 */
  contextMeter?: unknown
  /** 成功完成 provider 请求后，在下一轮发送前执行 turn-boundary 规划。 */
  turnBoundary?: (input: unknown) => Promise<void>
}

/** 调用结果（本期先落形状：ok/cancelled 布尔的四态化在后续阶段收敛为 status）。 */
export type AgentInvocationResult =
  | { ok: true; content: unknown[]; stopReason: string; usage?: unknown; finalSurfaceSnapshot?: unknown; finalSurfaceMessages?: unknown[] }
  | { ok: false; error: string; usage?: unknown; cancelled?: boolean }
