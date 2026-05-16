import { CHAT_CANCELLED_MESSAGE } from '../src/shared/chatCancel'
import { cancelAllToolConfirmsForRequest, cancelAllToolsForRequest } from './toolConfirmRegistry'

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
  cancelAllToolsForRequest(requestId)
}

export function clearChatCancel(requestId: string): void {
  chatCancelControllers.delete(requestId)
}

export function throwIfChatCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ChatCancelledError()
}
