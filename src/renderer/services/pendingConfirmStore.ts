import type { AutoApproveFallback, BrowserActDangerInfo, Message, ShellSecurityHints, ToolCallRecord, ToolRiskLevel } from '../../shared/domainTypes'
import type { ToolConfirmOptions } from '../../shared/toolConfirm'

export type PendingConfirmItem = {
  sessionId: string
  requestId: string
  toolUseId: string
  toolName: string
  input: unknown
  riskLevel: ToolRiskLevel
  diff?: ToolCallRecord['confirmDiff']
  shellSecurityHints?: ShellSecurityHints
  autoApproveFallback?: AutoApproveFallback
  currentPageUrl?: string
  dangerInfo?: BrowserActDangerInfo
  sessionTrustedHint?: true
  mcp?: {
    serverId: string
    serverName: string
    originalToolName: string
    description: string
    maskedArgs: Record<string, unknown>
  }
  createdAt: number
}

type Listener = () => void

class PendingConfirmStore {
  private items: PendingConfirmItem[] = []
  private listeners = new Set<Listener>()
  private initialized = false

  init(): void {
    if (this.initialized) return
    this.initialized = true
  }

  dispose(): void {
    this.initialized = false
    this.items = []
    this.listeners.clear()
  }

  getItems(): PendingConfirmItem[] {
    return [...this.items]
  }

  /** 从 Core 的完整 assistant snapshot 重建确认展示，不依赖旧 tool IPC。 */
  syncFromProjection(args: { sessionId: string; requestId: string; message: Message }): void {
    const confirming = (args.message.toolCalls ?? []).filter((tool) => tool.status === 'confirming')
    const next = confirming.map((tool) => ({
      sessionId: args.sessionId,
      requestId: args.requestId,
      toolUseId: tool.id,
      toolName: tool.toolName,
      input: tool.input,
      riskLevel: tool.riskLevel,
      ...(tool.confirmDiff ? { diff: tool.confirmDiff } : {}),
      ...(tool.shellSecurityHints ? { shellSecurityHints: tool.shellSecurityHints } : {}),
      ...(tool.autoApproveFallback ? { autoApproveFallback: tool.autoApproveFallback } : {}),
      ...(tool.currentPageUrl ? { currentPageUrl: tool.currentPageUrl } : {}),
      ...(tool.dangerInfo ? { dangerInfo: tool.dangerInfo } : {}),
      ...(tool.sessionTrustedHint ? { sessionTrustedHint: true as const } : {}),
      ...(tool.mcp ? { mcp: { ...tool.mcp, description: tool.mcp.description ?? '', maskedArgs: {} } } : {}),
      createdAt: tool.startedAt ?? Date.now()
    }))
    const keep = this.items.filter((item) => item.requestId !== args.requestId)
    this.items = [...keep, ...next]
    this.notify()
  }

  countForSession(sessionId: string): number {
    return this.items.filter((i) => i.sessionId === sessionId).length
  }

  find(sessionId: string, toolUseId: string): PendingConfirmItem | undefined {
    return this.items.find((i) => i.sessionId === sessionId && i.toolUseId === toolUseId)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  respond(requestId: string, toolUseId: string, approved: boolean, options?: ToolConfirmOptions): void {
    void window.api.toolConfirmResponse({
      requestId,
      toolUseId,
      approved,
      trustCommand: options?.trustCommand,
      trustDomain: options?.trustDomain,
      trustActDomain: options?.trustActDomain,
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options?.trustMcpServerId ? { trustMcpServerId: options.trustMcpServerId } : {}),
      ...(options?.trustMcpToolName ? { trustMcpToolName: options.trustMcpToolName } : {})
    })
    this.remove(requestId, toolUseId)
  }

  rejectAllForSession(sessionId: string): void {
    const pending = this.items.filter((i) => i.sessionId === sessionId)
    for (const item of pending) {
      void window.api.toolConfirmResponse({
        requestId: item.requestId,
        toolUseId: item.toolUseId,
        approved: false
      })
    }
    this.items = this.items.filter((i) => i.sessionId !== sessionId)
    this.notify()
  }

  remove(requestId: string, toolUseId: string): void {
    const before = this.items.length
    this.items = this.items.filter((i) => !(i.requestId === requestId && i.toolUseId === toolUseId))
    if (this.items.length !== before) this.notify()
  }

  removeAllForRequest(requestId: string): void {
    const before = this.items.length
    this.items = this.items.filter((i) => i.requestId !== requestId)
    if (this.items.length !== before) this.notify()
  }

  reconcileForSession(sessionId: string, activeRequestIds: Set<string>): void {
    const before = this.items.length
    this.items = this.items.filter(
      (i) => i.sessionId !== sessionId || activeRequestIds.has(i.requestId)
    )
    if (this.items.length !== before) this.notify()
  }

  /** 测试用 */
  reset(): void {
    this.items = []
    this.notify()
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

export const pendingConfirmStore = new PendingConfirmStore()
