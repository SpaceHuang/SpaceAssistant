import { randomUUID } from 'crypto'
import { PendingRequestRegistry, type PendingDecision } from '../remote/pendingRequestRegistry'
import { allocateConfirmId, releaseConfirmId } from '../remote/confirmId'
import type {
  ConfirmOutcome,
  ConfirmRequest,
  MemoryTier,
  OriginInfo,
  RiskLevel
} from '../../src/shared/confirmation/types'
import type { AuditSink } from './channels'

export interface ImPendingConfirm {
  id: string
  sessionId: string
  toolName?: string
  toolInput?: Record<string, unknown>
  messageId: string
  channel: 'feishu' | 'wechat'
  confirmId?: string
  trustEligible?: boolean
  authOwner?: string
  authorizationGeneration?: number
  /** 同一待确认项的提交尝试代次；回滚后重试必须单调递增。 */
  commitRevision?: number
  requestId?: string
  createdAt: number
  expiresAt: number
  memoryTiers: MemoryTier[]
  /** 由调用方注入的匹配键（wechat: userId；feishu: chatId）。 */
  matchKey?: string
  /** 链路专属扩展上下文（如微信 reply 所需的 IncomingMessage），供 sendPrompt 消费。 */
  context?: unknown
}

/** ImChannel.request 的待确认入参（id/confirmId/时间戳/链路由通道补齐）。 */
export type ImPendingInput = Omit<
  ImPendingConfirm,
  'id' | 'confirmId' | 'createdAt' | 'expiresAt' | 'channel' | 'memoryTiers'
> & { memoryTiers?: MemoryTier[] }

export interface ImChannelDeps {
  lane: 'feishu' | 'wechat'
  timeoutMs: number
  audit?: AuditSink
  log?: (event: string, fields: Record<string, unknown>) => void
  getGeneration?: (channel: 'feishu' | 'wechat') => number
  /** 发送确认提示（注入 replyFeishuText / weChatReplyService.reply 等）。 */
  sendPrompt: (entry: ImPendingConfirm) => void | Promise<void>
  /** 入站归属校验：仅绑定 owner 且 p2p/白名单命中才可确认。 */
  isAuthorizedInbound?: (
    inbound: { matchKey?: string; messageId: string },
    entry: ImPendingConfirm
  ) => boolean
  /** approve_and_trust 时由链路侧写入信任；返回 false（无资格/写入失败）则不解析。 */
  onTrust?: (entry: ImPendingConfirm) => boolean
  /** 持久提交服务：写入授权并记录 receipt 后才允许 resolve。 */
  onCommit?: (entry: ImPendingConfirm, action: { kind: 'trust' | 'memory' | 'decision'; tier?: MemoryTier; approved: boolean }) => ImCommitResult
  onCommitFailure?: (entry: ImPendingConfirm) => void
  /** 记N 选中档位后由链路侧写 decision_cache（执行链路侧写缓存，落 cache.write 审计）。 */
  /** 记忆写入必须先成功；返回 false 或抛错时不得结算为 approved。 */
  onMemory?: (entry: ImPendingConfirm, tier: MemoryTier) => boolean | void
  /** trust_misclick / usage_hint 时由链路侧回复提示。 */
  onHint?: (entry: ImPendingConfirm, kind: 'trust_misclick' | 'usage_hint') => void
}

/** IM 授权提交的结算结果；rollback 可重试，unknown 必须等待对账。 */
export type ImCommitResult = boolean | {
  committed: boolean
  canResubmit?: boolean
  unknown?: boolean
}

function normalizeCommitResult(result: ImCommitResult): { committed: boolean; canResubmit: boolean; unknown: boolean } {
  if (typeof result === 'boolean') return { committed: result, canResubmit: false, unknown: false }
  return {
    committed: result.committed,
    canResubmit: result.canResubmit === true,
    unknown: result.unknown === true
  }
}

function toOutcome(decision: PendingDecision, memoryTiers: MemoryTier[], memory?: MemoryTier): ConfirmOutcome {
  if (decision === 'y') {
    return { kind: 'approved', ...(memory ? { memory: memory.key } : {}), cause: 'user-approved' }
  }
  if (decision === 'timeout') return { kind: 'timeout', cause: 'timeout' }
  if (decision === 'unavailable') return { kind: 'rejected', cause: 'unavailable' }
  if (decision === 'cancelled') return { kind: 'rejected', cause: 'cancelled' }
  return { kind: 'rejected', cause: 'user-denied' }
}

/**
 * P2 合并确认通道：统一飞书/微信的待确认注册、入站解析、桌面代答、超时与多档记忆选择。
 * 链路差异（发送函数、日志、归属校验、超时）经 deps 注入，消除两个 ConfirmManager 的同构重复。
 */
export class ImChannel {
  private registry = new PendingRequestRegistry<ImPendingConfirm>()

  constructor(private readonly deps: ImChannelDeps) {}

  listPending(): ImPendingConfirm[] {
    return this.registry.listPending()
  }

  countPending(): number {
    return this.registry.countPending()
  }

  hasPendingForSession(sessionId: string): boolean {
    return this.registry.hasPendingForSession(sessionId)
  }

  cancel(id: string): boolean {
    if (!this.registry.get(id)) return false
    this.resolve(id, 'cancelled')
    return true
  }

  cancelAllPending(): void {
    for (const { id } of this.registry.listPending()) this.resolve(id, 'cancelled')
  }

  cancelByChannel(channel: 'feishu' | 'wechat'): number {
    if (channel !== this.deps.lane) return 0
    const ids = this.registry.listPending().map((p) => p.id)
    for (const id of ids) this.resolve(id, 'cancelled')
    return ids.length
  }

  cancelByRequestId(requestId: string): number {
    const ids = this.registry.listPending().filter((entry) => entry.requestId === requestId).map((entry) => entry.id)
    for (const id of ids) this.resolve(id, 'cancelled')
    return ids.length
  }

  resolveFromDesktop(requestId: string, approved: boolean): boolean {
    const entry = this.registry.get(requestId)
    if (!entry) return false
    if (this.deps.onCommit && !normalizeCommitResult(this.deps.onCommit(entry, { kind: 'decision', approved })).committed) return false
    this.resolve(requestId, approved ? 'y' : 'n')
    return true
  }

  request(req: ConfirmRequest, pending: ImPendingInput): Promise<ConfirmOutcome> {
    // 同一会话的确认按 confirmId 独立登记；入站回答仍按 confirmId/toolUseId 归属校验。
    const id = randomUUID()
    const confirmId = allocateConfirmId()
    const now = Date.now()
    const entry: ImPendingConfirm = {
      ...pending,
      channel: this.deps.lane,
      confirmId,
      memoryTiers: pending.memoryTiers ?? req.memoryTiers,
      id,
      createdAt: now,
      expiresAt: now + this.deps.timeoutMs
    }
    this.deps.log?.('confirm.request', { confirmId: id, shortConfirmId: confirmId, sessionId: entry.sessionId, toolName: entry.toolName })
    this.deps.audit?.record({
      ts: Date.now(),
      event: 'confirm.request',
      lane: this.deps.lane,
      sessionId: entry.sessionId,
      // 审计 requestId 优先用主循环传入的 requestId，保证与桌面通道/policy.* 事件同键关联
      requestId: entry.requestId ?? id,
      toolName: entry.toolName,
      riskLevel: req.riskLevel as RiskLevel,
      factsSummary: req.facts.summary.text,
      // B1 归因口径：confirm.request / confirm.outcome 归因于回答动作——IM 出站回答者恒为远端用户
      actor: 'user'
    })
    // 先注册再发送提示：sendPrompt 同步触发入站解析时能命中待确认项；
    // 注入实现同步抛异常时释放 confirmId，避免短确认码泄漏
    const outcomePromise = this.registry.register(entry, this.deps.timeoutMs, {
      onTimeout: () => {
        if (confirmId) releaseConfirmId(confirmId)
      }
    })
    try {
      Promise.resolve(this.deps.sendPrompt(entry)).catch(() => {
        if (confirmId) releaseConfirmId(confirmId)
        this.registry.resolve(id, 'unavailable')
      })
    } catch {
      if (confirmId) releaseConfirmId(confirmId)
      this.registry.resolve(id, 'unavailable')
    }
    return outcomePromise.then((decision) => {
      const memory = this.pendingMemory.get(id)
      // 记忆档位随请求结束即清理，pendingMemory 不随长跑进程累积
      this.pendingMemory.delete(id)
      this.emitConfirmOutcome(decision, entry, memory)
      return toOutcome(decision, entry.memoryTiers, memory)
    })
  }

  /**
   * 入站解析：一次性处理 Y/N/记N/TRUST 结果。返回是否消费了该消息。
   * `selectedTier` 用于记N 档位选择。
   */
  tryResolveFromInbound(
    parsed: { kind: string; confirmId?: string; tier?: number },
    inbound: { matchKey?: string; messageId: string }
  ): boolean {
    if (parsed.kind === 'not_confirm') return false
    if (parsed.kind === 'trust_misclick' || parsed.kind === 'usage_hint') {
      const any = this.registry.listPending().find((p) => this.isInboundAuthorized(inbound, p))
      if (any) this.deps.onHint?.(any, parsed.kind)
      return true
    }
    if (parsed.confirmId == null) return false
    const match = this.registry
      .listPending()
      .find((p) => p.confirmId === parsed.confirmId && this.isInboundAuthorized(inbound, p))
    if (!match) return true

    if (parsed.kind === 'remember' && parsed.tier != null && match.memoryTiers[parsed.tier - 1]) {
      const tier = match.memoryTiers[parsed.tier - 1]!
      try {
        const result = this.deps.onCommit
          ? normalizeCommitResult(this.deps.onCommit(match, { kind: 'memory', tier, approved: true }))
          : { committed: this.deps.onMemory?.(match, tier) !== false, canResubmit: false, unknown: false }
        if (!result.committed) {
          this.deps.onCommitFailure?.(match)
          if (!result.canResubmit && !result.unknown) this.resolve(match.id, 'unavailable')
          return true
        }
      } catch {
        this.deps.onCommitFailure?.(match)
        this.resolve(match.id, 'unavailable')
        return true
      }
      this.resolve(match.id, 'y', tier)
      return true
    }
    if (parsed.kind === 'approve_and_trust') {
      if (match.trustEligible === false) return true
      const result = this.deps.onCommit
        ? normalizeCommitResult(this.deps.onCommit(match, { kind: 'trust', approved: true }))
        : { committed: this.deps.onTrust ? this.deps.onTrust(match) : true, canResubmit: false, unknown: false }
      if (!result.committed) {
        this.deps.onCommitFailure?.(match)
        if (!result.canResubmit && !result.unknown) this.resolve(match.id, 'unavailable')
        return true
      }
      this.resolve(match.id, 'y')
      return true
    }
    const approved = parsed.kind === 'approve'
    if (this.deps.onCommit) {
      try {
        const result = normalizeCommitResult(this.deps.onCommit(match, { kind: 'decision', approved }))
        if (!result.committed) {
          this.deps.onCommitFailure?.(match)
          if (!result.canResubmit && !result.unknown) this.resolve(match.id, 'unavailable')
          return true
        }
      } catch {
        this.deps.onCommitFailure?.(match)
        this.resolve(match.id, 'unavailable')
        return true
      }
    }
    this.resolve(match.id, approved ? 'y' : 'n')
    return true
  }

  private isInboundAuthorized(
    inbound: { matchKey?: string; messageId: string },
    entry: ImPendingConfirm
  ): boolean {
    if (this.deps.isAuthorizedInbound) return this.deps.isAuthorizedInbound(inbound, entry)
    return inbound.matchKey === entry.matchKey && entry.messageId !== inbound.messageId
  }

  private resolve(id: string, decision: PendingDecision, memory?: MemoryTier): void {
    const entry = this.registry.get(id)
    if (!entry) return
    if (entry.confirmId) releaseConfirmId(entry.confirmId)
    this.pendingMemory.set(id, memory)
    this.registry.resolve(id, decision)
  }

  private pendingMemory = new Map<string, MemoryTier | undefined>()

  private emitConfirmOutcome(decision: PendingDecision, entry: ImPendingConfirm, memory?: MemoryTier): void {
    this.deps.log?.('confirm.resolved', { confirmId: entry.id, decision })
    this.deps.audit?.record({
      ts: Date.now(),
      event: 'confirm.outcome',
      lane: this.deps.lane,
      sessionId: entry.sessionId,
      requestId: entry.requestId ?? entry.id,
      toolName: entry.toolName,
      outcome: decision === 'y' ? 'approved' : decision === 'n' ? 'rejected' : decision === 'timeout' ? 'timeout' : decision === 'unavailable' ? 'unavailable' : 'cancelled',
      cause: decision === 'y' ? 'user-approved' : decision === 'n' ? 'user-denied' : decision === 'timeout' ? 'timeout' : decision === 'unavailable' ? 'unavailable' : 'cancelled',
      ...(memory ? { memoryTier: memory.label } : {}),
      // 超时无回答动作，actor 如实为 system；批准/拒绝归因远端用户（B1）
      actor: decision === 'y' || decision === 'n' ? 'user' : 'system'
    })
  }

  /** 供测试检查最近一次 resolve 的记忆档位。 */
  lastMemory(id: string): MemoryTier | undefined {
    return this.pendingMemory.get(id)
  }
}
