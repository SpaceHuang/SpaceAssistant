import type { Message } from '../../shared/domainTypes'
import { DEFAULT_MAX_PARALLEL_CHAT_SESSIONS, clampMaxParallelChatSessions } from '../../shared/chatParallelConfig'
import { store } from '../store'
import { addMessage, patchMessage, removeRunningSession } from '../store/chatSlice'
import type { ToolChatController } from './chatToolSessionService'
import { pendingConfirmStore } from './pendingConfirmStore'
import { pendingWriteDirConfirmStore } from './pendingWriteDirConfirmStore'
import {
  registerRunRequest,
  unregisterRunRequest,
  unregisterRunRequestsForSession,
  resolveSessionIdForRequest
} from './runRequestIndex'

/** @deprecated 使用 getMaxParallelChatSessions()；保留常量供测试/默认值引用 */
export const MAX_PARALLEL_CHAT_SESSIONS = DEFAULT_MAX_PARALLEL_CHAT_SESSIONS

export function getMaxParallelChatSessions(): number {
  const raw = store.getState().config.config?.maxParallelChatSessions
  return clampMaxParallelChatSessions(raw ?? DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)
}

const STREAM_PERSIST_MS = 2000

const liveBySession = new Map<string, Message[]>()
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const persistPendingPatch = new Map<string, Partial<Message>>()
const pendingUiPatches = new Map<string, Partial<Message>>()
const uiFlushRafIds = new Map<string, number>()
/** 多会话并行时按 requestId 持有工具控制器，避免后启动会话覆盖先前者导致确认卡片失效 */
const toolControllersByRequestId = new Map<string, ToolChatController>()

function cloneMessages(msgs: Message[]): Message[] {
  return msgs.map((m) => ({
    ...m,
    toolCalls: m.toolCalls ? m.toolCalls.map((t) => ({ ...t })) : undefined,
    skillHints: m.skillHints ? m.skillHints.map((h) => ({ ...h })) : undefined
  }))
}

function persistKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`
}

/**
 * 将 DB 历史与内存中的 live 快照合并（同 id 以 live 为准），按时间戳排序。
 */
export function mergeDbAndLive(db: Message[], live?: Message[] | null): Message[] {
  if (!live?.length) return db
  const map = new Map<string, Message>()
  for (const m of db) map.set(m.id, m)
  for (const m of live) {
    map.set(m.id, {
      ...m,
      toolCalls: m.toolCalls ? m.toolCalls.map((t) => ({ ...t })) : undefined,
      skillHints: m.skillHints ? m.skillHints.map((h) => ({ ...h })) : undefined
    })
  }
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp)
}

export function initLiveSessionFromStore(sessionId: string): void {
  const fromStore = store.getState().chat.messages.filter((m) => m.sessionId === sessionId)
  const existing = liveBySession.get(sessionId)
  liveBySession.set(sessionId, cloneMessages(mergeDbAndLive(fromStore, existing)))
}

/** 追加 live 快照；仅当用户正在查看该会话时同步 Redux */
export function routeAddMessage(sessionId: string, message: Message): void {
  const arr = liveBySession.get(sessionId) ?? []
  arr.push({
    ...message,
    toolCalls: message.toolCalls ? message.toolCalls.map((t) => ({ ...t })) : undefined,
    skillHints: message.skillHints ? message.skillHints.map((h) => ({ ...h })) : undefined
  })
  liveBySession.set(sessionId, arr)
  if (store.getState().chat.currentSessionId === sessionId) {
    store.dispatch(addMessage(message))
  }
}

export function registerToolChatController(requestId: string, controller: ToolChatController): void {
  toolControllersByRequestId.set(requestId, controller)
}

export function unregisterToolChatController(requestId: string): void {
  toolControllersByRequestId.delete(requestId)
}

export function getToolChatController(requestId: string): ToolChatController | undefined {
  return toolControllersByRequestId.get(requestId)
}

export function resetLiveSessionMessages(sessionId: string, messages: Message[]): void {
  liveBySession.set(sessionId, cloneMessages(messages))
}

export function getLiveMessages(sessionId: string): Message[] | undefined {
  const x = liveBySession.get(sessionId)
  return x ? cloneMessages(x) : undefined
}

export function patchLiveMessage(sessionId: string, messageId: string, patch: Partial<Message>): void {
  const arr = liveBySession.get(sessionId)
  if (!arr) return
  const m = arr.find((x) => x.id === messageId)
  if (!m) return
  Object.assign(m, patch)
}

export function removeLiveMessage(sessionId: string, messageId: string): void {
  const arr = liveBySession.get(sessionId)
  if (!arr) return
  const idx = arr.findIndex((m) => m.id === messageId)
  if (idx >= 0) arr.splice(idx, 1)
}

function dispatchPatchToRedux(sessionId: string, messageId: string, patch: Partial<Message>): void {
  if (store.getState().chat.currentSessionId === sessionId) {
    store.dispatch(patchMessage({ id: messageId, patch }))
  }
}

function flushUiPatchToRedux(sessionId: string, messageId: string): void {
  const key = persistKey(sessionId, messageId)
  const rafId = uiFlushRafIds.get(key)
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId)
    uiFlushRafIds.delete(key)
  }
  const merged = pendingUiPatches.get(key)
  pendingUiPatches.delete(key)
  if (merged) {
    dispatchPatchToRedux(sessionId, messageId, merged)
  }
}

/** 立即将 pending 流式 UI patch flush 到 Redux（onDone / cancel / error 前调用） */
export function flushUiPatch(sessionId: string, messageId: string): void {
  flushUiPatchToRedux(sessionId, messageId)
}

function scheduleUiFlush(sessionId: string, messageId: string): void {
  if (store.getState().chat.currentSessionId !== sessionId) return
  const key = persistKey(sessionId, messageId)
  if (uiFlushRafIds.has(key)) return
  const rafId = requestAnimationFrame(() => {
    uiFlushRafIds.delete(key)
    const merged = pendingUiPatches.get(key)
    pendingUiPatches.delete(key)
    if (merged) {
      dispatchPatchToRedux(sessionId, messageId, merged)
    }
  })
  uiFlushRafIds.set(key, rafId)
}

/** 更新 live；若当前正在查看该会话，则同步到 Redux messages */
export function routePatchMessage(sessionId: string, messageId: string, patch: Partial<Message>): void {
  patchLiveMessage(sessionId, messageId, patch)
  dispatchPatchToRedux(sessionId, messageId, patch)
}

/** 流式增量：live 立即更新，Redux rAF 合并，DB 2s 节流 */
export function routeStreamPatchMessage(sessionId: string, messageId: string, patch: Partial<Message>): void {
  patchLiveMessage(sessionId, messageId, patch)
  const key = persistKey(sessionId, messageId)
  const prev = pendingUiPatches.get(key) ?? {}
  pendingUiPatches.set(key, { ...prev, ...patch })
  scheduleUiFlush(sessionId, messageId)
  scheduleThrottledPersist(sessionId, messageId, patch)
}

function scheduleThrottledPersist(sessionId: string, messageId: string, patch: Partial<Message>): void {
  const key = persistKey(sessionId, messageId)
  const prev = persistPendingPatch.get(key) ?? {}
  persistPendingPatch.set(key, { ...prev, ...patch })

  const existing = persistTimers.get(key)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    persistTimers.delete(key)
    const merged = persistPendingPatch.get(key)
    persistPendingPatch.delete(key)
    if (!merged) return
    void window.api.chatPatchMessage({
      messageId,
      sessionId,
      patch: merged
    })
  }, STREAM_PERSIST_MS)

  persistTimers.set(key, timer)
}

export function flushStreamPersist(sessionId: string, messageId: string): void {
  const key = persistKey(sessionId, messageId)
  const timer = persistTimers.get(key)
  if (timer) clearTimeout(timer)
  persistTimers.delete(key)
  const merged = persistPendingPatch.get(key)
  persistPendingPatch.delete(key)
  if (merged) {
    void window.api.chatPatchMessage({ messageId, sessionId, patch: merged })
  }
}

export function clearLiveSession(sessionId: string): void {
  liveBySession.delete(sessionId)
  for (const key of [...persistTimers.keys()]) {
    if (key.startsWith(`${sessionId}:`)) {
      clearTimeout(persistTimers.get(key))
      persistTimers.delete(key)
      persistPendingPatch.delete(key)
    }
  }
  for (const key of [...pendingUiPatches.keys()]) {
    if (key.startsWith(`${sessionId}:`)) {
      const rafId = uiFlushRafIds.get(key)
      if (rafId !== undefined) cancelAnimationFrame(rafId)
      uiFlushRafIds.delete(key)
      pendingUiPatches.delete(key)
    }
  }
}

export function countRunningSessions(): number {
  return Object.keys(store.getState().chat.runningSessions).length
}

export function isSessionRunning(sessionId: string): boolean {
  return Boolean(store.getState().chat.runningSessions[sessionId])
}

export function registerSessionRun(sessionId: string, requestId: string): void {
  registerRunRequest(sessionId, requestId)
}

export function finishSessionRun(sessionId: string, requestId: string, assistantMessageId?: string): void {
  if (assistantMessageId) {
    flushUiPatch(sessionId, assistantMessageId)
    flushStreamPersist(sessionId, assistantMessageId)
  }
  unregisterToolChatController(requestId)
  pendingConfirmStore.removeAllForRequest(requestId)
  pendingWriteDirConfirmStore.removeAllForRequest(requestId)
  unregisterRunRequest(requestId)
}

export function abortSessionRun(sessionId: string): void {
  const meta = store.getState().chat.runningSessions[sessionId]
  if (meta) {
    void window.api.claudeChatCancel({ requestId: meta.requestId })
    unregisterToolChatController(meta.requestId)
    unregisterRunRequest(meta.requestId)
  } else {
    for (const requestId of toolControllersByRequestId.keys()) {
      if (resolveSessionIdForRequest(requestId) === sessionId) {
        unregisterToolChatController(requestId)
      }
    }
    unregisterRunRequestsForSession(sessionId)
  }
  pendingConfirmStore.rejectAllForSession(sessionId)
  clearLiveSession(sessionId)
  store.dispatch(removeRunningSession(sessionId))
}
