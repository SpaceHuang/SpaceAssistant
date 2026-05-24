import { patchMessage } from '../store/chatSlice'
import type { AppDispatch } from '../store'
import type { ToolCallRecord, ToolCallResultPersisted, Message } from '../../shared/domainTypes'
import { builtinToolRiskLevel } from '../../shared/domainTypes'
import { buildClaudeToolChatMessages } from '../../shared/claudeToolHistory'
import { filterBuiltinToolsForRenderer } from '../../shared/toolsConfigFilter'
import { filterBuiltinToolsForPlanPhase } from '../../shared/planToolsFilter'
import type { ChatMode } from '../../shared/planTypes'
import { isPlanDrafting, isSessionPlanExplorationBlocked } from '../../shared/planTypes'
import { sanitizeAnthropicToolsPayloadForStrictGateways } from '../../shared/anthropicToolSanitize'
import type { ClaudeChatCreateWithToolsPayload } from '../../shared/api'

export type ToolChatController = {
  subscribe: () => void
  unsubscribe: () => void
}

export function createToolChatController(args: {
  dispatch: AppDispatch
  assistantMessageId: string
  getRequestId: () => string
  onRecordsChange?: () => void
  /** 多会话并行时由 chatRunner 路由 patch，默认仍写 Redux */
  applyAssistantPatch?: (patch: Partial<Message>) => void
}): ToolChatController {
  const { dispatch, assistantMessageId, getRequestId, onRecordsChange, applyAssistantPatch } = args
  const records: ToolCallRecord[] = []

  const flush = () => {
    const patch: Partial<Message> = { toolCalls: [...records] }
    if (applyAssistantPatch) {
      applyAssistantPatch(patch)
    } else {
      dispatch(patchMessage({ id: assistantMessageId, patch }))
    }
    onRecordsChange?.()
  }

  const onUse = (d: { requestId: string; toolUse: { id: string; name: string; input: unknown } }) => {
    if (d.requestId !== getRequestId()) return
    records.push({
      id: d.toolUse.id,
      toolName: d.toolUse.name,
      input: (d.toolUse.input as Record<string, unknown>) ?? {},
      status: 'calling',
      riskLevel: builtinToolRiskLevel(d.toolUse.name),
      startedAt: Date.now()
    })
    flush()
  }

  const onConfirmReq = (d: {
    requestId: string
    toolUseId: string
    toolName: string
    input: unknown
    riskLevel: ToolCallRecord['riskLevel']
    diff?: ToolCallRecord['confirmDiff']
  }) => {
    if (d.requestId !== getRequestId()) return
    const i = records.findIndex((t) => t.id === d.toolUseId)
    if (i >= 0) {
      records[i] = { ...records[i]!, status: 'confirming', ...(d.diff ? { confirmDiff: d.diff } : {}) }
      flush()
    }
    void d.toolName
    void d.input
    void d.riskLevel
  }

  const onProgress = (d: { requestId: string; toolUseId: string; status: string; message?: string }) => {
    if (d.requestId !== getRequestId()) return
    const i = records.findIndex((t) => t.id === d.toolUseId)
    if (i >= 0) {
      records[i] = { ...records[i]!, status: 'executing' }
      flush()
    }
    void d.status
    void d.message
  }

  const onResult = (d: { requestId: string; toolUseId: string; result: ToolCallResultPersisted }) => {
    if (d.requestId !== getRequestId()) return
    const i = records.findIndex((t) => t.id === d.toolUseId)
    if (i < 0) return
    const ok = d.result.success
    const err = d.result.error ?? ''
    const rejected = err.includes('拒绝') || err.includes('超时') || err.includes('取消')
    records[i] = {
      ...records[i]!,
      status: ok ? 'completed' : rejected ? 'rejected' : 'failed',
      result: d.result,
      completedAt: Date.now(),
      confirmDiff: undefined
    }
    flush()
  }

  const unsubs: Array<() => void> = []

  const subscribe = () => {
    unsubs.push(window.api.toolOnUse(onUse))
    unsubs.push(window.api.toolOnConfirmRequest(onConfirmReq))
    unsubs.push(window.api.toolOnProgress(onProgress))
    unsubs.push(window.api.toolOnResult(onResult))
  }

  const unsubscribe = () => {
    for (const u of unsubs) u()
    unsubs.length = 0
  }

  return { subscribe, unsubscribe }
}

export function buildToolChatPayload(args: {
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: Message[]
  toolsConfig: import('../../shared/domainTypes').ToolsConfig
  maxTokens?: number
  thinkingEnabled?: boolean
  system?: string
  chatMode?: ChatMode
  sessionMetadata?: Record<string, unknown>
  planRevisionFeedback?: string
}): ClaudeChatCreateWithToolsPayload {
  const planningPhase =
    args.chatMode === 'plan' &&
    (isPlanDrafting(args.sessionMetadata) ||
      !args.sessionMetadata?.plan ||
      isSessionPlanExplorationBlocked(args.sessionMetadata))

  const toolsFiltered = planningPhase
    ? filterBuiltinToolsForPlanPhase(args.toolsConfig, 'planning')
    : args.chatMode === 'plan'
      ? filterBuiltinToolsForPlanPhase(args.toolsConfig, 'implementation')
      : filterBuiltinToolsForRenderer(args.toolsConfig)

  const tools = sanitizeAnthropicToolsPayloadForStrictGateways(toolsFiltered as unknown[])
  const convo = buildClaudeToolChatMessages(args.messages)
  return {
    requestId: args.requestId,
    sessionId: args.sessionId,
    model: args.model,
    baseUrl: args.baseUrl,
    messages: convo,
    tools: tools as Array<Record<string, unknown>>,
    system: args.system,
    options: {
      maxTokens: args.maxTokens,
      enableThinking: args.thinkingEnabled
    },
    chatMode: args.chatMode,
    planRevisionFeedback: args.planRevisionFeedback
  }
}

export function extractAssistantTextFromApiContent(content: unknown[]): string {
  let s = ''
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string') {
      s += (b as { text: string }).text
    }
  }
  return s
}
