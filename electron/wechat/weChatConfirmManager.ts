import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { WeChatAuditLogger } from './weChatAuditLogger'
import { logWeChatCliEvent } from './weChatCliLogger'
import { buildConfirmInstantPrompt } from '../remote/remoteProgressHooks'
import {
  PendingRequestRegistry,
  type PendingDecision
} from '../remote/pendingRequestRegistry'
import {
  formatImConfirmPromptFooter,
  IM_CONFIRM_TRUST_MISCLICK_HINT,
  IM_CONFIRM_USAGE_HINT,
  parseImConfirmReply
} from '../remote/imConfirmReply'
import { allocateConfirmId, releaseConfirmId } from '../remote/confirmId'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import { addTrustedCommand } from '../shell/shellCommandTrust'
import type { AppDatabase } from '../database'

export type WeChatConfirmKind = 'tool_write'

export interface WeChatPendingConfirm {
  id: string
  kind: WeChatConfirmKind
  sessionId: string
  toolCallId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  messageId: string
  userId: string
  inboundMsg: IncomingMessage
  createdAt: number
  expiresAt: number
  trustEligible?: boolean
  channel: 'wechat'
  authOwner?: string
  authorizationGeneration?: number
  requestId?: string
  /** Short confirm id for IM protocol (Y <confirmId>) */
  confirmId?: string
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 5 * 60_000

export type WeChatConfirmRequestOptions = {
  imPrompt?: string
}

export class WeChatConfirmManager {
  private registry = new PendingRequestRegistry<WeChatPendingConfirm>()

  constructor(
    private auditLogger?: WeChatAuditLogger,
    private getWebContents?: () => WebContents | null,
    private getReplyBot?: () => import('./weChatReplyService').WeChatReplyBot | undefined,
    private db?: AppDatabase
  ) {}

  listPending(): WeChatPendingConfirm[] {
    return this.registry.listPending()
  }

  hasPendingForSession(sessionId: string): boolean {
    return this.registry.hasPendingForSession(sessionId)
  }

  countPending(): number {
    return this.registry.countPending()
  }

  cancel(id: string): boolean {
    if (!this.registry.get(id)) return false
    this.resolve(id, 'n')
    return true
  }

  cancelAllPending(): void {
    for (const { id } of this.registry.listPending()) {
      this.resolve(id, 'n')
    }
  }

  cancelByChannel(channel: 'feishu' | 'wechat'): number {
    if (channel !== 'wechat') return 0
    const ids = this.registry.listPending().map((p) => p.id)
    for (const id of ids) this.resolve(id, 'n')
    return ids.length
  }

  tryResolveFromInbound(
    msg: WeChatInboundMessage,
    _inboundRaw: IncomingMessage,
    opts?: { allowedUserIds?: string[] }
  ): boolean {
    const parsed = parseImConfirmReply(msg.text)
    if (parsed.kind === 'not_confirm') return false

    if (!isWeChatConfirmAuthorizedSender(msg, opts?.allowedUserIds)) return false

    const replyBot = this.getReplyBot?.()

    if (parsed.kind === 'trust_misclick' || parsed.kind === 'usage_hint') {
      const hint =
        parsed.kind === 'trust_misclick' ? IM_CONFIRM_TRUST_MISCLICK_HINT : IM_CONFIRM_USAGE_HINT
      const anyPending = this.registry.listPending().find((p) => p.userId === msg.userId)
      if (anyPending && replyBot) {
        void replyBot.reply(anyPending.inboundMsg, hint).catch(() => undefined)
        return true
      }
      return true
    }

    const match = this.registry
      .listPending()
      .find(
        (p) =>
          p.confirmId === parsed.confirmId &&
          p.userId === msg.userId &&
          p.messageId !== msg.messageId
      )
    if (!match) {
      if (replyBot) {
        const any = this.registry.listPending().find((p) => p.userId === msg.userId)
        if (any) void replyBot.reply(any.inboundMsg, IM_CONFIRM_USAGE_HINT).catch(() => undefined)
      }
      return true
    }

    // Reject if authorization generation was revoked
    if (
      match.authorizationGeneration != null &&
      match.authorizationGeneration !== remoteAuthorizationRegistry.getGeneration('wechat')
    ) {
      this.resolve(match.id, 'n')
      return true
    }

    if (parsed.kind === 'approve_and_trust') {
      if (match.trustEligible === false || !this.tryAddTrust(match)) {
        if (replyBot) void replyBot.reply(match.inboundMsg, IM_CONFIRM_USAGE_HINT).catch(() => undefined)
        return true
      }
      this.resolve(match.id, 'y')
      return true
    }

    const decision: 'y' | 'n' = parsed.kind === 'approve' ? 'y' : 'n'
    this.resolve(match.id, decision)
    return true
  }

  private tryAddTrust(pending: WeChatPendingConfirm): boolean {
    if (pending.toolName !== 'run_shell' || !this.db) return false
    const command = typeof pending.toolInput?.command === 'string' ? pending.toolInput.command : ''
    if (!command.trim()) return false
    const added = addTrustedCommand(this.db, command, { source: 'im-wechat' })
    if (!added) return false
    logWeChatCliEvent('info', 'wechat.trust.add', {
      confirmId: pending.id,
      commandPreview: command.slice(0, 80)
    })
    return true
  }

  resolveFromDesktop(requestId: string, approved: boolean): boolean {
    if (!this.registry.get(requestId)) return false
    this.resolve(requestId, approved ? 'y' : 'n')
    return true
  }

  private emitResolved(id: string, decision: PendingDecision): void {
    void this.auditLogger?.append({ type: 'confirm_request', confirmId: id, decision })
    logWeChatCliEvent('info', 'wechat.remote.confirm', { confirmId: id, decision })
    this.getWebContents?.()?.send('wechat:pending-confirm', { count: this.registry.countPending() })
  }

  private resolve(id: string, decision: PendingDecision): void {
    const item = this.registry.get(id)
    if (!item) return
    if (item.confirmId) releaseConfirmId(item.confirmId)
    this.registry.resolve(id, decision)
    this.emitResolved(id, decision)
  }

  requestConfirm(
    pending: Omit<WeChatPendingConfirm, 'id' | 'createdAt' | 'expiresAt' | 'channel'>,
    _wechatConfig: WeChatConfig,
    timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
    options?: WeChatConfirmRequestOptions
  ): Promise<'y' | 'n' | 'timeout'> {
    if (this.registry.hasPendingForSession(pending.sessionId)) return Promise.resolve('n')

    const id = randomUUID()
    const confirmId = allocateConfirmId()
    const now = Date.now()
    const entry: WeChatPendingConfirm = {
      ...pending,
      channel: 'wechat',
      confirmId,
      authorizationGeneration:
        pending.authorizationGeneration ?? remoteAuthorizationRegistry.getGeneration('wechat'),
      trustEligible: pending.trustEligible ?? false,
      id,
      createdAt: now,
      expiresAt: now + timeoutMs
    }
    const wait = this.registry.register(entry, timeoutMs, {
      onTimeout: (item) => {
        if (item.confirmId) releaseConfirmId(item.confirmId)
        this.emitResolved(id, 'timeout')
        const replyBot = this.getReplyBot?.()
        if (replyBot) {
          void replyBot
            .reply(item.inboundMsg, '操作已取消（确认超时）')
            .catch(() => undefined)
        }
      }
    })

    void this.auditLogger?.append({ type: 'confirm_request', confirmId: id })
    logWeChatCliEvent('info', 'wechat.confirm.request', {
      confirmId: id,
      shortConfirmId: confirmId,
      sessionId: pending.sessionId,
      toolName: pending.toolName,
      userId: pending.userId
    })

    const wc = this.getWebContents?.()
    wc?.send('wechat:confirm-request', {
      requestId: id,
      type: pending.toolName ?? 'tool_write',
      description: this.buildDescription(entry),
      timestamp: now,
      source: 'wechat'
    })
    wc?.send('wechat:pending-confirm', { count: this.registry.countPending() })

    const replyBot = this.getReplyBot?.()
    const prompt = options?.imPrompt ?? this.buildWeChatYnPrompt(entry)
    if (replyBot && prompt) {
      void replyBot.reply(pending.inboundMsg, prompt).catch(() => undefined)
    }

    return wait
  }

  buildWeChatYnPrompt(pending: WeChatPendingConfirm, progressPrefix = ''): string {
    const tool = pending.toolName ?? 'unknown'
    const footer = formatImConfirmPromptFooter({
      trustEligible: pending.trustEligible === true,
      confirmId: pending.confirmId
    })
    const summary = `该操作需在确认后执行：\n工具：${tool}\n${footer}`
    const prefix = progressPrefix.trim() || `【进度】等待确认：${tool}`
    return buildConfirmInstantPrompt({
      progressPrefix: prefix,
      toolName: tool,
      summary,
      timeoutMinutes: 5
    })
  }

  private buildDescription(pending: WeChatPendingConfirm): string {
    const tool = pending.toolName ?? 'unknown'
    const input = pending.toolInput ? JSON.stringify(pending.toolInput).slice(0, 200) : ''
    return `微信远程 · ${tool}${input ? `: ${input}` : ''}`
  }
}

/** Confirm replies only from allowlisted senders (bound WeChat user). */
export function isWeChatConfirmAuthorizedSender(
  msg: WeChatInboundMessage,
  allowedUserIds?: string[]
): boolean {
  if (!allowedUserIds?.length) return false
  return allowedUserIds.includes(msg.userId)
}
