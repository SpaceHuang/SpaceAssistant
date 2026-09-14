import type { Message } from '../../shared/domainTypes'
import { routePatchMessage } from './chatRunnerService'
import { pendingConfirmStore } from './pendingConfirmStore'
import type { SessionUsage } from '../../shared/sessionUsage'
import { store } from '../store'
import { setChatStatus, setLastUsage } from '../store/chatSlice'
import { turnDisplayToMessage } from '../../shared/turnDisplayProtocol'

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
    turnId: payload.turn.turnId,
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
  const terminalRetries = new Map<string, number>()
  const pending = new Map<string, TurnProjectionPayload>()
  const pendingDisplays = new Map<string, import('../../shared/turnDisplayProtocol').TurnDisplay>()
  const statusIdentity = new Map<string, string>()
  let frameHandle: number | undefined
  let displayFrameHandle: number | undefined
  let disposed = false
  const apply = (payload: TurnProjectionPayload): void => {
    if (disposed) return
    const startedAt = typeof performance !== 'undefined' ? performance.now() : 0
    const previous = versions.get(payload.turn.turnId) ?? -1
    if (payload.turn.version <= previous) return
    versions.set(payload.turn.turnId, payload.turn.version)
    routePatchMessage(payload.turn.sessionId, payload.turn.assistantMessage.id, payload.turn.assistantMessage)
    const hasConfirmation = (payload.turn.assistantMessage.toolCalls ?? []).some((tool) => tool.status === 'confirming')
    const isTerminal = payload.event.type === 'source-completed' || payload.event.type === 'source-failed' || payload.event.type === 'source-cancelled' || payload.event.type === 'source-timeout'
    if (hasConfirmation || isTerminal) {
      pendingConfirmStore.syncFromProjection({ sessionId: payload.turn.sessionId, requestId: payload.turn.requestId, turnId: payload.turn.turnId, turnVersion: payload.turn.version, message: payload.turn.assistantMessage })
    }
    applyTerminalStatus(payload)
    if (payload.event.type === 'usage-updated') {
      const usage = (payload.event as { usage?: unknown }).usage
      if (usage && typeof usage === 'object') applyProjectedUsage(payload.turn.sessionId, usage as SessionUsage, Boolean((payload.event as { projected?: boolean }).projected))
    }
    onMetric?.({ kind: 'projection', turnId: payload.turn.turnId, version: payload.turn.version, eventType: payload.event.type, durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : 0) - startedAt) })
  }
  const applyDisplay = ({ display, retry = false }: { display: import('../../shared/turnDisplayProtocol').TurnDisplay; retry?: boolean }): void => {
    if (disposed) return
    const previous = versions.get(display.turnId) ?? -1
    if (display.version < previous || (!retry && display.version === previous)) return
    if (retry && display.version !== previous) return
    versions.set(display.turnId, display.version)
    // bounded display 只能进入 renderer 展示层；不能伪装成 Message 写入 Redux/API context。
    if (display.lifecycle === 'awaiting-confirmation' || display.lifecycle === 'completed' || display.lifecycle === 'failed') {
      pendingConfirmStore.syncFromProjection({ sessionId: display.sessionId, requestId: display.requestId, turnId: display.turnId, turnVersion: display.version, message: turnDisplayToMessage(display) })
    }
    if (display.lifecycle === 'running' || display.lifecycle === 'awaiting-confirmation') {
      const identity = `${display.requestId}:${display.lifecycle}`
      if (statusIdentity.get(display.turnId) !== identity) {
        statusIdentity.set(display.turnId, identity)
        store.dispatch(setChatStatus({ status: 'streaming', requestId: display.requestId, sessionId: display.sessionId, turnId: display.turnId }))
      }
    }
    if (display.lifecycle === 'completed' || display.lifecycle === 'failed') {
      // 终态 display 只是候选；先读取 canonical message，成功接管后才释放 running/queued 状态。
      if (typeof window.api.chatGetTurnTerminal !== 'function') return
      void window.api.chatGetTurnTerminal(display.turnId).then((terminal) => {
        if (!terminal || terminal.version < display.version || terminal.committedVersion === undefined || terminal.committedVersion < display.version) {
          if (terminal?.commitStatus === 'failed') {
            store.dispatch(setChatStatus({ status: 'error', error: 'TURN_CHECKPOINT_FAILED', requestId: null, sessionId: display.sessionId, turnId: display.turnId }))
            import('./turnDisplayStore').then(({ turnDisplayStore }) => turnDisplayStore.remove(display.turnId))
            return undefined
          }
          const attempt = terminalRetries.get(display.turnId) ?? 0
          terminalRetries.set(display.turnId, attempt + 1)
          void window.api.chatRetryTurnCheckpoint?.(display.turnId)
          window.setTimeout(() => { if (!disposed) applyDisplay({ display, retry: true }) }, Math.min(30_000, 100 * 2 ** Math.min(attempt, 8)))
          return undefined
        }
        return window.api.chatGetMessagePage({ sessionId: display.sessionId, limit: 60 })
      }).then((page) => {
        if (versions.get(display.turnId) !== display.version) return
        if (!page) return
        const message = page.entries.find((entry) => entry.message.id === display.message.id)?.message
        if (!message) {
          import('./turnDisplayStore').then(({ turnDisplayStore }) => turnDisplayStore.remove(display.turnId))
          return
        }
        routePatchMessage(display.sessionId, message.id, message)
        terminalRetries.delete(display.turnId)
        store.dispatch(setChatStatus({ status: display.outcome === 'failed' || display.outcome === 'timed-out' ? 'error' : 'completed', requestId: null, sessionId: display.sessionId, turnId: display.turnId }))
        import('./turnDisplayStore').then(({ turnDisplayStore }) => turnDisplayStore.remove(display.turnId))
      }).catch(() => {
        const attempt = terminalRetries.get(display.turnId) ?? 0
        terminalRetries.set(display.turnId, attempt + 1)
          window.setTimeout(() => { if (!disposed) applyDisplay({ display, retry: true }) }, Math.min(30_000, 250 * 2 ** Math.min(attempt, 8)))
      })
    }
  }
  const flushDisplays = (): void => {
    displayFrameHandle = undefined
    if (disposed) return
    const batch = [...pendingDisplays.values()]
    pendingDisplays.clear()
    for (const display of batch) applyDisplay({ display })
  }
  const enqueueDisplay = (display: import('../../shared/turnDisplayProtocol').TurnDisplay): void => {
    if (disposed) return
    if (typeof window.requestAnimationFrame !== 'function') {
      applyDisplay({ display })
      return
    }
    const previous = pendingDisplays.get(display.turnId)
    if (!previous || display.version > previous.version) pendingDisplays.set(display.turnId, display)
    if (displayFrameHandle === undefined) displayFrameHandle = window.requestAnimationFrame(flushDisplays)
  }
  const flush = (): void => {
    frameHandle = undefined
    if (disposed) return
    const batch = [...pending.values()]
    pending.clear()
    for (const payload of batch) apply(payload)
  }
  const enqueue = (payload: TurnProjectionPayload): void => {
    if (typeof window.requestAnimationFrame !== 'function') {
      apply(payload)
      return
    }
    pending.set(payload.turn.turnId, payload)
    if (frameHandle === undefined) frameHandle = window.requestAnimationFrame(flush)
  }
  const unsubscribe = typeof window.api.chatOnTurnDisplay === 'function'
    ? window.api.chatOnTurnDisplay(({ display }) => enqueueDisplay(display))
    : window.api.chatOnTurnProjection(enqueue)
  const reconciliationListener = (event: Event) => enqueueDisplay((event as CustomEvent<import('../../shared/turnDisplayProtocol').TurnDisplay>).detail)
  if (typeof window.addEventListener === 'function') window.addEventListener('spaceassistant:turn-display-reconcile', reconciliationListener)
  // 先订阅再请求 snapshot，避免 snapshot 调用期间同步到达的 projection event 丢失。
  // snapshot 可能落后于事件，统一由 turn version 去重/择新。
  if (typeof window.api.chatOnTurnDisplay !== 'function' && typeof window.api.chatListActiveTurns === 'function') {
    void window.api.chatListActiveTurns().then((turns) => {
      for (const turn of turns) enqueue({ turn, event: { type: 'snapshot' } })
    })
  }
  const unsubscribeUsage = typeof window.api.chatOnTurnUsage === 'function'
    ? window.api.chatOnTurnUsage(({ sessionId, usage, projected }) => applyProjectedUsage(sessionId, usage, projected))
    : () => undefined
  return () => {
    disposed = true
    pending.clear()
    pendingDisplays.clear()
    if (frameHandle !== undefined && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frameHandle)
    if (displayFrameHandle !== undefined && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(displayFrameHandle)
    unsubscribe()
    if (typeof window.removeEventListener === 'function') window.removeEventListener('spaceassistant:turn-display-reconcile', reconciliationListener)
    unsubscribeUsage()
  }
}
