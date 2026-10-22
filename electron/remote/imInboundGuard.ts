import { remoteAuthorizationRegistry, type RemoteAuthChannel } from './remoteAuthorizationRegistry'
import { classifyImOrigin, evaluateIngress } from '../confirmation/ingress'
import { getSecurityAuditLog, type AuditSink } from '../confirmation/audit'
import type { PolicyRule } from '../../src/shared/confirmation/types'

export type ImInboundGuardConfig = {
  enabled?: boolean
  remoteEnabled?: boolean
  loggedIn?: boolean
  remoteSenderAllowlist?: string[]
}

export type ImAuthSnapshot = {
  channel: RemoteAuthChannel
  owner: string
  authorizationGeneration: number
  capturedAt: number
  messageId?: string
  /** Re-resolve current user policy at every post-await authorization check. */
  getPolicyRules?: () => PolicyRule[]
  ingressApproval?: { channel: RemoteAuthChannel; senderId: string; messageId: string; ruleId: string }
  skipIngressPolicy?: true
}

export type GuardResult =
  | { ok: true; snapshot: ImAuthSnapshot }
  | {
      ok: false
      reason: 'channel_disabled' | 'remote_disabled' | 'not_logged_in' | 'not_owner' | 'revoked'
      | 'approval_required' | 'approval_rejected'
      ruleId?: string
    }

/**
 * Shared IM inbound authorization gate.
 * Success returns a one-shot auth snapshot carrying authorizationGeneration.
 * Call revalidate(snapshot) after every await that may change external auth state.
 */
export function evaluateImInboundGuard(args: {
  channel: RemoteAuthChannel
  senderId: string
  getConfig: () => ImInboundGuardConfig
  /** Optional login probe (WeChat). Default: treat as logged in when omitted. */
  isLoggedIn?: () => boolean
  /** 审计出口（测试注入）；缺省走主进程 SecurityAuditLog 单例（异步、不阻断）。 */
  audit?: AuditSink
  getPolicyRules?: () => PolicyRule[]
  messageId?: string
  approvedIngress?: { channel: RemoteAuthChannel; senderId: string; messageId: string; ruleId: string }
  skipIngressPolicy?: boolean
}): GuardResult {
  const cfg = args.getConfig()
  if (cfg.enabled === false) return { ok: false, reason: 'channel_disabled' }
  if (!cfg.remoteEnabled) return { ok: false, reason: 'remote_disabled' }
  const loggedIn = args.isLoggedIn ? args.isLoggedIn() : cfg.loggedIn !== false
  if (!loggedIn) return { ok: false, reason: 'not_logged_in' }
  const allow = cfg.remoteSenderAllowlist ?? []
  // 白名单由来源分类器吸收：名单内 direct-owner / 名单外 direct-other；
  // 再由 ingress 规则判定准入（默认规则"名单外一律拒"等价现状 not_owner 不响应）。
  const originInfo = classifyImOrigin({ senderId: args.senderId, allowlist: allow })
  const ingress = args.skipIngressPolicy ? null : evaluateIngress({
    lane: args.channel === 'feishu' ? 'feishu' : 'wechat',
    origin: originInfo
  }, args.getPolicyRules?.())
  if (ingress?.action === 'ask') {
    const approval = args.approvedIngress
    if (!args.messageId || approval?.channel !== args.channel || approval.senderId !== args.senderId ||
      approval.messageId !== args.messageId || approval.ruleId !== ingress.ruleId) {
      return { ok: false, reason: 'approval_required', ruleId: ingress.ruleId }
    }
  }
  if (ingress && !ingress.allow && ingress.action === 'deny') {
    // ingress deny 必落 policy.deny-ingress 审计（§5.2a/§5.6）；此时尚无会话，sessionId 置空。
    // 审计为异步缓冲写，失败降级不阻断主流程。
    ;(args.audit ?? getSecurityAuditLog()).record({
      ts: Date.now(),
      event: 'policy.deny-ingress',
      lane: args.channel === 'feishu' ? 'feishu' : 'wechat',
      origin: originInfo,
      sessionId: '',
      decision: 'deny',
      ruleId: ingress.ruleId,
      reason: ingress.reason,
      actor: 'system'
    })
    return { ok: false, reason: 'not_owner' }
  }
  return {
    ok: true,
    snapshot: {
      channel: args.channel,
      owner: args.senderId,
      authorizationGeneration: remoteAuthorizationRegistry.getGeneration(args.channel),
      capturedAt: Date.now(),
      ...(args.messageId ? { messageId: args.messageId } : {}),
      ...(args.getPolicyRules ? { getPolicyRules: args.getPolicyRules } : {}),
      ...(args.approvedIngress ? { ingressApproval: args.approvedIngress } : {}),
      ...(args.skipIngressPolicy ? { skipIngressPolicy: true as const } : {})
    }
  }
}

export function revalidateImInboundGuard(
  snapshot: ImAuthSnapshot,
  args: {
    getConfig: () => ImInboundGuardConfig
    isLoggedIn?: () => boolean
    getPolicyRules?: () => PolicyRule[]
  }
): GuardResult {
  const again = evaluateImInboundGuard({
    channel: snapshot.channel,
    senderId: snapshot.owner,
    messageId: snapshot.messageId,
    getConfig: args.getConfig,
    isLoggedIn: args.isLoggedIn,
    getPolicyRules: args.getPolicyRules ?? snapshot.getPolicyRules,
    approvedIngress: snapshot.ingressApproval,
    skipIngressPolicy: snapshot.skipIngressPolicy === true
  })
  if (!again.ok) return again
  if (again.snapshot.authorizationGeneration !== snapshot.authorizationGeneration) {
    return { ok: false, reason: 'revoked' }
  }
  return again
}

/**
 * Resolve an ingress ask for this one inbound message. The approval object is kept only in
 * the caller's in-memory auth snapshot and is bound to channel, sender, platform message and rule.
 */
export async function authorizeImInboundMessage(args: Parameters<typeof evaluateImInboundGuard>[0] & {
  requestApproval: (request: { channel: RemoteAuthChannel; senderId: string; messageId: string; ruleId: string }) => Promise<boolean>
}): Promise<GuardResult> {
  const initial = evaluateImInboundGuard(args)
  if (initial.ok || initial.reason !== 'approval_required' || !args.messageId || !initial.ruleId) return initial
  const generation = remoteAuthorizationRegistry.getGeneration(args.channel)
  const approval = { channel: args.channel, senderId: args.senderId, messageId: args.messageId, ruleId: initial.ruleId }
  let approved = false
  try { approved = await args.requestApproval(approval) } catch { approved = false }
  if (!approved) return { ok: false, reason: 'approval_rejected', ruleId: initial.ruleId }
  if (remoteAuthorizationRegistry.getGeneration(args.channel) !== generation) return { ok: false, reason: 'revoked' }
  return evaluateImInboundGuard({ ...args, approvedIngress: approval })
}
