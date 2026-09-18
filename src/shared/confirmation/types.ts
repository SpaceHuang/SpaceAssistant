/**
 * 工具确认机制框架 —— 跨进程共享类型（唯一真实来源）
 *
 * 依据：
 *  - docs/requirement/tool-confirmation-top-level-design-v2.md §3
 *  - docs/develop/tool-confirmation-framework-implementation-plan.md §4
 *
 * 策略层（src/shared/policy/）保持纯函数，只依赖这里声明的类型。
 * 本文件为"叶子"模块：不反向引用 domainTypes，避免与 builtinToolDefinitions 形成类型环。
 */

// ===== 动作类别 / 风险等级 =====
export type ActionClass = 'read' | 'write' | 'execute' | 'outbound'
/** 与 domainTypes.ToolRiskLevel 结构一致（均为 'low' | 'medium' | 'high'）。 */
export type RiskLevel = 'low' | 'medium' | 'high'

// ===== 执行链路 =====
/** automation 本期仅定义、不实现。 */
export type ExecutionLane = 'desktop' | 'wechat' | 'feishu' | 'automation'

/** 指令来源：只有 IM 链路能区分；desktop 恒为 direct-owner。 */
export interface OriginInfo {
  kind: 'direct-owner' | 'direct-other' | 'group'
  senderId?: string
}

/** 每次工具调用的完整上下文。 */
export interface ExecutionContext {
  lane: ExecutionLane
  origin: OriginInfo
  sessionId: string
  /** 出站写额度余量（只读，由执行链路注入）。 */
  outboundWriteBudgetRemaining?: number
  /** 套餐 B 预留：本期无人写入。 */
  declaredCapabilities?: DeclaredCapability[]
}

/** 套餐 B 预留的能力声明。 */
export interface DeclaredCapability {
  actionClass: ActionClass
  scope: string
}

/** 消息入口准入的输入事实（ingress 时机，此时尚无工具调用）。 */
export interface IngressFacts {
  lane: ExecutionLane
  origin: OriginInfo
}

// ===== 工具静态元数据 =====
export interface ToolActionDescriptor {
  toolName: string
  actionClass: ActionClass
  riskLevel: RiskLevel
  /** 启用哪些事实提取器。 */
  extractors: string[]
}

// ===== 平台注入的环境事实 =====
export interface EnvFacts {
  os: 'win32' | 'darwin' | 'linux' | string
  workDir: string
  sensitivePaths: string[]
  /**
   * 浏览器 act 的链路侧事实（当前页域名 + 高危评估结论），由执行链路注入：
   * 提取器只读 toolInput，act 的目标域名与 dangerAssessment 不在输入里。
   */
  browserAct?: { currentHost?: string; dangerous?: boolean }
}

// ===== 事实提取层 =====
export type PathZone = 'system-dir' | 'outside-workdir' | 'sensitive-file' | 'workdir-normal'

export interface CommandFact {
  verb: string
  args: string[]
  /** 规范化签名（与缓存键同源），不落原始输入。 */
  signature?: string
  /** exact trust/cache namespace，避免不同 Shell profile/dialect 复用同一命令签名。 */
  profileNamespace?: string
  redirectTarget?: string
  pipesInto?: string
  /** 连接当前命令与前一段的真实 Shell connector（如 &&、|、;）。 */
  connector?: string
  /** 当前 segment 执行前的有效工作目录。 */
  effectiveCwd?: string
}

export interface ConfirmSummarySection {
  label: string
  value: string
}

/** 确认界面/IM 文本共用同一份内容摘要。 */
export interface ConfirmSummary {
  text: string
  sections?: ConfirmSummarySection[]
}

export type FactSignal =
  | { kind: 'command-sequence'; commands: CommandFact[]; persistable?: boolean }
  | { kind: 'path-target'; path: string; zone: PathZone }
  | { kind: 'network-egress'; domains: string[] }
  | { kind: 'outbound-target'; channel: string; recipient?: string; domains?: string[] }
  | { kind: 'script-analysis'; signal: 'clean' | 'suspicious' | 'dangerous'; patterns: string[] }
  /** 脚本专属的网络命中信号（与通用 network-egress 区分，见 §5.2 规则）。 */
  | { kind: 'script-network'; patterns: string[] }
  /** 未通过 isScriptCertifiedRemoteSafe 认证时产出。 */
  | { kind: 'script-uncertified' }
  /**
   * 浏览器动作事实：动作名 + 目标域名（act 时为当前页域名，由执行链路注入 env）+
   * 高危评估结论。dangerous 映射 suspicious 档（§5.1 裁决：问而非拒）。
   */
  | { kind: 'browser-action'; action: string; host?: string; dangerous?: boolean }
  /** lark-cli 子命令读/写分类事实（复用 classifyLarkCliImpact；high_impact/unknown fail-closed 必确认）。 */
  | { kind: 'lark-subcommand'; impact: 'read' | 'write' | 'low_write' | 'high_impact' | 'unknown' }
  /** MCP 工具调用事实：携带 serverId 与原始工具名（会话信任缓存键来源）。 */
  | { kind: 'mcp-tool'; serverId: string; toolName: string }
  /** MCP 只读注解信号：server 单方面声明 `readOnlyHint === true && destructiveHint !== true` 时
   * 额外产出（payload 同 mcp-tool）。命中 `mcp-readonly-allow` 默认放行；strict 套餐自动上调为
   * ask，自定义套餐可覆盖。该信号永不进确认，不派生会话信任缓存键。
   */
  | { kind: 'mcp-readonly'; serverId: string; toolName: string }
  /**
   * toolkit.call 能力调用事实：携带能力 id 与描述符风险级（toolkitCapabilityExtractor 派生）。
   * 信号 token：`toolkit-capability`、`toolkit-capability:${id}`、`toolkit-read|toolkit-act`。
   */
  | { kind: 'toolkit-capability'; capabilityId: string; risk: 'read' | 'act' }
  | { kind: 'extraction-failed'; reason: string }
  // reserved: 沙箱迭代启用
  | { kind: 'sandbox-escape'; blockedReason: string }

export interface ContentFacts {
  toolName: string
  actionClass: ActionClass
  baseRiskLevel: RiskLevel
  signals: FactSignal[]
  summary: ConfirmSummary
}

// ===== 策略层输出 =====
export type Decision =
  | { type: 'auto-allow'; ruleId: string; cacheKey?: CacheKey; reason: string }
  | {
      type: 'require-confirm'
      ruleId: string
      riskLevel: RiskLevel
      facts: ContentFacts
      memoryTiers: MemoryTier[]
      timeoutMs: number | null
    }
  | { type: 'deny'; ruleId: string; reason: string }

// ===== 确认通道 =====
export interface MemoryTier {
  key: CacheKey
  label: string
}

export interface ConfirmRequest {
  facts: ContentFacts
  riskLevel: RiskLevel
  memoryTiers: MemoryTier[]
  timeoutMs: number | null
}

// ===== 回答者（I1：回答者与 lane 正交；I3：记忆只源于人类）=====
export type ConfirmAnswererKind = 'user' | 'agent' | 'deny'

export interface ConfirmAnswererPolicy {
  kind: ConfirmAnswererKind
  /** kind='agent' 时使用；缺省用全局唯一的审批 Profile。 */
  approvalProfileId?: string
  /** 覆盖默认超时；不得为 null——无人场景必须有上界。 */
  timeoutMs?: number
}

/** lane → 回答者配置；缺省 lane 用默认值表（desktop/wechat/feishu=user，automation 由主进程装配决定）。 */
export type ConfirmAnswererMap = Partial<Record<ExecutionLane, ConfirmAnswererPolicy>>

/** 审批裁决理由（方案 §4.5）：summary 给模型可读，evidence 仅审计侧。 */
export interface ApprovalReason {
  summary: string
  evidence?: string[]
  confidence?: 'low' | 'medium' | 'high'
}

/**
 * 风险维度（Skill v2 双维裁决，对比分析 §4-A）：裁决模型先独立评估动作的内在风险，
 * 与是否被授权无关（风险分类学见 security-approval Skill）。
 */
export type ApprovalRiskDimension = 'low' | 'medium' | 'high' | 'critical'

/**
 * 授权维度：unknown=无证据。automation 无人场景运行时上限为 low（真实人类授权信号
 * 仅 P3 桌面档位启用）；上限由 parseApprovalVerdict 的 maxAuthorization 在代码侧强制。
 */
export type ApprovalAuthorizationDimension = 'unknown' | 'low' | 'medium' | 'high'

/** 审批 Agent 裁决输出：只有两态，无中间态（输出不可解析/超时/不可用一律 deny）。 */
export type ApprovalVerdict =
  | {
      kind: 'approve'
      reason: ApprovalReason
      riskLevel?: ApprovalRiskDimension
      authorization?: ApprovalAuthorizationDimension
    }
  | {
      kind: 'deny'
      reason: ApprovalReason
      riskLevel?: ApprovalRiskDimension
      authorization?: ApprovalAuthorizationDimension
    }

/**
 * 审批调用输入（方案 §12-1 采纳：facts + 结构化线索包），不给全量会话。
 * 由执行链路从 ContentFacts 与工具输入构造。
 */
export interface ApprovalCluePack {
  toolName: string
  actionClass: ActionClass
  riskLevel: RiskLevel
  /** ConfirmSummary 纯文本摘要。 */
  summary: string
  /** 事实信号种类清单（不落原始输入全文）。 */
  signals: string[]
  targetPath?: string
  command?: string
  url?: string
  involvedFiles?: string[]
  /**
   * 已声明的任务（对比分析 §4-D，可信证据）：真实用户创建任务时的输入摘要，
   * 用于「动作是否服务于任务」的相关性判断；缺省 = 调用方无任务上下文（安全缺省）。
   * 与不可信证据分区呈现（渲染在围栏之外，见 approvalAgent.renderCluePack）。
   */
  taskDigest?: string
}

/** 一次审批 Agent 调用（I2：标准唯一；I5：由 AgentChannel 深度计数兜底递归）。 */
export interface ApprovalInvocation {
  clue: ApprovalCluePack
  lane: ExecutionLane
  sessionId: string
  requestId: string
  invocationId: string
  profileId: string
  timeoutMs: number
}

/** 审批执行链结果：ok=false 时 cause 必须可区分（I4 / 审计五问）。 */
export type ApprovalInvocationResult =
  | { ok: true; verdict: ApprovalVerdict; model?: string; usage?: Record<string, unknown> }
  | { ok: false; cause: 'timeout' | 'unavailable' | 'unparsable' | 'config-error'; summary?: string }

/**
 * 确认结束原因（审计五问之「到底拿没拿到裁决」）：fail-closed 各路径必须与 agent-deny 可区分。
 * agent-approved 为 agent 放行的显式表达（与 user-approved 在「谁批的」口径可区分）。
 */
export type ConfirmOutcomeCause =
  | 'user-approved'
  | 'user-denied'
  | 'agent-approved'
  | 'agent-deny'
  | 'unavailable'
  | 'timeout'
  | 'unparsable'
  | 'config-error'
  | 'recursion-blocked'
  | 'no-answerer'

export type ConfirmOutcome =
  | {
      kind: 'approved'
      memory?: CacheKey
      reason?: ApprovalReason
      /** 本次批准的回答者；缺省视为 user（既有桌面 / IM 路径）。非 user 不得产生任何记忆写入（I3）。 */
      answererKind?: ConfirmAnswererKind
      cause: ConfirmOutcomeCause
    }
  | {
      kind: 'rejected'
      memory?: CacheKey
      reason?: ApprovalReason
      answererKind?: ConfirmAnswererKind
      cause: ConfirmOutcomeCause
    }
  | { kind: 'timeout'; reason?: ApprovalReason; answererKind?: ConfirmAnswererKind; cause: ConfirmOutcomeCause }
  | {
      kind: 'approved-with-action'
      action: 'continue' | 'back-to-desktop' | 'stop'
      /** 用户通过三选一动作回答，归因 user-approved。 */
      cause: ConfirmOutcomeCause
    }

export interface ConfirmationChannel {
  request(req: ConfirmRequest): Promise<ConfirmOutcome>
  cancel(requestId: string): void
}

// ===== 决策缓存 =====
export type CacheKey =
  | { kind: 'shell-command'; verb: string; target?: string; level: 'exact' | 'verb+target' | 'verb' }
  | {
      kind: 'domain'
      domain: string
      level: 'domain+action' | 'domain-any-action'
      /** 会话级条目绑定 chat sessionId（等价原内存态按会话失效）；持久条目不设。 */
      sessionId?: string
    }
  | { kind: 'path'; path: string; level: 'file' | 'directory' | 'zone' }
  | {
      kind: 'mcp-tool'
      serverId: string
      toolName: string
      /** MCP 会话信任按 chat sessionId 绑定（等价 mcpSessionTrust 内存语义）。 */
      sessionId?: string
    }
  | { kind: 'remote-write'; sessionId: string }

export interface DecisionCacheEntry {
  id: string
  key: CacheKey
  decision: 'allow' | 'deny'
  lane: ExecutionLane | '*'
  scope: 'session' | 'persistent'
  createdAt: number
  lastHitAt: number
  hitCount: number
  source: 'user-confirm' | 'settings' | 'migration'
  expiresAt?: number
}

// ===== 安全审计日志 =====
export interface SecurityAuditEvent {
  ts: number
  event: SecurityAuditEventKind
  lane: ExecutionLane
  origin?: OriginInfo
  sessionId: string
  /** 请求短号（复用 allocateConfirmId），用于关联 confirm.request/outcome。 */
  requestId?: string
  toolName?: string
  actionClass?: ActionClass
  riskLevel?: RiskLevel
  /** ConfirmSummary 纯文本摘要（事实，非原始输入全文）。 */
  factsSummary?: string
  signals?: string[]
  decision?: 'auto-allow' | 'require-confirm' | 'deny'
  ruleId?: string
  reason?: string
  outcome?: 'approved' | 'rejected' | 'timeout' | 'cancelled'
  /** 用户所选档位的规范化签名文本。 */
  memoryTier?: string
  /** 规范化签名文本（与缓存键同源，可对账），不落原始输入。 */
  cacheKey?: string
  /** settings.* 事件的新旧值（JSON 序列化文本，写入前脱敏）。 */
  before?: string
  after?: string
  actor: 'user' | 'system' | 'migration' | 'agent'
  /**
   * 确认结束原因（仅 confirm.outcome 等有裁决的事件携带；与 outcome 联动，
   * fail-closed 各路径与 agent-deny 可区分）。
   */
  cause?: ConfirmOutcomeCause
  /** actor='agent' 时的归因细节（哪个 Profile / 模型 / 哪次审批调用）。 */
  actorRef?: { profileId: string; model?: string; invocationId?: string }
  /** 该事件的耗时（审批调用等有明确时长的动作，成本观测用）。 */
  latencyMs?: number
}

export type SecurityAuditEventKind =
  | 'policy.decision'
  | 'policy.deny-ingress'
  | 'policy.deny-exposure'
  | 'confirm.request'
  | 'confirm.outcome'
  | 'confirm.answerer-fallback'
  | 'cache.hit'
  | 'cache.write'
  | 'cache.clear'
  | 'cache.expire-dormant'
  | 'cache.generation-reset'
  | 'settings.policy-change'
  | 'settings.tool-toggle'
  | 'budget.exhausted'
  | `migration.${string}`

// ===== 策略层（policyEngine / defaultRules 依赖）=====
export type PolicyAction = 'deny' | 'allow' | 'ask' | 'auto-evaluator' | 'confirm-every-time'
export type PolicyWhen = 'ingress' | 'exposure' | 'invocation'

export interface PolicyRuleMatch {
  lane?: ExecutionLane[]
  origin?: OriginInfo['kind']
  /** 字符串或字符串数组（数组语义"任一命中"）。 */
  toolName?: string | string[]
  actionClass?: ActionClass
  /** 「包含」语义：所列信号全部出现在事实信号集即命中。 */
  signals?: string[]
  target?: 'owner-only'
}

export interface PolicyRule {
  id: string
  when: PolicyWhen
  match?: PolicyRuleMatch
  action: PolicyAction
  /** 系统保护条目：UI 只读、自定义套餐不可调松。 */
  locked?: boolean
  reason: string
  /** 条件放行：门控不满足即不命中（参数化配置引用，非策略层读运行时状态）。 */
  askUnless?: { config: string; equals: unknown; andMigrationComplete?: boolean }
  /** 配置前置：值等于 equals 才命中；数组语义为"全部满足"（参数化配置引用）。 */
  configRequires?: PolicyConfigRequirement | PolicyConfigRequirement[]
  /** 上下文前置：消费 ExecutionContext 中注入的只读事实。 */
  requiresContext?: { outboundWriteBudgetExhausted?: boolean }
}

/** 配置前置条件（值等于 equals 才满足）。 */
export interface PolicyConfigRequirement {
  config: string
  equals: unknown
}

/** 策略层只读缓存视图：写缓存是执行链路的事。 */
export interface DecisionCacheView {
  /** lane 透传：缓存读写按真实 lane 键控（评审 B1——automation 不得命中 desktop 用户的历史信任条目）。 */
  lookup(key: CacheKey, lane?: ExecutionLane | '*'): DecisionCacheEntry | null
}

/** 第 4 步自动审批器：批准返回 Decision，不裁决（approve:false）交还规则链。 */
export type AutoEvaluator = (
  facts: ContentFacts,
  context: ExecutionContext
) => { approve: true; reason: string } | { approve: false; reason: string }

/** decide 的求值环境：策略层保持纯函数，所有运行时输入经由依赖对象传入。 */
export interface PolicyEngineDeps {
  cache: DecisionCacheView
  /** 配置值（confirmMode / remoteScriptRequiresConfirm / deniedTools / remoteDenyOutbound 等）。 */
  config: Record<string, unknown>
  /** 迁移完成位（参数化配置引用问询）。 */
  migrationComplete: boolean
  /** 第 4 步自动审批器（可注入，缺省不裁决）。 */
  autoEvaluator?: AutoEvaluator
}
