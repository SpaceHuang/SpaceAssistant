import { randomUUID } from 'crypto'
import { PendingRequestRegistry, type PendingDecision } from '../remote/pendingRequestRegistry'
import { allocateConfirmId, releaseConfirmId } from '../remote/confirmId'
import { contentHash } from '../remote/imCliLogFields'
import type { ConfirmCodeLease, ConfirmIdSpaceLike } from '../../packages/agent-sdk/src/runtime/components'
import type {
  ConfirmOutcome,
  ConfirmationPromptSendFailure,
  ConfirmRequest,
  MemoryTier,
  RiskLevel
} from '../../src/shared/confirmation/types'
import type { PromptSendErrorCategory, PromptSendNotAttemptedErrorCategory, PromptSendResult } from './promptSend'
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
  turnId?: string
  toolUseId?: string
  trackId?: string
  trackAttributionEventId?: string
  createdAt: number
  expiresAt: number
  memoryTiers: MemoryTier[]
  /** 由调用方注入的匹配键（wechat: userId；feishu: chatId）。 */
  matchKey?: string
  /** 链路专属扩展上下文（如微信 reply 所需的 IncomingMessage），供 sendPrompt 消费。 */
  context?: unknown
  /** Trusted platform ID returned by the confirmation prompt send API. */
  promptMessageId?: string
  /** Per-message marker recovered from quoted prompt text when platform IDs are unavailable. */
  promptQuoteMarker?: string
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
  confirmIds?: ConfirmIdSpaceLike
  /** 发送确认提示并返回可用于精确绑定入站引用的真实平台消息 ID。 */
  sendPrompt: (entry: ImPendingConfirm, signal?: AbortSignal) => { messageId: string } | PromptPreflightFailure | PromptSendResult | Promise<{ messageId: string } | PromptPreflightFailure | PromptSendResult>
  /** 入站归属校验：仅绑定 owner 且 p2p/白名单命中才可确认。 */
  isAuthorizedInbound?: (
    inbound: { matchKey?: string; messageId: string; quotedMessageId?: string; quotedMessageText?: string },
    entry: ImPendingConfirm
  ) => boolean
  /** approve_and_trust 时由链路侧写入信任；返回 false（无资格/写入失败）则不解析。 */
  onTrust?: (entry: ImPendingConfirm) => boolean
  /** 持久提交服务：写入授权并记录 receipt 后才允许 resolve。 */
  onCommit?: (entry: ImPendingConfirm, action: { kind: 'trust' | 'memory' | 'decision'; tier?: MemoryTier; approved: boolean }) => ImCommitResult
  onCommitFailure?: (entry: ImPendingConfirm) => void
  /** Durable Track child lifecycle; a linked confirmation cannot start without this writer. */
  onTrackConfirmationChild?: (entry: ImPendingConfirm, state: 'pending' | 'settled') => void
  /** 记N 选中档位后由链路侧写 decision_cache（执行链路侧写缓存，落 cache.write 审计）。 */
  /** 记忆写入必须先成功；返回 false 或抛错时不得结算为 approved。 */
  onMemory?: (entry: ImPendingConfirm, tier: MemoryTier) => boolean | void
  /** trust_misclick / usage_hint 时由链路侧回复提示。 */
  onHint?: (entry: ImPendingConfirm, kind: 'trust_misclick' | 'usage_hint' | 'prompt_sending' | 'quote_required') => void
}

export type PromptPreflightFailure = Readonly<{
  kind: 'not-attempted'
  errorCategory: PromptSendNotAttemptedErrorCategory
}>

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

const SAFE_WECHAT_SDK_CODES = new Set([
  'wechat-bot-unavailable', 'wechat-inbound-context-missing', 'wechat-credentials-unavailable', 'wechat-api-rejected',
  'API_ERROR', 'TRANSPORT_ERROR', 'AUTH_ERROR', 'NO_CONTEXT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'EHOSTUNREACH', 'ENOTFOUND'
])

type PromptSendErrorDetails = Readonly<{
  category: PromptSendErrorCategory
  sdkErrorCode?: string
  httpStatus?: number
  apiErrcode?: number
}>

function promptSendErrorDetails(error: unknown): PromptSendErrorDetails {
  const objects: Record<string, unknown>[] = []
  let current: unknown = error
  for (let depth = 0; depth < 3 && current && typeof current === 'object' && !objects.includes(current as Record<string, unknown>); depth++) {
    const record = current as Record<string, unknown>
    objects.push(record)
    current = record.cause
  }
  const codes = objects.map((record) => record.code).filter((code): code is string => typeof code === 'string')
  const sdkErrorCode = codes.find((code) => SAFE_WECHAT_SDK_CODES.has(code))
  const apiErrcode = objects.map((record) => record.errcode).find((value): value is number => Number.isInteger(value) && Math.abs(value as number) <= 2_147_483_647)
  let category: PromptSendErrorCategory = 'unknown'
  if (codes.includes('wechat-bot-unavailable')) category = 'bot-unavailable'
  else if (codes.includes('wechat-inbound-context-missing') || codes.includes('NO_CONTEXT')) category = 'inbound-context-missing'
  else if (codes.includes('wechat-credentials-unavailable') || codes.includes('AUTH_ERROR') || [40001, 40014, 42001].includes(apiErrcode ?? 0)) category = 'credentials-unavailable'
  else if (codes.includes('wechat-api-rejected') || codes.includes('API_ERROR')) category = 'api-rejected'
  else if (codes.some((code) => SAFE_WECHAT_SDK_CODES.has(code) && /^(ECONN|ETIMEDOUT|ENETUNREACH|EPIPE|EHOSTUNREACH)/.test(code)) || codes.includes('TRANSPORT_ERROR')) category = 'transport-failed'
  const httpStatus = objects.map((record) => record.httpStatus).find((value): value is number => Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599)
  return {
    category,
    ...(sdkErrorCode ? { sdkErrorCode } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(apiErrcode !== undefined ? { apiErrcode } : {})
  }
}

function logPromptDiagnostic(log: ImChannelDeps['log'], event: string, fields: Record<string, unknown>): void {
  try { log?.(event, fields) } catch { /* Diagnostics must never change fail-closed settlement. */ }
}

function toOutcome(decision: PendingDecision, _memoryTiers: MemoryTier[], memory?: MemoryTier): ConfirmOutcome {
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
  private leases = new Map<string, ConfirmCodeLease>()
  private sendControllers = new Map<string, AbortController>()

  constructor(private readonly deps: ImChannelDeps) {}

  listPending(): ImPendingConfirm[] {
    return this.registry.listPending()
  }

  countPending(): number {
    return this.registry.countPending()
  }

  listPendingTrackConfirmations(trackId: string): Array<{ confirmationId: string; state: 'pending' }> {
    return this.registry.listPending()
      .filter((entry) => entry.trackId === trackId)
      .map((entry) => ({ confirmationId: entry.id, state: 'pending' as const }))
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
    let lease: ConfirmCodeLease
    try {
      lease = this.deps.confirmIds?.allocate() ?? allocateConfirmId()
    } catch (error) {
      logPromptDiagnostic(this.deps.log, 'confirm.code-space-exhausted', {
        lane: this.deps.lane, sessionId: pending.sessionId, requestId: pending.requestId ?? id,
        errorCategory: error instanceof Error && error.message === 'CONFIRM_ID_SPACE_EXHAUSTED' ? 'exhausted' : 'allocation-failed',
        at: Date.now()
      })
      return Promise.resolve({ kind: 'rejected', cause: 'unavailable' })
    }
    const confirmId = lease.code
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
    if (entry.trackId) {
      if (!entry.trackAttributionEventId || !entry.requestId || !entry.turnId || !entry.toolUseId || !this.deps.onTrackConfirmationChild) {
        if (this.deps.confirmIds) this.deps.confirmIds.release(lease)
        else releaseConfirmId(lease)
        return Promise.resolve({ kind: 'rejected', cause: 'unavailable' })
      }
      try {
        this.deps.onTrackConfirmationChild(entry, 'pending')
      } catch {
        if (this.deps.confirmIds) this.deps.confirmIds.release(lease)
        else releaseConfirmId(lease)
        return Promise.resolve({ kind: 'rejected', cause: 'unavailable' })
      }
    }
    logPromptDiagnostic(this.deps.log, 'confirm.request', { confirmId: id, sessionId: entry.sessionId, toolName: entry.toolName })
    logPromptDiagnostic(this.deps.log, 'confirm.prompt-send-started', {
      lane: this.deps.lane, sessionId: entry.sessionId, requestId: entry.requestId ?? id,
      confirmId: id, toolName: entry.toolName, sendCall: 'started', at: Date.now()
    })
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
    // 先注册再发送提示；提示 ID 返回前 pending 保持 sending，任何入站回答都不能结算。
    this.leases.set(id, lease)
    const sendController = new AbortController()
    this.sendControllers.set(id, sendController)
    const outcomePromise = this.registry.register(entry, this.deps.timeoutMs, {
      onResolved: (resolvedEntry) => {
        const controller = this.sendControllers.get(resolvedEntry.id)
        this.sendControllers.delete(resolvedEntry.id)
        controller?.abort()
        const ownedLease = this.leases.get(resolvedEntry.id)
        if (ownedLease) {
          this.leases.delete(resolvedEntry.id)
          if (this.deps.confirmIds) this.deps.confirmIds.release(ownedLease)
          else releaseConfirmId(ownedLease)
        }
        if (resolvedEntry.trackId) {
          try { this.deps.onTrackConfirmationChild?.(resolvedEntry, 'settled') }
          catch (error) {
            logPromptDiagnostic(this.deps.log, 'confirm.track-child-settlement-failed', {
              lane: this.deps.lane, sessionId: resolvedEntry.sessionId, requestId: resolvedEntry.requestId ?? resolvedEntry.id,
              confirmationId: resolvedEntry.id, errorCategory: error instanceof Error ? error.name : 'unknown', at: Date.now()
            })
          }
        }
      }
    })
    const settleUnavailable = (promptSendFailure: ConfirmationPromptSendFailure, details?: PromptSendErrorDetails) => {
      if (this.registry.get(id) !== entry) return
      logPromptDiagnostic(this.deps.log, 'confirm.prompt-send-failed', {
        lane: this.deps.lane, sessionId: entry.sessionId, requestId: entry.requestId ?? id,
        confirmId: id, toolName: entry.toolName, sendCall: promptSendFailure.sendCall, delivery: promptSendFailure.delivery,
        errorCategory: promptSendFailure.errorCategory,
        ...(details?.sdkErrorCode ? { sdkErrorCode: details.sdkErrorCode } : {}),
        ...(details?.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
        ...(details?.apiErrcode !== undefined ? { apiErrcode: details.apiErrcode } : {}),
        at: Date.now()
      })
      this.promptSendFailures.set(id, promptSendFailure)
      this.registry.resolve(id, 'unavailable')
    }
    const settleSendFailure = (error: unknown) => {
      const details = promptSendErrorDetails(error)
      settleUnavailable({
        kind: 'confirmation-prompt-send-failed', state: 'send-rejected', sendCall: 'rejected', delivery: 'unknown', errorCategory: details.category
      }, details)
    }
    const settlePromptFailure = (failure: PromptSendResult & { kind: 'not-attempted' | 'send-rejected' | 'binding-unavailable' | 'timed-out' } | PromptPreflightFailure) => {
      const isPreflight = failure.kind === 'not-attempted'
      const isBindingFailure = failure.kind === 'binding-unavailable'
      const isTimedOut = failure.kind === 'timed-out'
      const details = failure.kind === 'send-rejected' ? promptSendErrorDetails(failure.error) : undefined
      const base = { kind: 'confirmation-prompt-send-failed' as const }
      const promptSendFailure: ConfirmationPromptSendFailure = isPreflight
        ? { ...base, state: 'not-attempted', sendCall: 'not-attempted', delivery: 'not-attempted', errorCategory: failure.errorCategory }
        : isBindingFailure
          ? { ...base, state: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unavailable', errorCategory: 'message-binding-unavailable' }
          : isTimedOut
            ? { ...base, state: 'send-pending', sendCall: 'pending', delivery: 'unknown', errorCategory: 'unknown' }
            : { ...base, state: 'send-rejected', sendCall: 'rejected', delivery: 'unknown', errorCategory: details?.category ?? (failure.kind === 'send-rejected' ? promptSendErrorDetails(failure.error).category : 'unknown') }
      settleUnavailable(promptSendFailure, details)
    }
    try {
      Promise.resolve(this.deps.sendPrompt(entry, sendController.signal)).then((result) => {
        if (this.registry.get(id) !== entry) return
        if (result && typeof result === 'object' && 'kind' in result) {
          const promptResult = result as PromptSendResult
          if (promptResult.kind === 'not-attempted' || promptResult.kind === 'send-rejected' || promptResult.kind === 'binding-unavailable' || promptResult.kind === 'timed-out') {
            settlePromptFailure(promptResult)
            return
          }
          if (promptResult.kind === 'cancelled') {
            if (this.registry.get(id) === entry) {
              settlePromptFailure(promptResult.sendCall === 'fulfilled'
                ? { kind: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unbound', errorCategory: 'message-binding-unavailable' }
                : { kind: 'timed-out', sendCall: 'pending', delivery: 'unknown' })
            }
            return
          }
          if (promptResult.kind === 'sent') {
            if (promptResult.binding.kind === 'message-id') entry.promptMessageId = promptResult.binding.value
            else entry.promptQuoteMarker = promptResult.binding.marker
            logPromptDiagnostic(this.deps.log, 'confirm.prompt-send-finished', {
              lane: this.deps.lane, sessionId: entry.sessionId, requestId: entry.requestId ?? id,
              confirmId: id, toolName: entry.toolName, sendCall: promptResult.sendCall, delivery: 'bound', at: Date.now(),
              ...(promptResult.binding.kind === 'message-id' ? { promptMessageIdHash: contentHash(promptResult.binding.value) } : {}),
              ...('clientId' in promptResult.binding && promptResult.binding.clientId
                ? { promptClientIdHash: contentHash(promptResult.binding.clientId) }
                : {})
            })
            return
          }
        }
        if (!result || !('messageId' in result) || typeof result.messageId !== 'string' || !result.messageId.trim()) {
          settleSendFailure(new Error('CONFIRMATION_PROMPT_MESSAGE_ID_MISSING'))
          return
        }
        entry.promptMessageId = result.messageId
        logPromptDiagnostic(this.deps.log, 'confirm.prompt-send-finished', {
          lane: this.deps.lane, sessionId: entry.sessionId, requestId: entry.requestId ?? id,
          confirmId: id, toolName: entry.toolName, sendCall: 'fulfilled', delivery: 'bound',
          promptMessageIdHash: contentHash(result.messageId), at: Date.now()
        })
      }, settleSendFailure)
    } catch (error) {
      settleSendFailure(error)
    }
    return outcomePromise.then((decision) => {
      const memory = this.pendingMemory.get(id)
      const promptSendFailure = decision === 'unavailable' ? this.promptSendFailures.get(id) : undefined
      // 记忆档位随请求结束即清理，pendingMemory 不随长跑进程累积
      this.pendingMemory.delete(id)
      this.promptSendFailures.delete(id)
      this.emitConfirmOutcome(decision, entry, memory)
      const outcome = toOutcome(decision, entry.memoryTiers, memory)
      return promptSendFailure && outcome.kind === 'rejected'
        ? { ...outcome, promptSendFailure }
        : outcome
    })
  }

  /**
   * 入站解析：一次性处理 Y/N/记N/TRUST 结果。返回是否消费了该消息。
   * `selectedTier` 用于记N 档位选择。
   */
  tryResolveFromInbound(
    parsed: { kind: string; confirmId?: string; tier?: number },
    inbound: { matchKey?: string; messageId: string; quotedMessageId?: string; quotedMessageText?: string }
  ): boolean {
    if (parsed.kind === 'not_confirm') return false
    if (parsed.kind === 'trust_misclick' || parsed.kind === 'usage_hint') {
      const any = this.registry.listPending().find((p) => this.isInboundAuthorized(inbound, p))
      if (any) this.deps.onHint?.(any, parsed.kind)
      return true
    }
    if (parsed.confirmId == null) return false
    const sending = this.registry.listPending().find((p) => p.confirmId === parsed.confirmId && !p.promptMessageId && !p.promptQuoteMarker && this.isInboundAuthorized(inbound, p))
    if (sending) {
      this.deps.onHint?.(sending, 'prompt_sending')
      return true
    }
    const match = this.registry
      .listPending()
      .find((p) => p.confirmId === parsed.confirmId && this.isPromptBoundReply(inbound, p))
    if (!match) {
      const quoteRequired = this.registry.listPending().find((p) => p.confirmId === parsed.confirmId && (p.promptMessageId || p.promptQuoteMarker) && this.isInboundAuthorized(inbound, p))
      if (quoteRequired) this.deps.onHint?.(quoteRequired, 'quote_required')
      return true
    }

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
    inbound: { matchKey?: string; messageId: string; quotedMessageId?: string; quotedMessageText?: string },
    entry: ImPendingConfirm
  ): boolean {
    if (this.deps.isAuthorizedInbound) return this.deps.isAuthorizedInbound(inbound, entry)
    return inbound.matchKey === entry.matchKey && entry.messageId !== inbound.messageId
  }

  private isPromptBoundReply(inbound: { matchKey?: string; messageId: string; quotedMessageId?: string; quotedMessageText?: string }, entry: ImPendingConfirm): boolean {
    const messageIdMatches = Boolean(entry.promptMessageId && inbound.quotedMessageId === entry.promptMessageId)
    const quoteMarkerMatches = Boolean(entry.promptQuoteMarker && inbound.quotedMessageText?.includes(entry.promptQuoteMarker))
    return Boolean((messageIdMatches || quoteMarkerMatches) && this.isInboundAuthorized(inbound, entry))
  }

  private resolve(id: string, decision: PendingDecision, memory?: MemoryTier): void {
    const entry = this.registry.get(id)
    if (!entry) return
    this.pendingMemory.set(id, memory)
    this.registry.resolve(id, decision)
  }

  private pendingMemory = new Map<string, MemoryTier | undefined>()
  private promptSendFailures = new Map<string, ConfirmationPromptSendFailure>()

  private emitConfirmOutcome(decision: PendingDecision, entry: ImPendingConfirm, memory?: MemoryTier): void {
    logPromptDiagnostic(this.deps.log, 'confirm.resolved', { confirmId: entry.id, decision })
    try { this.deps.audit?.record({
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
    }) } catch { /* Audit failures cannot alter a settled confirmation. */ }
  }

  /** 供测试检查最近一次 resolve 的记忆档位。 */
  lastMemory(id: string): MemoryTier | undefined {
    return this.pendingMemory.get(id)
  }
}
