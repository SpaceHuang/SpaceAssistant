import { createHash } from 'node:crypto'
import type { PolicyRule } from '../../src/shared/confirmation/types'
import { evaluateImInboundGuard } from '../remote/imInboundGuard'

export type RuntimeTriggerImSource = Readonly<{
  channel: 'feishu' | 'wechat'
  accountId: string
  conversationId: string
  senderId: string
  isGroup: boolean
}>

export type RuntimeTriggerImChannelConfig = Readonly<{
  enabled: boolean
  ready: boolean
  remoteEnabled: boolean
  loggedIn: boolean
  remoteSenderAllowlist?: string[]
}>

/** Apply the same current ingress classification and policy decision used for live IM messages. */
export function authorizeRuntimeTriggerImSource(input: {
  source: RuntimeTriggerImSource
  config: RuntimeTriggerImChannelConfig
  policyRules: PolicyRule[]
  policyRevision: string
  authorizationGeneration: string
}): Readonly<{ allowed: false }> | Readonly<{ allowed: true; policyTrace: Readonly<Record<string, unknown>> }> {
  const { source, config } = input
  if (!source.accountId.trim() || source.accountId !== source.senderId || !source.conversationId.trim() ||
    !source.senderId.trim() || typeof source.isGroup !== 'boolean' || !config.enabled || !config.ready ||
    !config.remoteEnabled || !config.loggedIn) return { allowed: false }
  const guard = evaluateImInboundGuard({ channel: source.channel, senderId: source.senderId, isGroup: source.isGroup,
    getConfig: () => ({ enabled: config.enabled && config.ready, remoteEnabled: config.remoteEnabled,
      loggedIn: config.loggedIn, remoteSenderAllowlist: config.remoteSenderAllowlist }),
    getPolicyRules: () => input.policyRules, getPolicyRevision: () => input.policyRevision })
  if (!guard.ok || !guard.snapshot.ingressDecision) return { allowed: false }
  return { allowed: true, policyTrace: { ...guard.snapshot.ingressDecision, authorizationGeneration: input.authorizationGeneration,
    accountId: source.accountId, senderIdDigest: createHash('sha256').update(source.senderId).digest('hex') } }
}
