import {
  normalizeWeChatConfirmPolicy,
  resolveRemoteConfirmPolicy
} from '../../src/shared/remoteConfirmPolicy'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import type { RemoteContext } from '../tools/types'

export const FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE =
  '飞书确认超时（10分钟），工具调用已取消。请查看 Bot 发出的确认消息后回复 Y，或重新发送指令。'

export const WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE =
  '用户确认超时（5分钟），工具调用已取消'

export const REMOTE_CONFIRM_TIMEOUT_MESSAGES: Record<'feishu' | 'wechat', string> = {
  feishu: FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE,
  wechat: WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE
}

/** 远程链路确认策略解析（微信兼容旧 remoteWechatConfirm 布尔配置）。 */
export function resolveRemoteContextConfirmPolicy(
  remoteContext: RemoteContext,
  wechatConfig?: WeChatConfig | null
): ReturnType<typeof resolveRemoteConfirmPolicy> {
  if (remoteContext.source === 'wechat') {
    const normalized = normalizeWeChatConfirmPolicy(
      remoteContext.confirmPolicy,
      wechatConfig?.remoteWechatConfirm
    )
    return resolveRemoteConfirmPolicy({ source: 'wechat', confirmPolicy: normalized })
  }
  return resolveRemoteConfirmPolicy({
    source: 'feishu',
    confirmPolicy: remoteContext.confirmPolicy
  })
}
