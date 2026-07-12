import type { IncomingMessage } from '@wechatbot/wechatbot'
import {
  DEFAULT_REMOTE_PROGRESS_CONFIG,
  mergeRemoteProgressConfig,
  type RemoteProgressConfig
} from '../../src/shared/remoteProgressTypes'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import { sendWeChatTyping } from '../wechat/weChatReplyService'
import type { WeChatBotService } from '../wechat/weChatBotService'
import { logWeChatCliEvent } from '../wechat/weChatCliLogger'
import type { RemoteProgressAdapter } from './remoteProgressCoordinator'

export function createWeChatProgressAdapter(args: {
  botService: WeChatBotService
  userId: string
  inboundRaw: IncomingMessage
  sessionId: string
  config: WeChatConfig
}): RemoteProgressAdapter {
  const progressConfig = mergeRemoteProgressConfig(
    pickWeChatProgressConfig(args.config),
    {
      ...DEFAULT_REMOTE_PROGRESS_CONFIG,
      remoteTypingEnabled: args.config.remoteTypingEnabled,
      remoteProgressHeartbeatSec: args.config.remoteProgressHeartbeatSec ?? 60
    }
  )

  const bot = args.botService.getBot()

  return {
    channel: 'wechat',
    sendTyping: bot
      ? () => {
          void sendWeChatTyping(bot, args.userId)
        }
      : undefined,
    reply: (text: string) => {
      if (!bot) return
      void bot.reply(args.inboundRaw, text).catch(() => undefined)
    },
    logProgress: ({ sessionId, textLen, textHash }) => {
      logWeChatCliEvent('info', 'wechat.remote.progress', { sessionId, textLen, textHash })
    }
  }
}

export function pickWeChatProgressConfig(config: WeChatConfig): RemoteProgressConfig {
  return {
    remoteProgressMode: config.remoteProgressMode,
    remoteProgressHeartbeatSec: config.remoteProgressHeartbeatSec,
    remoteTypingEnabled: config.remoteTypingEnabled,
    remoteProgressMinIntervalSec: config.remoteProgressMinIntervalSec,
    remoteProgressMaxChars: config.remoteProgressMaxChars,
    remoteProgressFallbackText: config.remoteProgressFallbackText
  }
}
