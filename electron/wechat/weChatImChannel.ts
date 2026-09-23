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
import { ImChannel, type ImCommitResult, type ImPendingConfirm } from '../confirmation/imChannel'
import { getSecurityAuditLog } from '../confirmation/audit'
import { recordUserAnswerFromMemoryTiers } from '../confirmation/decisionCacheWriter'
import { reserveConfirmationSubmission, commitConfirmationSubmissionWithWork, reconcileConfirmationSubmission, ConfirmationCommitRolledBackError, ConfirmationCommitUnknownError } from '../confirmation/persistentConfirmationCommit'
import type { WeChatReplyBot } from './weChatReplyService'

const DEFAULT_CONFIRM_TIMEOUT_MS = 5 * 60_000

export interface WeChatImChannelDeps {
  auditLogger?: WeChatAuditLogger
  getWebContents?: () => WebContents | null
  getReplyBot?: () => WeChatReplyBot | undefined
  db?: AppDatabase
  getGeneration?: (channel: 'feishu' | 'wechat') => number
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
            decision: String(fields.decision ?? '') as 'y' | 'n' | 'timeout' | 'unavailable'
          })
          deps.getWebContents?.()?.send('wechat:pending-confirm', { count: channelRef.current?.countPending() ?? 0 })
        }
      },
      sendPrompt: (entry) => {
        const replyBot = deps.getReplyBot?.()
        if (!replyBot) return Promise.reject(new Error('wechat-bot-unavailable'))
        const inbound = entry.context as IncomingMessage
        if (!inbound) return Promise.reject(new Error('wechat-inbound-context-missing'))
        return replyBot.reply(inbound, buildWeChatConfirmPrompt(entry))
      },
      onTrust: (entry) => tryAddWeChatShellTrust(deps.db, entry),
      ...(deps.db ? { onCommit: (entry: ImPendingConfirm, action: { kind: 'trust' | 'memory' | 'decision'; tier?: import('../../src/shared/confirmation/types').MemoryTier; approved: boolean }) => commitWeChatAction(deps.db, entry, action, deps.getGeneration) } : {}),
      // 记N：写 decision_cache（执行链路侧），落 cache.write 审计；无 db 时跳过
      onMemory: (entry, tier) => {
        if (!deps.db) return false
        recordUserAnswerFromMemoryTiers({
          db: deps.db,
          audit: getSecurityAuditLog(),
          lane: 'wechat',
          sessionId: entry.sessionId,
          key: tier.key,
          memoryTiers: entry.memoryTiers,
          answererKind: 'user',
          source: 'user-confirm'
        })
        return true
      },
      onHint: (entry, kind) => {
        const replyBot = deps.getReplyBot?.()
        if (!replyBot) return
        const hint = kind === 'trust_misclick' ? IM_CONFIRM_TRUST_MISCLICK_HINT : IM_CONFIRM_USAGE_HINT
        void replyBot.reply(entry.context as IncomingMessage, hint).catch(() => undefined)
      },
      onCommitFailure: (entry) => {
        const replyBot = deps.getReplyBot?.()
        if (replyBot && entry.context) void replyBot.reply(entry.context as IncomingMessage, '确认提交失败，授权未生效，请重新发起操作。').catch(() => undefined)
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

export function commitWeChatAction(db: AppDatabase | undefined, entry: ImPendingConfirm, action: { kind: 'trust' | 'memory' | 'decision'; tier?: import('../../src/shared/confirmation/types').MemoryTier; approved: boolean }, getGeneration?: (channel: 'feishu' | 'wechat') => number): ImCommitResult {
  if (!db) return false
  // IM 授权必须绑定创建确认项时的代际；历史/损坏 pending 没有代际时一律拒绝，
  // 不能用默认值把撤销前的旧消息重新变成可提交授权。
  if (entry.authorizationGeneration == null || !getGeneration) return false
  if (Date.now() >= entry.expiresAt) return false
  if (entry.authorizationGeneration !== getGeneration('wechat')) return false
  const revision = (entry.commitRevision ?? 0) + 1
  const plan = { submissionId: `im:${entry.id}`, confirmId: entry.confirmId ?? entry.id, sessionId: entry.sessionId, ownerId: entry.matchKey ?? entry.sessionId, generation: entry.authorizationGeneration, revision, action: action.approved ? 'approved' as const : 'denied' as const, memory: action.kind === 'memory' ? 'written' as const : 'none' as const }
  try {
    // 先 reserve，再推进内存 revision；过期/撤销/校验失败不会制造 revision 空洞。
    const reserved = reserveConfirmationSubmission(db, plan)
    if (reserved?.kind === 'committed') {
      entry.commitRevision = revision
      return { committed: true }
    }
    if (reserved?.kind === 'unknown') {
      entry.commitRevision = revision
      return reconcileWeChatUnknown(db, plan.submissionId)
    }
    if (reserved?.kind === 'not-committed') return { committed: false, canResubmit: reserved.canResubmit }
    entry.commitRevision = revision
    const deferredAudits: import('../../src/shared/confirmation/types').SecurityAuditEvent[] = []
    const receipt = commitConfirmationSubmissionWithWork(db, plan, () => {
      if (Date.now() >= entry.expiresAt) throw new Error('confirmation-expired')
      if (action.kind === 'decision') return
      const ok = action.kind === 'trust'
        ? tryAddWeChatShellTrust(db, entry)
        : Boolean(action.tier && recordUserAnswerFromMemoryTiers({ db, audit: { record: (event) => deferredAudits.push(event) }, lane: 'wechat', sessionId: entry.sessionId, key: action.tier.key, memoryTiers: entry.memoryTiers, answererKind: 'user', source: 'user-confirm' }) === undefined)
      if (!ok) throw new Error('confirmation-authority-write-failed')
    }, `confirm:im:${entry.id}`, 1, () => { if (Date.now() >= entry.expiresAt) throw new Error('confirmation-expired') })
    if (receipt.kind === 'committed') {
      deferredAudits.forEach((event) => getSecurityAuditLog().record(event))
      if (action.kind === 'trust') logWeChatCliEvent('info', 'wechat.trust.add', { confirmId: entry.id, commandPreview: String(entry.toolInput?.command ?? '').slice(0, 80) })
    }
    if (receipt.kind === 'committed') return { committed: true }
    if (receipt.kind === 'unknown') return reconcileWeChatUnknown(db, plan.submissionId)
    return { committed: false, canResubmit: receipt.canResubmit }
  } catch (error) {
    if (error instanceof ConfirmationCommitUnknownError) return reconcileWeChatUnknown(db, plan.submissionId)
    if (error instanceof ConfirmationCommitRolledBackError) return { committed: false, canResubmit: Date.now() < entry.expiresAt }
    return false
  }
}

function reconcileWeChatUnknown(db: AppDatabase, submissionId: string): ImCommitResult {
  const settled = reconcileConfirmationSubmission(db, submissionId)
  if (settled?.outcome === 'committed') return { committed: true }
  if (settled?.outcome === 'rolled_back') return { committed: false, canResubmit: true }
  return { committed: false, unknown: true }
}

function tryAddWeChatShellTrust(db: AppDatabase | undefined, pending: ImPendingConfirm): boolean {
  if (pending.toolName !== 'run_shell' || !db) return false
  const command = typeof pending.toolInput?.command === 'string' ? pending.toolInput.command : ''
  if (!command.trim()) return false
  const added = addTrustedCommand(db, command, { source: 'im-wechat' })
  if (!added) return false
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
