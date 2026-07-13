import type { ImConfirmPolicy, LegacyImConfirmPolicy } from './imTypes'
import { normalizeImConfirmPolicy } from './imTypes'

export type RemoteChannel = 'feishu' | 'wechat'

export type ResolvedRemoteConfirmPolicy = 'im_confirm' | 'remote_read_only'

export type RemoteConfirmPolicyInput = LegacyImConfirmPolicy

export function normalizeWeChatConfirmPolicy(
  policy: LegacyImConfirmPolicy,
  remoteWechatConfirm?: boolean
): ImConfirmPolicy {
  if (remoteWechatConfirm && policy !== 'remote_read_only') return 'im_confirm'
  return normalizeImConfirmPolicy(policy) ?? 'always'
}

export function resolveRemoteConfirmPolicy(args: {
  source: RemoteChannel
  confirmPolicy: RemoteConfirmPolicyInput
}): ResolvedRemoteConfirmPolicy {
  const { confirmPolicy } = args
  if (confirmPolicy === 'remote_read_only') return 'remote_read_only'
  return 'im_confirm'
}

export function shouldRequestImConfirm(resolved: ResolvedRemoteConfirmPolicy): boolean {
  return resolved === 'im_confirm'
}

export function isRemoteReadOnlyPolicy(confirmPolicy: RemoteConfirmPolicyInput): boolean {
  return confirmPolicy === 'remote_read_only'
}
