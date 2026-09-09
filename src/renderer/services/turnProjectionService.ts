import type { Message } from '../../shared/domainTypes'
import { routePatchMessage } from './chatRunnerService'
import { pendingConfirmStore } from './pendingConfirmStore'
import type { SessionUsage } from '../../shared/sessionUsage'
import { store } from '../store'
import { setChatStatus, setLastUsage } from '../store/chatSlice'

function applyProjectedUsage(sessionId: string, usage: SessionUsage, projected: boolean): void {
  if (!projected) void window.api.usageSet({ sessionId, usage }).catch(() => {})
  if (store.getState().chat.currentSessionId === sessionId) store.dispatch(setLastUsage({ sessionId, usage }))
}

function applyTerminalStatus(payload: TurnProjectionPayload): void {
  const { type } = payload.event
  if (type !== 'source-completed' && type !== 'source-failed' && type !== 'source-cancelled' && type !== 'source-timeout') return
  store.dispatch(setChatStatus({
    status: type === 'source-failed' || type === 'source-timeout' ? 'error' : 'completed',
    requestId: null,
    sessionId: payload.turn.sessionId,
    ...(type === 'source-failed' ? { error: 'source-failed' } : {}),
    ...(type === 'source-timeout' ? { error: 'TURN_TIMEOUT' } : {})
  }))
}

export type TurnProjectionPayload = {
  turn: { turnId: string; requestId: string; sessionId: string; assistantMessage: Message; version: number }
  event: { type: string }
}

export type TurnProjectionMetric = {
  kind: 'projection'
  turnId: string
  version: number
  eventType: string
  durationMs: number
}

/** 应用级 turn snapshot 投影：只接受单调版本，事实仍由主进程持有。 */
export function initTurnProjectionBridge(onMetric?: (metric: TurnProjectionMetric) => void): () => void {
  const versions = new Map<string, number>()
  let disposed = false
  const apply = (payload: TurnProjectionPayload): void => {
    if (disposed) return
    const startedAt = typeof performance !== 'undefined' ? performance.now() : 0
    const previous = versions.get(payload.turn.turnId) ?? -1
    if (payload.turn.version <= previous) return
    versions.set(payload.turn.turnId, payload.turn.version)
    routePatchMessage(payload.turn.sessionId, payload.turn.assistantMessage.id, payload.turn.assistantMessage)
    pendingConfirmStore.syncFromProjection({ sessionId: payload.turn.sessionId, requestId: payload.turn.requestId, message: payload.turn.assistantMessage })
    applyTerminalStatus(payload)
    if (payload.event.type === 'usage-updated') {
      const usage = (payload.event as { usage?: unknown }).usage
      if (usage && typeof usage === 'object') applyProjectedUsage(payload.turn.sessionId, usage as SessionUsage, Boolean((payload.event as { projected?: boolean }).projected))
    }
    onMetric?.({ kind: 'projection', turnId: payload.turn.turnId, version: payload.turn.version, eventType: payload.event.type, durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : 0) - startedAt) })
  }
  const unsubscribe = window.api.chatOnTurnProjection((payload) => {
    apply(payload)
  })
  // 先订阅再请求 snapshot，避免 snapshot 调用期间同步到达的 projection event 丢失。
  // snapshot 可能落后于事件，统一由 turn version 去重/择新。
  if (typeof window.api.chatListActiveTurns === 'function') {
    void window.api.chatListActiveTurns().then((turns) => {
      for (const turn of turns) apply({ turn, event: { type: 'snapshot' } })
    })
  }
  return () => {
    disposed = true
    unsubscribe()
  }
}
