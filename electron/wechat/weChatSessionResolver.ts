import type { SessionStorage } from '../sessionStorage/contracts'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'
import { resolveImSession, truncateTitle } from '../remote/imSessionResolver'

export async function createNewWeChatSession(
  sessionStorage: SessionStorage,
  msg: WeChatInboundMessage,
  model: string,
  activeWorkDirProfileId?: string
): Promise<string> {
  const title = `[微信] ${truncateTitle(msg.text)}`
  const session = sessionStorage.commands.createSession({
    name: title,
    model,
    ...(activeWorkDirProfileId ? { workDirProfileId: activeWorkDirProfileId } : {}),
    metadata: {
      source: 'wechat',
      isRemote: true,
      wechatUserId: msg.userId,
      wechatMessageId: msg.messageId,
      wechatMeta: {
        userId: msg.userId,
        lastMessageId: msg.messageId,
        lastContextToken: msg.contextToken,
        lastReplyAt: Date.now()
      }
    }
  })
  return session.id
}

export async function resolveWeChatSession(
  sessionStorage: SessionStorage,
  msg: WeChatInboundMessage,
  config: WeChatConfig,
  defaultModel: string,
  availableModelNames?: string[],
  getActiveWorkDirProfileId?: () => string
): Promise<{ sessionId: string; isNew: boolean }> {
  const activeProfileId = getActiveWorkDirProfileId?.()
  return resolveImSession({
    sessionQueries: sessionStorage.queries,
    config,
    defaultModel,
    availableModelNames,
    channel: 'wechat',
    identityKey: msg.userId,
    getIdentityFromSession: (s) => {
      const m = s.metadata as Record<string, unknown> | undefined
      const meta = m?.wechatMeta as { userId?: string } | undefined
      return meta?.userId
    },
    createNew: (model) => createNewWeChatSession(sessionStorage, msg, model, activeProfileId),
    onReuse: (existing) => { sessionStorage.commands.recordRemoteSessionIdentity(existing.id, { channel: 'wechat', userId: msg.userId, messageId: msg.messageId, contextToken: msg.contextToken, ...(activeProfileId ? { workDirProfileId: activeProfileId } : {}) }) }
  })
}
