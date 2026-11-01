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
import { removeContextSummaryMessage, summarizeContextMessage, upsertContextSummaryOverride } from './contextHistorySummaryService'

/** @deprecated 使用 getMaxParallelChatSessions()；保留常量供测试/默认值引用 */
export const MAX_PARALLEL_CHAT_SESSIONS = DEFAULT_MAX_PARALLEL_CHAT_SESSIONS

export function getMaxParallelChatSessions(): number {
  const raw = store.getState().config.config?.maxParallelChatSessions
  return clampMaxParallelChatSessions(raw ?? DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)
}

const liveBySession = new Map<string, Message[]>()
const contextSummaryOrdinalBySession = new Map<string, number>()

function nextContextSummaryOrdinal(sessionId: string): number {
  const next = (contextSummaryOrdinalBySession.get(sessionId) ?? 0) + 1
  contextSummaryOrdinalBySession.set(sessionId, next)
  return next
}

function cloneMessages(msgs: Message[]): Message[] {
  return msgs.map((m) => ({
    ...m,
    toolCalls: m.toolCalls ? m.toolCalls.map((t) => ({ ...t })) : undefined,
    skillHints: m.skillHints ? m.skillHints.map((h) => ({ ...h })) : undefined
  }))
}

export function initLiveSessionFromStore(sessionId: string): void {
  // Historical rows belong to the display/query store. The live map tracks only
  // events that arrive during or after a turn, so session selection stays O(1).
  if (!liveBySession.has(sessionId)) liveBySession.set(sessionId, [])
}

/** live 快照缺失时只创建增量列表，不再从 Redux 克隆整段历史。 */
function ensureLiveSession(sessionId: string): Message[] {
  let arr = liveBySession.get(sessionId)
  if (!arr) {
    arr = []
    liveBySession.set(sessionId, arr)
  }
  return arr
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
  upsertContextSummaryOverride(sessionId, summarizeContextMessage(message,
    { kind: 'optimistic', ordinal: nextContextSummaryOrdinal(sessionId) }))
  if (store.getState().chat.currentSessionId === sessionId) {
    store.dispatch(addMessage(message))
  }
  const existing = getApiContextOverlaySnapshot(sessionId).find((e) => e.message.id === message.id)
  if (!existing) routeAddApiContextMessageOptimistic(message)
}

export function resetLiveSessionMessages(sessionId: string, messages: Message[]): void {
  // Compatibility helper for callers that explicitly reset live data; history is no longer seeded.
  const live = messages.filter((message) => message.status === 'streaming' || message.status === 'queued')
  liveBySession.set(sessionId, cloneMessages(live))
  for (const message of live) upsertContextSummaryOverride(sessionId, summarizeContextMessage(message,
    { kind: 'optimistic', ordinal: nextContextSummaryOrdinal(sessionId) }))
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
  removeContextSummaryMessage(sessionId, messageId)
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
  if ('thinking' in patch || 'attachments' in patch || 'role' in patch) {
    const message = liveBySession.get(sessionId)?.find((item) => item.id === messageId) ??
      store.getState().chat.messages.find((item) => item.id === messageId)
    if (message) upsertContextSummaryOverride(sessionId, summarizeContextMessage(message,
      { kind: 'optimistic', ordinal: nextContextSummaryOrdinal(sessionId) }))
  }
  try {
    routePatchApiContextMessage(sessionId, messageId, patch)
  } catch {
    // overlay 可能尚未建立（历史消息仅存在于 DB）；忽略
  }
}

export function clearLiveSession(sessionId: string): void {
  liveBySession.delete(sessionId)
}

function findRunningAssistantMessage(sessionId: string): Message | undefined {
  const liveAssistant = [...(liveBySession.get(sessionId) ?? [])].reverse().find((message) =>
    message.role === 'assistant' && message.status === 'streaming'
  )
  const storedAssistant = [...store.getState().chat.messages].reverse().find((message) =>
    message.sessionId === sessionId && message.role === 'assistant' && message.status === 'streaming'
  )
  return liveAssistant ?? storedAssistant
}

function settleAbortedAssistantMessage(sessionId: string, assistant: Message | undefined): void {
  if (!assistant) return
  routePatchMessage(sessionId, assistant.id, {
    status: 'cancelled',
    ...(assistant.toolCalls
      ? { toolCalls: assistant.toolCalls.map((tool) => tool.status === 'confirming' ? { ...tool, status: 'failed' as const } : tool) }
      : {})
  })
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
  void assistantMessageId
  pendingConfirmStore.removeAllForRequest(requestId, sessionId)
  unregisterRunRequest(requestId, sessionId)
}

/** 中止会话运行：IPC 受理结果与本地止血解耦——先同步发起取消并完成本地清理
 *（按钮立即消失，不被 IPC 返回拖延），再等受理结果。返回取消是否被主进程接受
 *（turn 不存在或 IPC 失败时为 false），供列表按钮区分「已中止」与「任务已结束」。 */
export async function abortSessionRun(sessionId: string): Promise<boolean> {
  const meta = store.getState().chat.runningSessions[sessionId]
  const activeAssistant = meta ? findRunningAssistantMessage(sessionId) : undefined
  const cancelPromise = meta?.turnId
    ? Promise.resolve(window.api.chatCancelTurn(meta.turnId)).catch(() => false)
    : Promise.resolve(false)
  if (meta) unregisterRunRequest(meta.requestId, sessionId)
  else unregisterRunRequestsForSession(sessionId)
  pendingConfirmStore.rejectAllForSession(sessionId)
  clearLiveSession(sessionId)
  store.dispatch(removeRunningSession(sessionId))
  const accepted = meta ? await cancelPromise : false
  if (accepted) settleAbortedAssistantMessage(sessionId, activeAssistant)
  return accepted
}
