import type { Message, ToolCallRecord } from '../../shared/domainTypes'
import type { PendingConfirmItem } from './pendingConfirmStore'

export type ToolsInteractiveScalars = {
  requestId: string
}

/** 切回会话时，DB 分页可能早于工具调用持久化；用 pending store 补回确认卡片节点。 */
export function restorePendingConfirmToolCalls(messages: Message[], pendingItems: PendingConfirmItem[]): Message[] {
  const bySession = new Map<string, PendingConfirmItem[]>()
  for (const item of pendingItems) bySession.set(item.sessionId, [...(bySession.get(item.sessionId) ?? []), item])
  const itemsByMessage = new Map<string, PendingConfirmItem[]>()
  for (const [sessionId, items] of bySession) {
    const candidates = messages.filter((message) => message.sessionId === sessionId && message.role === 'assistant')
    const fallback = [...candidates].reverse().find((message) => message.status === 'streaming') ?? candidates.at(-1)
    for (const item of items) {
      // toolUseId 是稳定身份：即使 DB 中状态仍是 executing/completed，也要在原气泡内修正。
      const existing = candidates.find((message) => message.toolCalls?.some((tool) => tool.id === item.toolUseId))
      const positioned = item.assistantMessageId
        ? candidates.find((message) => message.id === item.assistantMessageId)
        : undefined
      // 带有明确来源消息但该行尚未加载时，不把卡片错放到另一轮最新消息里。
      const target = positioned ?? existing ?? (item.assistantMessageId ? undefined : fallback)
      if (!target) continue
      itemsByMessage.set(target.id, [...(itemsByMessage.get(target.id) ?? []), item])
    }
  }

  return messages.map((message) => {
    const sessionItems = itemsByMessage.get(message.id)
    if (!sessionItems?.length) return message
    const existingCalls = [...(message.toolCalls ?? [])]
    const missing = sessionItems.filter((item) => !existingCalls.some((tool) => tool.id === item.toolUseId))
    const calls: ToolCallRecord[] = missing.map((item) => ({
      id: item.toolUseId,
      toolName: item.toolName,
      input:
        item.mcp?.maskedArgs ??
        (item.input && typeof item.input === 'object' && !Array.isArray(item.input)
          ? (item.input as Record<string, unknown>)
          : {}),
      status: 'confirming',
      riskLevel: item.riskLevel,
      ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
      ...(item.diff ? { confirmDiff: item.diff } : {}),
      ...(item.shellSecurityHints ? { shellSecurityHints: item.shellSecurityHints } : {}),
      ...(item.autoApproveFallback ? { autoApproveFallback: item.autoApproveFallback } : {}),
      ...(item.currentPageUrl ? { currentPageUrl: item.currentPageUrl } : {}),
      ...(item.dangerInfo ? { dangerInfo: item.dangerInfo } : {}),
      ...(item.sessionTrustedHint ? { sessionTrustedHint: item.sessionTrustedHint } : {}),
      ...(item.mcp
        ? {
            mcp: {
              serverId: item.mcp.serverId,
              serverName: item.mcp.serverName,
              originalToolName: item.mcp.originalToolName,
              description: item.mcp.description
            }
          }
      : {})
    }))
    for (const item of sessionItems) {
      const index = existingCalls.findIndex((tool) => tool.id === item.toolUseId)
      if (index >= 0 && existingCalls[index]!.status !== 'confirming') {
        existingCalls[index] = { ...existingCalls[index]!, status: 'confirming' }
      }
    }
    for (const item of missing.sort((a, b) => (b.toolIndex ?? Number.MAX_SAFE_INTEGER) - (a.toolIndex ?? Number.MAX_SAFE_INTEGER))) {
      const record = calls.find((candidate) => candidate.id === item.toolUseId)
      if (!record) continue
      const index = item.toolIndex === undefined ? existingCalls.length : Math.max(0, Math.min(item.toolIndex, existingCalls.length))
      existingCalls.splice(index, 0, record)
    }

    let activity = message.activity
    if (activity) {
      activity = [...activity]
      const missingActivity = sessionItems.filter((item) => !activity!.some((entry) => entry.kind === 'tool' && entry.toolId === item.toolUseId))
      for (const item of missingActivity.sort((a, b) => (b.activityIndex ?? Number.MAX_SAFE_INTEGER) - (a.activityIndex ?? Number.MAX_SAFE_INTEGER))) {
        const index = item.activityIndex === undefined ? activity.length : Math.max(0, Math.min(item.activityIndex, activity.length))
        activity.splice(index, 0, { kind: 'tool', toolId: item.toolUseId })
      }
    }
    return { ...message, toolCalls: existingCalls, ...(activity ? { activity } : {}) }
  })
}

export function messageHasConfirmingTool(message: Message | undefined): boolean {
  return Boolean(message?.toolCalls?.some((tc) => tc.status === 'confirming' && !tc.autoAnswerer))
}

export function messageHasExecutingTool(message: Message | undefined): boolean {
  return Boolean(message?.toolCalls?.some((tc) => tc.status === 'executing'))
}

function actionablePendingToolUseIds(
  sessionId: string,
  message: Message,
  pendingItems: PendingConfirmItem[]
): Set<string> {
  const toolIds = new Set(
    message.toolCalls?.filter((tool) => !tool.autoAnswerer).map((tool) => tool.id) ?? []
  )
  return new Set(
    pendingItems
      .filter((item) => item.sessionId === sessionId && toolIds.has(item.toolUseId))
      .map((item) => item.toolUseId)
  )
}

export function resolveRequestIdForConfirmingMessage(args: {
  sessionId: string
  message: Message
  pendingItems: PendingConfirmItem[]
  streamingAssistantId?: string
  streamingRequestId?: string | null
}): string | null {
  const { sessionId, message, pendingItems, streamingAssistantId, streamingRequestId } = args
  const pendingToolUseIds = actionablePendingToolUseIds(sessionId, message, pendingItems)
  if (!messageHasConfirmingTool(message) && !message.toolCalls?.some((tc) => pendingToolUseIds.has(tc.id))) return null

  for (const tc of message.toolCalls ?? []) {
    if (tc.autoAnswerer || (tc.status !== 'confirming' && !pendingToolUseIds.has(tc.id))) continue
    const pending = pendingItems.find((item) => item.sessionId === sessionId && item.toolUseId === tc.id)
    if (pending?.requestId) return pending.requestId
  }

  if (streamingRequestId && message.id === streamingAssistantId) {
    return streamingRequestId
  }

  // Active run still waiting on confirm but pending store missed IPC (race / index miss).
  if (streamingRequestId) {
    return streamingRequestId
  }

  return null
}

/**
 * 返回工具交互标量（无回调）。confirm/cancel 由 ChatMessageActions 提供。
 * confirming 或（当前流式助手上的）executing 消息可获得标量。
 */
export function resolveMessageToolsInteractive(args: {
  message: Message
  sessionId: string | null
  pendingItems: PendingConfirmItem[]
  streamingAssistantId?: string
  streamingRequestId?: string | null
}): ToolsInteractiveScalars | undefined {
  const {
    message,
    sessionId,
    pendingItems,
    streamingAssistantId,
    streamingRequestId
  } = args

  if (!sessionId) return undefined

  const pendingToolUseIds = actionablePendingToolUseIds(sessionId, message, pendingItems)
  const hasPendingTool = message.toolCalls?.some((tc) => pendingToolUseIds.has(tc.id)) ?? false

  if (messageHasConfirmingTool(message) || hasPendingTool) {
    const requestId = resolveRequestIdForConfirmingMessage({
      sessionId,
      message,
      pendingItems,
      streamingAssistantId,
      streamingRequestId
    })
    if (!requestId) return undefined
    return { requestId }
  }

  if (
    messageHasExecutingTool(message) &&
    streamingRequestId &&
    message.id === streamingAssistantId
  ) {
    return { requestId: streamingRequestId }
  }

  return undefined
}
