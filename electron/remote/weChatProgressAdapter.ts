import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { SessionCommands } from '../sessionStorage/contracts'
import {
  DEFAULT_REMOTE_PROGRESS_CONFIG,
  mergeRemoteProgressConfig,
  type RemoteProgressConfig
} from '../../src/shared/remoteProgressTypes'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import { sendWeChatTyping } from '../wechat/weChatReplyService'
import { sendWeChatRemoteOutbound } from '../wechat/weChatRemoteOutbound'
import type { WeChatBotService } from '../wechat/weChatBotService'
import { logWeChatCliEvent } from '../wechat/weChatCliLogger'
import type { RemoteProgressAdapter } from './remoteProgressCoordinator'

export function createWeChatProgressAdapter(args: {
  botService: WeChatBotService
  userId: string
  inboundRaw: IncomingMessage
  getSessionId: () => string
  config: WeChatConfig
  sessionCommands: Pick<SessionCommands, 'recordRemoteSessionActivity'>
}): RemoteProgressAdapter {
  const progressConfig = mergeRemoteProgressConfig(
    pickWeChatProgressConfig(args.config),
    {
      ...DEFAULT_REMOTE_PROGRESS_CONFIG,
      remoteTypingEnabled:
        args.config.remoteTypingEnabled ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteTypingEnabled,
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
      const sessionId = args.getSessionId()
      void sendWeChatRemoteOutbound({
        bot,
        inbound: args.inboundRaw,
        body: text,
        sessionId,
        touch: { sessionCommands: args.sessionCommands, sessionId }
      }).catch(() => undefined)
    },
    logProgress: ({ textLen, textHash }) => {
      const sessionId = args.getSessionId()
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
