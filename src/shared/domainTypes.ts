export const CURRENT_SCHEMA_VERSION = 1

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageStatus = 'sending' | 'sent' | 'streaming' | 'completed' | 'failed'

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
