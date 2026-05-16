export const CURRENT_SCHEMA_VERSION = 1

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageStatus = 'sending' | 'sent' | 'streaming' | 'completed' | 'failed'

export type ToolRiskLevel = 'low' | 'medium' | 'high'

export type ToolCallStatus = 'calling' | 'confirming' | 'executing' | 'completed' | 'failed' | 'rejected'

export interface ToolsConfig {
  enabled: boolean
  confirmMode: 'diff' | 'direct'
  allowedTools: string[]
  deniedTools: string[]
  pythonPath: string
  scriptTimeout: number
  fileCheckpointingEnabled: boolean
  maxFileSnapshots: number
  grepTimeoutSec: number
}

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  enabled: true,
  confirmMode: 'diff',
  allowedTools: [],
  deniedTools: [],
  pythonPath: 'python',
  scriptTimeout: 300,
  fileCheckpointingEnabled: true,
  maxFileSnapshots: 100,
  grepTimeoutSec: 60
}

export function mergeToolsConfig(partial?: Partial<ToolsConfig> | null): ToolsConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_TOOLS_CONFIG }
  return { ...DEFAULT_TOOLS_CONFIG, ...partial }
}

export interface SkillsConfig {
  autoDetect: boolean
  maxConcurrent: number
  disabled: string[]
  alwaysLoad: string[]
}

export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  autoDetect: true,
  maxConcurrent: 5,
  disabled: [],
  alwaysLoad: []
}

export function mergeSkillsConfig(partial?: Partial<SkillsConfig> | null): SkillsConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_SKILLS_CONFIG }
  return {
    ...DEFAULT_SKILLS_CONFIG,
    ...partial,
    disabled: Array.isArray(partial.disabled) ? [...partial.disabled] : DEFAULT_SKILLS_CONFIG.disabled,
    alwaysLoad: Array.isArray(partial.alwaysLoad) ? [...partial.alwaysLoad] : DEFAULT_SKILLS_CONFIG.alwaysLoad
  }
}

export interface SkillMeta {
  name: string
  description: string
  triggers: string[]
  version: string
  author: string
}

export type SkillScope = 'project' | 'user'

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

export interface SkillsCache {
  skills: SkillDefinition[]
  scannedAt: number
  workDir: string
}

export interface SkillActivationLogEntry {
  timestamp: number
  skillNames: string[]
  source: 'auto' | 'manual' | 'alwaysLoad'
  userInput?: string
}

export function builtinToolRiskLevel(name: string): ToolRiskLevel {
  switch (name) {
    case 'read_file':
    case 'list_directory':
    case 'grep':
      return 'low'
    case 'edit_file':
    case 'write_file':
      return 'medium'
    case 'run_script':
      return 'high'
    default:
      return 'medium'
  }
}

export function builtinToolNeedsConfirmation(name: string): boolean {
  return name === 'edit_file' || name === 'write_file' || name === 'run_script'
}

export interface ToolCallResultPersisted {
  success: boolean
  data?: unknown
  error?: string
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
  confirmedAt?: number
  startedAt?: number
  completedAt?: number
  duration?: number
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
  temperature: number
  maxTokens: number
  createdAt: number
  updatedAt: number
  messageCount: number
  skillsState: SessionSkillsState
  metadata: Record<string, unknown>
  schemaVersion: number
}

export interface Message {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  timestamp: number
  toolUse?: ToolUseData
  /** 新版内置工具调用记录；优先于 toolUse 展示 */
  toolCalls?: ToolCallRecord[]
  thinking?: ThinkingData
  /** 助手正文分段（与 thinking / toolCalls 按时间线交错展示） */
  contentSegments?: ContentSegment[]
  status: MessageStatus
  schemaVersion: number
}

export interface ModelEntry {
  id: string
  name: string
  maximumContext: number
  maxTokens: number
  isDefault: boolean
  isFast: boolean
  enabled: boolean
}

export type UiThemeMode = 'light' | 'dark' | 'system'

export const DEFAULT_UI_THEME: UiThemeMode = 'system'

export interface AppConfig {
  apiKeyPresent: boolean
  baseUrl: string
  model: string
  defaultModel: string
  models: ModelEntry[]
  temperature: number
  maxTokens: number
  thinkingEnabled: boolean
  workDir: string
  uiTheme: UiThemeMode
  /** 多会话并行 LLM 请求上限（设置页可配置） */
  maxParallelChatSessions: number
  tools: ToolsConfig
  skills: SkillsConfig
}

export interface SearchResult {
  id: string
  type: 'session' | 'file'
  title: string
  preview: string
  path?: string
  sessionId?: string
}

export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

export const DEFAULT_MODELS: Omit<ModelEntry, 'id'>[] = [
  { name: 'kimi-k2.6', maximumContext: 262144, maxTokens: 98304, isDefault: false, isFast: false, enabled: true },
  { name: 'glm-5.1', maximumContext: 200000, maxTokens: 128000, isDefault: true, isFast: false, enabled: true },
  { name: 'minimax-m2.7', maximumContext: 204800, maxTokens: 204800, isDefault: false, isFast: false, enabled: true },
  { name: 'deepseek-v4-pro', maximumContext: 1000000, maxTokens: 384000, isDefault: false, isFast: false, enabled: true },
  { name: 'deepseek-v4-flash', maximumContext: 1000000, maxTokens: 384000, isDefault: false, isFast: true, enabled: true },
  { name: 'claude-sonnet-4-6', maximumContext: 1000000, maxTokens: 64000, isDefault: false, isFast: false, enabled: true },
  { name: 'claude-opus-4-7', maximumContext: 1000000, maxTokens: 128000, isDefault: false, isFast: false, enabled: true },
  { name: 'claude-haiku-4-5', maximumContext: 200000, maxTokens: 64000, isDefault: false, isFast: true, enabled: true },
  { name: 'gpt-5.5', maximumContext: 1000000, maxTokens: 128000, isDefault: false, isFast: false, enabled: true },
  { name: 'gemini-3.1-pro', maximumContext: 1000000, maxTokens: 65536, isDefault: false, isFast: false, enabled: true },
  { name: 'gemini-3.1-flash-lite', maximumContext: 1000000, maxTokens: 64000, isDefault: false, isFast: true, enabled: true }
]
