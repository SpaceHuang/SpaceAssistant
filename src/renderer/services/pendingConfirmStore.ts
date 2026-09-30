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
  scriptPathHint?: string
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

type ProjectionSyncArgs = Parameters<PendingConfirmStore['syncFromProjection']>[0]

type ConfirmPayloadFields = Omit<PendingConfirmItem, 'createdAt' | 'confirmationReady' | 'confirmationSnapshot'>

/**
 * 确认语义载荷比较：仅比较展示与裁决相关字段，不含 createdAt / turnVersion /
 * confirmationReady / confirmationSnapshot（前三者由 syncFromProjection 冻结或静默跟踪，
 * snapshot 与 confirmationReady 同步写入，不参与 payload 判定）。
 */
function sameItemPayload(a: ConfirmPayloadFields, b: ConfirmPayloadFields): boolean {
  return a.sessionId === b.sessionId
    && a.toolName === b.toolName
    && a.riskLevel === b.riskLevel
    && a.autoApproveFallback === b.autoApproveFallback
    && a.currentPageUrl === b.currentPageUrl
    && a.sessionTrustedHint === b.sessionTrustedHint
    && JSON.stringify(a.input ?? null) === JSON.stringify(b.input ?? null)
    && JSON.stringify(a.diff ?? null) === JSON.stringify(b.diff ?? null)
    && JSON.stringify(a.shellSecurityHints ?? null) === JSON.stringify(b.shellSecurityHints ?? null)
    && (a.scriptPathHint ?? '') === (b.scriptPathHint ?? '')
    && JSON.stringify(a.dangerInfo ?? null) === JSON.stringify(b.dangerInfo ?? null)
    && JSON.stringify(a.mcp ?? null) === JSON.stringify(b.mcp ?? null)
    && JSON.stringify(a.memoryTiers ?? null) === JSON.stringify(b.memoryTiers ?? null)
}

/**
 * 不变量（评审 S-01）：confirmationSnapshot 永不脱离 confirmationReady 单独变化——
 * snapshot 仅在 chatGetPendingConfirmation 的 .then 回调中与 confirmationReady=true 同时写入，
 * 而投影重建仅在 payload 变化时重置 confirmationReady（此时 snapshot 一并丢弃），
 * 因此本函数不比较 confirmationSnapshot，snapshot 差异必然已被 confirmationReady 捕获。
 * 若未来出现单独写 snapshot 的路径，必须把该字段纳入比较，否则会静默丢失 notify。
 * turnVersion 不参与比较：投影版本推进由 syncFromProjection 静默跟踪（更新 items 但不 notify），
 * 否则等待确认期间每次投影推送都会触发一次全界面重渲染（确认卡闪动的放大器）。
 */
function samePendingItems(a: PendingConfirmItem[], b: PendingConfirmItem[]): boolean {
  if (a.length !== b.length) return false
  const index = new Map(a.map((item) => [`${item.requestId}:${item.toolUseId}`, item]))
  for (const item of b) {
    const prev = index.get(`${item.requestId}:${item.toolUseId}`)
    if (!prev) return false
    if (prev.turnId !== item.turnId
      || prev.confirmationReady !== item.confirmationReady) return false
    if (!sameItemPayload(prev, item)) return false
  }
  return true
}

class PendingConfirmStore {
  private items: PendingConfirmItem[] = []
  private listeners = new Set<Listener>()
  private readonly latestProjections = new Map<string, Parameters<PendingConfirmStore['syncFromProjection']>[0]>()
  private readonly inFlightSnapshots = new Set<string>()
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
    this.inFlightSnapshots.clear()
  }

  getItems(): PendingConfirmItem[] {
    return [...this.items]
  }

  /** 从 Core 的完整 assistant snapshot 重建确认展示，不依赖旧 tool IPC。 */
  syncFromProjection(args: { sessionId: string; requestId: string; message: Message; turnId?: string; turnVersion?: number; retryAttempt?: number }): void {
    const confirming = (args.message.toolCalls ?? []).filter((tool) => tool.status === 'confirming' && !tool.autoAnswerer)
    if (args.turnId && confirming.length === 0) this.latestProjections.delete(args.turnId)
    else if (args.turnId) this.latestProjections.set(args.turnId, args)
    const keep = this.items.filter((item) => item.requestId !== args.requestId)
    const next = confirming.map((tool) => {
      const base = {
        sessionId: args.sessionId,
        requestId: args.requestId,
        toolUseId: tool.id,
        toolName: tool.toolName,
        input: tool.input,
        ...(tool.memoryTiers ? { memoryTiers: tool.memoryTiers } : {}),
        riskLevel: tool.riskLevel,
        ...(tool.confirmDiff ? { diff: tool.confirmDiff } : {}),
        ...(tool.shellSecurityHints ? { shellSecurityHints: tool.shellSecurityHints } : {}),
        ...(tool.scriptPathHint ? { scriptPathHint: tool.scriptPathHint } : {}),
        ...(tool.autoApproveFallback ? { autoApproveFallback: tool.autoApproveFallback } : {}),
        ...(tool.currentPageUrl ? { currentPageUrl: tool.currentPageUrl } : {}),
        ...(tool.dangerInfo ? { dangerInfo: tool.dangerInfo } : {}),
        ...(tool.sessionTrustedHint ? { sessionTrustedHint: true as const } : {}),
        ...(tool.mcp ? { mcp: { ...tool.mcp, description: tool.mcp.description ?? '', maskedArgs: {} } } : {}),
        turnId: args.turnId,
        turnVersion: args.turnVersion
      }
      // 同一工具的重复投影：冻结 createdAt（主进程投影不携带 startedAt，Date.now() 兜底会让
      // 幂等守卫恒失效）；payload 未变则保持既有就绪态与快照（不回退、不重拉），变了才重置重拉。
      const existing = this.items.find((item) => item.requestId === args.requestId && item.toolUseId === tool.id)
      if (!existing) {
        return { ...base, createdAt: Date.now(), ...(args.turnId && args.turnVersion !== undefined ? { confirmationReady: false as const } : {}) }
      }
      // turnId 变化视为 payload 不稳定：旧 turn 的快照过不了 respond 的 turnId 归属校验，
      // 保留就绪态只会得到「就绪但永远批不了」的卡片（评审 P2-4）
      const payloadStable = existing.turnId === args.turnId && sameItemPayload(existing, { ...base, sessionId: args.sessionId, requestId: args.requestId })
      return {
        ...base,
        createdAt: existing.createdAt,
        ...(args.turnId && args.turnVersion !== undefined
          ? (payloadStable && existing.confirmationReady !== undefined
            ? { confirmationReady: existing.confirmationReady, ...(existing.confirmationSnapshot ? { confirmationSnapshot: existing.confirmationSnapshot } : {}) }
            : { confirmationReady: false as const })
          : {})
      }
    })
    const updated = [...keep, ...next]
    // 幂等静默更新只跳过 notify，不得短路快照拉取循环——stale/失败后的恢复
    // 依赖「任何后续投影都会以最新版本补拉」这条活性来源（评审 P0-1）
    const unchanged = !args.retryAttempt && samePendingItems(this.items, updated)
    this.items = updated
    if (!unchanged) this.notify()
    this.requestPendingSnapshots(args, next)
  }

  private requestPendingSnapshots(args: ProjectionSyncArgs, items: PendingConfirmItem[]): void {
    if (!args.turnId || args.turnVersion === undefined || typeof window.api.chatGetPendingConfirmation !== 'function') return
    for (const item of items) {
      if (item.confirmationReady === true) continue
      // 在飞去重按版本隔离：payload/版本推进后的新拉取不被旧在飞请求拦截（评审 P0-2）
      const flightKey = `${args.requestId}:${item.toolUseId}:${args.turnVersion}`
      if (this.inFlightSnapshots.has(flightKey)) continue
      this.inFlightSnapshots.add(flightKey)
      void window.api.chatGetPendingConfirmation({ sessionId: args.sessionId, turnId: args.turnId, requestId: args.requestId, turnVersion: args.turnVersion, toolCallId: item.toolUseId }).then((result) => {
        this.inFlightSnapshots.delete(flightKey)
        if ('status' in result) {
          if (result.status === 'stale') this.scheduleSnapshotRetry(args, item, args.retryAttempt ?? 0)
          return
        }
        const current = this.items.find((candidate) => candidate.sessionId === args.sessionId && candidate.requestId === args.requestId && candidate.toolUseId === item.toolUseId)
        if (!current) return
        // 版本裁决（响应侧对齐）：落后于 item 已知投影版本的快照不可信——
        // 拉取在飞期间 payload/版本可能已推进，应用即「所见非所批」（评审 P0-2）
        if (current.turnVersion !== undefined && result.turnVersion !== undefined && result.turnVersion < current.turnVersion) {
          this.scheduleSnapshotRetry(args, item, args.retryAttempt ?? 0)
          return
        }
        // 响应幂等守卫：就绪态已确立的重复响应（多投影竞态重发）不再翻转与 notify
        if (current.confirmationReady === true) return
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
        if (result.confirmation.scriptPathHint) current.scriptPathHint = result.confirmation.scriptPathHint
        if (result.confirmation.autoApproveFallback) current.autoApproveFallback = result.confirmation.autoApproveFallback
        if (result.confirmation.browser.currentPageUrl) current.currentPageUrl = result.confirmation.browser.currentPageUrl
        if (result.confirmation.browser.dangerInfo) current.dangerInfo = result.confirmation.browser.dangerInfo
        if (result.confirmation.browser.sessionTrustedHint) current.sessionTrustedHint = true
        if (result.confirmation.mcp) current.mcp = { ...result.confirmation.mcp, description: result.confirmation.mcp.description ?? '', maskedArgs: {} }
        this.notify()
      }).catch(() => {
        this.inFlightSnapshots.delete(flightKey)
        if ((args.retryAttempt ?? 0) >= 3) return
        setTimeout(() => {
          const current = this.items.find((candidate) => candidate.sessionId === args.sessionId && candidate.requestId === args.requestId && candidate.toolUseId === item.toolUseId)
          if (current?.confirmationReady !== false) return
          // 重试基于 latestProjections 最新投影而非捕获的旧 args：旧版本会让 item 版本回退、
          // 污染 latestProjections，使后续重拉必得 stale（评审 P1-3）
          const latest = current.turnId ? this.latestProjections.get(current.turnId) : undefined
          this.syncFromProjection({ ...(latest ?? args), retryAttempt: (args.retryAttempt ?? 0) + 1 })
        }, 500 * 2 ** (args.retryAttempt ?? 0))
      })
    }
  }

  /** stale/过期快照的有限退避补拉；投影驱动的拉取循环（含幂等早退分支）是无限兜底，放弃重试不产生永久卡死。 */
  private scheduleSnapshotRetry(args: ProjectionSyncArgs, item: { toolUseId: string }, attempt: number): void {
    if (attempt >= 3) return
    setTimeout(() => {
      const current = this.items.find((candidate) => candidate.requestId === args.requestId && candidate.toolUseId === item.toolUseId)
      if (!current || current.confirmationReady === true) return
      const latest = current.turnId ? this.latestProjections.get(current.turnId) : undefined
      this.syncFromProjection({ ...(latest ?? args), retryAttempt: attempt + 1 })
    }, 100 * 2 ** attempt)
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
    // 快照新鲜度由 requestPendingSnapshots 的响应版本裁决保证（应用时 ≥ 已知投影版本，
    // 且 payload 未变的投影推进不使快照失效），此处只做归属校验防错卡；
    // 不比较 turnVersion：渲染端已知版本可能短暂落后于在途投影，比较会造成「就绪但批不了」。
    if (approved && current?.confirmationReady !== undefined && (!current.confirmationReady || !current.confirmationSnapshot || current.confirmationSnapshot.sessionId !== current.sessionId || current.confirmationSnapshot.requestId !== current.requestId || current.confirmationSnapshot.toolCallId !== current.toolUseId || (current.turnId !== undefined && current.confirmationSnapshot.turnId !== current.turnId))) return
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
    this.inFlightSnapshots.clear()
    this.notify()
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

export const pendingConfirmStore = new PendingConfirmStore()
