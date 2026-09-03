import type { FileConfirmMode, Message, ToolCallRecord } from '../../shared/domainTypes'
import type { PendingConfirmItem } from './pendingConfirmStore'

export type ToolsInteractiveScalars = {
  requestId: string
  confirmMode: FileConfirmMode
}

/** 切回会话时，DB 分页可能早于工具调用持久化；用 pending store 补回确认卡片节点。 */
export function restorePendingConfirmToolCalls(messages: Message[], pendingItems: PendingConfirmItem[]): Message[] {
  const bySession = new Map<string, PendingConfirmItem[]>()
  for (const item of pendingItems) bySession.set(item.sessionId, [...(bySession.get(item.sessionId) ?? []), item])
  const targetMessageIds = new Set<string>()
  for (const sessionId of bySession.keys()) {
    const candidates = messages.filter((message) => message.sessionId === sessionId && message.role === 'assistant')
    const target = [...candidates].reverse().find((message) => message.status === 'streaming') ?? candidates.at(-1)
    if (target) targetMessageIds.add(target.id)
  }
  return messages.map((message) => {
    const sessionItems = bySession.get(message.sessionId)
    if (!sessionItems?.length || !targetMessageIds.has(message.id)) return message
    const existingIds = new Set((message.toolCalls ?? []).map((tool) => tool.id))
    const missing = sessionItems.filter((item) => !existingIds.has(item.toolUseId))
    const hasStalePending = message.toolCalls?.some((tool) =>
      sessionItems.some((item) => item.toolUseId === tool.id) && tool.status !== 'confirming'
    ) ?? false
    if (missing.length === 0 && !hasStalePending) return message
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
    const existingCalls = (message.toolCalls ?? []).map((tool) =>
      sessionItems.some((item) => item.toolUseId === tool.id) && tool.status !== 'confirming'
        ? { ...tool, status: 'confirming' as const }
        : tool
    )
    return { ...message, toolCalls: [...existingCalls, ...calls] }
  })
}

export function messageHasConfirmingTool(message: Message | undefined): boolean {
  return Boolean(message?.toolCalls?.some((tc) => tc.status === 'confirming'))
}

export function messageHasExecutingTool(message: Message | undefined): boolean {
  return Boolean(message?.toolCalls?.some((tc) => tc.status === 'executing'))
}

export function resolveRequestIdForConfirmingMessage(args: {
  sessionId: string
  message: Message
  pendingItems: PendingConfirmItem[]
  streamingAssistantId?: string
  streamingRequestId?: string | null
}): string | null {
  const { sessionId, message, pendingItems, streamingAssistantId, streamingRequestId } = args
  const pendingToolUseIds = new Set(
    pendingItems.filter((item) => item.sessionId === sessionId).map((item) => item.toolUseId)
  )
  if (!messageHasConfirmingTool(message) && !message.toolCalls?.some((tc) => pendingToolUseIds.has(tc.id))) return null

  for (const tc of message.toolCalls ?? []) {
    if (tc.status !== 'confirming' && !pendingToolUseIds.has(tc.id)) continue
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
  toolsEnabled: boolean
  confirmMode: FileConfirmMode
  pendingItems: PendingConfirmItem[]
  streamingAssistantId?: string
  streamingRequestId?: string | null
}): ToolsInteractiveScalars | undefined {
  const {
    message,
    sessionId,
    toolsEnabled,
    confirmMode,
    pendingItems,
    streamingAssistantId,
    streamingRequestId
  } = args

  if (!sessionId || !toolsEnabled) return undefined

  const pendingToolUseIds = new Set(
    pendingItems.filter((item) => item.sessionId === sessionId).map((item) => item.toolUseId)
  )
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
    return { requestId, confirmMode }
  }

  if (
    messageHasExecutingTool(message) &&
    streamingRequestId &&
    message.id === streamingAssistantId
  ) {
    return { requestId: streamingRequestId, confirmMode }
  }

  return undefined
}
