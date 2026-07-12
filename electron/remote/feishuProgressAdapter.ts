import type { AppDatabase } from '../database'
import type { LarkCliRunner } from '../feishu/larkCliRunner'
import { sendFeishuRemoteOutbound } from '../feishu/feishuRemoteOutbound'
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
  getSessionId: () => string
  config: FeishuConfig
  db: AppDatabase
}): RemoteProgressAdapter {
  return {
    channel: 'feishu',
    sendTyping: undefined,
    reply: (text: string) => {
      const sessionId = args.getSessionId()
      void sendFeishuRemoteOutbound({
        runner: args.runner,
        messageId: args.messageId,
        body: text,
        sessionId,
        touch: { db: args.db, sessionId }
      }).catch(() => undefined)
    },
    logProgress: ({ textLen, textHash }) => {
      const sessionId = args.getSessionId()
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
