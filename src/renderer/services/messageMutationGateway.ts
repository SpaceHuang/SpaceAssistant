import type { ChatImageAttachment, Message } from '../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../../shared/domainTypes'
import type { ApiContextEntry, ApiContextRequest } from '../../shared/displayOrder'
import {
  getApiContextOverlaySnapshot,
  removeApiContextMessage,
  routeAddApiContextMessage,
  routePatchApiContextMessage
} from './apiContextService'
import {
  summarizeContextMessage,
  upsertContextSummaryOverride
} from './contextHistorySummaryService'
import { removeLiveMessage, routePatchMessage } from './chatRunnerService'
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
