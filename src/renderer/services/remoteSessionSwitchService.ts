import { store } from '../store'
import { setMessages, setSession } from '../store/chatSlice'
import {
  activeWorkDirProfileId,
  ensureWorkDirForSession,
  rollbackWorkDirProfile
} from './workDirSessionSync'

/**
 * 单调递增 token：每次切换请求领取一个新 token。
 * 工作目录 IPC 经单飞队列串行化，并在队内检查 token：被取代的请求不得向主进程提交
 * workdirSwitch；若已提交则在让出队列前补偿回滚，避免晚到响应覆盖更新请求的 active profile。
 */
let latestSwitchToken = 0
let workDirSwitchChain: Promise<void> = Promise.resolve()

function isLatestSwitch(token: number): boolean {
  return token === latestSwitchToken
}

function enqueueWorkDirOp<T>(op: () => Promise<T>): Promise<T> {
  const run = workDirSwitchChain.then(op, op)
  workDirSwitchChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export type RemoteSessionSwitchResult = {
  desktopSwitched: boolean
  viewChanged: boolean
}

export async function handleRemoteSessionSwitch(
  sessionId: string
): Promise<RemoteSessionSwitchResult> {
  const token = ++latestSwitchToken

  const state = store.getState()
  const previousSessionId = state.chat.currentSessionId
  const session =
    state.session.list.find((s) => s.id === sessionId) ?? (await window.api.sessionGet(sessionId))
  if (!isLatestSwitch(token)) {
    return { desktopSwitched: false, viewChanged: false }
  }
  if (!session) {
    return { desktopSwitched: false, viewChanged: false }
  }

  const config = state.config.config
  if (!config) {
    return { desktopSwitched: false, viewChanged: false }
  }
  const previousProfileId = activeWorkDirProfileId(config)

  const workDirResult = await enqueueWorkDirOp(async () => {
    if (!isLatestSwitch(token)) {
      return { ok: true as const, switched: false, committed: false }
    }
    const latestConfig = store.getState().config.config ?? config
    const result = await ensureWorkDirForSession(session, latestConfig, store.dispatch, {
      isCurrent: () => isLatestSwitch(token)
    })
    // 若在切换过程中被取代且已改动主进程 active，在让出队列前补偿回滚。
    if (!isLatestSwitch(token) && result.ok && result.switched && previousProfileId) {
      await rollbackWorkDirProfile(previousProfileId, store.dispatch)
      return { ok: true as const, switched: true, committed: false }
    }
    return result
  })

  if (!isLatestSwitch(token)) {
    return { desktopSwitched: false, viewChanged: false }
  }
  if (!workDirResult.ok) {
    return { desktopSwitched: false, viewChanged: false }
  }

  const viewChanged = previousSessionId !== sessionId
  store.dispatch(setSession(sessionId))

  let rows: Awaited<ReturnType<typeof window.api.chatGetMessages>>
  try {
    rows = await window.api.chatGetMessages({ sessionId })
  } catch {
    if (isLatestSwitch(token)) {
      store.dispatch(setSession(previousSessionId))
      if (workDirResult.switched) {
        await enqueueWorkDirOp(() => rollbackWorkDirProfile(previousProfileId, store.dispatch))
      }
    }
    return { desktopSwitched: false, viewChanged: false }
  }

  if (!isLatestSwitch(token)) {
    return { desktopSwitched: true, viewChanged: false }
  }

  store.dispatch(setMessages(rows))
  return { desktopSwitched: true, viewChanged }
}

export function initRemoteSessionSwitchBridge(): () => void {
  return window.api.onRemoteSwitchSessionRequest((payload) => {
    void (async () => {
      let result: RemoteSessionSwitchResult = { desktopSwitched: false, viewChanged: false }
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
