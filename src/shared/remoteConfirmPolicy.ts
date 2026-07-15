import type { ImConfirmPolicy, LegacyImConfirmPolicy } from './imTypes'
import { normalizeImConfirmPolicy } from './imTypes'

export type RemoteChannel = 'feishu' | 'wechat'

/**
 * @deprecated Confirm path is no longer gated by policy; always im_confirm.
 * remote_read_only behavior moved to remoteDenyOutbound / remoteAllowLocalWrite.
 */
export type ResolvedRemoteConfirmPolicy = 'im_confirm' | 'remote_read_only'

export type RemoteConfirmPolicyInput = LegacyImConfirmPolicy

export function normalizeWeChatConfirmPolicy(
  policy: LegacyImConfirmPolicy,
  remoteWechatConfirm?: boolean
): ImConfirmPolicy {
  if (remoteWechatConfirm && policy !== 'remote_read_only') return 'im_confirm'
  return normalizeImConfirmPolicy(policy) ?? 'always'
}

/**
 * @deprecated Runtime always allows IM confirm when a tool needs it.
 * Outbound/write hard-deny is via remoteDenyOutbound / remoteAllowLocalWrite.
 */
export function resolveRemoteConfirmPolicy(_args: {
  source: RemoteChannel
  confirmPolicy: RemoteConfirmPolicyInput
}): ResolvedRemoteConfirmPolicy {
  return 'im_confirm'
}

export function shouldRequestImConfirm(resolved: ResolvedRemoteConfirmPolicy): boolean {
  return resolved === 'im_confirm'
}

/** @deprecated Use remoteDenyOutbound / remoteAllowLocalWrite instead. */
export function isRemoteReadOnlyPolicy(confirmPolicy: RemoteConfirmPolicyInput): boolean {
  return confirmPolicy === 'remote_read_only'
}
