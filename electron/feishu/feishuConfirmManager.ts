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
import {
  formatImConfirmPromptFooter,
  IM_CONFIRM_TRUST_MISCLICK_HINT,
  IM_CONFIRM_USAGE_HINT,
  parseImConfirmReply
} from '../remote/imConfirmReply'
import { addTrustedCommand, canShowShellTrustOption } from '../shell/shellCommandTrust'
import type { ShellAnalysisResult } from '../shell/shellTypes'

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
  /** When false, trust phrases are rejected without approving. */
  trustEligible?: boolean
}

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

  cancelAllPending(): void {
    for (const { id } of this.registry.listPending()) {
      this.resolve(id, 'n')
    }
  }

  tryResolveFromInbound(
    msg: FeishuInboundMessage,
    opts?: { ownerOpenId?: string }
  ): boolean {
    const parsed = parseImConfirmReply(msg.content)
    if (parsed.kind === 'not_confirm') return false

    // Confirm path requires bound owner + p2p (must not resolve from group / non-owner).
    if (!isFeishuConfirmAuthorizedSender(msg, opts?.ownerOpenId)) return false

    const match = this.registry.listPending().find((p) => matchesFeishuConfirmPending(p, msg))
    if (!match) return false

    if (parsed.kind === 'trust_misclick' || parsed.kind === 'usage_hint') {
      void this.replyHint(
        match,
        parsed.kind === 'trust_misclick' ? IM_CONFIRM_TRUST_MISCLICK_HINT : IM_CONFIRM_USAGE_HINT
      )
      return true
    }

    if (parsed.kind === 'approve_and_trust') {
      if (match.trustEligible === false || !this.tryAddTrust(match)) {
        void this.replyHint(match, IM_CONFIRM_USAGE_HINT)
        return true
      }
      logFeishuCliEvent('info', 'feishu.inbound.confirm_resolved', {
        confirmId: match.id,
        decision: 'y',
        trust: true
      })
      this.resolve(match.id, 'y')
      return true
    }

    const decision: 'y' | 'n' = parsed.kind === 'approve' ? 'y' : 'n'
    logFeishuCliEvent('info', 'feishu.inbound.confirm_resolved', { confirmId: match.id, decision })
    this.resolve(match.id, decision)
    return true
  }

  private tryAddTrust(pending: FeishuPendingConfirm): boolean {
    if (pending.toolName !== 'run_shell' || !this.db) return false
    const command = typeof pending.toolInput?.command === 'string' ? pending.toolInput.command : ''
    if (!command.trim()) return false
    const added = addTrustedCommand(this.db, command, { source: 'im-feishu' })
    if (!added) return false
    logFeishuCliEvent('info', 'feishu.trust.add', {
      confirmId: pending.id,
      commandPreview: command.slice(0, 80)
    })
    return true
  }

  private replyHint(pending: FeishuPendingConfirm, text: string): void {
    if (!this.runner) return
    void replyFeishuText(this.runner, pending.messageId, text).catch(() => undefined)
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
      trustEligible: pending.trustEligible ?? false,
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
    const footer = formatImConfirmPromptFooter({ trustEligible: pending.trustEligible === true })
    if (pending.toolName === 'browser' && pending.toolInput) {
      const action = pending.toolInput.action
      if (action === 'navigate' && typeof pending.toolInput.url === 'string') {
        return `${progressPrefix}⚠️ 需要在浏览器中打开网页：\n${pending.toolInput.url.slice(0, 500)}\n${footer}（10 分钟内有效）`
      }
      if (action === 'act' && typeof pending.toolInput.instruction === 'string') {
        return `${progressPrefix}⚠️ 需要在浏览器中执行操作：\n${pending.toolInput.instruction.slice(0, 200)}\n${footer}（10 分钟内有效）`
      }
    }
    let cmd =
      pending.toolName === 'run_lark_cli' && pending.toolInput?.args
        ? `lark-cli ${(pending.toolInput.args as string[]).join(' ')}`
        : pending.toolName === 'run_shell' && typeof pending.toolInput?.command === 'string'
          ? pending.toolInput.command
          : pending.toolName === 'run_script' && typeof pending.toolInput?.code === 'string'
            ? pending.toolInput.code.trim().split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))?.slice(0, 120) ??
              'run_script'
            : (pending.toolName ?? 'unknown')
    if (pending.toolName === 'run_script' && typeof pending.toolInput?.code === 'string') {
      const full = pending.toolInput.code
      if (full.length > 4000) {
        cmd = `${full.slice(0, 4000)}\n…（脚本过长，请在桌面端查看全文）`
      } else {
        cmd = full.slice(0, 2000)
      }
    }
    return `${progressPrefix}⚠️ 需要确认以下操作：\n工具：${pending.toolName}\n命令：${String(cmd).slice(0, 2000)}\n${footer}（10 分钟内有效）`
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

/** Helper for remoteConfirmBridge: trust option only for eligible shell. */
export function resolveShellTrustEligible(analysis?: ShellAnalysisResult | null): boolean {
  if (!analysis) return false
  return canShowShellTrustOption(analysis)
}

/** Confirm replies are only accepted from the bound owner in a p2p chat. */
export function isFeishuConfirmAuthorizedSender(
  msg: FeishuInboundMessage,
  ownerOpenId?: string
): boolean {
  if (msg.chatType !== 'p2p') return false
  if (!ownerOpenId) return false
  return msg.senderOpenId === ownerOpenId
}

/** Match pending confirm to an inbound Y/N in the same private chat. */
export function matchesFeishuConfirmPending(
  pending: Pick<FeishuPendingConfirm, 'chatId' | 'messageId'>,
  msg: FeishuInboundMessage
): boolean {
  return pending.chatId === msg.chatId && pending.messageId !== msg.messageId
}
