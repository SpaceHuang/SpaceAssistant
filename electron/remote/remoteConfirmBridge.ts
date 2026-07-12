import type { IncomingMessage } from '@wechatbot/wechatbot'
import {
  normalizeWeChatConfirmPolicy,
  resolveRemoteConfirmPolicy,
  shouldRequestImConfirm
} from '../../src/shared/remoteConfirmPolicy'
import { formatRemoteProgressMessage } from '../../src/shared/remoteProgressTypes'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import type { RemoteContext } from '../tools/types'
import { logFeishuCliEvent } from '../feishu/feishuCliLogger'
import { logWeChatCliEvent } from '../wechat/weChatCliLogger'
import { getLastPublishableSnapshot } from './remoteProgressStore'
import { buildConfirmInstantPrompt } from './remoteProgressHooks'

export type RemoteConfirmDecision = 'y' | 'n' | 'timeout'

export type RemoteConfirmPayload = {
  sessionId: string
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  messageId: string
  chatId?: string
  userId?: string
  inboundRaw?: IncomingMessage
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

export async function requestRemoteConfirm(args: {
  remoteContext: RemoteContext
  payload: RemoteConfirmPayload
  wechatConfig?: WeChatConfig
}): Promise<RemoteConfirmDecision> {
  const resolved = resolveRemoteContextConfirmPolicy(args.remoteContext, args.wechatConfig)
  if (!shouldRequestImConfirm(resolved)) return 'n'

  const { remoteContext, payload } = args
  const progressPrefix = formatLastPublishablePrefix(payload.sessionId)

  if (remoteContext.source === 'feishu' && remoteContext.confirmManager) {
    logFeishuCliEvent('info', 'feishu.remote.confirm', {
      sessionId: payload.sessionId,
      toolName: payload.toolName
    })
    const decision = await remoteContext.confirmManager.requestConfirm({
      kind: 'tool_write',
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      messageId: payload.messageId,
      chatId: payload.chatId ?? ''
    })
    logFeishuCliEvent('info', 'feishu.remote.confirm', {
      sessionId: payload.sessionId,
      toolName: payload.toolName,
      decision
    })
    return decision
  }

  if (
    remoteContext.source === 'wechat' &&
    remoteContext.confirmManager &&
    remoteContext.inboundRaw &&
    args.wechatConfig
  ) {
    logWeChatCliEvent('info', 'wechat.remote.confirm', {
      sessionId: payload.sessionId,
      toolName: payload.toolName
    })
    const imPrompt = buildWeChatImPrompt(payload, progressPrefix)
    const decision = await remoteContext.confirmManager.requestConfirm(
      {
        kind: 'tool_write',
        sessionId: payload.sessionId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        toolInput: payload.toolInput,
        messageId: payload.messageId,
        userId: payload.userId ?? remoteContext.userId,
        inboundMsg: remoteContext.inboundRaw
      },
      args.wechatConfig,
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

  return 'n'
}
