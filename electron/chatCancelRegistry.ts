import { CHAT_CANCELLED_MESSAGE } from '../src/shared/chatCancel'
import {
  cancelAllPendingToolConfirms,
  cancelAllToolConfirmsForRequest,
  cancelAllToolsForRequest
} from './toolConfirmRegistry'
import { cancelAllWriteDirConfirmsForRequest } from './workspaceLayout/writeDirConfirmRegistry'

export { CHAT_CANCELLED_MESSAGE }

export class ChatCancelledError extends Error {
  constructor(message = CHAT_CANCELLED_MESSAGE) {
    super(message)
    this.name = 'ChatCancelledError'
  }
}

const chatCancelControllers = new Map<string, AbortController>()

export function registerChatCancel(requestId: string): AbortSignal {
  const prev = chatCancelControllers.get(requestId)
  prev?.abort()
  const ac = new AbortController()
  chatCancelControllers.set(requestId, ac)
  return ac.signal
}

export function signalChatCancel(requestId: string): void {
  chatCancelControllers.get(requestId)?.abort()
  cancelAllToolConfirmsForRequest(requestId)
  cancelAllWriteDirConfirmsForRequest(requestId)
  cancelAllToolsForRequest(requestId)
}

export function clearChatCancel(requestId: string): void {
  chatCancelControllers.delete(requestId)
}

export function throwIfChatCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ChatCancelledError()
}

/** 应用退出时中止全部进行中的聊天/远程 Agent，释放 HTTP 与工具等待。 */
export function cancelAllActiveChats(): void {
  for (const [requestId, ac] of chatCancelControllers) {
    ac.abort()
    cancelAllToolConfirmsForRequest(requestId)
    cancelAllToolsForRequest(requestId)
  }
  chatCancelControllers.clear()
  cancelAllPendingToolConfirms()
}
