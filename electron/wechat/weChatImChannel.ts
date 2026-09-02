import type { WebContents } from 'electron'
import type { WeChatInboundMessage } from '../../src/shared/wechatTypes'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { WeChatAuditLogger } from './weChatAuditLogger'
import { logWeChatCliEvent } from './weChatCliLogger'
import { buildConfirmInstantPrompt } from '../remote/remoteProgressHooks'
import {
  formatImConfirmPromptFooter,
  IM_CONFIRM_TRUST_MISCLICK_HINT,
  IM_CONFIRM_USAGE_HINT,
  parseImConfirmReply
} from '../remote/imConfirmReply'
import { addTrustedCommand } from '../shell/shellCommandTrust'
import type { AppDatabase } from '../database'
import { ImChannel, type ImPendingConfirm } from '../confirmation/imChannel'
import { getSecurityAuditLog } from '../confirmation/audit'
import { recordUserAnswerToCache, scopeForCacheKey } from '../confirmation/decisionCacheWriter'
import type { WeChatReplyBot } from './weChatReplyService'

const DEFAULT_CONFIRM_TIMEOUT_MS = 5 * 60_000

export interface WeChatImChannelDeps {
  auditLogger?: WeChatAuditLogger
  getWebContents?: () => WebContents | null
  getReplyBot?: () => WeChatReplyBot | undefined
  db?: AppDatabase
}

/**
 * §5.4 P2：微信 lane 的 ImChannel 参数化（reply 发送函数 / 文案模板 / 超时 5 分钟）。
 * 取代原 WeChatConfirmManager 委托壳；注册、入站解析、桌面代答、超时与 confirm.* 审计
 * 全部落在基类 ImChannel，本类只补微信消息形态的入站适配。
 */
export class WeChatImChannel extends ImChannel {
  constructor(deps: WeChatImChannelDeps = {}) {
    // confirm.resolved 回调里要推送实时 pending 计数，需回指通道实例（super 后赋值）。
    const channelRef: { current?: WeChatImChannel } = {}
    super({
      lane: 'wechat',
      timeoutMs: DEFAULT_CONFIRM_TIMEOUT_MS,
      audit: getSecurityAuditLog(),
      log: (event, fields) => {
        logWeChatCliEvent('info', event, fields)
        if (event === 'confirm.request') {
          void deps.auditLogger?.append({ type: 'confirm_request', confirmId: String(fields.confirmId ?? '') })
        }
        if (event === 'confirm.resolved') {
          void deps.auditLogger?.append({
            type: 'confirm_request',
            confirmId: String(fields.confirmId ?? ''),
            decision: String(fields.decision ?? '') as 'y' | 'n' | 'timeout'
          })
          deps.getWebContents?.()?.send('wechat:pending-confirm', { count: channelRef.current?.countPending() ?? 0 })
        }
      },
      sendPrompt: (entry) => {
        const replyBot = deps.getReplyBot?.()
        if (!replyBot) return
        const inbound = entry.context as IncomingMessage
        if (!inbound) return
        void replyBot.reply(inbound, buildWeChatConfirmPrompt(entry)).catch(() => undefined)
      },
      onTrust: (entry) => tryAddWeChatShellTrust(deps.db, entry),
      // 记N：写 decision_cache（执行链路侧），落 cache.write 审计；无 db 时跳过
      onMemory: (entry, tier) => {
        if (!deps.db) return
        recordUserAnswerToCache({
          db: deps.db,
          audit: getSecurityAuditLog(),
          lane: 'wechat',
          sessionId: entry.sessionId,
          key: tier.key,
          decision: 'allow',
          scope: scopeForCacheKey(tier.key),
          source: 'user-confirm'
        })
      },
      onHint: (entry, kind) => {
        const replyBot = deps.getReplyBot?.()
        if (!replyBot) return
        const hint = kind === 'trust_misclick' ? IM_CONFIRM_TRUST_MISCLICK_HINT : IM_CONFIRM_USAGE_HINT
        void replyBot.reply(entry.context as IncomingMessage, hint).catch(() => undefined)
      }
    })
    channelRef.current = this
  }

  /** 微信入站消息适配：解析 Y/N/记N + 白名单校验后交基类解析。 */
  tryResolveFromInboundMessage(
    msg: WeChatInboundMessage,
    opts?: { allowedUserIds?: string[] }
  ): boolean {
    const parsed = parseImConfirmReply(msg.text)
    if (parsed.kind === 'not_confirm') return false

    if (!isWeChatConfirmAuthorizedSender(msg, opts?.allowedUserIds)) return false
    return this.tryResolveFromInbound(
      parsed as { kind: string; confirmId?: string; tier?: number },
      { matchKey: msg.userId, messageId: msg.messageId }
    )
  }
}

function tryAddWeChatShellTrust(db: AppDatabase | undefined, pending: ImPendingConfirm): boolean {
  if (pending.toolName !== 'run_shell' || !db) return false
  const command = typeof pending.toolInput?.command === 'string' ? pending.toolInput.command : ''
  if (!command.trim()) return false
  const added = addTrustedCommand(db, command, { source: 'im-wechat' })
  if (!added) return false
  logWeChatCliEvent('info', 'wechat.trust.add', {
    confirmId: pending.id,
    commandPreview: command.slice(0, 80)
  })
  return true
}

/** 微信 Y/N 确认提示文案（5 分钟有效）。 */
export function buildWeChatConfirmPrompt(pending: ImPendingConfirm, progressPrefix = ''): string {
  const tool = pending.toolName ?? 'unknown'
  const footer = formatImConfirmPromptFooter({
    trustEligible: pending.trustEligible === true,
    confirmId: pending.confirmId,
    memoryTiers: pending.memoryTiers
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

/** Confirm replies only from allowlisted senders (bound WeChat user). */
export function isWeChatConfirmAuthorizedSender(
  msg: WeChatInboundMessage,
  allowedUserIds?: string[]
): boolean {
  if (!allowedUserIds?.length) return false
  return allowedUserIds.includes(msg.userId)
}
