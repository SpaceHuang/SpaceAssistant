import type { AppDatabase } from '../database'
import { createSession, listSessions, updateSession } from '../database'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'
import { truncateTitle } from './weChatInboundParser'
import {
  pickRemoteSessionCandidate,
  readRemoteSessionIdleMinutes,
  resolveActivityAt
} from '../../src/shared/remoteSessionResolve'

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

  const idleTimeoutMs = readRemoteSessionIdleMinutes(config) * 60_000
  if (idleTimeoutMs <= 0) {
    return {
      sessionId: await createNewWeChatSession(db, msg, model, activeProfileId),
      isNew: true
    }
  }

  const existing = pickRemoteSessionCandidate(
    listSessions(db),
    'wechat',
    msg.userId,
    (s) => {
      const m = s.metadata as Record<string, unknown> | undefined
      const meta = m?.wechatMeta as { userId?: string } | undefined
      return meta?.userId
    }
  )

  if (existing && Date.now() - resolveActivityAt(existing) < idleTimeoutMs) {
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
