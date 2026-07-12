import type { LarkCliRunner } from '../feishu/larkCliRunner'
import { replyFeishuText } from '../feishu/feishuReply'
import { logFeishuCliEvent } from '../feishu/feishuCliLogger'
import {
  FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG,
  mergeRemoteProgressConfig,
  type RemoteProgressConfig
} from '../../src/shared/remoteProgressTypes'
import type { FeishuConfig } from '../../src/shared/feishuTypes'
import type { RemoteProgressAdapter } from './remoteProgressCoordinator'

export function createFeishuProgressAdapter(args: {
  runner: LarkCliRunner
  messageId: string
  sessionId: string
  config: FeishuConfig
}): RemoteProgressAdapter {
  return {
    channel: 'feishu',
    sendTyping: undefined,
    reply: (text: string) => {
      void replyFeishuText(args.runner, args.messageId, text).catch(() => undefined)
    },
    logProgress: ({ sessionId, textLen, textHash }) => {
      logFeishuCliEvent('info', 'feishu.remote.progress', { sessionId, textLen, textHash })
    }
  }
}

export function pickFeishuProgressConfig(config: FeishuConfig): RemoteProgressConfig {
  return {
    remoteProgressMode: config.remoteProgressMode,
    remoteProgressHeartbeatSec: config.remoteProgressHeartbeatSec,
    remoteTypingEnabled: config.remoteTypingEnabled,
    remoteProgressMinIntervalSec: config.remoteProgressMinIntervalSec,
    remoteProgressMaxChars: config.remoteProgressMaxChars,
    remoteProgressFallbackText: config.remoteProgressFallbackText
  }
}

export function feishuProgressDefaults() {
  return FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG
}

export function mergeFeishuProgressConfig(config: FeishuConfig) {
  return mergeRemoteProgressConfig(pickFeishuProgressConfig(config), FEISHU_DEFAULT_REMOTE_PROGRESS_CONFIG)
}
