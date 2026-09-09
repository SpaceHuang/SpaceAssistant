import type { ChatImageAttachment, Message } from '../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../../shared/domainTypes'
import type { ApiContextEntry, ApiContextRequest } from '../../shared/displayOrder'
import {
  ackApiContextMessagePersisted,
  getApiContextOverlaySnapshot,
  removeApiContextMessage,
  routeAddApiContextMessageOptimistic,
  routeAddApiContextMessage,
  routePatchApiContextMessage
} from './apiContextService'
import {
  ackContextSummaryPersisted,
  summarizeContextMessage,
  upsertContextSummaryOverride
} from './contextHistorySummaryService'
import { routeAddMessage, removeLiveMessage, routePatchMessage } from './chatRunnerService'
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
      requestId?: string
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
  const entry = await window.api.messagePatchNonTurn({
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
  intent: SendContextIntent,
  requestId = crypto.randomUUID()
): Promise<ApiContextRequest> {
  if (intent.kind === 'reuse-user') {
    const { currentUser, excludeMessageIds } = intent
    if (currentUser.message.role !== 'user' || (currentUser.message.status !== 'sent' && currentUser.message.status !== 'queued')) {
      throw new Error('prepareSendContext reuse-user requires sent or queued user')
    }
    const prepared = await window.api.chatPrepareTurn({
      mode: 'reuse-user',
      requestId,
      sessionId,
      userMessageId: currentUser.message.id,
      excludeMessageIds: excludeMessageIds ?? [],
      config: {}
    })
    if (!prepared?.userMessage) throw new Error('CORE_PREPARE_TURN_REQUIRED')
    const user = prepared.userMessage
    const displayHasUser = store.getState().chat.displayEntries.some(
      (entry) => entry.message.id === user.id
    )
    if (displayHasUser) {
      routePatchMessage(sessionId, user.id, user)
    } else {
      routeAddMessage(sessionId, user)
    }
    store.dispatch(patchDisplayMessage({
      id: user.id,
      patch: user,
      order: currentUser.order
    }))
    const overlayHasUser = getApiContextOverlaySnapshot(sessionId).some(
      (entry) => entry.message.id === user.id
    )
    if (overlayHasUser) {
      routePatchApiContextMessage(sessionId, user.id, user)
    } else {
      routeAddApiContextMessage({ message: user, order: currentUser.order })
    }
    const sequence = await window.api.chatGetMessageSequence({ sessionId, messageId: user.id })
    return {
      sessionId,
      requiredCurrentUser: {
        message: user,
        order: { kind: 'persisted', sequence: sequence ?? (currentUser.order.kind === 'persisted' ? currentUser.order.sequence : 0) }
      },
      excludeMessageIds,
      coordinatorTurn: prepared
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

  const prepared = await window.api.chatPrepareTurn({
    mode: 'create-user',
    requestId,
    sessionId,
    input: { text: userMsg.content, attachments: userMsg.attachments },
    config: {}
  })
  if (!prepared?.userMessage) {
    throw new Error('CORE_PREPARE_TURN_REQUIRED')
  }
  const user = prepared.userMessage
  routeAddMessage(sessionId, user)
  routeAddApiContextMessageOptimistic(user)
  upsertContextSummaryOverride(sessionId, summarizeContextMessage(user, { kind: 'optimistic', ordinal: 0 }))
  const sequence = await window.api.chatGetMessageSequence({ sessionId, messageId: user.id })
  if (sequence != null) {
    ackApiContextMessagePersisted({ messageId: user.id, sequence }, sessionId)
    ackContextSummaryPersisted(sessionId, user.id, sequence)
    store.dispatch(ackDisplayMessagePersisted({ messageId: user.id, sequence }))
  }
  return {
    sessionId,
    requiredCurrentUser: { message: user, order: { kind: 'persisted', sequence: sequence ?? 0 } },
    coordinatorTurn: prepared
  }
}
