import type { AppDatabase } from '../database'
import { createSession, listSessions, updateSession } from '../database'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'
import { truncateTitle } from './weChatInboundParser'

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
  let model = config.remoteDefaultModelId ?? defaultModel
  if (config.remoteDefaultModelId && availableModelNames && !availableModelNames.includes(model)) {
    model = defaultModel
  }
  const activeProfileId = getActiveWorkDirProfileId?.()
  const mergeWindowMs = (config.remoteSessionMergeMinutes ?? 0) * 60_000
  if (mergeWindowMs <= 0) {
    return {
      sessionId: await createNewWeChatSession(db, msg, model, activeProfileId),
      isNew: true
    }
  }

  const existing = listSessions(db).find((s) => {
    const m = s.metadata as Record<string, unknown> | undefined
    const meta = m?.wechatMeta as { userId?: string; lastReplyAt?: number } | undefined
    return (
      m?.source === 'wechat' &&
      meta?.userId === msg.userId &&
      Date.now() - (meta?.lastReplyAt ?? s.updatedAt) < mergeWindowMs
    )
  })

  if (existing) {
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
    return { sessionId: existing.id, isNew: false }
  }

  return {
    sessionId: await createNewWeChatSession(db, msg, model, activeProfileId),
    isNew: true
  }
}

export function touchWeChatSessionReply(db: AppDatabase, sessionId: string): void {
  const sessions = listSessions(db)
  const s = sessions.find((x) => x.id === sessionId)
  if (!s) return
  const meta = (s.metadata ?? {}) as Record<string, unknown>
  const wechatMeta = (meta.wechatMeta ?? {}) as Record<string, unknown>
  updateSession(db, sessionId, {
    metadata: {
      ...meta,
      wechatMeta: { ...wechatMeta, lastReplyAt: Date.now() }
    }
  })
}
