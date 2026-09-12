import type { ChatImageAttachment, Message, ToolCallRecord } from './domainTypes'
import { appendProgressOutputRaw } from './terminalScrollback'

export type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'recovered'

/** prepare 时冻结的非敏感执行快照；API key、授权凭据和工具 permit 禁止进入该结构。 */
export type TurnExecutionConfig = {
  lane?: 'desktop' | 'feishu' | 'wechat'
  model?: string
  llmServiceId?: string
  baseUrl?: string
  system?: string
  maxTokens?: number
  enableThinking?: boolean
  locale?: string
  projectMemoryEnabled?: boolean
  effectiveModelForUsage?: string
}

export type TurnIntent =
  | { mode: 'create-user'; requestId: string; sessionId: string; input: { text: string; attachments?: ChatImageAttachment[] }; excludeMessageIds?: string[]; config: TurnExecutionConfig }
  | { mode: 'reuse-user'; requestId: string; sessionId: string; userMessageId: string; excludeMessageIds: string[]; config: TurnExecutionConfig }

export type TurnTerminal = {
  turnId: string; requestId: string; sessionId: string; assistantMessageId: string; version: number
  outcome: TurnOutcome; message: Message; usage?: unknown; error?: { code: string; message: string }
}

type AssistantFactEventPayload =
  | { type: 'content-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-use'; id: string; toolName: string; input: Record<string, unknown>; riskLevel?: ToolCallRecord['riskLevel'] }
  | { type: 'tool-progress'; id: string; seq: number; text: string; rawDelta?: string; rawEncoding?: string; processPid?: number; processGroupId?: number; processOwnerToken?: string }
  | {
      type: 'confirm-requested'
      id: string
      riskLevel: ToolCallRecord['riskLevel']
      confirmId?: string
      memoryTiers?: ToolCallRecord['memoryTiers']
      confirmDiff?: ToolCallRecord['confirmDiff']
      shellSecurityHints?: ToolCallRecord['shellSecurityHints']
      autoApproveFallback?: ToolCallRecord['autoApproveFallback']
      currentPageUrl?: ToolCallRecord['currentPageUrl']
      dangerInfo?: ToolCallRecord['dangerInfo']
      sessionTrustedHint?: true
      mcp?: ToolCallRecord['mcp']
    }
  | { type: 'tool-confirmed'; id: string; approved: boolean; reason?: string }
  | { type: 'tool-result'; id: string; result: NonNullable<ToolCallRecord['result']> }
  | { type: 'usage-updated'; usage: unknown; projected?: boolean }
  | { type: 'skill-hint'; text: string }
  | { type: 'source-completed' }
  | { type: 'source-failed' }
  | { type: 'source-cancelled' }
  | { type: 'source-timeout' }

export type AssistantFactEvent = AssistantFactEventPayload & { eventSeq?: number }

export type AssistantFactReducerDeps = { now: number; createId: () => string }

const terminal = (status: Message['status']) => status === 'completed' || status === 'failed'

export function reduceAssistantFact(state: Message, event: AssistantFactEvent, deps: AssistantFactReducerDeps): Message {
  if (terminal(state.status)) return state
  const next = { ...state }
  if (event.type === 'content-delta') {
    next.content += event.text
    const segments = [...(next.contentSegments ?? [])]
    const last = segments.at(-1)
    if (last && !last.endTime) segments[segments.length - 1] = { ...last, content: last.content + event.text }
    else segments.push({ content: event.text, startTime: deps.now })
    next.contentSegments = segments
  } else if (event.type === 'thinking-delta') {
    if (next.contentSegments) next.contentSegments = next.contentSegments.map((segment) => ({ ...segment, endTime: segment.endTime ?? deps.now }))
    const thinking = next.thinking ?? { content: '', isVisible: true, startTime: deps.now, segments: [] }
    const thinkingSegments = [...(thinking.segments ?? [])]
    const lastThinkingSegment = thinkingSegments.at(-1)
    if (lastThinkingSegment && !lastThinkingSegment.endTime) thinkingSegments[thinkingSegments.length - 1] = { ...lastThinkingSegment, content: lastThinkingSegment.content + event.text }
    else thinkingSegments.push({ content: event.text, startTime: deps.now })
    next.thinking = { ...thinking, content: thinking.content + event.text, segments: thinkingSegments }
  } else if (event.type === 'tool-use') {
    if (!(next.toolCalls ?? []).some((tool) => tool.id === event.id)) {
      // 首次工具调用是活动时间线的边界：关闭调用前开放的正文/Thinking segment，
      // 否则工具执行期间再次到达的 thinking 会沿用旧 startTime，被渲染到工具之前。
      closeSegments(next, deps.now)
      next.toolCalls = [...(next.toolCalls ?? []), { id: event.id, toolName: event.toolName, input: event.input, status: 'calling', riskLevel: event.riskLevel ?? 'low', startedAt: deps.now }]
    }
  } else if (event.type === 'tool-progress') {
    const processPid = event.processPid
    const validProcessPid = typeof processPid === 'number' && Number.isInteger(processPid) && processPid > 0 ? processPid : undefined
    const validProcessGroupId = typeof event.processGroupId === 'number' && Number.isInteger(event.processGroupId) && event.processGroupId > 0 ? event.processGroupId : undefined
    const validOwnerToken = typeof event.processOwnerToken === 'string' && event.processOwnerToken.length > 0 && event.processOwnerToken.length <= 256 ? event.processOwnerToken : undefined
    const rawDelta = typeof event.rawDelta === 'string' && event.rawDelta.length > 0 ? event.rawDelta : undefined
    // terminal 模式的 raw 增量不能当成明文进度（是 base64）：累加进 progressOutputRaw，
    // 并保留主进程下发的编码标签供终端回放使用。
    const progressFieldsFor = (tool: ToolCallRecord) =>
      rawDelta === undefined
        ? { progressOutput: event.text, progressOutputRaw: undefined, progressOutputRawLabel: undefined }
        : {
            progressOutput: undefined,
            progressOutputRaw: appendProgressOutputRaw(tool.progressOutputRaw, rawDelta),
            progressOutputRawLabel: typeof event.rawEncoding === 'string' && event.rawEncoding.length > 0 ? event.rawEncoding : undefined
          }
    next.toolCalls = next.toolCalls?.map((tool) => tool.id !== event.id || tool.status === 'completed' || tool.status === 'failed' || (tool.progressSeq ?? -1) >= event.seq ? tool : { ...tool, status: 'executing', ...progressFieldsFor(tool), progressSeq: event.seq, ...(validProcessPid === undefined ? {} : { processPid: validProcessPid }), ...(validProcessGroupId === undefined ? {} : { processGroupId: validProcessGroupId }), ...(validOwnerToken === undefined ? {} : { processOwnerToken: validOwnerToken }) })
  } else if (event.type === 'tool-result') {
    next.toolCalls = next.toolCalls?.map((tool) => tool.id !== event.id || terminalTool(tool.status) ? tool : { ...tool, result: event.result, status: event.result.success ? 'completed' : 'failed', completedAt: deps.now, duration: tool.startedAt == null ? undefined : deps.now - tool.startedAt })
  } else if (event.type === 'confirm-requested') {
    next.toolCalls = next.toolCalls?.map((tool) => tool.id === event.id && !terminalTool(tool.status)
      ? {
          ...tool,
          status: 'confirming',
          riskLevel: event.riskLevel,
          ...(event.memoryTiers ? { memoryTiers: event.memoryTiers } : {}),
          ...(event.confirmDiff ? { confirmDiff: event.confirmDiff } : {}),
          ...(event.shellSecurityHints ? { shellSecurityHints: event.shellSecurityHints } : {}),
          ...(event.autoApproveFallback ? { autoApproveFallback: event.autoApproveFallback } : {}),
          ...(event.currentPageUrl ? { currentPageUrl: event.currentPageUrl } : {}),
          ...(event.dangerInfo ? { dangerInfo: event.dangerInfo } : {}),
          ...(event.sessionTrustedHint ? { sessionTrustedHint: true as const } : {}),
          ...(event.mcp ? { mcp: event.mcp } : {})
        }
      : tool)
  } else if (event.type === 'tool-confirmed') {
    next.toolCalls = next.toolCalls?.map((tool) => tool.id === event.id && tool.status === 'confirming'
      ? event.approved
        ? { ...tool, status: 'executing', confirmedAt: deps.now }
        : { ...tool, status: 'rejected', completedAt: deps.now, ...(event.reason ? { rejectionReason: event.reason } : {}) }
      : tool)
  } else if (event.type === 'skill-hint') {
    next.skillHints = [...(next.skillHints ?? []), { id: deps.createId(), text: event.text, shownAt: deps.now }]
  } else if (event.type === 'usage-updated') {
    // usage 属于会话级投影数据，不改变 assistant message 本身。
  } else {
    closeSegments(next, deps.now)
    next.status = event.type === 'source-completed' ? 'completed' : 'failed'
  }
  return next
}

function terminalTool(status: ToolCallRecord['status']) { return status === 'completed' || status === 'failed' || status === 'rejected' }
function closeSegments(message: Message, now: number) {
  if (message.contentSegments) message.contentSegments = message.contentSegments.map((segment) => ({ ...segment, endTime: segment.endTime ?? now }))
  if (message.thinking) message.thinking = { ...message.thinking, endTime: message.thinking.endTime ?? now, segments: message.thinking.segments?.map((segment) => ({ ...segment, endTime: segment.endTime ?? now })) }
}
