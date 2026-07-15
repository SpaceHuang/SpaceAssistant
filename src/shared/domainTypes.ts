export const CURRENT_SCHEMA_VERSION = 1

import type { BrowserDependencyToolError } from './browserTypes'
import type { AppLocale } from './locale'

export type { AppLocale }

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageStatus = 'sending' | 'sent' | 'queued' | 'streaming' | 'completed' | 'failed'

export type ToolRiskLevel = 'low' | 'medium' | 'high'

export type ToolCallStatus = 'calling' | 'confirming' | 'executing' | 'completed' | 'failed' | 'rejected'

export type FileConfirmMode = 'diff' | 'direct' | 'auto'

export interface ToolsConfig {
  enabled: boolean
  confirmMode: FileConfirmMode
  allowedTools: string[]
  deniedTools: string[]
  pythonPath: string
  scriptTimeout: number
  fileCheckpointingEnabled: boolean
  maxFileSnapshots: number
  grepTimeoutSec: number
  autoApproveMaxBytes?: number
  autoApproveMaxEditChars?: number
}

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  enabled: true,
  confirmMode: 'diff',
  allowedTools: [],
  deniedTools: ['run_shell'],
  pythonPath: 'python',
  scriptTimeout: 300,
  fileCheckpointingEnabled: true,
  maxFileSnapshots: 100,
  grepTimeoutSec: 60,
  autoApproveMaxBytes: 256 * 1024,
  autoApproveMaxEditChars: 64 * 1024
}

export function mergeToolsConfig(partial?: Partial<ToolsConfig> | null): ToolsConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_TOOLS_CONFIG }
  return { ...DEFAULT_TOOLS_CONFIG, ...partial }
}

export interface BrowserConfig {
  enabled: boolean
  env: 'LOCAL' | 'BROWSERBASE'
  allowedDomains: string[]
  trustedDomains: string[]
  allowHttp: boolean
  headless: boolean
  stagehandModel: string
  reuseActiveLlmProfile: boolean
  actionTimeoutSec: number
  idleTimeoutSec: number
  maxOutputChars: number
  maxInferencesPerRequest: number
  navigateRequiresConfirm: boolean
  actRequiresConfirm: boolean
  deniedActions: string[]
  allowRemoteSessions: boolean
  captureSubdir: string
  rateLimitEnabled: boolean
  rateLimitMinIntervalMs: number
  rateLimitPerMinute: number
  rateLimitPerHour: number
  rateLimitPerDomainPerMinute: number
  rateLimitMode: 'wait' | 'reject'
  rateLimitMaxWaitSec: number
  /** act 操作的会话级信任开关（默认 true） */
  actSessionTrustEnabled: boolean
  /** act 操作的持久化信任域名列表（跨会话生效） */
  actTrustedDomains: string[]
  /** act instruction 高风险关键词（命中则强制确认，不享受信任） */
  actHighRiskKeywords: string[]
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: true,
  env: 'LOCAL',
  allowedDomains: [],
  trustedDomains: [],
  allowHttp: true,
  headless: true,
  stagehandModel: '',
  reuseActiveLlmProfile: true,
  actionTimeoutSec: 90,
  idleTimeoutSec: 1800,
  maxOutputChars: 50000,
  maxInferencesPerRequest: 8,
  navigateRequiresConfirm: true,
  actRequiresConfirm: true,
  deniedActions: [],
  allowRemoteSessions: false,
  captureSubdir: 'browser-captures',
  rateLimitEnabled: true,
  rateLimitMinIntervalMs: 1000,
  rateLimitPerMinute: 20,
  rateLimitPerHour: 200,
  rateLimitPerDomainPerMinute: 10,
  rateLimitMode: 'wait',
  rateLimitMaxWaitSec: 30,
  actSessionTrustEnabled: true,
  actTrustedDomains: [],
  actHighRiskKeywords: [
    '支付', '付款', '转账', '结账',
    'checkout', 'pay', 'payment', 'transfer',
    '提交订单', '确认订单',
    'place order', 'submit order', 'confirm order',
    '删除', '移除', '清空',
    'delete', 'remove', 'clear', 'destroy',
    '登录', '登出', '注销',
    'login', 'logout', 'sign in', 'sign out', 'register', '注册',
    '上传', '下载', 'upload', 'download',
    '安装', '卸载', 'install', 'uninstall'
  ]
}

export function mergeBrowserConfig(partial?: Partial<BrowserConfig> | null): BrowserConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_BROWSER_CONFIG }
  return {
    ...DEFAULT_BROWSER_CONFIG,
    ...partial,
    allowedDomains: Array.isArray(partial.allowedDomains)
      ? [...partial.allowedDomains]
      : DEFAULT_BROWSER_CONFIG.allowedDomains,
    trustedDomains: Array.isArray(partial.trustedDomains)
      ? [...partial.trustedDomains]
      : DEFAULT_BROWSER_CONFIG.trustedDomains,
    deniedActions: Array.isArray(partial.deniedActions)
      ? [...partial.deniedActions]
      : DEFAULT_BROWSER_CONFIG.deniedActions,
    rateLimitEnabled: partial.rateLimitEnabled ?? DEFAULT_BROWSER_CONFIG.rateLimitEnabled,
    rateLimitMinIntervalMs:
      partial.rateLimitMinIntervalMs ?? DEFAULT_BROWSER_CONFIG.rateLimitMinIntervalMs,
    rateLimitPerMinute: partial.rateLimitPerMinute ?? DEFAULT_BROWSER_CONFIG.rateLimitPerMinute,
    rateLimitPerHour: partial.rateLimitPerHour ?? DEFAULT_BROWSER_CONFIG.rateLimitPerHour,
    rateLimitPerDomainPerMinute:
      partial.rateLimitPerDomainPerMinute ?? DEFAULT_BROWSER_CONFIG.rateLimitPerDomainPerMinute,
    rateLimitMode: partial.rateLimitMode ?? DEFAULT_BROWSER_CONFIG.rateLimitMode,
    rateLimitMaxWaitSec: partial.rateLimitMaxWaitSec ?? DEFAULT_BROWSER_CONFIG.rateLimitMaxWaitSec,
    actSessionTrustEnabled:
      partial.actSessionTrustEnabled ?? DEFAULT_BROWSER_CONFIG.actSessionTrustEnabled,
    actTrustedDomains: Array.isArray(partial.actTrustedDomains)
      ? [...partial.actTrustedDomains]
      : DEFAULT_BROWSER_CONFIG.actTrustedDomains,
    actHighRiskKeywords: Array.isArray(partial.actHighRiskKeywords)
      ? [...partial.actHighRiskKeywords]
      : DEFAULT_BROWSER_CONFIG.actHighRiskKeywords
  }
}

export type ShellRuleDecision = 'allow' | 'deny' | 'ask'

export interface ShellRule {
  id: string
  pattern: string
  decision: ShellRuleDecision
  note?: string
}

export interface ShellSecurityHints {
  requiresRiskAck: boolean
  outsideWorkDirRisk: boolean
  warnings?: string[]
  scannedPaths?: string[]
  violationCodes?: string[]
  validatorId?: string
  denyType?: 'strong' | 'weak'
  securityWarning?: string
  /** 是否可在确认卡勾选「信任此命令」 */
  canTrust?: boolean
}

/** How trailing (post-fixed-prefix) argv tokens are authorized. */
export type TrustedShellTrailingArgv = 'plain-tokens' | 'exact'

/** Provenance of a trust entry (which channel/UI created it). */
export type TrustedShellSource = 'desktop' | 'im-feishu' | 'im-wechat' | 'manual'

/**
 * Status for entries that could not be stored in the structured (v2) form:
 * - `converted-pending-review`: a legacy prefix that parses to a simple command; kept for the
 *   user to re-confirm, but MUST NOT authorize skip until reviewed.
 * - `invalid`: legacy prefix containing metasyntax / not tokenizable; never authorizes.
 */
export type TrustedShellLegacyStatus = 'converted-pending-review' | 'invalid'

/**
 * Structured (schemaVersion 2) trusted shell command. Authorization is token-boundary based
 * (executable + fixedArgvPrefix), so `npm test` never authorizes `npm testing`.
 * Legacy v1 entries only carried `command` (a startsWith prefix); those are read but require
 * conversion + review before they can skip confirmation again.
 */
export interface TrustedShellCommand {
  id: string
  /** 2 = structured. Absent / 1 = legacy prefix entry. */
  schemaVersion?: number
  executable?: string
  fixedArgvPrefix?: string[]
  trailingArgv?: TrustedShellTrailingArgv
  source?: TrustedShellSource
  createdAt: number
  lastUsedAt?: number
  expired?: boolean
  legacyStatus?: TrustedShellLegacyStatus
  /** Legacy prefix / normalized display string (kept for read + UI rendering). */
  command?: string
}

export interface AutoApproveFallback {
  reason: string
  reasonCode: string
}

export type ShellOutputMode = 'plain' | 'terminal'

export interface ShellTerminalScrollback {
  serialized?: string
  ansiText?: string
  plainText?: string
  cols: number
  rows: number
  truncated?: boolean
}

export interface ShellConfig {
  enabled: boolean
  shellDefaultTimeoutSec: number
  executable?: string
  argsPrefix?: string[]
  rules?: ShellRule[]
  maxInlineOutputBytes?: number
  customSensitivePrefixes?: string[]
  /** plain：v1 纯文本；terminal：xterm + scrollback（默认） */
  outputMode?: ShellOutputMode
  trustedCommands?: TrustedShellCommand[]
  autoAllowScriptExecution?: boolean
}

export const DEFAULT_SHELL_CONFIG: ShellConfig = {
  enabled: false,
  shellDefaultTimeoutSec: 300,
  maxInlineOutputBytes: 102400,
  outputMode: 'terminal',
  autoAllowScriptExecution: false
}

export function mergeShellConfig(partial?: Partial<ShellConfig> | null): ShellConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_SHELL_CONFIG }
  return {
    ...DEFAULT_SHELL_CONFIG,
    ...partial,
    rules: Array.isArray(partial.rules) ? [...partial.rules] : partial.rules,
    argsPrefix: Array.isArray(partial.argsPrefix) ? [...partial.argsPrefix] : partial.argsPrefix,
    customSensitivePrefixes: Array.isArray(partial.customSensitivePrefixes)
      ? [...partial.customSensitivePrefixes]
      : partial.customSensitivePrefixes,
    // Keep raw trustedCommands here; runtime normalizes via shellCommandTrust.normalizeTrustedCommandList
    trustedCommands: Array.isArray(partial.trustedCommands)
      ? [...partial.trustedCommands]
      : partial.trustedCommands
  }
}

export interface SkillsRoutingConfig {
  /** llm：大模型路由（默认）；legacy：保留旧本地匹配（回滚用） */
  mode: 'llm' | 'legacy'
  /** 是否启用 LLM 路由（autoDetect 为 true 且 mode 为 llm 时生效） */
  enabled: boolean
  /** 可选：路由专用模型 name；空则与会话模型相同 */
  model?: string
  /** 路由上下文策略 */
  context: 'none' | 'last_user_turn' | 'last_n_turns'
  contextTurns?: number
  contextMaxChars?: number
  timeoutMs?: number
  /** 是否在 catalog 中附带 triggers（默认 false） */
  includeTriggersInCatalog?: boolean
}

export const DEFAULT_SKILLS_ROUTING_CONFIG: SkillsRoutingConfig = {
  mode: 'llm',
  enabled: true,
  context: 'last_user_turn',
  contextTurns: 2,
  contextMaxChars: 2000,
  timeoutMs: 15000,
  includeTriggersInCatalog: false
}

export function mergeSkillsRoutingConfig(partial?: Partial<SkillsRoutingConfig> | null): SkillsRoutingConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_SKILLS_ROUTING_CONFIG }
  return { ...DEFAULT_SKILLS_ROUTING_CONFIG, ...partial }
}

export interface SkillsConfig {
  autoDetect: boolean
  maxConcurrent: number
  disabled: string[]
  alwaysLoad: string[]
  routing: SkillsRoutingConfig
}

export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  autoDetect: true,
  maxConcurrent: 5,
  disabled: [],
  alwaysLoad: [],
  routing: { ...DEFAULT_SKILLS_ROUTING_CONFIG }
}

export function mergeSkillsConfig(partial?: Partial<SkillsConfig> | null): SkillsConfig {
  if (!partial || typeof partial !== 'object') {
    return { ...DEFAULT_SKILLS_CONFIG, routing: { ...DEFAULT_SKILLS_ROUTING_CONFIG } }
  }
  return {
    ...DEFAULT_SKILLS_CONFIG,
    ...partial,
    disabled: Array.isArray(partial.disabled) ? [...partial.disabled] : DEFAULT_SKILLS_CONFIG.disabled,
    alwaysLoad: Array.isArray(partial.alwaysLoad) ? [...partial.alwaysLoad] : DEFAULT_SKILLS_CONFIG.alwaysLoad,
    routing: mergeSkillsRoutingConfig(partial.routing)
  }
}

export type SkillActivationSource = 'manual' | 'alwaysLoad' | 'llm' | 'feishu' | 'legacy'

export interface SkillRouteRecentMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SkillRouteResult {
  skills: SkillDefinition[]
  meta: {
    sources: Record<string, SkillActivationSource>
    llmRecommended?: string[]
    routingFailed?: boolean
    routingError?: string
    durationMs: number
    routingRequestId?: string
  }
}

export interface SkillMeta {
  name: string
  description: string
  triggers: string[]
  version: string
  author: string
}

export type SkillScope = 'project' | 'user' | 'builtin'

/** 产品内置 Skill（由应用自动安装/管理，不在设置页 Skill 列表展示） */
export const PRODUCT_BUILTIN_SKILL_NAMES = ['llm-wiki', 'browser-setup-guide', 'shell-setup-guide'] as const

/** 一次性聊天启动意图，消费后清空 */
export interface ChatLaunchIntent {
  skillName: 'browser-setup-guide'
  initialUserMessage: string
  source: 'browser-settings-repair'
  metadata?: Record<string, unknown>
}

export const BROWSER_SETUP_REPAIR_INITIAL_MESSAGE =
  '请帮我检查并修复网络访问（browser 工具）所需的浏览器依赖。'

export const BROWSER_SETUP_REPAIR_SESSION_NAME = '网络访问修复'

export function isProductBuiltinSkill(name: string): boolean {
  return (PRODUCT_BUILTIN_SKILL_NAMES as readonly string[]).includes(name)
}

/** 仅通过手动/依赖恢复链路激活，不参与 LLM Skill 路由 */
export const LLM_ROUTING_EXCLUDED_SKILL_NAMES = ['browser-setup-guide', 'shell-setup-guide'] as const

export function isLlmRoutingExcludedSkill(name: string): boolean {
  return (LLM_ROUTING_EXCLUDED_SKILL_NAMES as readonly string[]).includes(name)
}

export interface SkillDefinition {
  meta: SkillMeta
  content: string
  scope: SkillScope
  directoryPath: string
  filePath: string
  lastModified: number
}

export interface SessionSkillsState {
  manualActivated: string[]
  manualDisabled: string[]
}

export const DEFAULT_SESSION_SKILLS_STATE: SessionSkillsState = {
  manualActivated: [],
  manualDisabled: []
}

export function normalizeSessionSkillsState(state?: Partial<SessionSkillsState> | null): SessionSkillsState {
  if (!state || typeof state !== 'object') return { ...DEFAULT_SESSION_SKILLS_STATE }
  return {
    manualActivated: Array.isArray(state.manualActivated) ? [...state.manualActivated] : [],
    manualDisabled: Array.isArray(state.manualDisabled) ? [...state.manualDisabled] : []
  }
}

export interface WikiConfig {
  enabled: boolean
  rootPath: string
  hideWikiFromFileTree: boolean
  interactiveIngest: boolean
  maxBatchIngest: number
}

export const DEFAULT_WIKI_CONFIG: WikiConfig = {
  enabled: false,
  rootPath: 'llm-wiki',
  hideWikiFromFileTree: true,
  interactiveIngest: false,
  maxBatchIngest: 10
}

export function mergeWikiConfig(partial?: Partial<WikiConfig> | null): WikiConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_WIKI_CONFIG }
  return { ...DEFAULT_WIKI_CONFIG, ...partial }
}

export interface ExtensionSubdirMapEntry {
  /** 不含点，小写，如 "py"、"md" */
  extension: string
  /** 单层名，如 "Script"、"Docs"；不含路径分隔符 */
  subdir: string
}

export interface WorkspaceLayoutConfig {
  /** 总开关，默认 false */
  enabled: boolean
  /** 首次写入前确认写入目录（仅 enabled 为 true 时生效），默认 true */
  writeDirConfirmEnabled: boolean
  /** 扩展名 → 子目录映射 */
  extensionSubdirMap: ExtensionSubdirMapEntry[]
}

export const DEFAULT_WORKSPACE_LAYOUT_CONFIG: WorkspaceLayoutConfig = {
  enabled: false,
  writeDirConfirmEnabled: true,
  extensionSubdirMap: [
    { extension: 'py', subdir: 'Script' },
    { extension: 'js', subdir: 'Script' },
    { extension: 'ts', subdir: 'Script' },
    { extension: 'tsx', subdir: 'Script' },
    { extension: 'jsx', subdir: 'Script' },
    { extension: 'sh', subdir: 'Script' },
    { extension: 'md', subdir: 'Docs' },
    { extension: 'json', subdir: 'Config' }
  ]
}

export function mergeWorkspaceLayoutConfig(
  partial?: Partial<WorkspaceLayoutConfig> | null
): WorkspaceLayoutConfig {
  if (!partial || typeof partial !== 'object') {
    return {
      ...DEFAULT_WORKSPACE_LAYOUT_CONFIG,
      extensionSubdirMap: [...DEFAULT_WORKSPACE_LAYOUT_CONFIG.extensionSubdirMap]
    }
  }
  return {
    ...DEFAULT_WORKSPACE_LAYOUT_CONFIG,
    ...partial,
    extensionSubdirMap: Array.isArray(partial.extensionSubdirMap)
      ? partial.extensionSubdirMap.map((e) => ({ ...e }))
      : partial.extensionSubdirMap === null
        ? []
        : [...DEFAULT_WORKSPACE_LAYOUT_CONFIG.extensionSubdirMap]
  }
}

export interface FilePaneSectionUiState {
  fileListCollapsed: boolean
  llmWikiCollapsed: boolean
  fileListHeightRatio: number
}

export const DEFAULT_FILE_PANE_SECTION_UI: FilePaneSectionUiState = {
  fileListCollapsed: false,
  llmWikiCollapsed: false,
  fileListHeightRatio: 0.6
}

export interface WikiStatus {
  enabled: boolean
  rootPath: string
  initialized: boolean
  pageCount: number
  rawCount: number
  lastLogEntry?: string
}

export interface SessionWikiState {
  wikiModeActive: boolean
  archivedQueries: string[]
}

export const DEFAULT_SESSION_WIKI_STATE: SessionWikiState = {
  wikiModeActive: false,
  archivedQueries: []
}

export function normalizeSessionWikiState(state?: Partial<SessionWikiState> | null): SessionWikiState {
  if (!state || typeof state !== 'object') return { ...DEFAULT_SESSION_WIKI_STATE }
  return {
    wikiModeActive: Boolean(state.wikiModeActive),
    archivedQueries: Array.isArray(state.archivedQueries) ? [...state.archivedQueries] : []
  }
}

export interface SkillsCache {
  skills: SkillDefinition[]
  scannedAt: number
  workDir: string
}

export interface SkillActivationLogEntry {
  timestamp: number
  skillNames: string[]
  source: SkillActivationSource | 'auto'
  userInput?: string
  routingRequestId?: string
  llmRecommended?: string[]
  routingFailed?: boolean
  routingError?: string
}

export function builtinToolRiskLevel(name: string): ToolRiskLevel {
  switch (name) {
    case 'read_file':
    case 'list_directory':
    case 'grep':
    case 'read_feishu_attachment':
    case 'browser':
    case 'browser_detect':
    case 'list_work_dirs':
    case 'switch_work_dir':
    case 'switch_session':
      return 'low'
    case 'edit_file':
    case 'write_file':
      return 'medium'
    case 'run_script':
    case 'run_lark_cli':
    case 'run_shell':
      return 'high'
    default:
      return 'medium'
  }
}

export function builtinToolNeedsConfirmation(name: string): boolean {
  return (
    name === 'edit_file' ||
    name === 'write_file' ||
    name === 'run_script' ||
    name === 'run_lark_cli' ||
    name === 'run_shell'
  )
}

export interface AutoApprovedWriteMeta {
  path: string
  added: number
  removed: number
  bytesWritten: number
  diff?: { oldContent: string; newContent: string; oldPath: string }
}

export interface ToolCallResultPersisted {
  success: boolean
  data?: unknown
  error?: string
  dependencyRecovery?: BrowserDependencyToolError
  autoApprovedWrite?: AutoApprovedWriteMeta
}

/** 工具调用记录（持久化到消息中） */
export interface ToolCallRecord {
  id: string
  toolName: string
  input: Record<string, unknown>
  result?: ToolCallResultPersisted
  status: ToolCallStatus
  riskLevel: ToolRiskLevel
  /** 确认阶段由主进程下发的 diff，仅会话内使用 */
  confirmDiff?: { oldContent: string; newContent: string; oldPath: string }
  /** run_shell 路径/安全警示（确认卡片展示） */
  shellSecurityHints?: ShellSecurityHints
  /** 文件 auto 模式回落 diff 时的原因 */
  autoApproveFallback?: AutoApproveFallback
  confirmedAt?: number
  startedAt?: number
  completedAt?: number
  duration?: number
  /** run_shell plain 模式实时输出（最近 N 字符） */
  progressOutput?: string
  /** run_shell terminal 模式 base64 raw 增量（executing 内存，完成后清除） */
  progressOutputRaw?: string
  progressSeq?: number
  /** browser act 确认：当前页面 URL */
  currentPageUrl?: string
  /** browser act 危险信息（确认卡片展示） */
  dangerInfo?: BrowserActDangerInfo
  /** 本会话已信任该域名但本次仍需确认 */
  sessionTrustedHint?: true
  /** 反序列化失败等导致的数据损坏标记，重建时生成合成错误占位 */
  corrupted?: boolean
  /** 应用崩溃中断后由启动清理降级 */
  interrupted?: boolean
}

export type BrowserActDangerInfo = {
  userReason: string
  consequence: 'money' | 'data-loss' | 'account' | 'file' | 'unknown-site' | 'generic'
  source: 'page-effect' | 'target-effect' | 'keyword'
  fillPreview?: { selector: string; method: string; value: string }[]
}

export interface ToolResult {
  data: unknown
  success: boolean
  error?: string
  metadata?: Record<string, unknown>
}

export interface ToolUseData {
  id: string
  toolName: string
  toolType: string
  parameters: Record<string, unknown>
  result?: ToolResult
  status: 'calling' | 'completed' | 'failed'
  timestamp: number
  duration?: number
  metadata?: Record<string, unknown>
}

export interface TimelineSegment {
  content: string
  startTime: number
  endTime?: number
}

export type ThinkingSegment = TimelineSegment

/** Skill 提示（持久化到消息，与工具卡片按 shownAt 交错展示） */
export interface SkillHintRecord {
  id: string
  text: string
  shownAt: number
}

export type ContentSegment = TimelineSegment

export interface ThinkingData {
  content: string
  isVisible: boolean
  startTime: number
  endTime?: number
  /** 多轮工具循环中分段思考；缺省时用 content 作为单段 */
  segments?: ThinkingSegment[]
  metadata?: Record<string, unknown>
}

export interface Session {
  id: string
  name: string
  preview: string
  model: string
  /** 本次会话使用的 API 服务 id；缺省时按服务列表顺序解析 */
  llmServiceId?: string
  temperature: number
  maxTokens: number
  createdAt: number
  updatedAt: number
  messageCount: number
  skillsState: SessionSkillsState
  metadata: Record<string, unknown>
  schemaVersion: number
  /** 所属工作目录 profile；缺省时视为当前激活目录（向后兼容） */
  workDirProfileId?: string
}

/** 用户消息附带的图片（DB 只存引用，不存 base64） */
export interface ChatImageAttachment {
  id: string
  /** staging 相对 userData 的路径键，如 chat-attachments/{sessionId}/{id}.png */
  stagingKey: string
  fileName: string
  mimeType: string
  byteLength: number
  width?: number
  height?: number
}

export interface Message {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  timestamp: number
  /** 用户消息附带的图片元数据（无 base64） */
  attachments?: ChatImageAttachment[]
  /**
   * 该条用户消息的图片 block 已成功送达 API。
   * 为 true 时后续 build 仅输出文本占位，不再 re-hydrate base64。
   */
  imagesDeliveredToApi?: boolean
  toolUse?: ToolUseData
  /** 新版内置工具调用记录；优先于 toolUse 展示 */
  toolCalls?: ToolCallRecord[]
  thinking?: ThinkingData
  /** 助手正文分段（与 thinking / toolCalls 按时间线交错展示） */
  contentSegments?: ContentSegment[]
  /** Skill 提示（与工具卡片按 shownAt 交错展示；system 消息可仅含此项） */
  skillHints?: SkillHintRecord[]
  status: MessageStatus
  schemaVersion: number
}

export interface ModelEntry {
  id: string
  name: string
  maximumContext: number
  maxTokens: number
  /** @deprecated 迁移后恒为 false，使用 preferredLanguageModelId */
  isDefault: boolean
  isFast: boolean
  isVision: boolean
  enabled: boolean
}

import type { FeishuConfig, WorkDirProfile } from './feishuTypes'
import { DEFAULT_FEISHU_CONFIG, mergeFeishuConfig } from './feishuTypes'
export type { FeishuConfig, WorkDirProfile } from './feishuTypes'
export { DEFAULT_FEISHU_CONFIG, mergeFeishuConfig } from './feishuTypes'

import type { WeChatConfig } from './wechatTypes'
import { DEFAULT_WECHAT_CONFIG, mergeWeChatConfig } from './wechatTypes'
export type { WeChatConfig } from './wechatTypes'
export { DEFAULT_WECHAT_CONFIG, mergeWeChatConfig } from './wechatTypes'

/** 单套大模型 API 接入配置（不含明文 Key） */
export interface LlmServiceProfile {
  id: string
  name: string
  baseUrl: string
  apiKeyPresent: boolean
  /** 该服务支持的模型 id 列表（引用全局 ModelEntry.id） */
  supportedModelIds?: string[]
  createdAt?: string
  updatedAt?: string
}

export interface AppConfig {
  /** 界面语言，遵循 BCP 47 标签 */
  locale: AppLocale
  /** 是否已配置 API Key（激活服务的镜像，兼容旧逻辑） */
  apiKeyPresent: boolean
  /** Base URL（激活服务的镜像，兼容旧逻辑） */
  baseUrl: string
  llmServices: LlmServiceProfile[]
  /** @deprecated 迁移自 activeLlmServiceId，只读镜像 */
  activeLlmServiceId: string
  activeLlmServiceIds: string[]
  model: string
  /** @deprecated 等于语言优选 model name，只读镜像 */
  defaultModel: string
  preferredLanguageModelId: string
  preferredFastLanguageModelId: string
  preferredVisionModelId: string
  models: ModelEntry[]
  thinkingEnabled: boolean
  workDir: string
  workDirProfiles: WorkDirProfile[]
  activeWorkDirProfileId: string
  /** 多会话并行 LLM 请求上限（设置页可配置） */
  maxParallelChatSessions: number
  tools: ToolsConfig
  skills: SkillsConfig
  wiki: WikiConfig
  feishu: FeishuConfig
  wechat: WeChatConfig
  browser: BrowserConfig
  shell: ShellConfig
  workspaceLayout: WorkspaceLayoutConfig
}

/** 从 FeishuConfig 移除 Plan 远程字段；幂等 */
export function stripPlanFieldsFromFeishuConfig(feishu: FeishuConfig): FeishuConfig {
  const next = { ...feishu } as FeishuConfig & { remotePlanMode?: unknown; remotePlanKeywords?: unknown }
  delete next.remotePlanMode
  delete next.remotePlanKeywords
  return next as FeishuConfig
}

/** 从 AppConfig 移除遗留 Plan 字段；幂等（兼容旧 DB 读取路径） */
export function stripPlanFieldsFromAppConfig(config: AppConfig & { defaultChatMode?: unknown; plan?: unknown }): AppConfig {
  const next = { ...config }
  delete next.defaultChatMode
  delete next.plan
  next.feishu = stripPlanFieldsFromFeishuConfig(config.feishu)
  return next
}

export interface ProjectMemoryState {
  /** 原始内容（已校验大小） */
  content: string | null
  /** 文件名 */
  fileName: string
  /** 文件大小（字节），用于 UI 展示 */
  fileSize: number
  /** 是否被截断 */
  truncated: boolean
  /** 最后加载时间 */
  loadedAt: number | null
}

export const PROJECT_MEMORY_FILE_NAME = 'SPACEASSISTANT.md'
export const PROJECT_MEMORY_MAX_SIZE = 40960 // 40KB

/** 各 LLM 场景未单独指定 temperature 时的共用默认值 */
export const DEFAULT_LLM_TEMPERATURE = 0.7

/** 自定义模型未填写时的默认上下文 / 输出上限；亦作模型列表未匹配时的输出兜底 */
export const DEFAULT_MODEL_MAX_CONTEXT = 200_000
export const DEFAULT_MODEL_MAX_TOKENS = 64_000

export interface SearchResult {
  id: string
  type: 'session' | 'file'
  title: string
  preview: string
  path?: string
  sessionId?: string
  /** session 类型：用于点击后滚动定位到消息 */
  messageId?: string
}

export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

export const DEFAULT_MODELS: Omit<ModelEntry, 'id'>[] = [
  { name: 'kimi-k2.6', maximumContext: 262144, maxTokens: 98304, isDefault: false, isFast: false, isVision: true, enabled: true },
  { name: 'glm-5.1', maximumContext: 200000, maxTokens: 128000, isDefault: false, isFast: false, isVision: true, enabled: true },
  { name: 'minimax-m2.7', maximumContext: 204800, maxTokens: 204800, isDefault: false, isFast: false, isVision: true, enabled: true },
  { name: 'deepseek-v4-pro', maximumContext: 1_048_565, maxTokens: 384000, isDefault: false, isFast: false, isVision: false, enabled: true },
  { name: 'deepseek-v4-flash', maximumContext: 1_048_565, maxTokens: 384000, isDefault: false, isFast: true, isVision: false, enabled: true },
  { name: 'claude-sonnet-4-6', maximumContext: 1000000, maxTokens: 64000, isDefault: false, isFast: false, isVision: true, enabled: true },
  { name: 'claude-opus-4-7', maximumContext: 1000000, maxTokens: 128000, isDefault: false, isFast: false, isVision: true, enabled: true },
  { name: 'claude-haiku-4-5', maximumContext: 200000, maxTokens: 64000, isDefault: false, isFast: true, isVision: true, enabled: true },
  { name: 'gpt-5.5', maximumContext: 1000000, maxTokens: 128000, isDefault: false, isFast: false, isVision: true, enabled: true },
  { name: 'gemini-3.1-pro', maximumContext: 1000000, maxTokens: 65536, isDefault: false, isFast: false, isVision: true, enabled: true },
  { name: 'gemini-3.1-flash-lite', maximumContext: 1000000, maxTokens: 64000, isDefault: false, isFast: true, isVision: true, enabled: true }
]
