import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js'
import { MCP_CONNECT_TIMEOUT_MS, type McpServerProfile } from '../../src/shared/mcpTypes'
import { createStdioTransport, StdioCommandValidationError } from './stdioTransport'
import { createStreamableHttpTransport, McpEndpointValidationError } from './streamableHttpTransport'

/**
 * MCP 连接管理器：连接池、initialize 超时、capabilities 兼容性诊断、空闲回收、
 * 进程退出标记断开（下次调用前重启一次）。
 * 协议细节下沉给 SDK；工具发现/映射由 mcpToolRegistry 负责。
 */

export interface McpSessionInfo {
  name: string
  version?: string
}

export interface McpSession {
  serverId: string
  client: Client
  info: McpSessionInfo
  protocolVersion: string
  capabilities: Record<string, unknown>
  close(): Promise<void>
}

export type McpSecretProvider = (kind: string) => Promise<string | null>

export class McpConnectionTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpConnectionTimeoutError'
  }
}

type PoolEntry = {
  session: McpSession
  lastUsedAt: number
  idleTimer: ReturnType<typeof setTimeout> | null
  dead: boolean
}

export type McpConnectionManagerOptions = {
  idleTimeoutMs?: number
  connectTimeoutMs?: number
  appendDiagnostic?: (
    serverId: string,
    entry: { code: string; message: string }
  ) => void | Promise<void>
}

export type McpTestConnectionResult =
  | {
      ok: true
      serverInfo: McpSessionInfo
      protocolVersion: string
      capabilities: Record<string, unknown>
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    }
  | { ok: false; code: string; message: string }

/**
 * SDK 1.30.0 的 Client 不暴露 stdio 协商后的协议版本（仅 HTTP 传输实现 setProtocolVersion），
 * 这里在传输层捕获 initialize 响应中的 protocolVersion。
 */
class VersionTrackingTransport implements Transport {
  private inner: Transport
  private capturedVersion: string | null = null
  private capturedResult: { capabilities?: unknown } | null = null

  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void
  onclose?: () => void
  onerror?: (error: Error) => void

  constructor(inner: Transport) {
    this.inner = inner
    inner.onmessage = (message: JSONRPCMessage) => {
      this.capture(message)
      this.onmessage?.(message)
    }
    inner.onclose = () => this.onclose?.()
    inner.onerror = (error) => this.onerror?.(error)
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId
  }

  async start(): Promise<void> {
    await this.inner.start()
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.inner.send(message, options)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }

  getNegotiatedProtocolVersion(): string | null {
    return this.capturedVersion
  }

  private capture(message: JSONRPCMessage): void {
    const m = message as { id?: unknown; result?: { protocolVersion?: unknown } }
    if (m.id !== undefined && m.result && typeof m.result === 'object' && 'protocolVersion' in m.result) {
      const version = m.result.protocolVersion
      if (typeof version === 'string') this.capturedVersion = version
      this.capturedResult = m.result as { capabilities?: unknown }
    }
  }

  getRawCapabilities(): Record<string, unknown> | null {
    const caps = this.capturedResult?.capabilities
    return caps && typeof caps === 'object' && !Array.isArray(caps)
      ? (caps as Record<string, unknown>)
      : null
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpConnectionTimeoutError(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export class McpConnectionManager {
  private sessions = new Map<string, PoolEntry>()
  private idleTimeoutMs: number
  private connectTimeoutMs: number
  private appendDiagnostic?: McpConnectionManagerOptions['appendDiagnostic']

  constructor(options?: McpConnectionManagerOptions) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 5 * 60 * 1000
    this.connectTimeoutMs = options?.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS
    this.appendDiagnostic = options?.appendDiagnostic
  }

  isSessionAlive(serverId: string): boolean {
    const entry = this.sessions.get(serverId)
    return Boolean(entry && !entry.dead)
  }

  async connect(
    profile: McpServerProfile,
    secretProvider: McpSecretProvider,
    options?: { connectTimeoutMs?: number }
  ): Promise<McpSession> {
    const existing = this.sessions.get(profile.id)
    if (existing && !existing.dead) {
      this.touch(profile.id)
      return existing.session
    }
    if (existing) {
      await this.closeEntry(profile.id, existing)
    }

    const timeoutMs = options?.connectTimeoutMs ?? this.connectTimeoutMs
    const session = await this.createSession(profile, secretProvider, timeoutMs)
    this.sessions.set(profile.id, {
      session,
      lastUsedAt: Date.now(),
      idleTimer: null,
      dead: false
    })
    this.touch(profile.id)
    return session
  }

  private async createSession(
    profile: McpServerProfile,
    secretProvider: McpSecretProvider,
    timeoutMs: number
  ): Promise<McpSession> {
    let rawTransport: Transport
    if (profile.transport === 'stdio') {
      if (!profile.stdio) throw new Error('stdio 服务缺少连接配置')
      const env: Record<string, string> = {}
      for (const envItem of profile.stdio.env) {
        const value = await secretProvider(`env:${envItem.key}`)
        if (value !== null) env[envItem.key] = value
      }
      rawTransport = createStdioTransport(
        {
          command: profile.stdio.command,
          args: profile.stdio.args,
          cwd: profile.stdio.cwd,
          env
        },
        {
          onStderr: (line) => {
            void this.appendDiagnostic?.(profile.id, { code: 'stdio-stderr', message: line })
          }
        }
      )
    } else if (profile.transport === 'streamable-http') {
      if (!profile.http) throw new Error('HTTP 服务缺少 endpoint 配置')
      const authHeaders: Record<string, string> = {}
      if (profile.auth.mode === 'bearer-token') {
        const token = await secretProvider('access-token')
        if (token) authHeaders.Authorization = `Bearer ${token}`
      } else if (profile.auth.mode === 'custom-header') {
        const value = await secretProvider('auth-header')
        const headerName = profile.auth.headerName?.trim() || 'Authorization'
        if (value) authHeaders[headerName] = `${profile.auth.valuePrefix ?? ''}${value}`
      }
      rawTransport = await createStreamableHttpTransport({
        endpoint: profile.http.endpoint,
        authHeaders,
        onDiagnostic: (line) => {
          void this.appendDiagnostic?.(profile.id, { code: 'http-diagnostic', message: line })
        }
      })
    } else {
      throw new Error(`暂不支持的传输方式: ${profile.transport}`)
    }

    const transport: Transport = new VersionTrackingTransport(rawTransport)
    const client = new Client({ name: 'spaceassistant', version: '0.1.5' })
    try {
      await withTimeout(client.connect(transport), timeoutMs, 'MCP 连接/初始化超时')
    } catch (error) {
      try {
        await client.close()
      } catch {
        /* ignore */
      }
      throw error
    }

    const serverVersion = client.getServerVersion()
    const rawCapabilities =
      transport instanceof VersionTrackingTransport ? transport.getRawCapabilities() : null
    const capabilities =
      rawCapabilities ?? ((client.getServerCapabilities() ?? {}) as Record<string, unknown>)
    for (const unsupported of ['sampling', 'elicitation', 'roots']) {
      if (capabilities[unsupported]) {
        void this.appendDiagnostic?.(profile.id, {
          code: 'capability-unsupported',
          message: `Server 声明了本期不支持的能力: ${unsupported}`
        })
      }
    }

    // 钩住传输关闭：进程退出/断线时标记失效，下次调用前重启。
    const previousOnClose = transport.onclose
    transport.onclose = () => {
      try {
        previousOnClose?.()
      } catch {
        /* ignore */
      }
      const entry = this.sessions.get(profile.id)
      if (entry && entry.session.client === client) {
        entry.dead = true
      }
    }

    const session: McpSession = {
      serverId: profile.id,
      client,
      info: { name: serverVersion?.name ?? profile.name, version: serverVersion?.version },
      protocolVersion:
        transport instanceof VersionTrackingTransport
          ? transport.getNegotiatedProtocolVersion() ?? ''
          : '',
      capabilities,
      close: async () => {
        try {
          await client.close()
        } catch {
          /* ignore */
        }
      }
    }
    return session
  }

  private touch(serverId: string): void {
    const entry = this.sessions.get(serverId)
    if (!entry || entry.dead) return
    entry.lastUsedAt = Date.now()
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      const current = this.sessions.get(serverId)
      if (current === entry && !current.dead) {
        void this.closeEntry(serverId, current)
      }
    }, this.idleTimeoutMs)
  }

  private async closeEntry(serverId: string, entry: PoolEntry): Promise<void> {
    entry.dead = true
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    await entry.session.close()
    if (this.sessions.get(serverId) === entry) {
      this.sessions.delete(serverId)
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const entry = this.sessions.get(serverId)
    if (entry) await this.closeEntry(serverId, entry)
  }

  async shutdown(): Promise<void> {
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(entries.map((entry) => entry.session.close().catch(() => undefined)))
  }
}

/**
 * 连通性测试（P0-A：stdio）：建立连接、initialize、发现工具，随后释放连接。
 * 不持久化任何内容。
 */
export async function testConnection(
  profile: McpServerProfile,
  options?: { connectTimeoutMs?: number; secretProvider?: McpSecretProvider }
): Promise<McpTestConnectionResult> {
  const manager = new McpConnectionManager({
    connectTimeoutMs: options?.connectTimeoutMs,
    idleTimeoutMs: 1000
  })
  try {
    const session = await manager.connect(profile, options?.secretProvider ?? (async () => null), {
      connectTimeoutMs: options?.connectTimeoutMs
    })
    const toolsResult = await session.client.listTools()
    const tools = toolsResult.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>
    }))
    return {
      ok: true,
      serverInfo: session.info,
      protocolVersion: session.protocolVersion,
      capabilities: session.capabilities,
      tools
    }
  } catch (error) {
    if (error instanceof StdioCommandValidationError) {
      return { ok: false, code: 'invalid-command', message: error.message }
    }
    if (error instanceof McpEndpointValidationError) {
      return { ok: false, code: 'invalid-endpoint', message: error.message }
    }
    if (error instanceof McpConnectionTimeoutError) {
      return { ok: false, code: 'timeout', message: error.message }
    }
    return {
      ok: false,
      code: 'connection-failed',
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    await manager.shutdown().catch(() => undefined)
  }
}
