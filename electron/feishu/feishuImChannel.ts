import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { logFeishuCliEvent } from './feishuCliLogger'
import type { FeishuAuditLogger } from './feishuAuditLogger'
import type { LarkCliRunner } from './larkCliRunner'
import { sendFeishuRemoteOutbound, sendFeishuRemoteOutboundWithId } from './feishuRemoteOutbound'
import { createHostImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'
import { formatFeishuRemoteProgressPrefix } from './feishuRemoteProgress'
import type { AppDatabase } from '../database'
import {
  formatImConfirmPromptFooter,
  IM_CONFIRM_QUOTE_REQUIRED_HINT,
  IM_CONFIRM_PROMPT_SENDING_HINT,
  IM_CONFIRM_TRUST_MISCLICK_HINT,
  IM_CONFIRM_USAGE_HINT,
  parseImConfirmReply
} from '../remote/imConfirmReply'
import { addTrustedCommand } from '../shell/shellCommandTrust'
import { ImChannel, type ImCommitResult, type ImPendingConfirm } from '../confirmation/imChannel'
import { formatMcpConfirmPromptDetails } from '../confirmation/mcpConfirmPrompt'
import { getSecurityAuditLog } from '../confirmation/audit'
import { recordUserAnswerFromMemoryTiers } from '../confirmation/decisionCacheWriter'
import type { SessionStorage } from '../sessionStorage/host/ports'
import { reserveConfirmationSubmission, commitConfirmationSubmissionWithWork, reconcileConfirmationSubmission, ConfirmationCommitRolledBackError, ConfirmationCommitUnknownError } from '../confirmation/persistentConfirmationCommit'
import { recordRemoteTrackConfirmationState } from '../database/remoteTrackStore'
import { sanitizeAgentText } from '../../src/shared/agentSafeText'
import { runShellJustificationForDisplay } from '../../src/shared/runShellJustification'

export interface FeishuImChannelDeps {
  auditLogger?: FeishuAuditLogger
  runner?: LarkCliRunner
  db?: AppDatabase
  sessionStorage?: SessionStorage
  getGeneration?: (channel: 'feishu' | 'wechat') => number
  /** Optional transport port for composition tests; production defaults to the Feishu sender below. */
  sendConfirmationPrompt?: (entry: ImPendingConfirm, signal?: AbortSignal) => Promise<{ messageId: string }>
}

/**
 * §5.4 P2：飞书 lane 的 ImChannel 参数化（发消息函数 / 文案模板 / 超时 10 分钟）。
 * 取代原 FeishuConfirmManager 委托壳；注册、入站解析、桌面代答、超时与 confirm.* 审计
 * 全部落在基类 ImChannel，本类只补飞书消息形态的入站适配。
 */
export class FeishuImChannel extends ImChannel {
  constructor(deps: FeishuImChannelDeps = {}) {
    super({
      lane: 'feishu',
      timeoutMs: 10 * 60_000,
      audit: getSecurityAuditLog(),
      log: (event, fields) => {
        logFeishuCliEvent('info', event, fields)
        if (event === 'confirm.request') {
          void deps.auditLogger?.append({ type: 'confirm_request', confirmId: String(fields.confirmId ?? '') })
        }
        if (event === 'confirm.resolved') {
          // 与微信侧同口径：解析结果（decision）落飞书审计，供下游对账
          void deps.auditLogger?.append({
            type: 'confirm_request',
            confirmId: String(fields.confirmId ?? ''),
            decision: String(fields.decision ?? '') as 'y' | 'n' | 'timeout' | 'unavailable'
          })
        }
      },
      sendPrompt: (entry, signal) => {
        if (deps.sendConfirmationPrompt) return deps.sendConfirmationPrompt(entry, signal)
        if (!entry.matchKey) return Promise.reject(new Error('feishu-chat-missing'))
        return notifyFeishuConfirmPrompt(deps, entry)
      },
      isAuthorizedInbound: (inbound, entry) => {
        // 归属校验由调用方先做（p2p+owner），这里仅匹配 chatId + 非同一消息
        return inbound.matchKey === entry.matchKey && entry.messageId !== inbound.messageId
      },
      onTrust: (entry) => tryAddFeishuShellTrust(deps.db, entry),
      onTrackConfirmationChild: (entry, state) => {
        if (!deps.db || !entry.trackId || !entry.trackAttributionEventId) throw new Error('FEISHU_TRACK_CONFIRMATION_LINK_REQUIRED')
        recordRemoteTrackConfirmationState(deps.db, {
          trackId: entry.trackId, confirmationId: entry.id, attributionEventId: entry.trackAttributionEventId, state,
          occurredAt: Date.now(), ...(entry.requestId ? { requestId: entry.requestId } : {}), ...(entry.toolName ? { toolName: entry.toolName } : {}),
          ...(entry.turnId ? { turnId: entry.turnId } : {}), ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
          ...(entry.envelopeHash ? { envelopeHash: entry.envelopeHash } : {}), ...(entry.factsHash ? { factsHash: entry.factsHash } : {}),
          ...(entry.policyBehaviorVersion ? { policyBehaviorVersion: entry.policyBehaviorVersion } : {}),
          ...(entry.policySnapshotRevision != null ? { policySnapshotRevision: entry.policySnapshotRevision } : {}),
          ...(entry.policyRevision ? { policyRevision: entry.policyRevision } : {}),
          ...(entry.authorizationGeneration != null ? { authorizationGeneration: entry.authorizationGeneration } : {})
        })
      },
      ...(deps.db ? { onCommit: (entry: ImPendingConfirm, action: { kind: 'trust' | 'memory' | 'decision'; tier?: import('../../src/shared/confirmation/types').MemoryTier; approved: boolean }) => commitFeishuAction(deps.db, entry, action, deps.getGeneration) } : {}),
      // 记N：写 decision_cache（执行链路侧），落 cache.write 审计；无 db 时跳过
      onMemory: (entry, tier) => {
        if (!deps.db) return false
        recordUserAnswerFromMemoryTiers({
          db: deps.db,
          audit: getSecurityAuditLog(),
          lane: 'feishu',
          sessionId: entry.sessionId,
          key: tier.key,
          memoryTiers: entry.memoryTiers,
          answererKind: 'user',
          source: 'user-confirm'
        })
        return true
      },
      onHint: (entry, kind) => {
        const runner = deps.runner
        const ownerId = entry.authOwner
        if (!runner || !ownerId || !entry.matchKey) return
        const hint = kind === 'trust_misclick' ? IM_CONFIRM_TRUST_MISCLICK_HINT : kind === 'prompt_sending' ? IM_CONFIRM_PROMPT_SENDING_HINT : kind === 'quote_required' ? IM_CONFIRM_QUOTE_REQUIRED_HINT : IM_CONFIRM_USAGE_HINT
        const outboundDeliveryFacts = createHostImOutboundFacts({ channel: 'feishu', purpose: 'system-reply', body: hint,
          sessionId: entry.sessionId, identityKey: ownerId, ownerId, recipient: ownerId, chatType: 'p2p', destinationId: entry.messageId })
        void sendFeishuRemoteOutbound({ runner, messageId: entry.messageId, body: hint, sessionId: entry.sessionId,
          recipient: ownerId, outboundDeliveryFacts }).catch(() => undefined)
      },
      onCommitFailure: (entry) => {
        const runner = deps.runner
        const ownerId = entry.authOwner
        if (!runner || !ownerId || !entry.matchKey) return
        const body = '确认提交失败，授权未生效，请重新发起操作。'
        const outboundDeliveryFacts = createHostImOutboundFacts({ channel: 'feishu', purpose: 'system-reply', body,
          sessionId: entry.sessionId, identityKey: ownerId, ownerId, recipient: ownerId, chatType: 'p2p', destinationId: entry.messageId })
        void sendFeishuRemoteOutbound({ runner, messageId: entry.messageId, body, sessionId: entry.sessionId,
          recipient: ownerId, outboundDeliveryFacts }).catch(() => undefined)
      }
    })
  }

  /** 飞书入站消息适配：解析 Y/N/记N + owner/p2p 校验后交基类解析。 */
  tryResolveFromInboundMessage(
    msg: FeishuInboundMessage,
    opts?: { ownerOpenId?: string }
  ): boolean {
    const parsed = parseImConfirmReply(msg.content)
    if (parsed.kind === 'not_confirm') return false

    // Confirm path requires bound owner + p2p (must not resolve from group / non-owner).
    if (!isFeishuConfirmAuthorizedSender(msg, opts?.ownerOpenId)) return false
    return this.tryResolveFromInbound(
      parsed as { kind: string; confirmId?: string; tier?: number },
      { matchKey: msg.chatId, messageId: msg.messageId, quotedMessageId: msg.replyToMessageId }
    )
  }
}

export function commitFeishuAction(db: AppDatabase | undefined, entry: ImPendingConfirm, action: { kind: 'trust' | 'memory' | 'decision'; tier?: import('../../src/shared/confirmation/types').MemoryTier; approved: boolean }, getGeneration?: (channel: 'feishu' | 'wechat') => number): ImCommitResult {
  if (!db) return false
  // IM 授权必须绑定创建确认项时的代际；历史/损坏 pending 没有代际时一律拒绝，
  // 不能用默认值把撤销前的旧消息重新变成可提交授权。
  if (entry.authorizationGeneration == null || !getGeneration) return false
  if (Date.now() >= entry.expiresAt) return false
  if (entry.authorizationGeneration !== getGeneration('feishu')) return false
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
      return reconcileFeishuUnknown(db, plan.submissionId)
    }
    if (reserved?.kind === 'not-committed') return { committed: false, canResubmit: reserved.canResubmit }
    entry.commitRevision = revision
    const deferredAudits: import('../../src/shared/confirmation/types').SecurityAuditEvent[] = []
    const receipt = commitConfirmationSubmissionWithWork(db, plan, () => {
      if (Date.now() >= entry.expiresAt) throw new Error('confirmation-expired')
      if (action.kind === 'decision') return
      const ok = action.kind === 'trust'
        ? tryAddFeishuShellTrust(db, entry)
        : Boolean(action.tier && recordUserAnswerFromMemoryTiers({ db, audit: { record: (event) => deferredAudits.push(event) }, lane: 'feishu', sessionId: entry.sessionId, key: action.tier.key, memoryTiers: entry.memoryTiers, answererKind: 'user', source: 'user-confirm' }) === undefined)
      if (!ok) throw new Error('confirmation-authority-write-failed')
    }, `confirm:im:${entry.id}`, 1, () => { if (Date.now() >= entry.expiresAt) throw new Error('confirmation-expired') })
    if (receipt.kind === 'committed') {
      deferredAudits.forEach((event) => getSecurityAuditLog().record(event))
      if (action.kind === 'trust') logFeishuCliEvent('info', 'feishu.trust.add', { confirmId: entry.id, commandPreview: String(entry.toolInput?.command ?? '').slice(0, 80) })
    }
    if (receipt.kind === 'committed') return { committed: true }
    if (receipt.kind === 'unknown') return reconcileFeishuUnknown(db, plan.submissionId)
    return { committed: false, canResubmit: receipt.canResubmit }
  } catch (error) {
    if (error instanceof ConfirmationCommitUnknownError) return reconcileFeishuUnknown(db, plan.submissionId)
    if (error instanceof ConfirmationCommitRolledBackError) return { committed: false, canResubmit: Date.now() < entry.expiresAt }
    return false
  }
}

function reconcileFeishuUnknown(db: AppDatabase, submissionId: string): ImCommitResult {
  const settled = reconcileConfirmationSubmission(db, submissionId)
  if (settled?.outcome === 'committed') return { committed: true }
  if (settled?.outcome === 'rolled_back') return { committed: false, canResubmit: true }
  return { committed: false, unknown: true }
}

function tryAddFeishuShellTrust(db: AppDatabase | undefined, pending: ImPendingConfirm): boolean {
  if (pending.toolName !== 'run_shell' || !db) return false
  const command = typeof pending.toolInput?.command === 'string' ? pending.toolInput.command : ''
  if (!command.trim()) return false
  const added = addTrustedCommand(db, command, { source: 'im-feishu' })
  if (!added) return false
  return true
}

function notifyFeishuConfirmPrompt(deps: FeishuImChannelDeps, entry: ImPendingConfirm): Promise<{ messageId: string }> {
  const { runner, db, sessionStorage } = deps
  if (!runner) return Promise.reject(new Error('feishu-runner-unavailable'))
  const ownerId = entry.authOwner
  if (!ownerId || !entry.matchKey) return Promise.reject(new Error('FEISHU_CONFIRM_PROMPT_BINDING_REQUIRED'))
  const text = buildFeishuConfirmPromptText(entry)
  const outboundDeliveryFacts = createHostImOutboundFacts({ channel: 'feishu', purpose: 'system-reply', body: text,
    sessionId: entry.sessionId, identityKey: ownerId, ownerId, recipient: ownerId, chatType: 'p2p', destinationId: entry.messageId })
  const send = () => sendFeishuRemoteOutboundWithId({ runner, messageId: entry.messageId, body: text, sessionId: entry.sessionId,
    recipient: ownerId, outboundDeliveryFacts,
    ...(db && sessionStorage ? { touch: { sessionCommands: sessionStorage.commands, sessionId: entry.sessionId } } : {}) })
  return send().catch((e) => {
    logFeishuCliEvent('error', 'feishu.confirm.prompt_failed', {
      confirmId: entry.id,
      messageId: entry.messageId,
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  })
}

/** Redact host-known secrets and collapse user-home path prefixes in the display copy only. */
function sanitizeFeishuConfirmDisplay(text: string): string {
  return sanitizeAgentText(text).text
    .replace(/\b((?:api[_-]?key|access[_-]?token|password|passwd|token|secret|cookie)\s*)[=:]\s*<secret:redacted>/gi, '$1[已隐藏]')
    .replace(/(?<![A-Za-z0-9_./-])\/(?:Users|home)\/[^/\s\"'`;&|<>{}()[\]]+/g, '~')
    .replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s\"'`;&|<>{}()[\]]+/gi, '~')
}

/** 飞书确认提示文案：进度前缀 + 工具/命令摘要 + Y/N/记N 尾部（10 分钟有效）。 */
export function buildFeishuConfirmPromptText(pending: ImPendingConfirm): string {
  const progressPrefix = formatFeishuRemoteProgressPrefix(pending.sessionId)
  const footer = formatImConfirmPromptFooter({
    trustEligible: pending.trustEligible === true,
    confirmId: pending.confirmId,
    memoryTiers: pending.memoryTiers
  })
  if (pending.toolName === 'browser' && pending.toolInput) {
    const action = pending.toolInput.action
    if (action === 'navigate' && typeof pending.toolInput.url === 'string') {
      return sanitizeFeishuConfirmDisplay(`${progressPrefix}⚠️ 需要在浏览器中打开网页：\n${pending.toolInput.url.slice(0, 500)}\n${footer}（10 分钟内有效）`)
    }
    if (action === 'act' && typeof pending.toolInput.instruction === 'string') {
      return sanitizeFeishuConfirmDisplay(`${progressPrefix}⚠️ 需要在浏览器中执行操作：\n${pending.toolInput.instruction.slice(0, 200)}\n${footer}（10 分钟内有效）`)
    }
  }
  if (pending.mcp) {
    const details = formatMcpConfirmPromptDetails(pending.mcp, pending.toolInput)
    return sanitizeFeishuConfirmDisplay(`${progressPrefix}⚠️ 需要确认以下 MCP 操作：\n${details}\n${footer}（10 分钟内有效）`)
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
  const rawJustification = pending.toolName === 'run_shell' && typeof pending.toolInput?.justification === 'string'
    ? pending.toolInput.justification.trim()
    : ''
  const justification = rawJustification ? runShellJustificationForDisplay(rawJustification) : ''
  const truncatedNote = pending.toolInput?._justificationTruncated === true ? '（内容已截断）' : ''
  if (pending.toolName === 'run_script' && typeof pending.toolInput?.code === 'string') {
    const full = pending.toolInput.code
    if (full.length > 4000) {
      cmd = `${full.slice(0, 4000)}\n…（脚本过长，请在桌面端查看全文）`
    } else {
      cmd = full.slice(0, 2000)
    }
  }
  return sanitizeFeishuConfirmDisplay(`${progressPrefix}⚠️ 需要确认以下操作：\n工具：${pending.toolName}\n命令：${String(cmd).slice(0, 2000)}\n${justification ? `调用理由${truncatedNote}：\n${justification}\n` : ''}${footer}（10 分钟内有效）`)
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
