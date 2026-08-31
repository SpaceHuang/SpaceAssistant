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
  /** 远程写授权余量（只读）；reserve 扣减仍在执行链路。 */
  remoteWriteGrant?: { remainingOps: number; remainingBytes: number } | null
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
}

// ===== 事实提取层 =====
export type PathZone = 'system-dir' | 'outside-workdir' | 'sensitive-file' | 'workdir-normal'

export interface CommandFact {
  verb: string
  args: string[]
  /** 规范化签名（与缓存键同源），不落原始输入。 */
  signature?: string
  redirectTarget?: string
  pipesInto?: string
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

export type ConfirmOutcome =
  | { kind: 'approved'; memory?: CacheKey }
  | { kind: 'rejected'; memory?: CacheKey }
  | { kind: 'timeout' }
  | { kind: 'approved-with-action'; action: 'continue' | 'back-to-desktop' | 'stop' }

export interface ConfirmationChannel {
  request(req: ConfirmRequest): Promise<ConfirmOutcome>
  cancel(requestId: string): void
}

// ===== 决策缓存 =====
export type CacheKey =
  | { kind: 'shell-command'; verb: string; target?: string; level: 'exact' | 'verb+target' | 'verb' }
  | { kind: 'domain'; domain: string; level: 'domain+action' | 'domain-any-action' }
  | { kind: 'path'; path: string; level: 'file' | 'directory' | 'zone' }
  | { kind: 'mcp-tool'; serverId: string; toolName: string }
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
  actor: 'user' | 'system' | 'migration'
}

export type SecurityAuditEventKind =
  | 'policy.decision'
  | 'policy.deny-ingress'
  | 'policy.deny-exposure'
  | 'confirm.request'
  | 'confirm.outcome'
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
export type PolicyAction = 'deny' | 'allow' | 'ask' | 'auto-evaluator'
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
  /** 配置前置：值等于 equals 才命中（参数化配置引用）。 */
  configRequires?: { config: string; equals: unknown }
  /** 上下文前置：消费 ExecutionContext 中注入的只读事实。 */
  requiresContext?: { remoteWriteGrantValid?: boolean }
}

/** 策略层只读缓存视图：写缓存是执行链路的事。 */
export interface DecisionCacheView {
  lookup(key: CacheKey): DecisionCacheEntry | null
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
