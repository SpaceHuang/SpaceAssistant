import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { logFeishuCliEvent } from './feishuCliLogger'
import type { FeishuAuditLogger } from './feishuAuditLogger'
import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuText } from './feishuReply'
import { sendFeishuRemoteOutbound } from './feishuRemoteOutbound'
import { formatFeishuRemoteProgressPrefix } from './feishuRemoteProgress'
import type { AppDatabase } from '../database'
import {
  formatImConfirmPromptFooter,
  IM_CONFIRM_TRUST_MISCLICK_HINT,
  IM_CONFIRM_USAGE_HINT,
  parseImConfirmReply
} from '../remote/imConfirmReply'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import { addTrustedCommand, canShowShellTrustOption } from '../shell/shellCommandTrust'
import type { ShellAnalysisResult } from '../shell/shellTypes'
import { ImChannel, type ImPendingConfirm } from '../confirmation/imChannel'
import { getSecurityAuditLog } from '../confirmation/audit'
import type { ConfirmRequest } from '../../src/shared/confirmation/types'

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
  channel: 'feishu'
  authOwner?: string
  authorizationGeneration?: number
  requestId?: string
  /** Short confirm id for IM protocol (Y <confirmId>) */
  confirmId?: string
}

export class FeishuConfirmManager {
  private readonly im: ImChannel

  constructor(
    private auditLogger?: FeishuAuditLogger,
    private runner?: LarkCliRunner,
    private db?: AppDatabase
  ) {
    this.im = new ImChannel({
      lane: 'feishu',
      timeoutMs: 10 * 60_000,
      audit: getSecurityAuditLog(),
      log: (event, fields) => {
        logFeishuCliEvent('info', event, fields)
        if (event === 'confirm.request') {
          void this.auditLogger?.append({ type: 'confirm_request', confirmId: String(fields.confirmId ?? '') })
        }
      },
      sendPrompt: (entry) => {
        if (entry.matchKey) this.notifyConfirmPrompt(entry)
      },
      isAuthorizedInbound: (inbound, entry) => {
        // 归属校验由调用方先做（p2p+owner），这里仅匹配 chatId + 非同一消息
        return inbound.matchKey === entry.matchKey && entry.messageId !== inbound.messageId
      },
      onTrust: (entry) => this.tryAddTrust(entry as unknown as FeishuPendingConfirm),
      onHint: (entry, kind) => {
        const runner = this.runner
        if (!runner) return
        const hint = kind === 'trust_misclick' ? IM_CONFIRM_TRUST_MISCLICK_HINT : IM_CONFIRM_USAGE_HINT
        void replyFeishuText(runner, (entry as unknown as FeishuPendingConfirm).messageId, hint).catch(() => undefined)
      }
    })
  }

  listPending(): FeishuPendingConfirm[] {
    return this.im.listPending() as unknown as FeishuPendingConfirm[]
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
    msg: FeishuInboundMessage,
    opts?: { ownerOpenId?: string }
  ): boolean {
    const parsed = parseImConfirmReply(msg.content)
    if (parsed.kind === 'not_confirm') return false

    // Confirm path requires bound owner + p2p (must not resolve from group / non-owner).
    if (!isFeishuConfirmAuthorizedSender(msg, opts?.ownerOpenId)) return false
    return this.im.tryResolveFromInbound(
      parsed as { kind: string; confirmId?: string; tier?: number },
      { matchKey: msg.chatId, messageId: msg.messageId }
    )
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

  requestConfirm(
    pending: Omit<FeishuPendingConfirm, 'id' | 'createdAt' | 'expiresAt' | 'channel'>,
    timeoutMs = 10 * 60_000
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
      matchKey: pending.chatId,
      context: pending.chatId,
      trustEligible: pending.trustEligible ?? false,
      authOwner: pending.authOwner,
      authorizationGeneration:
        pending.authorizationGeneration ?? remoteAuthorizationRegistry.getGeneration('feishu'),
      requestId: pending.requestId,
      memoryTiers: []
    }).then((outcome) => {
      if (outcome.kind === 'approved') return 'y'
      if (outcome.kind === 'timeout') return 'timeout'
      return 'n'
    })
  }

  buildConfirmPromptText(pending: FeishuPendingConfirm): string {
    const progressPrefix = formatFeishuRemoteProgressPrefix(pending.sessionId)
    const footer = formatImConfirmPromptFooter({
      trustEligible: pending.trustEligible === true,
      confirmId: pending.confirmId
    })
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

  private notifyConfirmPrompt(entry: ImPendingConfirm): void {
    if (!this.runner) return
    const text = this.buildConfirmPromptText(entry as unknown as FeishuPendingConfirm)
    const send = this.db
      ? () =>
          sendFeishuRemoteOutbound({
            runner: this.runner!,
            messageId: (entry as unknown as FeishuPendingConfirm).messageId,
            body: text,
            sessionId: (entry as unknown as FeishuPendingConfirm).sessionId,
            touch: { db: this.db!, sessionId: (entry as unknown as FeishuPendingConfirm).sessionId }
          })
      : () => replyFeishuText(this.runner!, (entry as unknown as FeishuPendingConfirm).messageId, text)
    void send().catch((e) => {
      logFeishuCliEvent('error', 'feishu.confirm.prompt_failed', {
        confirmId: entry.id,
        messageId: (entry as unknown as FeishuPendingConfirm).messageId,
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
