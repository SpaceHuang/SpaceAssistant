import type { Message } from '../../shared/domainTypes'
import {
  compareDisplayOrder,
  type ApiContextBaseline,
  type ApiContextEntry,
  type ApiContextRequest,
  type DisplayOrder,
  type PersistedMessageAck
} from '../../shared/displayOrder'
import { filterMessagesForChatApi, isMessageEligibleForChatApi } from '../../shared/chatMessageQueue'

export class ApiContextInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiContextInvariantError'
  }
}

type ApiContextSessionState = {
  generation: number
  nextOptimisticOrdinal: number
  overlayById: Map<string, ApiContextEntry>
}

const sessions = new Map<string, ApiContextSessionState>()

/** 测试用：清空全部 API overlay 状态 */
export function resetApiContextServiceForTest(): void {
  sessions.clear()
}

function ensureSession(sessionId: string): ApiContextSessionState {
  let state = sessions.get(sessionId)
  if (!state) {
    state = {
      generation: 1,
      nextOptimisticOrdinal: 0,
      overlayById: new Map()
    }
    sessions.set(sessionId, state)
  }
  return state
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    toolCalls: message.toolCalls ? message.toolCalls.map((t) => ({ ...t })) : undefined,
    skillHints: message.skillHints ? message.skillHints.map((h) => ({ ...h })) : undefined,
    contentSegments: message.contentSegments ? message.contentSegments.map((s) => ({ ...s })) : undefined,
    attachments: message.attachments ? [...message.attachments] : undefined
  }
}

export function bumpApiContextGeneration(sessionId: string): number {
  const state = ensureSession(sessionId)
  state.generation += 1
  state.overlayById.clear()
  state.nextOptimisticOrdinal = 0
  return state.generation
}

/** 会话切换时增加 generation；不清除仍在运行会话的 overlay（由调用方选择是否 bump）。 */
export function getApiContextGeneration(sessionId: string): number {
  return ensureSession(sessionId).generation
}

export function routeAddApiContextMessage(entry: ApiContextEntry): void {
  const state = ensureSession(entry.message.sessionId)
  let order = entry.order
  if (order.kind === 'optimistic' && order.ordinal < 0) {
    order = { kind: 'optimistic', ordinal: state.nextOptimisticOrdinal++ }
  } else if (order.kind === 'optimistic') {
    state.nextOptimisticOrdinal = Math.max(state.nextOptimisticOrdinal, order.ordinal + 1)
  }
  state.overlayById.set(entry.message.id, {
    message: cloneMessage(entry.message),
    order
  })
}

export function routeAddApiContextMessageOptimistic(message: Message): ApiContextEntry {
  const state = ensureSession(message.sessionId)
  const entry: ApiContextEntry = {
    message: cloneMessage(message),
    order: { kind: 'optimistic', ordinal: state.nextOptimisticOrdinal++ }
  }
  state.overlayById.set(message.id, entry)
  return entry
}

export function ackApiContextMessagePersisted(ack: PersistedMessageAck, sessionId: string): void {
  const state = sessions.get(sessionId)
  if (!state) return
  const existing = state.overlayById.get(ack.messageId)
  if (!existing) {
    throw new ApiContextInvariantError(`ack for unknown overlay message ${ack.messageId}`)
  }
  state.overlayById.set(ack.messageId, {
    message: existing.message,
    order: { kind: 'persisted', sequence: ack.sequence }
  })
}

export function routePatchApiContextMessage(
  sessionId: string,
  messageId: string,
  patch: Partial<Message>
): void {
  const state = sessions.get(sessionId)
  if (!state) {
    throw new ApiContextInvariantError(`routePatchApiContextMessage: no session overlay for ${sessionId}`)
  }
  const existing = state.overlayById.get(messageId)
  if (!existing) {
    throw new ApiContextInvariantError(`routePatchApiContextMessage: missing overlay ${messageId}`)
  }
  state.overlayById.set(messageId, {
    order: existing.order,
    message: cloneMessage({ ...existing.message, ...patch, id: messageId, sessionId })
  })
}

export function removeApiContextMessage(sessionId: string, messageId: string): void {
  sessions.get(sessionId)?.overlayById.delete(messageId)
}

export function getApiContextOverlaySnapshot(sessionId: string): ApiContextEntry[] {
  const state = sessions.get(sessionId)
  if (!state) return []
  return [...state.overlayById.values()].map((e) => ({
    message: cloneMessage(e.message),
    order: e.order
  }))
}

export function mergeApiContextBaselineWithOverlay(
  baseline: ApiContextBaseline,
  overlay: ApiContextEntry[]
): ApiContextEntry[] {
  const byId = new Map<string, ApiContextEntry>()
  for (const entry of baseline.entries) {
    byId.set(entry.message.id, {
      message: cloneMessage(entry.message),
      order: { kind: 'persisted', sequence: entry.sequence }
    })
  }
  for (const entry of overlay) {
    const prev = byId.get(entry.message.id)
    if (prev && prev.order.kind === 'persisted' && entry.order.kind === 'optimistic') {
      // overlay 完整消息覆盖，保留 persisted sequence
      byId.set(entry.message.id, {
        message: cloneMessage(entry.message),
        order: prev.order
      })
    } else if (prev && prev.order.kind === 'persisted' && entry.order.kind === 'persisted') {
      byId.set(entry.message.id, {
        message: cloneMessage(entry.message),
        order: entry.order
      })
    } else {
      byId.set(entry.message.id, {
        message: cloneMessage(entry.message),
        order: entry.order
      })
    }
  }
  return [...byId.values()].sort((a, b) => compareDisplayOrder(a.order, b.order))
}

export function buildHistoryForApiFromEntries(
  entries: ApiContextEntry[],
  request: ApiContextRequest
): Message[] {
  let merged = entries
  if (request.excludeMessageIds?.length) {
    const exclude = new Set(request.excludeMessageIds)
    merged = merged.filter((e) => !exclude.has(e.message.id))
  }
  merged = merged.filter((e) => e.message.id !== request.requiredCurrentUser.message.id)
  merged = [
    ...merged,
    {
      message: cloneMessage(request.requiredCurrentUser.message),
      order: request.requiredCurrentUser.order
    }
  ]
  merged.sort((a, b) => compareDisplayOrder(a.order, b.order))

  const required = request.requiredCurrentUser.message
  if (required.role !== 'user' || required.status !== 'sent') {
    throw new ApiContextInvariantError('requiredCurrentUser must be role=user status=sent')
  }

  const historyForApi = filterMessagesForChatApi(merged.map((e) => e.message))
  const requiredCount = historyForApi.filter((m) => m.id === required.id).length
  if (requiredCount !== 1) {
    throw new ApiContextInvariantError(
      `requiredCurrentUser must appear exactly once after filter, got ${requiredCount}`
    )
  }
  if (!isMessageEligibleForChatApi(required)) {
    throw new ApiContextInvariantError('requiredCurrentUser is not eligible for chat API')
  }
  return historyForApi
}

/**
 * 解析发送用 API 上下文。baselineFetcher 由调用方注入（便于单测）；
 * 生产路径使用 window.api.chatGetApiContextBaseline。
 */
export async function resolveSessionContextForApi(
  request: ApiContextRequest,
  baselineFetcher: (sessionId: string) => Promise<ApiContextBaseline> = defaultBaselineFetcher
): Promise<{ historyForApi: Message[]; requiredCurrentUserId: string }> {
  const state = ensureSession(request.sessionId)
  const generationAtStart = state.generation
  const baseline = await baselineFetcher(request.sessionId)
  if (ensureSession(request.sessionId).generation !== generationAtStart) {
    throw new ApiContextInvariantError('api context generation changed during baseline fetch')
  }
  const overlay = getApiContextOverlaySnapshot(request.sessionId)
  const merged = mergeApiContextBaselineWithOverlay(baseline, overlay)
  const historyForApi = buildHistoryForApiFromEntries(merged, request)
  return {
    historyForApi,
    requiredCurrentUserId: request.requiredCurrentUser.message.id
  }
}

async function defaultBaselineFetcher(sessionId: string): Promise<ApiContextBaseline> {
  return window.api.chatGetApiContextBaseline({ sessionId })
}

/** 非当前、非运行会话可淘汰 overlay（由编排层调用）。 */
export function evictApiContextSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export type { DisplayOrder }
