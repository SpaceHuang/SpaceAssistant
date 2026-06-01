import { patchMessage } from '../store/chatSlice'
import { appendProgressOutputRaw } from '../../shared/terminalScrollback'
import type { AppDispatch } from '../store'
import type { ToolCallRecord, ToolCallResultPersisted, Message } from '../../shared/domainTypes'
import { builtinToolRiskLevel } from '../../shared/domainTypes'
import type { BrowserDependencyToolError } from '../../shared/browserTypes'
import { buildClaudeToolChatMessages } from '../../shared/claudeToolHistory'
import { filterBuiltinToolsForRenderer } from '../../shared/toolsConfigFilter'
import { sanitizeAnthropicToolsPayloadForStrictGateways } from '../../shared/anthropicToolSanitize'
import type { ClaudeChatCreateWithToolsPayload } from '../../shared/api'

export type ToolChatController = {
  subscribe: () => void
  unsubscribe: () => void
  /** 用户点击确认/拒绝后立即更新 UI，避免等待主进程浏览器启动等重活 */
  applyConfirmOutcome: (toolUseId: string, approved: boolean) => void
}

function optimisticProgressForTool(record: ToolCallRecord): string {
  if (record.toolName === 'browser') return '正在准备浏览器…'
  if (record.toolName === 'run_shell') return '等待执行…'
  if (record.toolName === 'write_file' || record.toolName === 'edit_file') return '正在写入…'
  return '执行中…'
}

export function createToolChatController(args: {
  dispatch: AppDispatch
  assistantMessageId: string
  getRequestId: () => string
  onRecordsChange?: () => void
  /** 多会话并行时由 chatRunner 路由 patch，默认仍写 Redux */
  applyAssistantPatch?: (patch: Partial<Message>) => void
  onDependencyRecovery?: (recovery: BrowserDependencyToolError) => void
}): ToolChatController {
  const { dispatch, assistantMessageId, getRequestId, onRecordsChange, applyAssistantPatch, onDependencyRecovery } = args
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

  const onProgress = (d: {
    requestId: string
    toolUseId: string
    status: string
    message?: string
    raw?: string
    rawDelta?: string
    seq?: number
  }) => {
    if (d.requestId !== getRequestId()) return
    const i = records.findIndex((t) => t.id === d.toolUseId)
    if (i >= 0) {
      const prev = records[i]!
      if (typeof d.rawDelta === 'string') {
        records[i] = {
          ...prev,
          status: 'executing',
          progressOutputRaw: appendProgressOutputRaw(prev.progressOutputRaw, d.rawDelta),
          progressSeq: d.seq ?? prev.progressSeq
        }
      } else if (typeof d.raw === 'string') {
        records[i] = {
          ...prev,
          status: 'executing',
          progressOutputRaw: d.raw,
          progressSeq: d.seq ?? prev.progressSeq
        }
      } else {
        records[i] = {
          ...prev,
          status: 'executing',
          progressOutput: d.message ?? prev.progressOutput
        }
      }
      flush()
    }
    void d.status
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
    if (d.result.dependencyRecovery) {
      onDependencyRecovery?.(d.result.dependencyRecovery)
    }
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

  const applyConfirmOutcome = (toolUseId: string, approved: boolean) => {
    const i = records.findIndex((t) => t.id === toolUseId)
    if (i < 0) return
    const prev = records[i]!
    if (prev.status !== 'confirming') return
    if (!approved) {
      records[i] = {
        ...prev,
        status: 'rejected',
        completedAt: Date.now(),
        confirmDiff: undefined
      }
      flush()
      return
    }
    records[i] = {
      ...prev,
      status: 'executing',
      progressOutput: optimisticProgressForTool(prev),
      confirmDiff: undefined
    }
    flush()
  }

  return { subscribe, unsubscribe, applyConfirmOutcome }
}

export function buildToolChatPayload(args: {
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: Message[]
  toolsConfig: import('../../shared/domainTypes').ToolsConfig
  browserConfig?: import('../../shared/domainTypes').BrowserConfig
  shellConfig?: import('../../shared/domainTypes').ShellConfig
  maxTokens?: number
  thinkingEnabled?: boolean
  system?: string
}): ClaudeChatCreateWithToolsPayload {
  const toolsFiltered = filterBuiltinToolsForRenderer(
    args.toolsConfig,
    undefined,
    args.browserConfig,
    args.shellConfig
  )
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
    }
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
