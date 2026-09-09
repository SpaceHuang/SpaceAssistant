import type { Message } from '../../shared/domainTypes'
import { DEFAULT_MAX_PARALLEL_CHAT_SESSIONS, clampMaxParallelChatSessions } from '../../shared/chatParallelConfig'
import { store } from '../store'
import { addMessage, patchMessage, removeRunningSession } from '../store/chatSlice'
import { pendingConfirmStore } from './pendingConfirmStore'
import {
  registerRunRequest,
  unregisterRunRequest,
  unregisterRunRequestsForSession
} from './runRequestIndex'
import {
  getApiContextOverlaySnapshot,
  routeAddApiContextMessageOptimistic,
  routePatchApiContextMessage
} from './apiContextService'

/** @deprecated 使用 getMaxParallelChatSessions()；保留常量供测试/默认值引用 */
export const MAX_PARALLEL_CHAT_SESSIONS = DEFAULT_MAX_PARALLEL_CHAT_SESSIONS

export function getMaxParallelChatSessions(): number {
  const raw = store.getState().config.config?.maxParallelChatSessions
  return clampMaxParallelChatSessions(raw ?? DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)
}

const liveBySession = new Map<string, Message[]>()

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

/** @deprecated timestamp 合并；展示/API 路径禁止使用。保留给测试兼容。 */
export function mergeDbAndLive(db: Message[], live?: Message[] | null): Message[] {
  return mergeMessagesByTimestamp(db, live)
}

/** timestamp 语义合并（非 DisplayOrder）。 */
export function mergeMessagesByTimestamp(db: Message[], live?: Message[] | null): Message[] {
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

/** live 快照缺失时从 Redux 当前会话消息种子化，避免 clearLiveSession 后只剩新消息。 */
function ensureLiveSession(sessionId: string): Message[] {
  let arr = liveBySession.get(sessionId)
  if (!arr) {
    const fromStore = store.getState().chat.messages.filter((m) => m.sessionId === sessionId)
    arr = cloneMessages(fromStore)
    liveBySession.set(sessionId, arr)
  }
  return arr
}

/** 合并 DB + Redux + live，供发送 LLM 请求时构建完整上下文。 */
export async function resolveSessionMessagesForApi(sessionId: string): Promise<Message[]> {
  const dbRows = await window.api.chatGetMessages({ sessionId })
  const fromStore = store.getState().chat.messages.filter((m) => m.sessionId === sessionId)
  const live = getLiveMessages(sessionId)
  return mergeDbAndLive(mergeDbAndLive(dbRows, fromStore), live)
}

/** 追加 live 快照；仅当用户正在查看该会话时同步 Redux；同步 API overlay。 */
export function routeAddMessage(sessionId: string, message: Message): void {
  const arr = ensureLiveSession(sessionId)
  arr.push({
    ...message,
    toolCalls: message.toolCalls ? message.toolCalls.map((t) => ({ ...t })) : undefined,
    skillHints: message.skillHints ? message.skillHints.map((h) => ({ ...h })) : undefined
  })
  liveBySession.set(sessionId, arr)
  if (store.getState().chat.currentSessionId === sessionId) {
    store.dispatch(addMessage(message))
  }
  const existing = getApiContextOverlaySnapshot(sessionId).find((e) => e.message.id === message.id)
  if (!existing) routeAddApiContextMessageOptimistic(message)
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

/** 更新 live；若当前正在查看该会话，则同步到 Redux messages；同步 API overlay。 */
export function routePatchMessage(sessionId: string, messageId: string, patch: Partial<Message>): void {
  patchLiveMessage(sessionId, messageId, patch)
  dispatchPatchToRedux(sessionId, messageId, patch)
  try {
    routePatchApiContextMessage(sessionId, messageId, patch)
  } catch {
    // overlay 可能尚未建立（历史消息仅存在于 DB）；忽略
  }
}

export function clearLiveSession(sessionId: string): void {
  liveBySession.delete(sessionId)
}

export function countRunningSessions(): number {
  return Object.keys(store.getState().chat.runningSessions).length
}

export function isSessionRunning(sessionId: string): boolean {
  return Boolean(store.getState().chat.runningSessions[sessionId])
}

export function registerSessionRun(sessionId: string, requestId: string, turnId?: string): void {
  registerRunRequest(sessionId, requestId, turnId)
}

export function finishSessionRun(sessionId: string, requestId: string, assistantMessageId?: string): void {
  // Core projection 已负责 assistant 的 checkpoint/finalize；结束运行索引不再触发 renderer DB flush。
  void sessionId
  void assistantMessageId
  pendingConfirmStore.removeAllForRequest(requestId)
  unregisterRunRequest(requestId)
}

export function abortSessionRun(sessionId: string): void {
  const meta = store.getState().chat.runningSessions[sessionId]
  if (meta) {
    if (meta.turnId) void window.api.chatCancelTurn(meta.turnId)
    unregisterRunRequest(meta.requestId)
  } else {
    unregisterRunRequestsForSession(sessionId)
  }
  pendingConfirmStore.rejectAllForSession(sessionId)
  clearLiveSession(sessionId)
  store.dispatch(removeRunningSession(sessionId))
}
