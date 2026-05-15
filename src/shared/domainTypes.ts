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
  maxToolIterations: number
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
  maxToolIterations: 10,
  grepTimeoutSec: 60
}

export function mergeToolsConfig(partial?: Partial<ToolsConfig> | null): ToolsConfig {
  if (!partial || typeof partial !== 'object') return { ...DEFAULT_TOOLS_CONFIG }
  return { ...DEFAULT_TOOLS_CONFIG, ...partial }
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

export interface ThinkingData {
  content: string
  isVisible: boolean
  startTime: number
  endTime?: number
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
  tools: ToolsConfig
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
