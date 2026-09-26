import type { ChatImageAttachment, Message, ToolCallRecord } from './domainTypes'
import { appendProgressOutputRaw } from './terminalScrollback'

export type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'recovered'

/** prepare 时冻结的非敏感执行快照；API key、授权凭据和工具 permit 禁止进入该结构。 */
export type TurnExecutionConfig = {
  lane?: 'desktop' | 'feishu' | 'wechat' | 'automation'
  model?: string
  maximumContext?: number
  maximumContextTrusted?: boolean
  llmServiceId?: string
  system?: string
  skillFragments?: string[]
  maxTokens?: number
  /** Thinking 强度最终档位（发起时解析、调用内冻结）；远程 / Butler lane 恒 off（OQ-10） */
  thinkingEffort?: import('./agent/invocation').AgentReasoningEffort
  /**
   * 能力降级前的请求档位（评审 B1）：仅当模型 supportsThinking === false 导致降级时产出（≠ thinkingEffort）。
   * 主链路把它作为装配器 effort 入参，装配层照旧落 agent.profile.reasoning_degraded 并写 degraded 字段。
   */
  requestedThinkingEffort?: import('./agent/invocation').AgentReasoningEffort
  /** @deprecated 由 thinkingEffort 派生（≠off 即 true），保留一个发布周期做兼容映射 */
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
  outcome: TurnOutcome; message: Message; commitStatus?: 'pending' | 'committed' | 'failed'; usage?: unknown; error?: { code: string; message: string }
}

type AssistantFactEventPayload =
  | { type: 'content-delta'; text: string }
  | { type: 'preview-rollback' }
  | { type: 'preview-commit' }
  | { type: 'content-reconciled'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-reconciled'; text: string }
  | { type: 'tool-use'; id: string; toolName: string; input: Record<string, unknown>; riskLevel?: ToolCallRecord['riskLevel']; mcp?: ToolCallRecord['mcp'] }
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
      /**
       * H1：agent 裁决路径（AgentChannel）——渲染端据此出只读「自动审批中」卡，无交互按钮。
       * §5.8：放宽为 boolean 以支持回退分支显式清除（条件写入清不掉旧值）。
       */
      autoAnswerer?: boolean
    }
  | {
      type: 'approval-updated'
      id: string
      approval: import('../../packages/agent-core/src/approval').ApprovalRecord
    }
  | { type: 'tool-confirmed'; id: string; approved: boolean; reason?: string }
  | { type: 'tool-result'; id: string; result: NonNullable<ToolCallRecord['result']> }
  | { type: 'usage-updated'; usage: unknown; projected?: boolean }
  | { type: 'context-projection-updated'; projection: import('./contextMeter').ContextPressureProjection }
  | { type: 'compaction-committed'; compactionId: string; windowId: string; outputSurfaceFingerprint: string }
  | { type: 'skill-hint'; text: string }
  | { type: 'source-completed' }
  /** message：失败原因（诊断文本），随事实透出到渲染层，避免只剩一句「回复未能完成」 */
  | { type: 'source-failed'; message?: string }
  | { type: 'source-cancelled' }
  | { type: 'source-timeout' }

export type AssistantFactEvent = AssistantFactEventPayload & { eventSeq?: number }

export type AssistantFactReducerDeps = { now: number; createId: () => string }

const terminal = (status: Message['status']) => status === 'completed' || status === 'failed' || status === 'cancelled'

/** 持久化活动 turn 时剥离尚未接受的流式预览，只写最后一个已提交前缀。 */
export function acceptedAssistantCheckpoint(message: Message): Message {
  const snapshot = (message as Message & { _provisionalSnapshot?: { content: string; contentSegments?: Message['contentSegments']; thinking?: Message['thinking'] } })._provisionalSnapshot
  if (!snapshot) return message
  const { _provisionalSnapshot: _discarded, ...accepted } = message as Message & { _provisionalSnapshot?: unknown }
  void _discarded
  return {
    ...accepted,
    content: snapshot.content,
    contentSegments: snapshot.contentSegments?.map((segment) => ({ ...segment })),
    thinking: snapshot.thinking ? { ...snapshot.thinking, segments: snapshot.thinking.segments?.map((segment) => ({ ...segment })) } : undefined
  }
}

function restoreProvisionalSnapshot(message: Message): Message {
  const snapshot = (message as Message & { _provisionalSnapshot?: { content: string; contentSegments?: Message['contentSegments']; thinking?: Message['thinking'] } })._provisionalSnapshot
  if (!snapshot) return message
  return {
    ...message,
    content: snapshot.content,
    contentSegments: snapshot.contentSegments?.map((segment) => ({ ...segment })),
    thinking: snapshot.thinking ? { ...snapshot.thinking, segments: snapshot.thinking.segments?.map((segment) => ({ ...segment })) } : undefined
  }
}

export function reduceAssistantFact(state: Message, event: AssistantFactEvent, deps: AssistantFactReducerDeps): Message {
  if (terminal(state.status)) return state
  const next = { ...state }
  if (event.type === 'preview-rollback') {
    Object.assign(next, restoreProvisionalSnapshot(state))
    delete (next as Message & { _provisionalSnapshot?: unknown })._provisionalSnapshot
  } else if (event.type === 'preview-commit') {
    delete (next as Message & { _provisionalSnapshot?: unknown })._provisionalSnapshot
  } else if (event.type === 'content-delta') {
    if (!(next as Message & { _provisionalSnapshot?: unknown })._provisionalSnapshot) {
      (next as Message & { _provisionalSnapshot?: unknown })._provisionalSnapshot = {
        content: state.content,
        contentSegments: state.contentSegments?.map((segment) => ({ ...segment })),
        thinking: state.thinking ? { ...state.thinking, segments: state.thinking.segments?.map((segment) => ({ ...segment })) } : undefined
      }
    }
    next.content += event.text
    const segments = [...(next.contentSegments ?? [])]
    const last = segments.at(-1)
    if (last && !last.endTime) segments[segments.length - 1] = { ...last, content: last.content + event.text }
    else segments.push({ content: event.text, startTime: deps.now })
    next.contentSegments = segments
  } else if (event.type === 'content-reconciled') {
    next.content = event.text
    const commonPrefixLength = (() => {
      const limit = Math.min(state.content.length, event.text.length)
      let index = 0
      while (index < limit && state.content[index] === event.text[index]) index += 1
      return index
    })()
    if (commonPrefixLength === event.text.length && event.text === state.content) {
      // Final provider reconciliation agrees with the streamed ledger; retain the original
      // segment timestamps so earlier text stays before tool activity in replay.
    } else if (commonPrefixLength > 0 && state.contentSegments?.length) {
      let remaining = commonPrefixLength
      const segments: NonNullable<Message['contentSegments']> = []
      for (const segment of state.contentSegments) {
        if (remaining <= 0) break
        const content = segment.content.slice(0, remaining)
        if (content) segments.push({ ...segment, content })
        remaining -= content.length
      }
      if (remaining === 0) {
        const suffix = event.text.slice(commonPrefixLength)
        if (suffix) segments.push({ content: suffix, startTime: deps.now, endTime: deps.now })
        next.contentSegments = segments
      } else {
        next.contentSegments = event.text.length > 0 ? [{ content: event.text, startTime: deps.now, endTime: deps.now }] : []
      }
    } else {
      next.contentSegments = event.text.length > 0 ? [{ content: event.text, startTime: deps.now, endTime: deps.now }] : []
    }
    delete (next as Message & { _provisionalSnapshot?: unknown })._provisionalSnapshot
  } else if (event.type === 'thinking-delta') {
    if (!(next as Message & { _provisionalSnapshot?: unknown })._provisionalSnapshot) {
      (next as Message & { _provisionalSnapshot?: unknown })._provisionalSnapshot = {
        content: state.content,
        contentSegments: state.contentSegments?.map((segment) => ({ ...segment })),
        thinking: state.thinking ? { ...state.thinking, segments: state.thinking.segments?.map((segment) => ({ ...segment })) } : undefined
      }
    }
    if (next.contentSegments) next.contentSegments = next.contentSegments.map((segment) => ({ ...segment, endTime: segment.endTime ?? deps.now }))
    const thinking = next.thinking ?? { content: '', isVisible: true, startTime: deps.now, segments: [] }
    const thinkingSegments = [...(thinking.segments ?? [])]
    const lastThinkingSegment = thinkingSegments.at(-1)
    if (lastThinkingSegment && !lastThinkingSegment.endTime) thinkingSegments[thinkingSegments.length - 1] = { ...lastThinkingSegment, content: lastThinkingSegment.content + event.text }
    else thinkingSegments.push({ content: event.text, startTime: deps.now })
    next.thinking = { ...thinking, content: thinking.content + event.text, segments: thinkingSegments }
  } else if (event.type === 'thinking-reconciled') {
    next.thinking = event.text.length > 0
      ? { content: event.text, isVisible: true, startTime: deps.now, segments: [{ content: event.text, startTime: deps.now, endTime: deps.now }] }
      : undefined
  } else if (event.type === 'tool-use') {
    if (!(next.toolCalls ?? []).some((tool) => tool.id === event.id)) {
      // 首次工具调用是活动时间线的边界：关闭调用前开放的正文/Thinking segment，
      // 否则工具执行期间再次到达的 thinking 会沿用旧 startTime，被渲染到工具之前。
      closeSegments(next, deps.now)
      next.toolCalls = [...(next.toolCalls ?? []), { id: event.id, toolName: event.toolName, input: event.input, status: 'calling', riskLevel: event.riskLevel ?? 'low', startedAt: deps.now, ...(event.mcp ? { mcp: event.mcp } : {}) }]
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
          ...(event.mcp ? { mcp: event.mcp } : {}),
          ...(event.autoAnswerer !== undefined ? { autoAnswerer: event.autoAnswerer } : {})
        }
          : tool)
  } else if (event.type === 'approval-updated') {
    const notExecutedReason = approvalNotExecutedReason(event.approval.status, event.approval.cause)
    next.toolCalls = next.toolCalls?.map((tool) => tool.id !== event.id ? tool : {
      ...tool,
      approval: event.approval,
      ...(event.approval.status === 'approved' ? { status: 'executing', confirmedAt: deps.now } : {}),
      ...(event.approval.status === 'denied' || event.approval.status === 'unavailable' || event.approval.status === 'timed-out' || event.approval.status === 'cancelled'
        ? {
            status: 'rejected', completedAt: deps.now,
            result: { success: false, notExecuted: true, notExecutedReason },
            ...(event.approval.reason?.summary ? { rejectionReason: event.approval.reason.summary } : {})
          }
        : {})
    })
  } else if (event.type === 'tool-confirmed') {
    next.toolCalls = next.toolCalls?.map((tool) => tool.id === event.id && tool.status === 'confirming'
      ? event.approved
        ? { ...tool, status: 'executing', confirmedAt: deps.now }
        : { ...tool, status: 'rejected', completedAt: deps.now, ...(event.reason ? { rejectionReason: event.reason } : {}) }
      : tool)
  } else if (event.type === 'skill-hint') {
    next.skillHints = [...(next.skillHints ?? []), { id: deps.createId(), text: event.text, shownAt: deps.now }]
  } else if (event.type === 'usage-updated' || event.type === 'context-projection-updated' || event.type === 'compaction-committed') {
    // usage 属于会话级投影数据，不改变 assistant message 本身。
  } else {
    if (event.type === 'source-cancelled' || event.type === 'source-timeout' || event.type === 'source-failed') {
      Object.assign(next, restoreProvisionalSnapshot(state))
    }
    closeSegments(next, deps.now)
    delete (next as Message & { _provisionalSnapshot?: unknown })._provisionalSnapshot
    next.status = event.type === 'source-completed' ? 'completed' : event.type === 'source-cancelled' ? 'cancelled' : 'failed'
  }
  return next
}

function approvalNotExecutedReason(
  status: import('../../packages/agent-core/src/approval').ApprovalStatus,
  cause?: import('../../packages/agent-core/src/approval').ApprovalCause
): NonNullable<ToolCallRecord['result']>['notExecutedReason'] {
  if (cause === 'agent-deny') return 'agent_denied'
  if (cause === 'policy-denied') return 'policy_denied'
  if (cause === 'authorization-revoked') return 'authorization_revoked'
  if (status === 'unavailable' || cause === 'provider-unavailable') return 'confirm_unavailable'
  if (status === 'cancelled') return 'confirm_cancelled'
  if (status === 'timed-out' || cause === 'evaluation-timeout') return 'confirm_timeout'
  if (cause === 'cancelled' || cause === 'interrupted') return 'confirm_cancelled'
  return 'not_authorized'
}

function terminalTool(status: ToolCallRecord['status']) { return status === 'completed' || status === 'failed' || status === 'rejected' }
function closeSegments(message: Message, now: number) {
  if (message.contentSegments) message.contentSegments = message.contentSegments.map((segment) => ({ ...segment, endTime: segment.endTime ?? now }))
  if (message.thinking) message.thinking = { ...message.thinking, endTime: message.thinking.endTime ?? now, segments: message.thinking.segments?.map((segment) => ({ ...segment, endTime: segment.endTime ?? now })) }
}
