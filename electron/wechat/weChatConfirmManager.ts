import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { WeChatAuditLogger } from './weChatAuditLogger'
import type { WeChatReplyBot } from './weChatReplyService'
import { logWeChatCliEvent } from './weChatCliLogger'
import { buildConfirmInstantPrompt } from '../remote/remoteProgressHooks'

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
}

const CONFIRM_RE = /^[Yy]$|^[Nn]$|^确认$|^取消$/
const DEFAULT_CONFIRM_TIMEOUT_MS = 5 * 60_000

export type WeChatConfirmRequestOptions = {
  imPrompt?: string
}

export class WeChatConfirmManager {
  private pending = new Map<string, WeChatPendingConfirm>()
  private resolvers = new Map<string, (v: 'y' | 'n' | 'timeout') => void>()

  constructor(
    private auditLogger?: WeChatAuditLogger,
    private getWebContents?: () => WebContents | null,
    private getReplyBot?: () => import('./weChatReplyService').WeChatReplyBot | undefined
  ) {}

  listPending(): WeChatPendingConfirm[] {
    return [...this.pending.values()]
  }

  hasPendingForSession(sessionId: string): boolean {
    return [...this.pending.values()].some((p) => p.sessionId === sessionId)
  }

  countPending(): number {
    return this.pending.size
  }

  cancel(id: string): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.resolve(id, 'n')
    return true
  }

  cancelAllPending(): void {
    for (const id of [...this.pending.keys()]) {
      this.resolve(id, 'n')
    }
  }

  tryResolveFromInbound(msg: WeChatInboundMessage, inboundRaw: IncomingMessage): boolean {
    const text = msg.text.trim()
    if (!CONFIRM_RE.test(text)) return false

    const match = [...this.pending.values()].find(
      (p) => p.userId === msg.userId && p.messageId !== msg.messageId
    )
    if (!match) return false

    const decision: 'y' | 'n' = /^[Yy]$|^确认$/.test(text) ? 'y' : 'n'
    this.resolve(match.id, decision)
    return true
  }

  resolveFromDesktop(requestId: string, approved: boolean): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.resolve(requestId, approved ? 'y' : 'n')
    return true
  }

  private resolve(id: string, decision: 'y' | 'n' | 'timeout'): void {
    void this.auditLogger?.append({ type: 'confirm_request', confirmId: id, decision })
    logWeChatCliEvent('info', 'wechat.remote.confirm', { confirmId: id, decision })
    const resolver = this.resolvers.get(id)
    this.resolvers.delete(id)
    this.pending.delete(id)
    resolver?.(decision)
    this.getWebContents?.()?.send('wechat:pending-confirm', { count: this.pending.size })
  }

  requestConfirm(
    pending: Omit<WeChatPendingConfirm, 'id' | 'createdAt' | 'expiresAt'>,
    _wechatConfig: WeChatConfig,
    timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
    options?: WeChatConfirmRequestOptions
  ): Promise<'y' | 'n' | 'timeout'> {
    const existingForSession = [...this.pending.values()].find((p) => p.sessionId === pending.sessionId)
    if (existingForSession) return Promise.resolve('n')

    const id = randomUUID()
    const now = Date.now()
    const entry: WeChatPendingConfirm = {
      ...pending,
      id,
      createdAt: now,
      expiresAt: now + timeoutMs
    }
    this.pending.set(id, entry)
    void this.auditLogger?.append({ type: 'confirm_request', confirmId: id })
    logWeChatCliEvent('info', 'wechat.confirm.request', {
      confirmId: id,
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
    wc?.send('wechat:pending-confirm', { count: this.pending.size })

    const replyBot = this.getReplyBot?.()
    const prompt = options?.imPrompt ?? this.buildWeChatYnPrompt(entry)
    if (replyBot && prompt) {
      void replyBot.reply(pending.inboundMsg, prompt).catch(() => undefined)
    }

    return new Promise((resolve) => {
      this.resolvers.set(id, resolve)
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.resolve(id, 'timeout')
          if (replyBot) {
            void replyBot
              .reply(pending.inboundMsg, '操作已取消（确认超时）')
              .catch(() => undefined)
          }
        }
      }, timeoutMs)
      const orig = this.resolvers.get(id)
      this.resolvers.set(id, (v) => {
        clearTimeout(timer)
        orig?.(v)
      })
    })
  }

  buildWeChatYnPrompt(pending: WeChatPendingConfirm, progressPrefix = ''): string {
    const tool = pending.toolName ?? 'unknown'
    const summary = `该操作需在确认后执行：\n工具：${tool}`
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
