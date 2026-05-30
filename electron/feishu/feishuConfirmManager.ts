import { randomUUID } from 'crypto'
import type { FeishuConfig, FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { stripCommandPrefix } from './feishuInboundParser'
import { logFeishuCliEvent } from './feishuCliLogger'
import type { FeishuAuditLogger } from './feishuAuditLogger'
import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuText } from './feishuReply'
import { formatFeishuRemoteProgressPrefix } from './feishuRemoteProgress'

export interface InboundAcceptResult {
  accept: boolean
  reason?: string
  userMessage?: string
}

export function shouldAcceptInbound(msg: FeishuInboundMessage, config: FeishuConfig): InboundAcceptResult {
  if (!msg.content.trim()) return { accept: false, reason: 'empty' }
  if (msg.content.length > 4000) return { accept: false, reason: 'too_long' }

  if (msg.chatType === 'p2p') {
    return { accept: true, userMessage: msg.content.trim() }
  }

  if (msg.chatType === 'group') {
    const trigger = config.remoteGroupTrigger ?? 'mention'
    const prefix = config.remoteCommandPrefix ?? '/sa '
    const byMention = msg.mentionsBot
    const byPrefix = msg.content.startsWith(prefix)

    switch (trigger) {
      case 'mention':
        return byMention
          ? { accept: true, userMessage: msg.content.trim() }
          : { accept: false, reason: 'no_mention' }
      case 'prefix':
        return byPrefix
          ? { accept: true, userMessage: stripCommandPrefix(msg.content, prefix) }
          : { accept: false, reason: 'no_prefix' }
      case 'both':
        if (byMention) return { accept: true, userMessage: msg.content.trim() }
        if (byPrefix) return { accept: true, userMessage: stripCommandPrefix(msg.content, prefix) }
        return { accept: false, reason: 'no_trigger' }
    }
  }

  return { accept: false, reason: 'unsupported_chat_type' }
}

export function truncateTitle(content: string, max = 30): string {
  const t = content.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

export type FeishuConfirmKind = 'tool_write'

export interface FeishuPendingConfirm {
  id: string
  kind: FeishuConfirmKind
  sessionId: string
  toolCallId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  messageId: string
  confirmMessageId?: string
  chatId: string
  createdAt: number
  expiresAt: number
}

const CONFIRM_RE = /^[Yy]$|^[Nn]$|^确认$|^取消$/

export class FeishuConfirmManager {
  private pending = new Map<string, FeishuPendingConfirm>()
  private resolvers = new Map<string, (v: 'y' | 'n' | 'timeout') => void>()

  constructor(
    private auditLogger?: FeishuAuditLogger,
    private runner?: LarkCliRunner
  ) {}

  listPending(): FeishuPendingConfirm[] {
    return [...this.pending.values()]
  }

  countPending(): number {
    return this.pending.size
  }

  cancel(id: string): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    logFeishuCliEvent('info', 'feishu.confirm.cancel', { confirmId: id })
    this.resolve(id, 'n')
    return true
  }

  /** 应用退出时取消全部待确认，避免 10–30 分钟定时器阻止进程结束。 */
  cancelAllPending(): void {
    for (const id of [...this.pending.keys()]) {
      this.resolve(id, 'n')
    }
  }

  tryResolveFromInbound(msg: FeishuInboundMessage): boolean {
    const text = msg.content.trim()
    if (!CONFIRM_RE.test(text)) return false

    const match = [...this.pending.values()].find(
      (p) => p.chatId === msg.chatId && (msg.chatType === 'p2p' || p.messageId !== msg.messageId)
    )
    if (!match) return false

    const decision: 'y' | 'n' = /^[Yy]$|^确认$/.test(text) ? 'y' : 'n'
    logFeishuCliEvent('info', 'feishu.inbound.confirm_resolved', { confirmId: match.id, decision })
    this.resolve(match.id, decision)
    return true
  }

  private resolve(id: string, decision: 'y' | 'n' | 'timeout'): void {
    logFeishuCliEvent('info', 'feishu.confirm.resolved', { confirmId: id, decision })
    void this.auditLogger?.append({ type: 'confirm_request', confirmId: id, decision })
    const resolver = this.resolvers.get(id)
    this.resolvers.delete(id)
    this.pending.delete(id)
    resolver?.(decision)
  }

  requestConfirm(
    pending: Omit<FeishuPendingConfirm, 'id' | 'createdAt' | 'expiresAt'>,
    timeoutMs = 10 * 60_000
  ): Promise<'y' | 'n' | 'timeout'> {
    const existingForSession = [...this.pending.values()].find((p) => p.sessionId === pending.sessionId)
    if (existingForSession) {
      return Promise.resolve('n')
    }

    const id = randomUUID()
    const now = Date.now()
    const entry: FeishuPendingConfirm = {
      ...pending,
      id,
      createdAt: now,
      expiresAt: now + timeoutMs
    }
    this.pending.set(id, entry)
    logFeishuCliEvent('info', 'feishu.confirm.request', {
      confirmId: id,
      kind: entry.kind,
      sessionId: entry.sessionId,
      toolName: entry.toolName,
      messageId: entry.messageId,
      chatId: entry.chatId,
      expiresAt: entry.expiresAt
    })
    void this.auditLogger?.append({
      type: 'confirm_request',
      confirmId: id
    })
    void this.notifyConfirmPrompt(entry)

    return new Promise((resolve) => {
      this.resolvers.set(id, resolve)
      const timer = setTimeout(() => {
        if (this.pending.has(id)) this.resolve(id, 'timeout')
      }, timeoutMs)
      const orig = this.resolvers.get(id)
      this.resolvers.set(id, (v) => {
        clearTimeout(timer)
        orig?.(v)
      })
    })
  }

  buildConfirmPromptText(pending: FeishuPendingConfirm): string {
    const progressPrefix = formatFeishuRemoteProgressPrefix(pending.sessionId)
    if (pending.toolName === 'browser' && pending.toolInput) {
      const action = pending.toolInput.action
      if (action === 'navigate' && typeof pending.toolInput.url === 'string') {
        return `${progressPrefix}⚠️ 需要在浏览器中打开网页：\n${pending.toolInput.url.slice(0, 500)}\n回复 Y 确认，N 取消（10 分钟内有效）`
      }
      if (action === 'act' && typeof pending.toolInput.instruction === 'string') {
        return `${progressPrefix}⚠️ 需要在浏览器中执行操作：\n${pending.toolInput.instruction.slice(0, 200)}\n回复 Y 确认，N 取消（10 分钟内有效）`
      }
    }
    const cmd =
      pending.toolName === 'run_lark_cli' && pending.toolInput?.args
        ? `lark-cli ${(pending.toolInput.args as string[]).join(' ')}`
        : pending.toolName === 'run_script' && typeof pending.toolInput?.code === 'string'
          ? pending.toolInput.code.trim().split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))?.slice(0, 120) ??
            'run_script'
          : (pending.toolName ?? 'unknown')
    return `${progressPrefix}⚠️ 需要确认以下操作：\n工具：${pending.toolName}\n命令：${cmd.slice(0, 200)}\n回复 Y 确认执行，N 取消（10 分钟内有效）`
  }

  private notifyConfirmPrompt(entry: FeishuPendingConfirm): void {
    if (!this.runner) return
    const text = this.buildConfirmPromptText(entry)
    void replyFeishuText(this.runner, entry.messageId, text).catch((e) => {
      logFeishuCliEvent('error', 'feishu.confirm.prompt_failed', {
        confirmId: entry.id,
        messageId: entry.messageId,
        error: e instanceof Error ? e.message : String(e)
      })
    })
  }
}
