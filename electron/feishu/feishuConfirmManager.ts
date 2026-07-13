import { randomUUID } from 'crypto'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { logFeishuCliEvent } from './feishuCliLogger'
import type { FeishuAuditLogger } from './feishuAuditLogger'
import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuText } from './feishuReply'
import { sendFeishuRemoteOutbound } from './feishuRemoteOutbound'
import { formatFeishuRemoteProgressPrefix } from './feishuRemoteProgress'
import type { AppDatabase } from '../database'
import {
  PendingRequestRegistry,
  type PendingDecision
} from '../remote/pendingRequestRegistry'

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
  private registry = new PendingRequestRegistry<FeishuPendingConfirm>()

  constructor(
    private auditLogger?: FeishuAuditLogger,
    private runner?: LarkCliRunner,
    private db?: AppDatabase
  ) {}

  listPending(): FeishuPendingConfirm[] {
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
    logFeishuCliEvent('info', 'feishu.confirm.cancel', { confirmId: id })
    this.resolve(id, 'n')
    return true
  }

  /** 应用退出时取消全部待确认，避免 10–30 分钟定时器阻止进程结束。 */
  cancelAllPending(): void {
    for (const { id } of this.registry.listPending()) {
      this.resolve(id, 'n')
    }
  }

  tryResolveFromInbound(msg: FeishuInboundMessage): boolean {
    const text = msg.content.trim()
    if (!CONFIRM_RE.test(text)) return false

    const match = this.registry.listPending().find(
      (p) => p.chatId === msg.chatId && (msg.chatType === 'p2p' || p.messageId !== msg.messageId)
    )
    if (!match) return false

    const decision: 'y' | 'n' = /^[Yy]$|^确认$/.test(text) ? 'y' : 'n'
    logFeishuCliEvent('info', 'feishu.inbound.confirm_resolved', { confirmId: match.id, decision })
    this.resolve(match.id, decision)
    return true
  }

  private emitResolved(id: string, decision: PendingDecision): void {
    logFeishuCliEvent('info', 'feishu.confirm.resolved', { confirmId: id, decision })
    void this.auditLogger?.append({ type: 'confirm_request', confirmId: id, decision })
  }

  private resolve(id: string, decision: PendingDecision): void {
    if (!this.registry.get(id)) return
    this.emitResolved(id, decision)
    this.registry.resolve(id, decision)
  }

  requestConfirm(
    pending: Omit<FeishuPendingConfirm, 'id' | 'createdAt' | 'expiresAt'>,
    timeoutMs = 10 * 60_000
  ): Promise<'y' | 'n' | 'timeout'> {
    if (this.registry.hasPendingForSession(pending.sessionId)) {
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

    return this.registry.register(entry, timeoutMs, {
      onTimeout: () => this.emitResolved(id, 'timeout')
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
    const send = this.db
      ? () =>
          sendFeishuRemoteOutbound({
            runner: this.runner!,
            messageId: entry.messageId,
            body: text,
            sessionId: entry.sessionId,
            touch: { db: this.db!, sessionId: entry.sessionId }
          })
      : () => replyFeishuText(this.runner!, entry.messageId, text)
    void send().catch((e) => {
      logFeishuCliEvent('error', 'feishu.confirm.prompt_failed', {
        confirmId: entry.id,
        messageId: entry.messageId,
        error: e instanceof Error ? e.message : String(e)
      })
    })
  }
}
