import type { FeishuRemoteConfirmPolicy } from './feishuTypes'
import type { WeChatRemoteConfirmPolicy } from './wechatTypes'

export type RemoteChannel = 'feishu' | 'wechat'

export type ResolvedRemoteConfirmPolicy = 'im_confirm' | 'remote_read_only'

export type RemoteConfirmPolicyInput =
  | FeishuRemoteConfirmPolicy
  | WeChatRemoteConfirmPolicy

export function normalizeWeChatConfirmPolicy(
  policy: WeChatRemoteConfirmPolicy,
  remoteWechatConfirm?: boolean
): WeChatRemoteConfirmPolicy {
  if (remoteWechatConfirm && policy !== 'remote_read_only') return 'wechat_confirm'
  return policy
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
