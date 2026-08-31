import type { WebContents } from 'electron'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { WeChatAuditLogger } from './weChatAuditLogger'
import { logWeChatCliEvent } from './weChatCliLogger'
import { buildConfirmInstantPrompt } from '../remote/remoteProgressHooks'
import {
  formatImConfirmPromptFooter,
  parseImConfirmReply
} from '../remote/imConfirmReply'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import { addTrustedCommand } from '../shell/shellCommandTrust'
import type { AppDatabase } from '../database'
import { ImChannel, type ImPendingConfirm } from '../confirmation/imChannel'
import { getSecurityAuditLog } from '../confirmation/audit'
import type { ConfirmRequest } from '../../src/shared/confirmation/types'

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
  private readonly im: ImChannel

  constructor(
    private auditLogger?: WeChatAuditLogger,
    private getWebContents?: () => WebContents | null,
    private getReplyBot?: () => import('./weChatReplyService').WeChatReplyBot | undefined,
    private db?: AppDatabase
  ) {
    this.im = new ImChannel({
      lane: 'wechat',
      timeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
      audit: getSecurityAuditLog(),
      log: (event, fields) => {
        logWeChatCliEvent('info', event, fields)
        if (event === 'confirm.request') {
          void this.auditLogger?.append({ type: 'confirm_request', confirmId: String(fields.confirmId ?? '') })
        }
        if (event === 'confirm.resolved') {
          void this.auditLogger?.append({
            type: 'confirm_request',
            confirmId: String(fields.confirmId ?? ''),
            decision: String(fields.decision ?? '') as 'y' | 'n' | 'timeout'
          })
          this.getWebContents?.()?.send('wechat:pending-confirm', { count: this.countPending() })
        }
      },
      sendPrompt: (entry) => {
        const replyBot = this.getReplyBot?.()
        if (!replyBot) return
        const inbound = entry.context as IncomingMessage
        const prompt = this.buildWeChatYnPrompt(entry as unknown as WeChatPendingConfirm)
        if (prompt) void replyBot.reply(inbound, prompt).catch(() => undefined)
      }
    })
  }

  listPending(): WeChatPendingConfirm[] {
    return this.im.listPending() as unknown as WeChatPendingConfirm[]
  }

  hasPendingForSession(sessionId: string): boolean {
    return this.im.hasPendingForSession(sessionId)
  }

  countPending(): number {
    return this.im.countPending()
  }

  cancel(id: string): boolean {
    return this.im.cancel(id)
  }

  cancelAllPending(): void {
    this.im.cancelAllPending()
  }

  cancelByChannel(channel: 'feishu' | 'wechat'): number {
    return this.im.cancelByChannel(channel)
  }

  tryResolveFromInbound(
    msg: WeChatInboundMessage,
    _inboundRaw: IncomingMessage,
    opts?: { allowedUserIds?: string[] }
  ): boolean {
    const parsed = parseImConfirmReply(msg.text)
    if (parsed.kind === 'not_confirm') return false

    if (!isWeChatConfirmAuthorizedSender(msg, opts?.allowedUserIds)) return false
    return this.im.tryResolveFromInbound(
      parsed as { kind: string; confirmId?: string; tier?: number },
      { matchKey: msg.userId, messageId: msg.messageId }
    )
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
    return this.im.resolveFromDesktop(requestId, approved)
  }

  requestConfirm(
    pending: Omit<WeChatPendingConfirm, 'id' | 'createdAt' | 'expiresAt' | 'channel'>,
    _wechatConfig: WeChatConfig,
    timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
    options?: WeChatConfirmRequestOptions
  ): Promise<'y' | 'n' | 'timeout'> {
    const confirmRequest: ConfirmRequest = {
      facts: {
        toolName: pending.toolName ?? 'unknown',
        actionClass: 'write',
        baseRiskLevel: 'medium',
        signals: [],
        summary: { text: pending.toolName ?? 'unknown' }
      },
      riskLevel: 'medium',
      memoryTiers: [],
      timeoutMs: null
    }
    return this.im.request(confirmRequest, {
      sessionId: pending.sessionId,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
      messageId: pending.messageId,
      matchKey: pending.userId,
      context: pending.inboundMsg,
      trustEligible: pending.trustEligible ?? false,
      authOwner: pending.authOwner,
      authorizationGeneration:
        pending.authorizationGeneration ?? remoteAuthorizationRegistry.getGeneration('wechat'),
      requestId: pending.requestId,
      memoryTiers: []
    }).then((outcome) => {
      if (outcome.kind === 'approved') return 'y'
      if (outcome.kind === 'timeout') return 'timeout'
      return 'n'
    })
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
