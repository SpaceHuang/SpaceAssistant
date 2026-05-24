import type { WebContents } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { toolIdToOpenAiCompatibleApiToolName } from '../src/shared/toolApiFunctionName'
import { normalizeAnthropicMessageUsage } from './anthropicUsageNormalize'
import { createAnthropicClient } from './anthropicClientFactory'
import { buildClaudeToolLoopStreamParams } from './claudeToolLoopStreamParams'
import { normalizeStopReason, type NormalizedStopReason } from './stopReason'
import { resolveToolLoopModelOptions } from './toolLoopModelOptions'
import { sanitizeAnthropicToolsPayloadForStrictGateways } from './anthropicToolPayload'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
import { shouldBlockToolInPlanMode, type PlanToolPhaseArg } from './plan/planModeAcl'
import { getSession } from './database'
import { FileStateCache } from './fileStateCache'
import { getToolExecutor } from './tools/builtinExecutors'
import type { ToolsConfig, WikiConfig } from '../src/shared/domainTypes'
import type { AppDatabase } from './database'
import { scheduleSessionTitleSuggestion, reachedCumulativeAssistantTurnsForTitleSuggest } from './sessionTitleSuggest'
import { builtinToolNeedsConfirmation } from '../src/shared/domainTypes'
import {
  ChatCancelledError,
  clearChatCancel,
  registerChatCancel,
  throwIfChatCancelled
} from './chatCancelRegistry'
import {
  clearToolCancel,
  registerToolCancel,
  waitForToolConfirm,
  type ToolConfirmOutcome
} from './toolConfirmRegistry'
import fs from 'fs/promises'
import path from 'path'
import { resolveSafePathReal } from './pathSecurity'
import { assertSafeToolInput } from './toolInputGuards'
import { logAgentEvent } from './agentLogger/agentLogger'
import { mergeStreamedToolInputsIntoContent, normalizeToolUseInputRecord } from './toolUseInputMerge'
import {
  effectiveMaxTokensForBuiltinToolLoop,
  TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN
} from '../src/shared/llm/toolLoopMaxTokens'
import {
  checkWritePathConflict,
  claimWritePath,
  releaseWritePath,
  releaseAllWritePathsForSession
} from './toolWriteConflict'

const fileCaches = new Map<string, FileStateCache>()

export function getFileStateCacheForSession(sessionId: string): FileStateCache {
  let c = fileCaches.get(sessionId)
  if (!c) {
    c = new FileStateCache()
    fileCaches.set(sessionId, c)
  }
  return c
}

export function clearSessionToolResources(sessionId: string): void {
  fileCaches.delete(sessionId)
  releaseAllWritePathsForSession(sessionId)
}

export type ClaudeContentBlockMessage = {
  role: 'user' | 'assistant'
  content: string | Array<unknown>
  id?: string
  timestamp?: number
}

function sanitizeTools(tools: unknown[]): unknown[] {
  return sanitizeAnthropicToolsPayloadForStrictGateways(tools)
}

function parseToolInput(baseInput: unknown, partialJson: string): unknown {
  const fallback = baseInput ?? {}
  const jsonText = partialJson.trim()
  if (!jsonText) return fallback
  try {
    return JSON.parse(jsonText)
  } catch {
    return fallback
  }
}

function augmentToolInputValidationError(
  baseMessage: string,
  stopReason: NormalizedStopReason | undefined,
  toolName: string,
  inputObj: Record<string, unknown>
): string {
  if (stopReason !== 'max_tokens') return baseMessage
  if (toolName === 'write_file' && typeof inputObj.content !== 'string') {
    return `${baseMessage}（本轮 stop_reason 为 max_tokens：输出在写完 write_file 的完整参数前被截断。工具循环已将 max_tokens 下限抬到至少 ${TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN}；超长报告请在设置中继续提高 max_tokens，或分多次 write_file / edit_file 写入。）`
  }
  if (
    toolName === 'edit_file' &&
    (typeof inputObj.old_string !== 'string' || typeof inputObj.new_string !== 'string')
  ) {
    return `${baseMessage}（本轮 stop_reason 为 max_tokens，可能是 edit_file 参数未生成完毕即被截断。请提高 max_tokens 或缩小单次替换范围。）`
  }
  if (toolName === 'run_script' && typeof inputObj.code !== 'string') {
    return `${baseMessage}（本轮 stop_reason 为 max_tokens，可能是 run_script 的 code 未生成完毕即被截断。请提高 max_tokens 或缩短脚本。）`
  }
  return baseMessage
}

function formatToolResultPayload(r: { success: boolean; data?: unknown; error?: string }): string {
  if (!r.success) return r.error ?? '执行失败'
  if (r.data === undefined) return '{}'
  if (typeof r.data === 'string') return r.data
  try {
    return JSON.stringify(r.data)
  } catch {
    return String(r.data)
  }
}

async function maybeBuildConfirmDiff(
  workDir: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<{ oldContent: string; newContent: string; oldPath: string } | undefined> {
  const rel = typeof input.path === 'string' ? input.path : ''
  if (!rel || (toolName !== 'edit_file' && toolName !== 'write_file')) return undefined
  try {
    const abs = await resolveSafePathReal(workDir, rel)
    let oldContent = ''
    try {
      oldContent = await fs.readFile(abs, 'utf8')
    } catch {
      oldContent = ''
    }
    let newContent = ''
    if (toolName === 'write_file') {
      newContent = typeof input.content === 'string' ? input.content : ''
    } else {
      const oldS = typeof input.old_string === 'string' ? input.old_string : ''
      const newS = typeof input.new_string === 'string' ? input.new_string : ''
      const replaceAll = Boolean(input.replace_all)
      if (oldS === '' && !oldContent) newContent = newS
      else {
        const occ = oldS === '' ? 0 : oldContent.split(oldS).length - 1
        if (occ === 1 || replaceAll) {
          newContent = replaceAll ? oldContent.split(oldS).join(newS) : oldContent.replace(oldS, newS)
        } else {
          newContent = oldContent
        }
      }
    }
    return { oldContent, newContent, oldPath: rel }
  } catch {
    return undefined
  }
}

export type RunToolChatSessionArgs = {
  sender: WebContents
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: ClaudeContentBlockMessage[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  toolsConfig: ToolsConfig
  wikiConfig?: WikiConfig
  workDir: string
  userDataDir: string
  getApiKey: () => Promise<string | null>
  /** 用于达到累计 assistant 阈值后异步生成会话标题（不写则跳过） */
  appDb?: AppDatabase
  planToolPhase?: PlanToolPhaseArg
  /** Plan 探索期可传入只读工具子集 */
  toolsOverride?: unknown[]
}

export type RunToolChatSessionResult =
  | { ok: true; content: unknown[]; stopReason: string; usage?: ReturnType<typeof normalizeAnthropicMessageUsage> }
  | { ok: false; error: string }

export async function runToolChatSession(args: RunToolChatSessionArgs): Promise<RunToolChatSessionResult> {
  const chatSignal = registerChatCancel(args.requestId)
  try {
    return await runToolChatSessionInner({ ...args, chatSignal })
  } catch (e) {
    if (e instanceof ChatCancelledError) return { ok: false, error: e.message }
    throw e
  } finally {
    clearChatCancel(args.requestId)
  }
}

async function runToolChatSessionInner(
  args: RunToolChatSessionArgs & { chatSignal: AbortSignal }
): Promise<RunToolChatSessionResult> {
  const {
    sender,
    requestId,
    sessionId,
    model,
    baseUrl,
    messages: initialMessages,
    system,
    options,
    toolsConfig,
    wikiConfig,
    workDir,
    userDataDir,
    getApiKey,
    appDb,
    chatSignal,
    planToolPhase = null,
    toolsOverride
  } = args

  const apiKey = await getApiKey()
  if (!apiKey) {
    logAgentEvent('error', 'llm.error', {
      requestId,
      sessionId,
      model,
      error: 'API key not configured'
    })
    return { ok: false, error: 'API key not configured' }
  }

  const client = createAnthropicClient(apiKey, baseUrl)
  const toolLoopOptions = resolveToolLoopModelOptions(options ?? {})
  const maxTokensEffective = effectiveMaxTokensForBuiltinToolLoop(options?.maxTokens)
  const thinking = toolLoopOptions.enableThinking ? ({ type: 'adaptive' as const }) : ({ type: 'disabled' as const })

  if (maxTokensEffective !== toolLoopOptions.maxTokens) {
    logAgentEvent('info', 'llm.max_tokens_floor', {
      requestId,
      sessionId,
      configuredMaxTokens: toolLoopOptions.maxTokens,
      effectiveMaxTokens: maxTokensEffective,
      floor: TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN
    })
  }

  let messagesForApi: Anthropic.MessageParam[] = initialMessages.map((m) => ({
    role: m.role,
    content: m.content as Anthropic.MessageParam['content']
  }))

  /** 口径 B：本次 invoke 传入的上下文中，已有多少条 API `assistant`（不含本轮 while 将追加的） */
  const historicalAssistantApiMessageCount = initialMessages.filter((m) => m.role === 'assistant').length

  const stripThinking = (msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] => {
    if (toolLoopOptions.enableThinking) return msgs
    return msgs.map((m) => {
      if (m.role !== 'assistant' || typeof m.content === 'string' || !Array.isArray(m.content)) return m
      const filtered = m.content.filter((b: unknown) => {
        if (!b || typeof b !== 'object') return true
        const t = (b as { type?: string }).type
        return t !== 'thinking' && t !== 'redacted_thinking'
      })
      return { ...m, content: filtered }
    })
  }

  const builtinDefs = toolsOverride ?? filterBuiltinToolsForApi(toolsConfig)
  const tools = sanitizeTools(builtinDefs as unknown[])
  const toolNames = (tools as Array<{ name?: string }>).map((t) => t.name).filter((n): n is string => typeof n === 'string')
  let loopRound = 0
  /** 本会话单次 invoke 内标题摘要至多尝试调度一次（避免历史已达标且工具多轮时重复触发） */
  let titleSuggestScheduledThisInvoke = false

  while (true) {
    loopRound++
    throwIfChatCancelled(chatSignal)
    const systemPrompt = typeof system === 'string' && system.trim().length > 0 ? system : undefined
    const messagesStripped = stripThinking(messagesForApi)
    const toolLoopStreamParams = buildClaudeToolLoopStreamParams({
      model,
      max_tokens: maxTokensEffective,
      system: systemPrompt,
      messages: messagesStripped as Anthropic.MessageParam[],
      tools: tools as Anthropic.Tool[],
      thinking
    })

    logAgentEvent('info', 'llm.request', {
      requestId,
      sessionId,
      loopRound,
      model,
      baseUrl,
      system: systemPrompt,
      messages: messagesStripped,
      toolNames,
      maxTokens: maxTokensEffective,
      enableThinking: toolLoopOptions.enableThinking
    })

    const stream = client.messages.stream({
      ...toolLoopStreamParams,
      messages: messagesStripped as Anthropic.MessageParam[],
      tools: tools as Anthropic.Tool[]
    } as Parameters<typeof client.messages.stream>[0])

    const contentBlockTypes = new Map<number, string>()
    const contentBlocks: Array<unknown> = []
    const pendingToolUseByIndex = new Map<number, { id: string; name: string; input: unknown; partialJson: string }>()
    const pendingTextByIndex = new Map<number, string>()

    for await (const evt of stream) {
      throwIfChatCancelled(chatSignal)
      if (evt?.type === 'content_block_start') {
        const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
        const blockType = (evt as { content_block?: { type?: string } }).content_block?.type
        if (index >= 0 && typeof blockType === 'string') {
          contentBlockTypes.set(index, blockType)
          if (blockType === 'tool_use') {
            const block = (evt as { content_block?: { id?: string; name?: string; input?: unknown } }).content_block ?? {}
            pendingToolUseByIndex.set(index, {
              id: typeof block.id === 'string' ? block.id : '',
              name: typeof block.name === 'string' ? block.name : '',
              input: block.input,
              partialJson: ''
            })
          } else if (blockType === 'text') {
            pendingTextByIndex.set(index, '')
          }
        }
      }
      if (evt?.type === 'content_block_delta' && (evt as { delta?: { type?: string; partial_json?: string } }).delta?.type === 'input_json_delta') {
        const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
        const pending = pendingToolUseByIndex.get(index)
        const partialJson = (evt as { delta?: { partial_json?: string } }).delta?.partial_json
        if (pending && typeof partialJson === 'string') {
          pending.partialJson += partialJson
        }
      }
      if (evt?.type === 'content_block_delta' && (evt as { delta?: { type?: string; thinking?: string } }).delta?.type === 'thinking_delta') {
        const thinkingDelta = (evt as { delta?: { thinking?: string } }).delta?.thinking
        if (typeof thinkingDelta === 'string' && thinkingDelta.length > 0) {
          sender.send('claude-chat-thinking-delta', { requestId, text: thinkingDelta })
        }
      }
      if (
        evt?.type === 'content_block_delta' &&
        (evt as { delta?: { type?: string; text?: string } }).delta?.type === 'text_delta' &&
        typeof (evt as { delta: { text: string } }).delta.text === 'string' &&
        (evt as { delta: { text: string } }).delta.text.length > 0
      ) {
        const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
        const blockType = contentBlockTypes.get(index)
        const textDelta = (evt as { delta: { text: string } }).delta.text
        if (blockType === 'thinking') {
          sender.send('claude-chat-thinking-delta', { requestId, text: textDelta })
        } else if (blockType === 'text') {
          sender.send('claude-chat-delta', { requestId, text: textDelta })
          const prev = pendingTextByIndex.get(index) ?? ''
          pendingTextByIndex.set(index, prev + textDelta)
        }
      }
      if (evt?.type === 'content_block_stop') {
        const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
        const blockType = contentBlockTypes.get(index)
        if (index >= 0 && blockType === 'text') {
          const text = pendingTextByIndex.get(index) ?? ''
          pendingTextByIndex.delete(index)
          if (text.length > 0) {
            contentBlocks.push({ type: 'text', text })
          }
        } else if (index >= 0 && blockType === 'tool_use') {
          const pending = pendingToolUseByIndex.get(index)
          pendingToolUseByIndex.delete(index)
          if (pending && pending.id && pending.name) {
            const compatName = toolIdToOpenAiCompatibleApiToolName(pending.name)
            const toolUseBlock = {
              type: 'tool_use',
              id: pending.id,
              name: compatName,
              input: parseToolInput(pending.input, pending.partialJson)
            }
            contentBlocks.push(toolUseBlock)
            logAgentEvent('info', 'tool.request', {
              requestId,
              sessionId,
              loopRound,
              toolUseId: pending.id,
              toolName: compatName,
              input: toolUseBlock.input
            })
            sender.send('tool:use', {
              requestId,
              toolUse: { id: pending.id, name: compatName, input: toolUseBlock.input }
            })
          }
        }
      }
      sender.send('claude-chat-tools-activity', { requestId, at: Date.now() })
    }

    const res = (await stream.finalMessage()) as { content?: unknown[]; stop_reason?: string }
    const finalContent = Array.isArray(res?.content) ? res.content : []
    const rawContent = finalContent.length > 0 ? finalContent : contentBlocks
    const content = mergeStreamedToolInputsIntoContent(rawContent, contentBlocks) as Anthropic.ContentBlock[]
    const stopReason = normalizeStopReason(typeof res?.stop_reason === 'string' ? res.stop_reason : undefined)
    const usage = normalizeAnthropicMessageUsage(res)

    logAgentEvent('info', 'llm.response', {
      requestId,
      sessionId,
      loopRound,
      stopReason,
      content,
      usage
    })

    const toolUses = content.filter((b) =>
      Boolean(b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use')
    ) as Array<{ type: 'tool_use'; id: string; name: string; input: unknown }>

    messagesForApi = [...messagesForApi, { role: 'assistant', content: content as Anthropic.ContentBlock[] }]

    if (
      appDb &&
      !titleSuggestScheduledThisInvoke &&
      reachedCumulativeAssistantTurnsForTitleSuggest(historicalAssistantApiMessageCount, loopRound)
    ) {
      titleSuggestScheduledThisInvoke = true
      scheduleSessionTitleSuggestion({
        db: appDb,
        sender,
        sessionId,
        model,
        baseUrl,
        messagesForApi,
        getApiKey
      })
    }

    if (toolUses.length === 0) {
      return { ok: true, content, stopReason: stopReason ?? 'end_turn', ...(usage && { usage }) }
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    const fileCache = getFileStateCacheForSession(sessionId)

    for (const tu of toolUses) {
      throwIfChatCancelled(chatSignal)
      const toolUseId = tu.id
      const toolName = tu.name
      const inputObj = normalizeToolUseInputRecord(tu.input)

      const exec = getToolExecutor(toolName)
      if (!exec) {
        const unknownToolError = `未知工具: ${toolName}`
        logAgentEvent('error', 'tool.error', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          input: inputObj,
          error: unknownToolError
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: unknownToolError
        })
        sender.send('tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: unknownToolError }
        })
        continue
      }

      const sessionMeta = appDb ? getSession(appDb, sessionId)?.metadata : undefined
      const planBlock = shouldBlockToolInPlanMode(toolName, sessionMeta, planToolPhase)
      if (planBlock.blocked) {
        const blockedError = planBlock.error ?? 'BLOCKED_BY_PLAN_MODE'
        logAgentEvent('error', 'tool.error', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          input: inputObj,
          error: blockedError
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: blockedError
        })
        sender.send('tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: blockedError }
        })
        continue
      }

      try {
        assertSafeToolInput(toolName, inputObj)
      } catch (e) {
        const base = e instanceof Error ? e.message : String(e)
        const msg = augmentToolInputValidationError(base, stopReason, toolName, inputObj)
        logAgentEvent('error', 'tool.error', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          input: inputObj,
          error: msg
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: msg
        })
        sender.send('tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: msg }
        })
        continue
      }

      let outcome: ToolConfirmOutcome = 'approved'
      if (builtinToolNeedsConfirmation(toolName)) {
        const diff =
          toolsConfig.confirmMode === 'diff' ? await maybeBuildConfirmDiff(workDir, toolName, inputObj) : undefined
        sender.send('tool:confirm-request', {
          requestId,
          toolUseId,
          toolName,
          input: inputObj,
          riskLevel: toolName === 'run_script' ? 'high' : 'medium',
          ...(diff ? { diff } : {})
        })
        outcome = await waitForToolConfirm(requestId, toolUseId)
        logAgentEvent('info', 'tool.confirm', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          outcome
        })
        throwIfChatCancelled(chatSignal)
      }

      if (outcome === 'timeout') {
        const timeoutError = '用户确认超时（5分钟），工具调用已取消'
        logAgentEvent('error', 'tool.error', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          input: inputObj,
          error: timeoutError
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: timeoutError
        })
        sender.send('tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: timeoutError }
        })
        continue
      }
      if (outcome === 'rejected') {
        const rejectedError = '用户拒绝执行此工具'
        logAgentEvent('error', 'tool.error', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          input: inputObj,
          error: rejectedError
        })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: rejectedError
        })
        sender.send('tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: rejectedError }
        })
        continue
      }

      const relPath = typeof inputObj.path === 'string' ? inputObj.path : ''
      if (relPath && (toolName === 'write_file' || toolName === 'edit_file')) {
        const conflict = checkWritePathConflict(sessionId, relPath)
        if (conflict) {
          logAgentEvent('error', 'tool.error', {
            requestId,
            sessionId,
            loopRound,
            toolUseId,
            toolName,
            input: inputObj,
            error: conflict
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: conflict
          })
          sender.send('tool:result', {
            requestId,
            toolUseId,
            result: { success: false, error: conflict }
          })
          continue
        }
        claimWritePath(sessionId, relPath)
      }

      const signal = registerToolCancel(requestId, toolUseId)
      const sendProgress = (status: string, message?: string) => {
        if (status === 'error') {
          logAgentEvent('error', 'tool.progress', {
            requestId,
            sessionId,
            loopRound,
            toolUseId,
            toolName,
            status,
            message
          })
        }
        sender.send('tool:progress', { requestId, toolUseId, status, message })
      }

      let execResult: { success: boolean; data?: unknown; error?: string; duration?: number }
      const execStartedAt = Date.now()
      try {
        execResult = await exec.execute(inputObj, {
          workDir,
          userDataDir,
          requestId,
          toolUseId,
          sessionId,
          sendProgress,
          signal,
          fileStateCache: fileCache,
          toolsConfig,
          wikiConfig
        })
      } catch (e) {
        execResult = {
          success: false,
          error: e instanceof Error ? e.message : String(e)
        }
      }
      clearToolCancel(requestId, toolUseId)
      if (relPath && (toolName === 'write_file' || toolName === 'edit_file')) {
        releaseWritePath(sessionId, relPath)
      }

      const durationMs = Date.now() - execStartedAt
      if (execResult.success) {
        logAgentEvent('info', 'tool.result', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          success: true,
          data: execResult.data,
          durationMs
        })
      } else {
        logAgentEvent('error', 'tool.error', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          input: inputObj,
          error: execResult.error ?? '执行失败',
          durationMs
        })
        logAgentEvent('info', 'tool.result', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          success: false,
          error: execResult.error,
          durationMs
        })
      }

      const payload = formatToolResultPayload(execResult)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: payload
      })
      sender.send('tool:result', {
        requestId,
        toolUseId,
        result: { success: execResult.success, data: execResult.data, error: execResult.error }
      })
    }

    messagesForApi = [...messagesForApi, { role: 'user', content: toolResults }]
  }
}
