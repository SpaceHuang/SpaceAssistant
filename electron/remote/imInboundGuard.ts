import { remoteAuthorizationRegistry, type RemoteAuthChannel } from './remoteAuthorizationRegistry'
import { classifyImOrigin, evaluateIngress } from '../confirmation/ingress'
import { getSecurityAuditLog, type AuditSink } from '../confirmation/audit'

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
}

export type GuardResult =
  | { ok: true; snapshot: ImAuthSnapshot }
  | {
      ok: false
      reason: 'channel_disabled' | 'remote_disabled' | 'not_logged_in' | 'not_owner' | 'revoked'
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
  const ingress = evaluateIngress({
    lane: args.channel === 'feishu' ? 'feishu' : 'wechat',
    origin: originInfo
  })
  if (!ingress.allow) {
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
      capturedAt: Date.now()
    }
  }
}

export function revalidateImInboundGuard(
  snapshot: ImAuthSnapshot,
  args: {
    getConfig: () => ImInboundGuardConfig
    isLoggedIn?: () => boolean
  }
): GuardResult {
  const again = evaluateImInboundGuard({
    channel: snapshot.channel,
    senderId: snapshot.owner,
    getConfig: args.getConfig,
    isLoggedIn: args.isLoggedIn
  })
  if (!again.ok) return again
  if (again.snapshot.authorizationGeneration !== snapshot.authorizationGeneration) {
    return { ok: false, reason: 'revoked' }
  }
  return again
}
