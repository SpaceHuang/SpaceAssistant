import type { AutoApproveFallback, BrowserActDangerInfo, Message, ShellSecurityHints, ToolCallRecord, ToolRiskLevel } from '../../shared/domainTypes'
import type { ToolConfirmOptions } from '../../shared/toolConfirm'
import type { MemoryTier } from '../../shared/confirmation/types'
import type { ConfirmationSnapshot } from '../../shared/turnDisplayProtocol'

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
  confirmationReady?: boolean
  confirmationSnapshot?: ConfirmationSnapshot
  memoryTiers?: MemoryTier[]
  turnId?: string
  turnVersion?: number
}

type Listener = () => void

/**
 * 不变量（评审 S-01）：confirmationSnapshot 永不脱离 confirmationReady 单独变化——
 * snapshot 仅在 chatGetPendingConfirmation 的 .then 回调中与 confirmationReady=true 同时写入，
 * 而投影重建的 next 恒为 confirmationReady:false 且无 snapshot，
 * 因此本函数不比较 confirmationSnapshot，snapshot 差异必然已被 confirmationReady 捕获。
 * 若未来出现单独写 snapshot 的路径，必须把该字段纳入比较，否则会静默丢失 notify。
 */
function samePendingItems(a: PendingConfirmItem[], b: PendingConfirmItem[]): boolean {
  if (a.length !== b.length) return false
  const index = new Map(a.map((item) => [`${item.requestId}:${item.toolUseId}`, item]))
  for (const item of b) {
    const prev = index.get(`${item.requestId}:${item.toolUseId}`)
    if (!prev) return false
    if (prev.sessionId !== item.sessionId
      || prev.toolName !== item.toolName
      || prev.riskLevel !== item.riskLevel
      || prev.turnId !== item.turnId
      || prev.turnVersion !== item.turnVersion
      || prev.confirmationReady !== item.confirmationReady
      || prev.autoApproveFallback !== item.autoApproveFallback
      || prev.currentPageUrl !== item.currentPageUrl
      || prev.sessionTrustedHint !== item.sessionTrustedHint
      || prev.createdAt !== item.createdAt) return false
    // 深字段沿用旧 JSON.stringify 守卫的语义，但只对单个 item 执行
    if (JSON.stringify(prev.input ?? null) !== JSON.stringify(item.input ?? null)) return false
    if (JSON.stringify(prev.diff ?? null) !== JSON.stringify(item.diff ?? null)) return false
    if (JSON.stringify(prev.shellSecurityHints ?? null) !== JSON.stringify(item.shellSecurityHints ?? null)) return false
    if (JSON.stringify(prev.dangerInfo ?? null) !== JSON.stringify(item.dangerInfo ?? null)) return false
    if (JSON.stringify(prev.mcp ?? null) !== JSON.stringify(item.mcp ?? null)) return false
    if (JSON.stringify(prev.memoryTiers ?? null) !== JSON.stringify(item.memoryTiers ?? null)) return false
  }
  return true
}

class PendingConfirmStore {
  private items: PendingConfirmItem[] = []
  private listeners = new Set<Listener>()
  private readonly latestProjections = new Map<string, Parameters<PendingConfirmStore['syncFromProjection']>[0]>()
  private initialized = false

  init(): void {
    if (this.initialized) return
    this.initialized = true
  }

  dispose(): void {
    this.initialized = false
    this.items = []
    this.listeners.clear()
    this.latestProjections.clear()
  }

  getItems(): PendingConfirmItem[] {
    return [...this.items]
  }

  /** 从 Core 的完整 assistant snapshot 重建确认展示，不依赖旧 tool IPC。 */
  syncFromProjection(args: { sessionId: string; requestId: string; message: Message; turnId?: string; turnVersion?: number; retryAttempt?: number }): void {
    const confirming = (args.message.toolCalls ?? []).filter((tool) => tool.status === 'confirming' && !tool.autoAnswerer)
    if (args.turnId && confirming.length === 0) this.latestProjections.delete(args.turnId)
    else if (args.turnId) this.latestProjections.set(args.turnId, args)
    const next = confirming.map((tool) => ({
      sessionId: args.sessionId,
      requestId: args.requestId,
      toolUseId: tool.id,
      toolName: tool.toolName,
      input: tool.input,
      ...(tool.memoryTiers ? { memoryTiers: tool.memoryTiers } : {}),
      riskLevel: tool.riskLevel,
      ...(tool.confirmDiff ? { diff: tool.confirmDiff } : {}),
      ...(tool.shellSecurityHints ? { shellSecurityHints: tool.shellSecurityHints } : {}),
      ...(tool.autoApproveFallback ? { autoApproveFallback: tool.autoApproveFallback } : {}),
      ...(tool.currentPageUrl ? { currentPageUrl: tool.currentPageUrl } : {}),
      ...(tool.dangerInfo ? { dangerInfo: tool.dangerInfo } : {}),
      ...(tool.sessionTrustedHint ? { sessionTrustedHint: true as const } : {}),
      ...(tool.mcp ? { mcp: { ...tool.mcp, description: tool.mcp.description ?? '', maskedArgs: {} } } : {}),
      createdAt: tool.startedAt ?? Date.now()
      ,...(args.turnId ? { turnId: args.turnId } : {})
      ,...(args.turnVersion !== undefined ? { turnVersion: args.turnVersion } : {})
      ,...(args.turnId && args.turnVersion !== undefined ? { confirmationReady: false } : {})
    }))
    const keep = this.items.filter((item) => item.requestId !== args.requestId)
    const updated = [...keep, ...next]
    if (!args.retryAttempt && samePendingItems(this.items, updated)) return
    this.items = updated
    this.notify()
    if (args.turnId && args.turnVersion !== undefined && typeof window.api.chatGetPendingConfirmation === 'function') {
      for (const item of next) {
        void window.api.chatGetPendingConfirmation({ sessionId: args.sessionId, turnId: args.turnId, requestId: args.requestId, turnVersion: args.turnVersion, toolCallId: item.toolUseId }).then((result) => {
          if ('status' in result) return
          const current = this.items.find((candidate) => candidate.sessionId === args.sessionId && candidate.turnId === args.turnId && candidate.requestId === args.requestId && candidate.turnVersion === args.turnVersion && candidate.toolUseId === item.toolUseId)
          if (!current) return
          current.confirmationReady = true
          current.confirmationSnapshot = result
          if (result.confirmation.input && typeof result.confirmation.input === 'object') current.input = result.confirmation.input
          if (result.confirmation.diff) {
            try {
              const diff = JSON.parse(result.confirmation.diff) as ToolCallRecord['confirmDiff']
              if (diff && typeof diff === 'object') current.diff = diff
            } catch { /* malformed detail remains non-authoritative and cannot enable approval */ }
          }
          current.riskLevel = result.confirmation.riskLevel
          if (!current.memoryTiers?.length && result.confirmation.memoryTiers.length) current.memoryTiers = result.confirmation.memoryTiers.map((tier) => ({ label: tier.label, key: { kind: 'path', path: '', level: 'zone' } }))
          if (result.confirmation.shellSecurityHints) current.shellSecurityHints = result.confirmation.shellSecurityHints
          if (result.confirmation.autoApproveFallback) current.autoApproveFallback = result.confirmation.autoApproveFallback
          if (result.confirmation.browser.currentPageUrl) current.currentPageUrl = result.confirmation.browser.currentPageUrl
          if (result.confirmation.browser.dangerInfo) current.dangerInfo = result.confirmation.browser.dangerInfo
          if (result.confirmation.browser.sessionTrustedHint) current.sessionTrustedHint = true
          if (result.confirmation.mcp) current.mcp = { ...result.confirmation.mcp, description: result.confirmation.mcp.description ?? '', maskedArgs: {} }
          this.notify()
        }).catch(() => {
          if ((args.retryAttempt ?? 0) >= 3) return
          setTimeout(() => {
            const current = this.items.find((candidate) => candidate.sessionId === args.sessionId && candidate.turnId === args.turnId && candidate.requestId === args.requestId && candidate.turnVersion === args.turnVersion && candidate.toolUseId === item.toolUseId)
            if (current?.confirmationReady !== false) return
            this.syncFromProjection({ ...args, retryAttempt: (args.retryAttempt ?? 0) + 1 })
          }, 500 * 2 ** (args.retryAttempt ?? 0))
        })
      }
    }
  }

  retryUnready(): void {
    for (const item of this.items) {
      if (item.confirmationReady !== false || !item.turnId) continue
      const args = this.latestProjections.get(item.turnId)
      if (args) this.syncFromProjection({ ...args, retryAttempt: 1 })
    }
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
    const current = this.items.find((item) => item.requestId === requestId && item.toolUseId === toolUseId)
    if (approved && current?.confirmationReady !== undefined && (!current.confirmationReady || !current.confirmationSnapshot || current.confirmationSnapshot.sessionId !== current.sessionId || current.confirmationSnapshot.requestId !== current.requestId || current.confirmationSnapshot.toolCallId !== current.toolUseId || (current.turnId !== undefined && current.confirmationSnapshot.turnId !== current.turnId) || (current.turnVersion !== undefined && current.confirmationSnapshot.turnVersion !== current.turnVersion))) return
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
      ,...(options?.memoryTierOptionId !== undefined ? { memoryTierOptionId: options.memoryTierOptionId } : {})
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
    this.latestProjections.clear()
    this.notify()
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

export const pendingConfirmStore = new PendingConfirmStore()
