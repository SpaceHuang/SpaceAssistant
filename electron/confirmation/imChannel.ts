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
  requestId?: string
  createdAt: number
  expiresAt: number
  memoryTiers: MemoryTier[]
  /** 由调用方注入的匹配键（wechat: userId；feishu: chatId）。 */
  matchKey?: string
  /** 链路专属扩展上下文（如微信 reply 所需的 IncomingMessage），供 sendPrompt 消费。 */
  context?: unknown
}

export interface ImChannelDeps {
  lane: 'feishu' | 'wechat'
  timeoutMs: number
  audit?: AuditSink
  log?: (event: string, fields: Record<string, unknown>) => void
  getGeneration?: (channel: 'feishu' | 'wechat') => number
  /** 发送确认提示（注入 replyFeishuText / weChatReplyService.reply 等）。 */
  sendPrompt: (entry: ImPendingConfirm) => void
  /** 入站归属校验：仅绑定 owner 且 p2p/白名单命中才可确认。 */
  isAuthorizedInbound?: (
    inbound: { matchKey?: string; messageId: string },
    entry: ImPendingConfirm
  ) => boolean
  /** approve_and_trust 时由链路侧写入信任；返回 false（无资格/写入失败）则不解析。 */
  onTrust?: (entry: ImPendingConfirm) => boolean
  /** trust_misclick / usage_hint 时由链路侧回复提示。 */
  onHint?: (entry: ImPendingConfirm, kind: 'trust_misclick' | 'usage_hint') => void
}

function toOutcome(decision: PendingDecision, memoryTiers: MemoryTier[], memory?: MemoryTier): ConfirmOutcome {
  if (decision === 'y') return { kind: 'approved', ...(memory ? { memory: memory.key } : {}) }
  if (decision === 'timeout') return { kind: 'timeout' }
  return { kind: 'rejected' }
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
    this.resolve(id, 'n')
    return true
  }

  cancelAllPending(): void {
    for (const { id } of this.registry.listPending()) this.resolve(id, 'n')
  }

  cancelByChannel(channel: 'feishu' | 'wechat'): number {
    if (channel !== this.deps.lane) return 0
    const ids = this.registry.listPending().map((p) => p.id)
    for (const id of ids) this.resolve(id, 'n')
    return ids.length
  }

  resolveFromDesktop(requestId: string, approved: boolean): boolean {
    if (!this.registry.get(requestId)) return false
    this.resolve(requestId, approved ? 'y' : 'n')
    return true
  }

  request(
    req: ConfirmRequest,
    pending: Omit<
      ImPendingConfirm,
      'id' | 'confirmId' | 'createdAt' | 'expiresAt' | 'channel' | 'memoryTiers'
    > & { memoryTiers?: MemoryTier[] }
  ): Promise<ConfirmOutcome> {
    if (this.registry.hasPendingForSession(pending.sessionId)) return Promise.resolve({ kind: 'rejected' })
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
      requestId: id,
      toolName: entry.toolName,
      riskLevel: req.riskLevel as RiskLevel,
      factsSummary: req.facts.summary.text,
      actor: 'system'
    })
    this.deps.sendPrompt(entry)
    return this.registry.register(entry, this.deps.timeoutMs, {
      onTimeout: () => {
        if (confirmId) releaseConfirmId(confirmId)
      }
    }).then((decision) => {
      const memory = this.pendingMemory.get(id)
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
      this.resolve(match.id, 'y', match.memoryTiers[parsed.tier - 1])
      return true
    }
    if (parsed.kind === 'approve_and_trust') {
      if (match.trustEligible === false) return true
      if (this.deps.onTrust && !this.deps.onTrust(match)) return true
      this.resolve(match.id, 'y')
      return true
    }
    this.resolve(match.id, parsed.kind === 'approve' ? 'y' : 'n')
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
      requestId: entry.id,
      toolName: entry.toolName,
      outcome: decision === 'y' ? 'approved' : decision === 'n' ? 'rejected' : 'timeout',
      ...(memory ? { memoryTier: memory.label } : {}),
      actor: 'system'
    })
  }

  /** 供测试检查最近一次 resolve 的记忆档位。 */
  lastMemory(id: string): MemoryTier | undefined {
    return this.pendingMemory.get(id)
  }
}
