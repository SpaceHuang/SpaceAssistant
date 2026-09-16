import { compactOversizedToolResultContent } from '../../src/shared/oversizedToolResult'
import {
  MCP_GLOBAL_CONCURRENCY,
  MCP_PER_SERVER_CONCURRENCY,
  validateMcpCallArgs,
  type McpDiagnosticEntry,
  type McpServerProfile
} from '../../src/shared/mcpTypes'
import { sanitizeForLog } from '../logSanitize'
import { adaptMcpToolResult } from './mcpToolResultAdapter'
import { randomBytes } from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { OutputArtifactWriter } from '../shell/outputArtifactWriter'
import { cleanupMcpArtifacts } from './mcpArtifactCleanup'
import type { ToolExecutionContext, ToolExecutor, ToolExecutorResult } from '../tools/types'
import type { McpSession } from './mcpConnectionManager'
import { Semaphore, withSemaphore } from './semaphore'
import type { McpToolSnapshotEntry } from './mcpToolRegistry'
import { resolveMcpArtifactOwnerPath } from './mcpArtifactPath'

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

export function shouldPersistMcpArtifact(displayText: string): boolean {
  return displayText.length > 512 * 1024
}

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
            const envelope = { __spaceAssistantMcpResult: 1 as const, content: result.content, structuredContent: result.structuredContent }
            // Keep artifact construction independent from the bounded UI projection.
            // Otherwise a single large text block is clipped before the threshold check.
            const artifactData = adaptMcpToolResult(envelope, { maxTextBytes: 64 * 1024 * 1024, maxUnknownBytes: 16 * 1024, maxBlocks: Number.MAX_SAFE_INTEGER })
            const displayData = adaptMcpToolResult(envelope)
            const blockSummary = artifactData.blocks.filter((block) => block.kind !== 'text').map((block) => {
              if (block.kind === 'image') return `[图片] ${block.mimeType}，${block.byteLength} bytes${block.previewable ? '' : '（不可预览）'}`
              if (block.kind === 'resource') return `[资源] ${block.name ?? block.uri}${block.mimeType ? ` (${block.mimeType})` : ''}`
              return `[其他结果] ${block.raw}`
            }).join('\n')
            const displayText = [artifactData.text, artifactData.structuredText, blockSummary].filter(Boolean).join('\n\n')
            if (shouldPersistMcpArtifact(displayText)) {
              try {
                void cleanupMcpArtifacts(path.join(ctx.userDataDir, 'shell-output', 'mcp'))
                const artifactId = `artifact-mcp-${randomBytes(32).toString('hex')}` as `artifact-mcp-${string}`
                const writer = new OutputArtifactWriter(path.join(ctx.userDataDir, 'shell-output', 'mcp', `${artifactId}.log`), 16 * 1024 * 1024)
                await writer.open()
                const sourceBytes = new TextEncoder().encode(displayText).byteLength
                const artifactLimit = 16 * 1024 * 1024
                const marker = '\n\n[内容已截断：artifact 超过 16 MiB]\n'
                const markerBytes = new TextEncoder().encode(marker).byteLength
                let artifactText = displayText
                if (sourceBytes > artifactLimit) {
                  const bytes = new TextEncoder().encode(displayText)
                  const prefix = bytes.slice(0, Math.max(0, artifactLimit - markerBytes))
                  artifactText = `${new TextDecoder().decode(prefix)}${marker}`
                }
                writer.append(artifactText)
                const artifact = await writer.close()
                const artifactOwner = { sessionId: ctx.sessionId, assistantMessageId: ctx.assistantMessageId ?? ctx.requestId, toolUseId: ctx.toolUseId }
                const ownerPath = resolveMcpArtifactOwnerPath(ctx.userDataDir, artifactId)
                if (!ownerPath) throw new Error('invalid artifact owner path')
                await fs.writeFile(ownerPath, JSON.stringify(artifactOwner), 'utf8')
                displayData.artifactId = artifactId
                displayData.artifactTruncated = sourceBytes > artifactLimit
                displayData.artifactOwner = artifactOwner
              } catch (artifactError) {
                console.warn('[mcp] failed to persist oversized result artifact', artifactError instanceof Error ? artifactError.message : String(artifactError))
              }
            }
            const data = (result.structuredContent ?? result.content) as unknown
            return { success: true, data: compactResultIfNeeded(data), displayData }
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
