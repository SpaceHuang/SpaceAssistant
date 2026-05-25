import type { AppDatabase } from '../database'
import { createSession, listSessions, updateSession } from '../database'
import type { FeishuConfig, FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { truncateTitle } from './feishuConfirmManager'

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
  defaultModel: string
): Promise<{ sessionId: string; isNew: boolean }> {
  const model = config.remoteDefaultModelId ?? defaultModel
  const mergeWindowMs = (config.remoteSessionMergeMinutes ?? 0) * 60_000
  if (mergeWindowMs <= 0) {
    return { sessionId: await createNewFeishuSession(db, msg, model), isNew: true }
  }

  const existing = listSessions(db).find((s) => {
    const m = s.metadata as Record<string, unknown>
    return m?.source === 'feishu' && m?.feishuChatId === msg.chatId && Date.now() - s.updatedAt < mergeWindowMs
  })

  if (existing) {
    updateSession(db, existing.id, {
      metadata: { ...existing.metadata, feishuMessageId: msg.messageId }
    })
    return { sessionId: existing.id, isNew: false }
  }

  return { sessionId: await createNewFeishuSession(db, msg, model), isNew: true }
}
