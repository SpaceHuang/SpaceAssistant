import { compactOversizedToolResultContent } from '../../src/shared/oversizedToolResult'
import {
  MCP_GLOBAL_CONCURRENCY,
  MCP_PER_SERVER_CONCURRENCY,
  validateMcpCallArgs,
  type McpDiagnosticEntry,
  type McpServerProfile
} from '../../src/shared/mcpTypes'
import { sanitizeForLog } from '../logSanitize'
import type { ToolExecutionContext, ToolExecutor, ToolExecutorResult } from '../tools/types'
import type { McpSession } from './mcpConnectionManager'
import { Semaphore, withSemaphore } from './semaphore'
import type { McpToolSnapshotEntry } from './mcpToolRegistry'

/**
 * MCP 工具执行器：把模型映射调用路由到 Server 的 tools/call。
 * - 输入校验（深度 20 / 256 KiB）
 * - 每服务并发 4 / 全局 8 信号量排队
 * - 取消时经 SDK request signal 发送 notifications/cancelled；不重试 tools/call
 * - 结果 >1 MB 走 compactOversizedToolResultContent
 * - 错误分类为安全的模型可见文案，附脱敏后的原始错误摘要与该服务近期诊断
 */

const globalSemaphore = new Semaphore(MCP_GLOBAL_CONCURRENCY)
const perServerSemaphores = new Map<string, Semaphore>()

function getPerServerSemaphore(serverId: string): Semaphore {
  let semaphore = perServerSemaphores.get(serverId)
  if (!semaphore) {
    semaphore = new Semaphore(MCP_PER_SERVER_CONCURRENCY)
    perServerSemaphores.set(serverId, semaphore)
  }
  return semaphore
}

export type McpToolExecutorDeps = {
  getSession: (serverId: string) => Promise<McpSession>
  getProfile: (serverId: string) => McpServerProfile | undefined
  invalidateSession: (serverId: string) => Promise<void>
  /** 读取该服务近期脱敏诊断（同步），用于失败时向模型附上下文。 */
  getRecentDiagnostics?: (serverId: string) => McpDiagnosticEntry[]
}

function extractContentText(result: unknown): string {
  const content = result && typeof result === 'object' ? (result as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string') {
        return (block as { text: string }).text
      }
      return ''
    })
    .join('')
}

function safeServerSummary(raw: string): string {
  const sanitized = sanitizeForLog(raw)
  const text = typeof sanitized === 'string' ? sanitized : String(sanitized)
  return text.slice(0, 500)
}

function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|connection closed|channel closed|EPIPE|timed out/i.test(message)
}

function isAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /401|403|Unauthorized|Forbidden|authentication|auth required|AuthRequired|auth expired|invalid token|access token/i.test(message)
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g
const DIAGNOSTIC_WINDOW_MS = 2 * 60 * 1000
const DIAGNOSTIC_MAX_ENTRIES = 3
const DIAGNOSTIC_MESSAGE_MAX = 300

/**
 * 把该服务近期诊断（写入时已脱敏）拼进模型可见的错误文案，
 * 避免 Agent 只拿到「超时」等无信息量文案而瞎猜。
 */
function appendRecentDiagnostics(
  deps: McpToolExecutorDeps,
  serverId: string,
  baseError: string
): string {
  if (!deps.getRecentDiagnostics) return baseError
  let entries: McpDiagnosticEntry[]
  try {
    entries = deps.getRecentDiagnostics(serverId)
  } catch {
    return baseError
  }
  const now = Date.now()
  const recent = entries
    .filter((e) => {
      const ts = Date.parse(e.occurredAt)
      return !Number.isNaN(ts) && now - ts <= DIAGNOSTIC_WINDOW_MS
    })
    .slice(-DIAGNOSTIC_MAX_ENTRIES)
  if (recent.length === 0) return baseError
  const lines = recent.map((e) => {
    const message = e.message.replace(ANSI_ESCAPE_RE, '').trim().slice(0, DIAGNOSTIC_MESSAGE_MAX)
    return `- [${e.code}] ${message}`
  })
  return `${baseError}\n该服务近期诊断：\n${lines.join('\n')}`
}

export function createMcpToolExecutor(
  entry: McpToolSnapshotEntry,
  deps: McpToolExecutorDeps
): ToolExecutor {
  return {
    name: entry.mappedName,
    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutorResult> {
      const validation = validateMcpCallArgs(input, entry.inputSchema)
      if (!validation.ok) {
        return { success: false, error: `MCP 工具参数无效：${validation.reason}` }
      }
      const profile = deps.getProfile(entry.serverId)
      if (!profile) {
        return { success: false, error: 'MCP 服务配置不完整，无法调用该工具。' }
      }

      const timeoutMs = profile.timeoutSec * 1000
      return withSemaphore(globalSemaphore, () =>
        withSemaphore(getPerServerSemaphore(entry.serverId), async () => {
          const session = await deps.getSession(entry.serverId)
          try {
            const result = await session.client.callTool(
              { name: entry.originalName, arguments: input },
              undefined,
              { signal: ctx.signal, timeout: timeoutMs }
            )
            if (result.isError) {
              return { success: false, error: safeServerSummary(extractContentText(result)) }
            }
            const data = (result.structuredContent ?? result.content) as unknown
            return { success: true, data: compactResultIfNeeded(data) }
          } catch (error) {
            if (ctx.signal.aborted) {
              return { success: false, error: 'MCP 工具调用超时或已取消。' }
            }
            const message = error instanceof Error ? error.message : String(error)
            if (/timed out|timeout|Request timed out/i.test(message)) {
              return {
                success: false,
                error: appendRecentDiagnostics(
                  deps,
                  entry.serverId,
                  `MCP 工具调用超时（${timeoutMs}ms 无响应）。原始错误：${safeServerSummary(message)}`
                )
              }
            }
            if (isAuthFailure(error)) {
              void deps.invalidateSession(entry.serverId)
              return {
                success: false,
                error: appendRecentDiagnostics(
                  deps,
                  entry.serverId,
                  `MCP 服务认证失效，需要用户在设置中重新授权。原始错误：${safeServerSummary(message)}`
                )
              }
            }
            if (isConnectionFailure(error)) {
              void deps.invalidateSession(entry.serverId)
              return {
                success: false,
                error: appendRecentDiagnostics(
                  deps,
                  entry.serverId,
                  `MCP 服务暂时不可达，请稍后重试或使用其他工具。原始错误：${safeServerSummary(message)}`
                )
              }
            }
            return {
              success: false,
              error: appendRecentDiagnostics(
                deps,
                entry.serverId,
                `MCP 工具执行失败：${safeServerSummary(message)}`
              )
            }
          }
        })
      )
    }
  }
}

function compactResultIfNeeded(data: unknown): unknown {
  if (data === undefined || data === null) return data
  const serialized = JSON.stringify(data)
  if (!serialized || serialized.length <= 1024 * 1024) return data
  const compacted = compactOversizedToolResultContent(serialized, 1024 * 1024)
  return compacted.content
}
