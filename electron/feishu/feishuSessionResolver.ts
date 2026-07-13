import type { AppDatabase } from '../database'
import { createSession, updateSession } from '../database'
import type { FeishuConfig, FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { resolveImSession, truncateTitle } from '../remote/imSessionResolver'

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
  return resolveImSession({
    db,
    config,
    defaultModel,
    availableModelNames,
    channel: 'feishu',
    identityKey: msg.chatId,
    getIdentityFromSession: (s) => (s.metadata as { feishuChatId?: string }).feishuChatId,
    createNew: (model) => createNewFeishuSession(db, msg, model),
    onReuse: (existing) => {
      updateSession(db, existing.id, {
        metadata: { ...existing.metadata, feishuMessageId: msg.messageId }
      })
    }
  })
}
