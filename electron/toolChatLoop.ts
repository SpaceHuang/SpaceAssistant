import type { WebContents } from 'electron'
import { isWebContentsAlive, safeWebContentsSend } from './safeWebContentsSend'
import Anthropic from '@anthropic-ai/sdk'
import { toolIdToOpenAiCompatibleApiToolName } from '../src/shared/anthropicToolSanitize'
import { projectUsageAfterToolResults } from '../src/shared/contextUsageEstimate'
import { normalizeAnthropicMessageUsage } from './anthropicUsageNormalize'
import { createAnthropicClient } from './anthropicClientFactory'
import { buildClaudeToolLoopStreamParams } from './claudeToolLoopStreamParams'
import { normalizeStopReason, type NormalizedStopReason } from './stopReason'
import { resolveToolLoopModelOptions } from './toolLoopModelOptions'
import { sanitizeAnthropicToolsPayloadForStrictGateways } from './anthropicToolPayload'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
import { FileStateCache } from './fileStateCache'
import { getToolExecutor } from './tools/builtinExecutors'
import type { ToolExecutorResult } from './tools/types'
import type {
  AutoApproveFallback,
  AutoApprovedWriteMeta,
  BrowserConfig,
  ShellConfig,
  ShellSecurityHints,
  ToolsConfig,
  WikiConfig
} from '../src/shared/domainTypes'
import { computeDiffLineStats } from '../src/shared/writeDiffStats'
import { sessionDisplayNameRaw } from '../src/shared/sessionDisplay'
import { evaluateFileToolAutoApproval } from './tools/writeFileAutoApproval'
import { activateRecoverySkillInState } from '../src/shared/browserDependencyRecovery'
import { appendAvailableToolsHint, buildSystemPromptFromSkills } from '../src/shared/skillPrompt'
import { getSkillByName } from './skills/skillScanner'
import { getSession, updateSession } from './database'
import type { BrowserDetectContext } from '../src/shared/browserTypes'
import { browserActionNeedsConfirmation, type ActDangerAssessment, type BrowserAction } from './browser/browserActionPolicy'
import { assessActDanger } from './browser/actDangerAssessor'
import {
  clearBrowserSessionActTrust,
  clearBrowserSessionTrust,
  isBrowserSessionActTrustedHost,
  rememberBrowserSessionActTrust,
  rememberBrowserSessionTrustedUrl
} from './browser/browserSessionTrust'
import { extractHostname, isTrustedDomain } from './browser/urlSecurity'
import { stagehandService } from './browser/stagehandService'
import {
  formatDependencyRecoveryToolContent,
  resolveDependencyRecoverySkill
} from './browser/browserDependencyRecovery'
import { builtinToolNeedsConfirmation } from '../src/shared/domainTypes'
import type { AppDatabase } from './database'
import { scheduleSessionTitleSuggestion, reachedCumulativeAssistantTurnsForTitleSuggest } from './sessionTitleSuggest'
import type { FeishuConfig } from '../src/shared/feishuTypes'
import type { LarkCliRunner } from './feishu/larkCliRunner'
import type { FeishuRemoteContext } from './tools/types'
import { isLarkCliWriteOperation } from './feishu/larkCliSecurity'
import { BROWSER_FEISHU_REMOTE_DISABLED_CODE } from '../src/shared/browserRemotePolicy'
import { SHELL_FEISHU_REMOTE_DISABLED_ERROR } from '../src/shared/shellToolDisplay'
import { resolveEffectiveShellOutputMode } from '../src/shared/shellOutputMode'
import { logShellConfirmOutcome, logShellPrecheck } from './shell/shellAgentLogger'
import { shouldSkipRunScriptConfirmForAutoAllow } from './shell/shellCommandTrust'
import {
  logShellPathConfirm,
  logShellSecurityDeny,
  logShellWeakDenyOutcome,
  precheckRunShellTool,
  type RunShellPrecheckResult
} from './shell/shellToolLoopHelpers'
import { publishFeishuRemoteProgress } from './feishu/feishuRemoteProgress'
import {
  ChatCancelledError,
  clearChatCancel,
  registerChatCancel,
  throwIfChatCancelled
} from './chatCancelRegistry'
import { getCachedMemoryContent } from './projectMemory'
import { buildFinalSystemPrompt, resolveRequestLocale } from './llmSystemPrompt'
import type { AppLocale } from '../src/shared/locale'
import { stripThinkingBlocksFromAssistantMessages } from '../src/shared/stripThinkingFromApiMessages'
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
import { logAgentEvent, logAgentError } from './agentLogger/agentLogger'
import { sanitizeToolErrorString, toToolUserError } from './tools/toolUserErrors'
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
import { notifyFileTreeChanged } from './fileTreeSyncNotify'

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
  clearBrowserSessionTrust(sessionId)
  clearBrowserSessionActTrust(sessionId)
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

function logToolLoopError(
  fields: Record<string, unknown>,
  err: unknown,
  userMessage?: string
): void {
  const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined
  const user =
    userMessage ??
    (typeof err === 'string'
      ? sanitizeToolErrorString(err, toolName)
      : toToolUserError(err, { toolName }))
  logAgentError('tool.error', fields, err, user)
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

const MAX_CONSECUTIVE_SAME_TOOL_ERROR = 3

function buildToolErrorResult(toolUseId: string, error: string): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content: error, is_error: true }
}

function makeToolErrorRepeatTracker() {
  let lastKey: string | null = null
  let count = 0
  return {
    noteFailure(toolName: string, error: string): boolean {
      const key = `${toolName}\0${error}`
      if (key === lastKey) count++
      else {
        lastKey = key
        count = 1
      }
      return count >= MAX_CONSECUTIVE_SAME_TOOL_ERROR
    },
    noteSuccess(toolName: string): void {
      if (lastKey?.startsWith(`${toolName}\0`)) {
        lastKey = null
        count = 0
      }
    }
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
  browserConfig?: BrowserConfig
  shellConfig?: ShellConfig | null
  wikiConfig?: WikiConfig
  feishuConfig?: FeishuConfig
  larkCliRunner?: LarkCliRunner
  remoteContext?: FeishuRemoteContext
  workDir: string
  userDataDir: string
  getApiKey: () => Promise<string | null>
  /** 用于达到累计 assistant 阈值后异步生成会话标题（不写则跳过） */
  appDb?: AppDatabase
  locale?: AppLocale
  projectMemoryEnabled?: boolean
  /** 当轮 user 消息 id（tool loop 日志等） */
  currentUserMessageId?: string
  hasImageAttachments?: boolean
  getBrowserDetectContext?: () => BrowserDetectContext
  floatingNotificationManager?: import('./floatingNotificationManager').FloatingNotificationManager
}

export type ToolLoopUsage = ReturnType<typeof normalizeAnthropicMessageUsage>

/** 工具 loop 最终返回的 usage：优先最后一轮，缺失时回退到最近有效轮次 */
export function pickToolLoopReturnUsage(
  currentRound: ToolLoopUsage | undefined,
  lastValid: ToolLoopUsage | undefined
): ToolLoopUsage | undefined {
  return currentRound ?? lastValid
}

export type RunToolChatSessionResult =
  | { ok: true; content: unknown[]; stopReason: string; usage?: ToolLoopUsage }
  | { ok: false; error: string; usage?: ToolLoopUsage }

function failToolLoopWithLastUsage(
  sender: WebContents,
  requestId: string,
  sessionId: string,
  error: string,
  lastValidUsage?: ToolLoopUsage
): Extract<RunToolChatSessionResult, { ok: false }> {
  if (lastValidUsage) {
    safeWebContentsSend(sender, 'claude-chat-usage', { requestId, sessionId, usage: lastValidUsage })
  }
  return {
    ok: false,
    error,
    ...(lastValidUsage ? { usage: lastValidUsage } : {})
  }
}

export async function runToolChatSession(args: RunToolChatSessionArgs): Promise<RunToolChatSessionResult> {
  const chatSignal = registerChatCancel(args.requestId)
  try {
    return await runToolChatSessionInner({ ...args, chatSignal })
  } catch (e) {
    if (e instanceof ChatCancelledError) return { ok: false, error: e.message }
    throw e
  } finally {
    if (chatSignal.aborted) {
      args.floatingNotificationManager?.onAllCancelledForRequest(args.requestId)
    }
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
    browserConfig,
    shellConfig,
    wikiConfig,
    feishuConfig,
    larkCliRunner,
    remoteContext,
    workDir,
    userDataDir,
    getApiKey,
    appDb,
    locale: payloadLocale,
    projectMemoryEnabled,
    chatSignal,
    getBrowserDetectContext,
    floatingNotificationManager,
    hasImageAttachments
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
  const sessionMeta = appDb ? getSession(appDb, sessionId)?.metadata : undefined
  const shellOutputMode = resolveEffectiveShellOutputMode(shellConfig, sessionMeta, remoteContext?.source)
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
    // thinking 开启时须保留 assistant 消息中的 thinking/redacted_thinking（含 signature），
    // 否则多轮 tool loop 会触发 Anthropic 400（final assistant 须以 thinking 块开头）。
    if (toolLoopOptions.enableThinking) return msgs
    return stripThinkingBlocksFromAssistantMessages(msgs)
  }

  const builtinDefs = filterBuiltinToolsForApi(toolsConfig, feishuConfig, browserConfig, remoteContext, shellConfig)
  const tools = sanitizeTools(builtinDefs as unknown[])
  const toolNames = (tools as Array<{ name?: string }>).map((t) => t.name).filter((n): n is string => typeof n === 'string')
  if (toolNames.includes('browser')) {
    stagehandService.resetInferenceCount(sessionId)
  }
  let loopRound = 0
  let lastValidUsage: ToolLoopUsage | undefined
  /** 本会话单次 invoke 内标题摘要至多尝试调度一次（避免历史已达标且工具多轮时重复触发） */
  let titleSuggestScheduledThisInvoke = false
  const toolErrorRepeat = makeToolErrorRepeatTracker()
  let recoverySkillSystemSuffix = ''

  while (true) {
    loopRound++
    throwIfChatCancelled(chatSignal)
    if (!isWebContentsAlive(sender)) {
      logAgentEvent('warn', 'llm.error', { requestId, sessionId, error: 'Window closed' })
      return failToolLoopWithLastUsage(sender, requestId, sessionId, 'Window closed', lastValidUsage)
    }
    const memoryContent = getCachedMemoryContent()
    const baseSystemWithRecovery = recoverySkillSystemSuffix
      ? [typeof system === 'string' && system.trim().length > 0 ? system : undefined, recoverySkillSystemSuffix]
          .filter(Boolean)
          .join('\n\n')
      : typeof system === 'string' && system.trim().length > 0
        ? system
        : undefined
    const systemWithTools = appendAvailableToolsHint(baseSystemWithRecovery, toolNames)
    const locale = resolveRequestLocale(payloadLocale, appDb)
    const systemPrompt = buildFinalSystemPrompt({
      system: systemWithTools,
      memoryContent,
      memoryEnabled: projectMemoryEnabled ?? true,
      locale,
      hasImageAttachments: hasImageAttachments ?? false
    })
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
      locale,
      system: systemPrompt,
      messages: messagesStripped,
      toolNames,
      maxTokens: maxTokensEffective,
      enableThinking: toolLoopOptions.enableThinking
    })

    let content: Anthropic.ContentBlock[]
    let stopReason: NormalizedStopReason | undefined
    let usage: ToolLoopUsage | undefined

    try {
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
          safeWebContentsSend(sender,'claude-chat-thinking-delta', { requestId, text: thinkingDelta })
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
          safeWebContentsSend(sender,'claude-chat-thinking-delta', { requestId, text: textDelta })
        } else if (blockType === 'text') {
          safeWebContentsSend(sender,'claude-chat-delta', { requestId, text: textDelta })
          const prev = pendingTextByIndex.get(index) ?? ''
          pendingTextByIndex.set(index, prev + textDelta)
        }
      }
      if (evt?.type === 'message_start') {
        const startUsage = (evt as { message?: { usage?: unknown } }).message?.usage
        if (startUsage && typeof startUsage === 'object') {
          const partial = normalizeAnthropicMessageUsage({ usage: startUsage }, baseUrl)
          if (partial) {
            usage = { ...partial, output_tokens: usage?.output_tokens }
            lastValidUsage = usage
            safeWebContentsSend(sender, 'claude-chat-usage', { requestId, sessionId, usage })
          }
        }
      }
      if (evt?.type === 'message_delta') {
        const evtUsage = (evt as { usage?: unknown }).usage
        if (evtUsage && typeof evtUsage === 'object') {
          const partial = normalizeAnthropicMessageUsage({ usage: evtUsage }, baseUrl)
          if (partial) usage = partial
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
            if (
              remoteContext?.source === 'feishu' &&
              remoteContext.larkCliRunner &&
              remoteContext.messageId
            ) {
              void publishFeishuRemoteProgress(
                remoteContext.larkCliRunner,
                remoteContext.messageId,
                sessionId,
                text
              ).catch(() => undefined)
            }
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
            safeWebContentsSend(sender,'tool:use', {
              requestId,
              toolUse: { id: pending.id, name: compatName, input: toolUseBlock.input }
            })
          }
        }
      }
      safeWebContentsSend(sender,'claude-chat-tools-activity', { requestId, at: Date.now() })
    }

      const res = (await stream.finalMessage()) as { content?: unknown[]; stop_reason?: string }
      const finalContent = Array.isArray(res?.content) ? res.content : []
      const rawContent = finalContent.length > 0 ? finalContent : contentBlocks
      content = mergeStreamedToolInputsIntoContent(rawContent, contentBlocks) as Anthropic.ContentBlock[]
      stopReason = normalizeStopReason(typeof res?.stop_reason === 'string' ? res.stop_reason : undefined)
      const finalUsage = normalizeAnthropicMessageUsage(res, baseUrl)
      usage = finalUsage ?? usage
      if (usage) {
        lastValidUsage = usage
        safeWebContentsSend(sender, 'claude-chat-usage', { requestId, sessionId, usage })
      }

      logAgentEvent('info', 'llm.response', {
        requestId,
        sessionId,
        loopRound,
        stopReason,
        content,
        usage
      })
    } catch (e) {
      if (e instanceof ChatCancelledError) throw e
      const error = e instanceof Error ? e.message : String(e)
      logAgentEvent('error', 'llm.error', {
        requestId,
        sessionId,
        loopRound,
        model,
        error,
        stack: e instanceof Error ? e.stack : undefined
      })
      return failToolLoopWithLastUsage(sender, requestId, sessionId, error, lastValidUsage)
    }

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
      const returnUsage = pickToolLoopReturnUsage(usage, lastValidUsage)
      return { ok: true, content, stopReason: stopReason ?? 'end_turn', ...(returnUsage && { usage: returnUsage }) }
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    const fileCache = getFileStateCacheForSession(sessionId)
    let abortRepeatedToolError: string | null = null

    for (const tu of toolUses) {
      throwIfChatCancelled(chatSignal)
      const toolUseId = tu.id
      const toolName = tu.name
      const inputObj = normalizeToolUseInputRecord(tu.input)

      const exec = getToolExecutor(toolName)
      if (!exec) {
        const unknownToolError = `未知工具: ${toolName}`
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          unknownToolError,
          unknownToolError
        )
        toolResults.push(buildToolErrorResult(toolUseId, unknownToolError))
        safeWebContentsSend(sender,'tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: unknownToolError }
        })
        if (toolErrorRepeat.noteFailure(toolName, unknownToolError)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${unknownToolError}`
          break
        }
        continue
      }

      try {
        assertSafeToolInput(toolName, inputObj)
      } catch (e) {
        const base = e instanceof Error ? e.message : String(e)
        const msg = augmentToolInputValidationError(base, stopReason, toolName, inputObj)
        const userMsg = sanitizeToolErrorString(msg, toolName)
        logToolLoopError(
          {
            requestId,
            sessionId,
            loopRound,
            toolUseId,
            toolName,
            input: inputObj
          },
          e,
          userMsg
        )
        toolResults.push(buildToolErrorResult(toolUseId, userMsg))
        safeWebContentsSend(sender,'tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: userMsg }
        })
        if (toolErrorRepeat.noteFailure(toolName, userMsg)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${userMsg}`
          break
        }
        continue
      }

      const remoteBlock = evaluateFeishuRemoteToolBlock(toolName, inputObj, remoteContext, feishuConfig)
      if (remoteBlock) {
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          remoteBlock,
          remoteBlock
        )
        toolResults.push(buildToolErrorResult(toolUseId, remoteBlock))
        safeWebContentsSend(sender,'tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: remoteBlock, blockedReason: 'feishu_remote_write_blocked' }
        })
        if (toolErrorRepeat.noteFailure(toolName, remoteBlock)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${remoteBlock}`
          break
        }
        continue
      }

      if (
        toolName === 'browser' &&
        remoteContext?.source === 'feishu' &&
        browserConfig &&
        !browserConfig.allowRemoteSessions
      ) {
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          BROWSER_FEISHU_REMOTE_DISABLED_CODE,
          BROWSER_FEISHU_REMOTE_DISABLED_CODE
        )
        toolResults.push(buildToolErrorResult(toolUseId, BROWSER_FEISHU_REMOTE_DISABLED_CODE))
        safeWebContentsSend(sender,'tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: BROWSER_FEISHU_REMOTE_DISABLED_CODE }
        })
        if (toolErrorRepeat.noteFailure(toolName, BROWSER_FEISHU_REMOTE_DISABLED_CODE)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${BROWSER_FEISHU_REMOTE_DISABLED_CODE}`
          break
        }
        continue
      }

      if (toolName === 'run_shell' && remoteContext?.source === 'feishu') {
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          SHELL_FEISHU_REMOTE_DISABLED_ERROR,
          SHELL_FEISHU_REMOTE_DISABLED_ERROR
        )
        toolResults.push(buildToolErrorResult(toolUseId, SHELL_FEISHU_REMOTE_DISABLED_ERROR))
        safeWebContentsSend(sender,'tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: SHELL_FEISHU_REMOTE_DISABLED_ERROR }
        })
        if (toolErrorRepeat.noteFailure(toolName, SHELL_FEISHU_REMOTE_DISABLED_ERROR)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${SHELL_FEISHU_REMOTE_DISABLED_ERROR}`
          break
        }
        continue
      }

      let shellPrecheck: RunShellPrecheckResult | null = null
      let shellSecurityHints: ShellSecurityHints | undefined
      if (toolName === 'run_shell') {
        const command = typeof inputObj.command === 'string' ? inputObj.command : ''
        shellPrecheck = await precheckRunShellTool({
          command,
          workDir,
          userDataDir,
          shellConfig,
          appDb
        })
        if (!shellPrecheck.ok) {
          logShellSecurityDeny({
            requestId,
            sessionId,
            command,
            reason: shellPrecheck.auditReason,
            validatorId: shellPrecheck.validatorId,
            denyType: shellPrecheck.denyType
          })
          logToolLoopError(
            { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
            shellPrecheck.error,
            shellPrecheck.error
          )
          toolResults.push(buildToolErrorResult(toolUseId, shellPrecheck.error))
          safeWebContentsSend(sender,'tool:result', {
            requestId,
            toolUseId,
            result: { success: false, error: shellPrecheck.error }
          })
          if (toolErrorRepeat.noteFailure(toolName, shellPrecheck.error)) {
            abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${shellPrecheck.error}`
            break
          }
          continue
        }
        shellSecurityHints = shellPrecheck.hints
        logShellPrecheck({
          requestId,
          sessionId,
          toolUseId,
          loopRound,
          command,
          verdict: shellPrecheck.analysis.verdict,
          skipConfirm: shellPrecheck.skipConfirm,
          hints: shellPrecheck.hints
        })
      }

      let outcome: ToolConfirmOutcome = 'approved'
      let autoApproveFallback: AutoApproveFallback | undefined
      let fileAutoApproved = false
      let fileAutoApproveMeta: AutoApprovedWriteMeta | undefined
      if (
        (toolName === 'write_file' || toolName === 'edit_file') &&
        toolsConfig.confirmMode === 'auto'
      ) {
        const autoEval = await evaluateFileToolAutoApproval({
          workDir,
          userDataDir,
          toolsConfig,
          shellConfig,
          toolName,
          input: inputObj
        })
        if (autoEval.approve) {
          fileAutoApproved = true
          const relPath = typeof inputObj.path === 'string' ? inputObj.path : ''
          const diff = await maybeBuildConfirmDiff(workDir, toolName, inputObj)
          let bytesWritten = 0
          if (toolName === 'write_file') {
            const content = typeof inputObj.content === 'string' ? inputObj.content : ''
            bytesWritten = Buffer.byteLength(content, 'utf8')
          } else if (diff) {
            bytesWritten = Buffer.byteLength(diff.newContent, 'utf8')
          }
          const stats = diff
            ? computeDiffLineStats(diff.oldContent, diff.newContent)
            : { add: 0, remove: 0 }
          fileAutoApproveMeta = {
            path: relPath,
            added: stats.add,
            removed: stats.remove,
            bytesWritten,
            ...(diff ? { diff } : {})
          }
        } else {
          autoApproveFallback = { reason: autoEval.reason, reasonCode: autoEval.reasonCode }
          logAgentEvent('info', 'file.auto_approve.fallback', {
            requestId,
            sessionId,
            toolUseId,
            toolName,
            relPath: typeof inputObj.path === 'string' ? inputObj.path : '',
            reason: autoEval.reason,
            reasonCode: autoEval.reasonCode
          })
        }
      }

      const sendProgress = (status: string, payload?: string | import('./tools/types').ToolProgressPayload) => {
        let message: string | undefined
        let raw: string | undefined
        let rawDelta: string | undefined
        let seq: number | undefined
        if (typeof payload === 'string') {
          message = payload
        } else if (payload) {
          message = payload.message
          raw = payload.raw
          rawDelta = payload.rawDelta
          seq = payload.seq
        }
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
        safeWebContentsSend(sender,'tool:progress', { requestId, toolUseId, status, message, raw, rawDelta, seq })
        if (
          message?.trim() &&
          remoteContext?.source === 'feishu' &&
          remoteContext.larkCliRunner &&
          remoteContext.messageId
        ) {
          void publishFeishuRemoteProgress(
            remoteContext.larkCliRunner,
            remoteContext.messageId,
            sessionId,
            message
          ).catch(() => undefined)
        }
      }

      let dangerAssessment: ActDangerAssessment | null = null
      if (
        toolName === 'browser' &&
        inputObj.action === 'act' &&
        browserConfig?.actRequiresConfirm &&
        sessionId
      ) {
        sendProgress('analyzing_risk', '正在检查本次操作…')
        try {
          dangerAssessment = await assessActDanger(
            sessionId,
            inputObj,
            browserConfig,
            stagehandService,
            undefined
          )
        } catch {
          dangerAssessment = null
        }
      }

      const currentPageUrl =
        toolName === 'browser' && sessionId ? stagehandService.peekCurrentUrl(sessionId) : undefined

      let needsConfirm = toolNeedsUserConfirmation(
        toolName,
        inputObj,
        feishuConfig,
        browserConfig,
        sessionId,
        currentPageUrl,
        dangerAssessment
      )
      if (toolName === 'run_shell' && shellPrecheck?.ok && shellPrecheck.skipConfirm) {
        needsConfirm = false
      }
      if (toolName === 'run_script' && shouldSkipRunScriptConfirmForAutoAllow(shellConfig)) {
        needsConfirm = false
        logAgentEvent('info', 'script.auto_allow.execute', {
          requestId,
          sessionId,
          toolUseId,
          tool: 'run_script',
          timestamp: Date.now()
        })
      }
      if (fileAutoApproved) {
        needsConfirm = false
      }

      if (needsConfirm && remoteContext?.source === 'feishu') {
        if (
          (remoteContext.confirmPolicy === 'feishu_confirm' || remoteContext.confirmPolicy === 'always') &&
          remoteContext.confirmManager
        ) {
          const decision = await remoteContext.confirmManager.requestConfirm({
            kind: 'tool_write',
            sessionId,
            toolCallId: toolUseId,
            toolName,
            toolInput: inputObj,
            messageId: remoteContext.messageId,
            chatId: remoteContext.chatId ?? ''
          })
          outcome = decision === 'y' ? 'approved' : decision === 'timeout' ? 'timeout' : 'rejected'
        } else {
          outcome = 'rejected'
        }
      } else if (needsConfirm) {
        const useDiff =
          toolsConfig.confirmMode === 'diff' ||
          toolsConfig.confirmMode === 'auto' ||
          Boolean(autoApproveFallback)
        const diff = useDiff ? await maybeBuildConfirmDiff(workDir, toolName, inputObj) : undefined
        const actDanger =
          toolName === 'browser' && inputObj.action === 'act' && dangerAssessment?.dangerous
            ? dangerAssessment
            : null
        const actCurrentHost = currentPageUrl ? extractHostname(currentPageUrl) : null
        const sessionTrustedHint =
          !!actCurrentHost &&
          !!sessionId &&
          !actDanger &&
          isBrowserSessionActTrustedHost(sessionId, actCurrentHost)
            ? true
            : undefined
        const dangerInfo = actDanger
          ? {
              userReason: actDanger.userReason,
              consequence: actDanger.consequence ?? 'generic',
              source: actDanger.source!,
              ...(actDanger.fillPreview?.length ? { fillPreview: actDanger.fillPreview } : {})
            }
          : undefined
        safeWebContentsSend(sender,'tool:confirm-request', {
          requestId,
          toolUseId,
          toolName,
          input: inputObj,
          riskLevel:
            toolName === 'run_script' || toolName === 'run_lark_cli' || toolName === 'run_shell' ? 'high' : 'medium',
          ...(toolName === 'browser' && inputObj.action === 'act'
            ? {
                ...(currentPageUrl ? { currentPageUrl } : {}),
                ...(dangerInfo ? { dangerInfo } : {}),
                ...(sessionTrustedHint ? { sessionTrustedHint } : {})
              }
            : {}),
          ...(diff ? { diff } : {}),
          ...(shellSecurityHints ? { shellSecurityHints } : {}),
          ...(autoApproveFallback ? { autoApproveFallback } : {})
        })
        // 通知浮动通知管理器
        if (floatingNotificationManager) {
          const session = appDb ? getSession(appDb, sessionId) : undefined
          floatingNotificationManager.onConfirmRequest({
            sessionId,
            sessionName: sessionDisplayNameRaw(session?.name, sessionId),
            toolUseId,
            toolName,
            input: inputObj,
            requestId,
            createdAt: Date.now()
          })
        }
        outcome = await waitForToolConfirm(requestId, toolUseId)
        // 用户已确认/拒绝/超时，不再属于「待确认」；勿等到工具执行完毕才清除
        floatingNotificationManager?.onToolResult(requestId, toolUseId)
        if (toolName === 'run_shell' && shellSecurityHints) {
          const command = typeof inputObj.command === 'string' ? inputObj.command : ''
          if (outcome === 'approved' && shellSecurityHints.requiresRiskAck) {
            if (shellSecurityHints.securityWarning) {
              logShellWeakDenyOutcome({
                requestId,
                sessionId,
                command,
                outcome: 'confirm',
                hints: shellSecurityHints
              })
            } else {
              logShellPathConfirm({
                requestId,
                sessionId,
                command,
                outcome: 'confirm',
                hints: shellSecurityHints
              })
            }
          } else if (outcome === 'rejected' && shellSecurityHints.requiresRiskAck) {
            if (shellSecurityHints.securityWarning) {
              logShellWeakDenyOutcome({
                requestId,
                sessionId,
                command,
                outcome: 'reject',
                hints: shellSecurityHints
              })
            } else {
              logShellPathConfirm({
                requestId,
                sessionId,
                command,
                outcome: 'reject',
                hints: shellSecurityHints
              })
            }
          }
        }
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

      if (toolName === 'run_shell' && shellPrecheck?.ok) {
        const command = typeof inputObj.command === 'string' ? inputObj.command : ''
        logShellConfirmOutcome({
          requestId,
          sessionId,
          toolUseId,
          loopRound,
          command,
          outcome: shellPrecheck.skipConfirm && !needsConfirm ? 'skip_confirm' : outcome,
          skipConfirm: shellPrecheck.skipConfirm,
          hints: shellSecurityHints
        })
      }

      if (outcome === 'timeout') {
        const timeoutError =
          remoteContext?.source === 'feishu'
            ? '飞书确认超时（10分钟），工具调用已取消。请查看 Bot 发出的确认消息后回复 Y，或重新发送指令。'
            : '用户确认超时（5分钟），工具调用已取消'
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          timeoutError,
          timeoutError
        )
        toolResults.push(buildToolErrorResult(toolUseId, timeoutError))
        safeWebContentsSend(sender,'tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: timeoutError }
        })
        floatingNotificationManager?.onToolResult(requestId, toolUseId)
        if (toolErrorRepeat.noteFailure(toolName, timeoutError)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${timeoutError}`
          break
        }
        continue
      }
      if (
        outcome === 'approved' &&
        toolName === 'browser' &&
        inputObj.action === 'navigate' &&
        (typeof inputObj.mode !== 'string' || inputObj.mode === 'open') &&
        typeof inputObj.url === 'string' &&
        inputObj.url.trim()
      ) {
        rememberBrowserSessionTrustedUrl(sessionId, inputObj.url.trim())
      }
      if (
        outcome === 'approved' &&
        toolName === 'browser' &&
        inputObj.action === 'act' &&
        !dangerAssessment?.dangerous
      ) {
        const actUrl = stagehandService.peekCurrentUrl(sessionId)
        if (actUrl) {
          rememberBrowserSessionActTrust(sessionId, actUrl)
          logAgentEvent('info', 'browser.act.sessionTrust.remember', {
            sessionId,
            host: extractHostname(actUrl),
            timestamp: Date.now()
          })
        }
      }
      if (
        outcome === 'approved' &&
        toolName === 'browser' &&
        inputObj.action === 'act' &&
        dangerAssessment?.dangerous
      ) {
        logAgentEvent('info', 'browser.act.danger.confirmedNoTrust', {
          sessionId,
          source: dangerAssessment.source,
          userReason: dangerAssessment.userReason,
          consequence: dangerAssessment.consequence,
          timestamp: Date.now()
        })
      }

      if (outcome === 'rejected') {
        const rejectedError = '用户拒绝执行此工具'
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          rejectedError,
          rejectedError
        )
        toolResults.push(buildToolErrorResult(toolUseId, rejectedError))
        safeWebContentsSend(sender,'tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: rejectedError }
        })
        floatingNotificationManager?.onToolResult(requestId, toolUseId)
        if (toolErrorRepeat.noteFailure(toolName, rejectedError)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${rejectedError}`
          break
        }
        continue
      }

      const relPath = typeof inputObj.path === 'string' ? inputObj.path : ''
      if (relPath && (toolName === 'write_file' || toolName === 'edit_file')) {
        const conflict = checkWritePathConflict(sessionId, relPath)
        if (conflict) {
          logToolLoopError(
            { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
            conflict,
            conflict
          )
          toolResults.push(buildToolErrorResult(toolUseId, conflict))
          safeWebContentsSend(sender,'tool:result', {
            requestId,
            toolUseId,
            result: { success: false, error: conflict }
          })
          if (toolErrorRepeat.noteFailure(toolName, conflict)) {
            abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${conflict}`
            break
          }
          continue
        }
        claimWritePath(sessionId, relPath)
      }

      const signal = registerToolCancel(requestId, toolUseId)
      if (
        !needsConfirm &&
        toolName === 'browser' &&
        inputObj.action === 'act' &&
        !dangerAssessment?.dangerous &&
        currentPageUrl &&
        browserConfig?.actRequiresConfirm
      ) {
        const host = extractHostname(currentPageUrl)
        const persistent = host ? isTrustedDomain(host, browserConfig.actTrustedDomains) : false
        const sessionTrusted = host && sessionId ? isBrowserSessionActTrustedHost(sessionId, host) : false
        if (host && (persistent || sessionTrusted)) {
          sendProgress(
            'trust_auto_approved',
            `已信任「${host}」的常规操作，自动执行（敏感操作仍会询问）`
          )
          logAgentEvent('info', 'browser.act.trustAutoApproved', {
            sessionId,
            host,
            layer: persistent ? 'persistent' : 'session',
            timestamp: Date.now()
          })
        }
      }

      let execResult: ToolExecutorResult
      let execThrew = false
      const execStartedAt = Date.now()
      const toolUserConfirmed = needsConfirm && outcome === 'approved'
      if (toolUserConfirmed && toolName === 'browser') {
        sendProgress('preparing', '正在准备浏览器…')
      }
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
          browserConfig,
          shellConfig,
          shellOutputMode,
          appDatabase: appDb,
          wikiConfig,
          feishuConfig,
          larkCliRunner,
          remoteContext,
          toolUserConfirmed,
          getBrowserDetectContext
        })
        if (toolName === 'browser' && browserConfig) {
          stagehandService.scheduleIdleClose(sessionId, browserConfig.idleTimeoutSec)
        }
      } catch (e) {
        execThrew = true
        const userErr = toToolUserError(e, { toolName })
        execResult = { success: false, error: userErr }
        logToolLoopError(
          {
            requestId,
            sessionId,
            loopRound,
            toolUseId,
            toolName,
            input: inputObj,
            phase: 'execute_throw'
          },
          e,
          userErr
        )
      }
      clearToolCancel(requestId, toolUseId)
      if (relPath && (toolName === 'write_file' || toolName === 'edit_file')) {
        releaseWritePath(sessionId, relPath)
      }

      const durationMs = Date.now() - execStartedAt
      if (execResult.success && fileAutoApproved && (toolName === 'write_file' || toolName === 'edit_file')) {
        logAgentEvent('info', 'file.auto_approve', {
          requestId,
          sessionId,
          toolUseId,
          tool: toolName,
          relPath: fileAutoApproveMeta?.path ?? (typeof inputObj.path === 'string' ? inputObj.path : ''),
          bytesWritten: fileAutoApproveMeta?.bytesWritten ?? 0,
          timestamp: Date.now()
        })
      }

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
        toolErrorRepeat.noteSuccess(toolName)
      } else {
        const rawError = execResult.error ?? '执行失败'
        const userErr = execThrew ? (execResult.error ?? '执行失败') : sanitizeToolErrorString(rawError, toolName)
        if (!execThrew) {
          execResult = { ...execResult, error: userErr }
          logToolLoopError(
            {
              requestId,
              sessionId,
              loopRound,
              toolUseId,
              toolName,
              input: inputObj,
              durationMs
            },
            rawError,
            userErr
          )
        }
        logAgentEvent('info', 'tool.result', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          success: false,
          error: userErr,
          durationMs
        })
      }

      const payload = formatToolResultPayload(execResult)
      const recoverySkill =
        execResult.dependencyError &&
        resolveDependencyRecoverySkill(execResult.dependencyError.errorCode)

      if (execResult.success) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: payload
        })
      } else if (recoverySkill && execResult.dependencyError) {
        if (!recoverySkillSystemSuffix && appDb) {
          const cur = getSession(appDb, sessionId)
          if (cur) {
            updateSession(appDb, sessionId, {
              skillsState: activateRecoverySkillInState(cur.skillsState, recoverySkill)
            })
            const skill = getSkillByName(userDataDir, workDir, recoverySkill)
            if (skill) {
              recoverySkillSystemSuffix = buildSystemPromptFromSkills([skill])
            }
          }
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: formatDependencyRecoveryToolContent(execResult.dependencyError)
        })
        if (toolErrorRepeat.noteFailure(toolName, execResult.error ?? 'dependency')) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${execResult.error ?? '依赖未就绪'}`
        }
      } else {
        const execError = execResult.error ?? '执行失败'
        toolResults.push(buildToolErrorResult(toolUseId, execError))
        if (toolErrorRepeat.noteFailure(toolName, execError)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${execError}`
        }
      }
      safeWebContentsSend(sender,'tool:result', {
        requestId,
        toolUseId,
        result: {
          success: execResult.success,
          data: execResult.data,
          error: execResult.error,
          ...(execResult.dependencyError ? { dependencyRecovery: execResult.dependencyError } : {}),
          ...(execResult.success && fileAutoApproveMeta ? { autoApprovedWrite: fileAutoApproveMeta } : {})
        }
      })
      if (execResult.success) {
        if (toolName === 'write_file' || toolName === 'edit_file') {
          const rel = typeof inputObj.path === 'string' ? inputObj.path.trim() : ''
          if (rel) notifyFileTreeChanged(sender, { kind: 'paths', relPaths: [rel] })
        } else if (toolName === 'run_shell' || toolName === 'run_script') {
          notifyFileTreeChanged(sender, { kind: 'refreshExpanded' })
        }
      }
      floatingNotificationManager?.onToolResult(requestId, toolUseId)
      if (abortRepeatedToolError) break
    }

    messagesForApi = [...messagesForApi, { role: 'user', content: toolResults }]
    if (lastValidUsage && toolResults.length > 0) {
      const projected = projectUsageAfterToolResults(lastValidUsage, toolResults)
      safeWebContentsSend(sender, 'claude-chat-usage', { requestId, sessionId, usage: projected, projected: true })
    }
    if (abortRepeatedToolError) {
      return failToolLoopWithLastUsage(sender, requestId, sessionId, abortRepeatedToolError, lastValidUsage)
    }
  }
}

function toolNeedsUserConfirmation(
  toolName: string,
  inputObj: Record<string, unknown>,
  feishuConfig?: FeishuConfig,
  browserConfig?: BrowserConfig,
  sessionId?: string,
  currentPageUrl?: string,
  danger?: ActDangerAssessment | null
): boolean {
  if (toolName === 'browser' && browserConfig) {
    const action = inputObj.action
    if (typeof action !== 'string') return true
    return browserActionNeedsConfirmation(
      action as BrowserAction,
      inputObj,
      browserConfig,
      sessionId,
      currentPageUrl,
      danger
    )
  }
  if (toolName === 'run_lark_cli') {
    const args = inputObj.args
    if (!Array.isArray(args)) return feishuConfig?.larkCliWriteRequiresConfirm ?? true
    if (isLarkCliWriteOperation(args as string[])) {
      return feishuConfig?.larkCliWriteRequiresConfirm ?? true
    }
    return false
  }
  return builtinToolNeedsConfirmation(toolName)
}

function evaluateFeishuRemoteToolBlock(
  toolName: string,
  inputObj: Record<string, unknown>,
  remoteContext: FeishuRemoteContext | undefined,
  feishuConfig?: FeishuConfig
): string | null {
  if (remoteContext?.source !== 'feishu') return null
  const policy = remoteContext.confirmPolicy
  const allowLocalWrite = feishuConfig?.remoteAllowLocalWrite ?? false

  if ((toolName === 'write_file' || toolName === 'edit_file') && !allowLocalWrite) {
    return '远程飞书指令不允许自动执行本地文件写操作。请在桌面端 SpaceAssistant 中确认后执行。'
  }

  if (toolName === 'run_lark_cli' && policy === 'remote_read_only') {
    const args = inputObj.args
    if (Array.isArray(args) && isLarkCliWriteOperation(args as string[])) {
      return '远程飞书指令不允许自动执行写操作。请在桌面端 SpaceAssistant 中确认后执行。'
    }
  }

  return null
}
