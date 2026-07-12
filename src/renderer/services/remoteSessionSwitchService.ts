import { store } from '../store'
import { setMessages, setSession } from '../store/chatSlice'
import { ensureWorkDirForSession } from './workDirSessionSync'

export async function handleRemoteSessionSwitch(
  sessionId: string
): Promise<{ desktopSwitched: boolean; viewChanged: boolean }> {
  const state = store.getState()
  const previousSessionId = state.chat.currentSessionId
  const session =
    state.session.list.find((s) => s.id === sessionId) ?? (await window.api.sessionGet(sessionId))
  if (!session) {
    return { desktopSwitched: false, viewChanged: false }
  }

  const config = state.config.config
  if (!config) {
    return { desktopSwitched: false, viewChanged: false }
  }

  const workDirResult = await ensureWorkDirForSession(session, config, store.dispatch)
  if (!workDirResult.ok) {
    return { desktopSwitched: false, viewChanged: false }
  }

  const viewChanged = previousSessionId !== sessionId
  store.dispatch(setSession(sessionId))
  const rows = await window.api.chatGetMessages({ sessionId })
  store.dispatch(setMessages(rows))

  return { desktopSwitched: true, viewChanged }
}

export function initRemoteSessionSwitchBridge(): () => void {
  return window.api.onRemoteSwitchSessionRequest((payload) => {
    void (async () => {
      let result = { desktopSwitched: false, viewChanged: false }
      try {
        result = await handleRemoteSessionSwitch(payload.sessionId)
      } catch {
        /* ACK failure so main process does not wait for IPC timeout */
      }
      await window.api.remoteSwitchSessionComplete({
        requestId: payload.requestId,
        desktopSwitched: result.desktopSwitched,
        viewChanged: result.viewChanged
      })
    })()
  })
}
