import type { ChatImageAttachment, Message } from '../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../../shared/domainTypes'
import type { ApiContextEntry, ApiContextRequest } from '../../shared/displayOrder'
import {
  ackApiContextMessagePersisted,
  getApiContextOverlaySnapshot,
  removeApiContextMessage,
  routeAddApiContextMessage,
  routePatchApiContextMessage
} from './apiContextService'
import {
  ackContextSummaryPersisted,
  summarizeContextMessage,
  upsertContextSummaryOverride
} from './contextHistorySummaryService'
import { routeAddMessage, removeLiveMessage } from './chatRunnerService'
import { store } from '../store'
import {
  ackDisplayMessagePersisted,
  patchDisplayMessage,
  removeDisplayMessage,
  removeMessage,
  patchMessage
} from '../store/chatSlice'

export type PersistedMessageEntry = {
  message: Message
  sequence: number
}

export type SendContextIntent =
  | { kind: 'create-user'; text: string; attachments?: ChatImageAttachment[] }
  | {
      kind: 'reuse-user'
      currentUser: ApiContextEntry
      excludeMessageIds?: string[]
    }

/**
 * 统一 mutation gateway：先 await DB，再原子更新 API overlay / display / summary。
 */
export async function commitMessagePatch(args: {
  sessionId: string
  messageId: string
  patch: Partial<
    Pick<
      Message,
      | 'content'
      | 'status'
      | 'toolUse'
      | 'thinking'
      | 'toolCalls'
      | 'contentSegments'
      | 'skillHints'
      | 'attachments'
      | 'imagesDeliveredToApi'
    >
  >
}): Promise<PersistedMessageEntry> {
  const entry = await window.api.chatPatchMessage({
    messageId: args.messageId,
    sessionId: args.sessionId,
    patch: args.patch
  })
  if (!entry) {
    throw new Error(`commitMessagePatch: message not found ${args.messageId}`)
  }

  const overlay = getApiContextOverlaySnapshot(args.sessionId).find((e) => e.message.id === args.messageId)
  if (overlay) {
    routePatchApiContextMessage(args.sessionId, args.messageId, entry.message)
  } else {
    routeAddApiContextMessage({
      message: entry.message,
      order: { kind: 'persisted', sequence: entry.sequence }
    })
  }

  store.dispatch(patchMessage({ id: args.messageId, patch: entry.message }))
  store.dispatch(
    patchDisplayMessage({
      id: args.messageId,
      patch: entry.message,
      order: { kind: 'persisted', sequence: entry.sequence }
    })
  )

  upsertContextSummaryOverride(
    args.sessionId,
    summarizeContextMessage(entry.message, { kind: 'persisted', sequence: entry.sequence })
  )

  return entry
}

export async function commitMessageDelete(args: {
  sessionId: string
  messageId: string
}): Promise<void> {
  const result = await window.api.chatDeleteQueuedMessage({
    messageId: args.messageId,
    sessionId: args.sessionId
  })
  if (!result.ok) {
    throw new Error(result.error || 'commitMessageDelete failed')
  }
  removeApiContextMessage(args.sessionId, args.messageId)
  removeLiveMessage(args.sessionId, args.messageId)
  store.dispatch(removeMessage(args.messageId))
  store.dispatch(removeDisplayMessage(args.messageId))
}

/**
 * 新消息 / 复用 user → 统一 ApiContextRequest。
 */
export async function prepareSendContext(
  sessionId: string,
  intent: SendContextIntent
): Promise<ApiContextRequest> {
  if (intent.kind === 'reuse-user') {
    const { currentUser, excludeMessageIds } = intent
    if (currentUser.message.role !== 'user' || currentUser.message.status !== 'sent') {
      throw new Error('prepareSendContext reuse-user requires sent user')
    }
    return {
      sessionId,
      requiredCurrentUser: currentUser,
      excludeMessageIds
    }
  }

  const userMsg: Message = {
    id: crypto.randomUUID(),
    sessionId,
    role: 'user',
    content: intent.text,
    attachments: intent.attachments?.length ? intent.attachments : undefined,
    timestamp: Date.now(),
    status: 'sent',
    schemaVersion: CURRENT_SCHEMA_VERSION
  }

  // routeAddMessage：display + API overlay 同路径；ordinal 由 API overlay 分配
  routeAddMessage(sessionId, userMsg)
  const overlayEntry = getApiContextOverlaySnapshot(sessionId).find((e) => e.message.id === userMsg.id)
  const order = overlayEntry?.order ?? { kind: 'optimistic' as const, ordinal: 0 }
  upsertContextSummaryOverride(sessionId, summarizeContextMessage(userMsg, order))

  const ack = await window.api.chatAppendMessage(userMsg)
  ackApiContextMessagePersisted(ack, sessionId)
  store.dispatch(ackDisplayMessagePersisted({ messageId: ack.messageId, sequence: ack.sequence }))
  ackContextSummaryPersisted(sessionId, ack.messageId, ack.sequence)

  return {
    sessionId,
    requiredCurrentUser: {
      message: userMsg,
      order: { kind: 'persisted', sequence: ack.sequence }
    }
  }
}
