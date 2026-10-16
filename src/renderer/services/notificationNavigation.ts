import { setConfirmFocusToolUseId, setScrollToMessageId } from '../store/chatSlice'
import { store } from '../store'
import { pendingConfirmStore } from './pendingConfirmStore'
import { handleRemoteSessionSwitch } from './remoteSessionSwitchService'

let latestNavigationId = 0

/** Switch to the session owning a floating confirmation, then focus its card in chat. */
export async function navigateToPendingConfirmation(payload: { sessionId: string; toolUseId?: string }): Promise<void> {
  const navigationId = ++latestNavigationId
  const switched = await handleRemoteSessionSwitch(payload.sessionId)
  if (!switched.desktopSwitched || !payload.toolUseId) return
  // desktopSwitched means this request changed the session at some point; a later
  // notification may have superseded it while its messages were still loading.
  if (navigationId !== latestNavigationId || store.getState().chat.currentSessionId !== payload.sessionId) return
  const pending = pendingConfirmStore.find(payload.sessionId, payload.toolUseId)
  const messageId = pending?.assistantMessageId ?? store.getState().chat.messages.find((message) =>
    message.sessionId === payload.sessionId && message.toolCalls?.some((tool) => tool.id === payload.toolUseId)
  )?.id
  if (messageId) store.dispatch(setScrollToMessageId(messageId))
  store.dispatch(setConfirmFocusToolUseId(payload.toolUseId))
}
