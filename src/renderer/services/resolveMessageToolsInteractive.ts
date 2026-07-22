import type { FileConfirmMode, Message } from '../../shared/domainTypes'
import type { PendingConfirmItem } from './pendingConfirmStore'

export type ToolsInteractiveScalars = {
  requestId: string
  confirmMode: FileConfirmMode
}

export function messageHasConfirmingTool(message: Message | undefined): boolean {
  return Boolean(message?.toolCalls?.some((tc) => tc.status === 'confirming'))
}

export function messageHasExecutingTool(message: Message | undefined): boolean {
  return Boolean(message?.toolCalls?.some((tc) => tc.status === 'executing'))
}

export function resolveRequestIdForConfirmingMessage(args: {
  sessionId: string
  message: Message
  pendingItems: PendingConfirmItem[]
  streamingAssistantId?: string
  streamingRequestId?: string | null
}): string | null {
  const { sessionId, message, pendingItems, streamingAssistantId, streamingRequestId } = args
  if (!messageHasConfirmingTool(message)) return null

  for (const tc of message.toolCalls ?? []) {
    if (tc.status !== 'confirming') continue
    const pending = pendingItems.find((item) => item.sessionId === sessionId && item.toolUseId === tc.id)
    if (pending?.requestId) return pending.requestId
  }

  if (streamingRequestId && message.id === streamingAssistantId) {
    return streamingRequestId
  }

  // Active run still waiting on confirm but pending store missed IPC (race / index miss).
  if (streamingRequestId) {
    return streamingRequestId
  }

  return null
}

/**
 * 返回工具交互标量（无回调）。confirm/cancel 由 ChatMessageActions 提供。
 * confirming 或（当前流式助手上的）executing 消息可获得标量。
 */
export function resolveMessageToolsInteractive(args: {
  message: Message
  sessionId: string | null
  toolsEnabled: boolean
  confirmMode: FileConfirmMode
  pendingItems: PendingConfirmItem[]
  streamingAssistantId?: string
  streamingRequestId?: string | null
}): ToolsInteractiveScalars | undefined {
  const {
    message,
    sessionId,
    toolsEnabled,
    confirmMode,
    pendingItems,
    streamingAssistantId,
    streamingRequestId
  } = args

  if (!sessionId || !toolsEnabled) return undefined

  if (messageHasConfirmingTool(message)) {
    const requestId = resolveRequestIdForConfirmingMessage({
      sessionId,
      message,
      pendingItems,
      streamingAssistantId,
      streamingRequestId
    })
    if (!requestId) return undefined
    return { requestId, confirmMode }
  }

  if (
    messageHasExecutingTool(message) &&
    streamingRequestId &&
    message.id === streamingAssistantId
  ) {
    return { requestId: streamingRequestId, confirmMode }
  }

  return undefined
}
