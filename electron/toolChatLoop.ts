import type { WebContents } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { toolIdToOpenAiCompatibleApiToolName } from '../src/shared/toolApiFunctionName'
import { normalizeAnthropicMessageUsage } from './anthropicUsageNormalize'
import { createAnthropicClient } from './anthropicClientFactory'
import { buildClaudeToolLoopStreamParams } from './claudeToolLoopStreamParams'
import { normalizeStopReason } from './stopReason'
import { resolveToolLoopModelOptions } from './toolLoopModelOptions'
import { sanitizeAnthropicToolsPayloadForStrictGateways } from './anthropicToolPayload'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
import { FileStateCache } from './fileStateCache'
import { getToolExecutor } from './tools/builtinExecutors'
import type { ToolsConfig } from '../src/shared/domainTypes'
import { builtinToolNeedsConfirmation } from '../src/shared/domainTypes'
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

const fileCaches = new Map<string, FileStateCache>()

export function getFileStateCacheForSession(sessionId: string): FileStateCache {
  let c = fileCaches.get(sessionId)
  if (!c) {
    c = new FileStateCache()
    fileCaches.set(sessionId, c)
  }
  return c
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
  workDir: string
  userDataDir: string
  getApiKey: () => Promise<string | null>
}

export type RunToolChatSessionResult =
  | { ok: true; content: unknown[]; stopReason: string; usage?: ReturnType<typeof normalizeAnthropicMessageUsage> }
  | { ok: false; error: string }

export async function runToolChatSession(args: RunToolChatSessionArgs): Promise<RunToolChatSessionResult> {
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
    workDir,
    userDataDir,
    getApiKey
  } = args

  const apiKey = await getApiKey()
  if (!apiKey) return { ok: false, error: 'API key not configured' }

  const client = createAnthropicClient(apiKey, baseUrl)
  const toolLoopOptions = resolveToolLoopModelOptions(options ?? {})
  const thinking = toolLoopOptions.enableThinking ? ({ type: 'adaptive' as const }) : ({ type: 'disabled' as const })

  let messagesForApi: Anthropic.MessageParam[] = initialMessages.map((m) => ({
    role: m.role,
    content: m.content as Anthropic.MessageParam['content']
  }))

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

  const builtinDefs = filterBuiltinToolsForApi(toolsConfig)
  const tools = sanitizeTools(builtinDefs as unknown[])
  let completedToolExecutions = 0
  const maxIter = Math.max(1, toolsConfig.maxToolIterations ?? 10)

  while (true) {
    const systemPrompt = typeof system === 'string' && system.trim().length > 0 ? system : undefined
    const messagesStripped = stripThinking(messagesForApi)
    const toolLoopStreamParams = buildClaudeToolLoopStreamParams({
      model,
      max_tokens: toolLoopOptions.maxTokens,
      system: systemPrompt,
      messages: messagesStripped as Anthropic.MessageParam[],
      tools: tools as Anthropic.Tool[],
      thinking
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
    const content = finalContent.length > 0 ? finalContent : contentBlocks
    const stopReason = normalizeStopReason(typeof res?.stop_reason === 'string' ? res.stop_reason : undefined)
    const usage = normalizeAnthropicMessageUsage(res)

    const toolUses = content.filter(
      (b): b is { type: string; id: string; name: string; input: unknown } =>
        Boolean(b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use')
    ) as Array<{ type: 'tool_use'; id: string; name: string; input: unknown }>

    messagesForApi = [...messagesForApi, { role: 'assistant', content: content as Anthropic.ContentBlock[] }]

    if (toolUses.length === 0) {
      return { ok: true, content, stopReason: stopReason ?? 'end_turn', ...(usage && { usage }) }
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    const fileCache = getFileStateCacheForSession(sessionId)

    for (const tu of toolUses) {
      const toolUseId = tu.id
      const toolName = tu.name
      const inputObj =
        tu.input && typeof tu.input === 'object' && !Array.isArray(tu.input) ? (tu.input as Record<string, unknown>) : {}

      if (completedToolExecutions >= maxIter) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `工具调用次数已达上限（${maxIter}次），请结束当前任务`
        })
        sender.send('tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: `工具调用次数已达上限（${maxIter}次）` }
        })
        continue
      }

      const exec = getToolExecutor(toolName)
      if (!exec) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `未知工具: ${toolName}`
        })
        sender.send('tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: `未知工具: ${toolName}` }
        })
        completedToolExecutions++
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
      }

      if (outcome === 'timeout') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: '用户确认超时（5分钟），工具调用已取消'
        })
        sender.send('tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: '用户确认超时（5分钟），工具调用已取消' }
        })
        completedToolExecutions++
        continue
      }
      if (outcome === 'rejected') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: '用户拒绝执行此工具'
        })
        sender.send('tool:result', {
          requestId,
          toolUseId,
          result: { success: false, error: '用户拒绝执行此工具' }
        })
        completedToolExecutions++
        continue
      }

      try {
        assertSafeToolInput(toolName, inputObj)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
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
        completedToolExecutions++
        continue
      }

      const signal = registerToolCancel(requestId, toolUseId)
      const sendProgress = (status: string, message?: string) => {
        sender.send('tool:progress', { requestId, toolUseId, status, message })
      }

      let execResult: { success: boolean; data?: unknown; error?: string; duration?: number }
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
          toolsConfig
        })
      } catch (e) {
        execResult = {
          success: false,
          error: e instanceof Error ? e.message : String(e)
        }
      }
      clearToolCancel(requestId, toolUseId)

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
      completedToolExecutions++
    }

    messagesForApi = [...messagesForApi, { role: 'user', content: toolResults }]
  }
}
