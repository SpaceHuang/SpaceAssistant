import type { IncomingMessage } from '@wechatbot/wechatbot'
import {
  normalizeWeChatConfirmPolicy,
  resolveRemoteConfirmPolicy,
  shouldRequestImConfirm
} from '../../src/shared/remoteConfirmPolicy'
import { formatRemoteProgressMessage } from '../../src/shared/remoteProgressTypes'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import type { FeishuConfirmManager } from '../feishu/feishuConfirmManager'
import { logFeishuCliEvent } from '../feishu/feishuCliLogger'
import type {
  RemoteConfirmDecision,
  RemoteConfirmPayload,
  RemoteContext
} from '../tools/types'
import type { WeChatConfirmManager } from '../wechat/weChatConfirmManager'
import { logWeChatCliEvent } from '../wechat/weChatCliLogger'
import { getLastPublishableSnapshot } from './remoteProgressStore'
import { buildConfirmInstantPrompt } from './remoteProgressHooks'

export type { RemoteConfirmDecision, RemoteConfirmPayload }

export const FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE =
  '飞书确认超时（10分钟），工具调用已取消。请查看 Bot 发出的确认消息后回复 Y，或重新发送指令。'

export const WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE =
  '用户确认超时（5分钟），工具调用已取消'

export const REMOTE_CONFIRM_TIMEOUT_MESSAGES: Record<'feishu' | 'wechat', string> = {
  feishu: FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE,
  wechat: WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE
}

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

function formatLastPublishablePrefix(sessionId: string): string {
  const last = getLastPublishableSnapshot(sessionId)
  if (!last?.publishable) return ''
  return formatRemoteProgressMessage(last)
}

function buildWeChatImPrompt(payload: RemoteConfirmPayload, progressPrefix: string): string {
  const summary = `该操作需在确认后执行：\n工具：${payload.toolName}`
  return buildConfirmInstantPrompt({
    progressPrefix,
    toolName: payload.toolName,
    summary,
    timeoutMinutes: 5
  })
}

export function createFeishuRequestToolConfirm(
  confirmManager: FeishuConfirmManager
): NonNullable<RemoteContext['requestToolConfirm']> {
  return async (payload) => {
    logFeishuCliEvent('info', 'feishu.remote.confirm', {
      sessionId: payload.sessionId,
      toolName: payload.toolName
    })
    const decision = await confirmManager.requestConfirm({
      kind: 'tool_write',
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      messageId: payload.messageId,
      chatId: payload.chatId ?? '',
      trustEligible: payload.trustEligible
    })
    logFeishuCliEvent('info', 'feishu.remote.confirm', {
      sessionId: payload.sessionId,
      toolName: payload.toolName,
      decision
    })
    return decision
  }
}

export function createWeChatRequestToolConfirm(args: {
  confirmManager: WeChatConfirmManager
  wechatConfig: WeChatConfig
  userId: string
  inboundRaw: IncomingMessage
}): NonNullable<RemoteContext['requestToolConfirm']> {
  const { confirmManager, wechatConfig, userId, inboundRaw } = args
  return async (payload) => {
    logWeChatCliEvent('info', 'wechat.remote.confirm', {
      sessionId: payload.sessionId,
      toolName: payload.toolName
    })
    const progressPrefix = formatLastPublishablePrefix(payload.sessionId)
    const imPrompt = buildWeChatImPrompt(payload, progressPrefix)
    const decision = await confirmManager.requestConfirm(
      {
        kind: 'tool_write',
        sessionId: payload.sessionId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        toolInput: payload.toolInput,
        messageId: payload.messageId,
        userId: payload.userId ?? userId,
        inboundMsg: inboundRaw,
        trustEligible: payload.trustEligible
      },
      wechatConfig,
      undefined,
      { imPrompt }
    )
    logWeChatCliEvent('info', 'wechat.remote.confirm', {
      sessionId: payload.sessionId,
      toolName: payload.toolName,
      decision
    })
    return decision
  }
}

export async function requestRemoteConfirm(args: {
  remoteContext: RemoteContext
  payload: RemoteConfirmPayload
  wechatConfig?: WeChatConfig
}): Promise<RemoteConfirmDecision> {
  const resolved = resolveRemoteContextConfirmPolicy(args.remoteContext, args.wechatConfig)
  if (!shouldRequestImConfirm(resolved)) return 'n'

  const requestToolConfirm = args.remoteContext.requestToolConfirm
  if (!requestToolConfirm) return 'n'

  return requestToolConfirm(args.payload)
}
