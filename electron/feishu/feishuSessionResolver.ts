import type { SessionStorage } from '../sessionStorage/contracts'
import type { FeishuConfig, FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { resolveImSession, truncateTitle } from '../remote/imSessionResolver'

export async function createNewFeishuSession(
  sessionStorage: SessionStorage,
  msg: FeishuInboundMessage,
  model: string
): Promise<string> {
  const title = `[飞书] ${truncateTitle(msg.content)}`
  const session = sessionStorage.commands.createSession({
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
  sessionStorage: SessionStorage,
  msg: FeishuInboundMessage,
  config: FeishuConfig,
  defaultModel: string,
  availableModelNames?: string[]
): Promise<{ sessionId: string; isNew: boolean }> {
  return resolveImSession({
    sessionQueries: sessionStorage.queries,
    config,
    defaultModel,
    availableModelNames,
    channel: 'feishu',
    identityKey: msg.chatId,
    getIdentityFromSession: (s) => (s.metadata as { feishuChatId?: string }).feishuChatId,
    createNew: (model) => createNewFeishuSession(sessionStorage, msg, model),
    onReuse: (existing) => { sessionStorage.commands.recordRemoteSessionIdentity(existing.id, { channel: 'feishu', messageId: msg.messageId }) }
  })
}
