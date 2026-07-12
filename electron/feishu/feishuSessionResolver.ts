import type { AppDatabase } from '../database'
import { createSession, listSessions, updateSession } from '../database'
import type { FeishuConfig, FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { truncateTitle } from './feishuConfirmManager'
import {
  pickRemoteSessionCandidate,
  readRemoteSessionIdleMinutes,
  resolveActivityAt
} from '../../src/shared/remoteSessionResolve'

export async function createNewFeishuSession(
  db: AppDatabase,
  msg: FeishuInboundMessage,
  model: string
): Promise<string> {
  const title = `[飞书] ${truncateTitle(msg.content)}`
  const session = createSession(db, {
    name: title,
    model,
    metadata: {
      source: 'feishu',
      feishuChatId: msg.chatId,
      feishuMessageId: msg.messageId,
      feishuSenderOpenId: msg.senderOpenId
    }
  })
  return session.id
}

export async function resolveFeishuSession(
  db: AppDatabase,
  msg: FeishuInboundMessage,
  config: FeishuConfig,
  defaultModel: string,
  availableModelNames?: string[]
): Promise<{ sessionId: string; isNew: boolean }> {
  let model = config.remoteDefaultModelId ?? defaultModel
  if (config.remoteDefaultModelId && availableModelNames && !availableModelNames.includes(model)) {
    model = defaultModel
  }

  const idleTimeoutMs = readRemoteSessionIdleMinutes(config) * 60_000
  if (idleTimeoutMs <= 0) {
    return { sessionId: await createNewFeishuSession(db, msg, model), isNew: true }
  }

  const existing = pickRemoteSessionCandidate(
    listSessions(db),
    'feishu',
    msg.chatId,
    (s) => (s.metadata as { feishuChatId?: string }).feishuChatId
  )

  if (existing && Date.now() - resolveActivityAt(existing) < idleTimeoutMs) {
    updateSession(db, existing.id, {
      metadata: { ...existing.metadata, feishuMessageId: msg.messageId }
    })
    return { sessionId: existing.id, isNew: false }
  }

  return { sessionId: await createNewFeishuSession(db, msg, model), isNew: true }
}
