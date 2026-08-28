import { compactOversizedToolResultContent } from '../../src/shared/oversizedToolResult'
import {
  MCP_GLOBAL_CONCURRENCY,
  MCP_PER_SERVER_CONCURRENCY,
  validateMcpCallArgs,
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
 * - 错误分类为安全的模型可见文案；原始错误脱敏后入诊断
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
  return /ECONNREFUSED|ENOTFOUND|socket hang up|connection closed|Connection closed|EPIPE|timed out/i.test(message)
}

function isAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /401|Unauthorized|authentication|auth expired|invalid token|access token/i.test(message)
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
              return { success: false, error: 'MCP 工具调用超时或已取消。' }
            }
            if (isAuthFailure(error)) {
              void deps.invalidateSession(entry.serverId)
              return { success: false, error: 'MCP 服务认证失效，需要用户在设置中重新授权。' }
            }
            if (isConnectionFailure(error)) {
              void deps.invalidateSession(entry.serverId)
              return { success: false, error: 'MCP 服务暂时不可达，请稍后重试或使用其他工具。' }
            }
            return { success: false, error: `MCP 工具执行失败：${safeServerSummary(message)}` }
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
