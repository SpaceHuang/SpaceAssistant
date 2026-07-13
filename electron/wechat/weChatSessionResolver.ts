import type { AppDatabase } from '../database'
import { createSession, updateSession } from '../database'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'
import { resolveImSession, truncateTitle } from '../remote/imSessionResolver'

export async function createNewWeChatSession(
  db: AppDatabase,
  msg: WeChatInboundMessage,
  model: string,
  activeWorkDirProfileId?: string
): Promise<string> {
  const title = `[微信] ${truncateTitle(msg.text)}`
  const session = createSession(db, {
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
  db: AppDatabase,
  msg: WeChatInboundMessage,
  config: WeChatConfig,
  defaultModel: string,
  availableModelNames?: string[],
  getActiveWorkDirProfileId?: () => string
): Promise<{ sessionId: string; isNew: boolean }> {
  const activeProfileId = getActiveWorkDirProfileId?.()
  return resolveImSession({
    db,
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
    createNew: (model) => createNewWeChatSession(db, msg, model, activeProfileId),
    onReuse: (existing) => {
      const patch: Parameters<typeof updateSession>[2] = {
        metadata: {
          ...existing.metadata,
          wechatMessageId: msg.messageId,
          wechatMeta: {
            ...(existing.metadata as { wechatMeta?: Record<string, unknown> })?.wechatMeta,
            userId: msg.userId,
            lastMessageId: msg.messageId,
            lastContextToken: msg.contextToken
          }
        }
      }
      if (!existing.workDirProfileId && activeProfileId) {
        patch.workDirProfileId = activeProfileId
      }
      updateSession(db, existing.id, patch)
    }
  })
}
