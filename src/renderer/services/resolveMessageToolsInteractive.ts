import type { FileConfirmMode, Message } from '../../shared/domainTypes'
import type { ToolConfirmOptions } from '../../shared/toolConfirm'
import type { PendingConfirmItem } from './pendingConfirmStore'
import type { ToolsInteractiveProps } from '../components/Chat/ChatBubble'

export function messageHasConfirmingTool(message: Message | undefined): boolean {
  return Boolean(message?.toolCalls?.some((tc) => tc.status === 'confirming'))
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

  if (message.id === streamingAssistantId && streamingRequestId) {
    return streamingRequestId
  }

  for (const tc of message.toolCalls ?? []) {
    if (tc.status !== 'confirming') continue
    const pending = pendingItems.find((item) => item.sessionId === sessionId && item.toolUseId === tc.id)
    if (pending?.requestId) return pending.requestId
  }

  return null
}

export function resolveMessageToolsInteractive(args: {
  message: Message
  sessionId: string | null
  toolsEnabled: boolean
  confirmMode: FileConfirmMode
  pendingItems: PendingConfirmItem[]
  streamingAssistantId?: string
  streamingRequestId?: string | null
  onToolConfirm: (toolUseId: string, approved: boolean, options?: ToolConfirmOptions) => void
  onToolCancel: (toolUseId: string) => void
}): ToolsInteractiveProps | undefined {
  const {
    message,
    sessionId,
    toolsEnabled,
    confirmMode,
    pendingItems,
    streamingAssistantId,
    streamingRequestId,
    onToolConfirm,
    onToolCancel
  } = args

  if (!sessionId || !toolsEnabled || !messageHasConfirmingTool(message)) return undefined

  const requestId = resolveRequestIdForConfirmingMessage({
    sessionId,
    message,
    pendingItems,
    streamingAssistantId,
    streamingRequestId
  })
  if (!requestId) return undefined

  return {
    requestId,
    confirmMode,
    onToolConfirm,
    onToolCancel
  }
}
