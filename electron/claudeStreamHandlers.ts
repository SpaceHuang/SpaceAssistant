import type { IpcMain, WebContents } from 'electron'
import { safeWebContentsSend } from './safeWebContentsSend'
import Anthropic from '@anthropic-ai/sdk'
import { normalizeToolLoopMaxTokens } from '../src/shared/llm/toolLoopMaxTokens'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../src/shared/domainTypes'
import { createAnthropicClient } from './anthropicClientFactory'
import { assertValidModel, assertValidOptionalAnthropicBaseUrl, assertValidRequestId } from './claudeRequestGuards'
import { buildClaudeChatSendStreamParams } from './claudeToolLoopStreamParams'
import { CHAT_CANCELLED_MESSAGE, clearChatCancel, registerChatCancel, signalChatCancel } from './chatCancelRegistry'
import { logAgentEvent } from './agentLogger/agentLogger'
import { normalizeAnthropicMessageUsage } from './anthropicUsageNormalize'
import type { AppDatabase } from './database'
import { runToolChatSession } from './toolChatLoop'
import { getCachedMemoryContent } from './projectMemory'
import { buildFinalSystemPrompt, resolveRequestLocale } from './llmSystemPrompt'
import { isAppLocale } from '../src/shared/locale'
import { MAX_CHAT_API_MESSAGES } from '../src/shared/chatApiMessageLimits'
import { trimClaudeToolChatMessages } from '../src/shared/claudeToolHistory'
import { MAX_API_MESSAGE_TEXT_CHARS, MAX_TOOL_RESULT_CONTENT_CHARS } from '../src/shared/toolResultLimits'

export type ClaudeStreamDeps = {
  getApiKey: () => Promise<string | null>
  getWorkDir: () => string
  getUserDataPath: () => string
  getToolsConfig: () => ToolsConfig
  getBrowserConfig: () => BrowserConfig
  getShellConfig: () => ShellConfig
  getWikiConfig: () => WikiConfig
  getAppDatabase: () => AppDatabase
  getProjectMemoryEnabled?: () => boolean
  getBrowserDetectContext: () => import('../src/shared/browserTypes').BrowserDetectContext
  floatingNotificationManager?: import('./floatingNotificationManager').FloatingNotificationManager
}

type ClaudeMessageRole = 'user' | 'assistant'

type ClaudeChatMessage = {
  role: ClaudeMessageRole
  content: string
  id?: string
  timestamp?: number
}

type ClaudeChatSendPayload = {
  requestId: string
  model: string
  baseUrl?: string
  messages: ClaudeChatMessage[]
  system?: string
  maxTokens?: number
  projectMemoryEnabled?: boolean
  locale?: string
}

type ClaudeChatMessageWithContentBlocks = {
  role: ClaudeMessageRole
  content: string | Array<unknown>
  id?: string
  timestamp?: number
}

type ClaudeChatCreateWithToolsPayload = {
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: ClaudeChatMessageWithContentBlocks[]
  tools: Array<unknown>
  system?: string
  options?: {
    maxTokens?: number
    enableThinking?: boolean
  }
  projectMemoryEnabled?: boolean
  locale?: string
}

function normalizeAndValidateClaudeMessages(messages: unknown): ClaudeChatMessage[] {
  if (!Array.isArray(messages)) throw new Error('Invalid messages')

  return messages.map((m, idx) => {
    const msg = m as Partial<ClaudeChatMessage> | null
    if (!msg || typeof msg !== 'object') throw new Error(`Invalid message at index ${idx}`)
    if (msg.role !== 'user' && msg.role !== 'assistant') throw new Error(`Invalid role at index ${idx}`)
    if (typeof msg.content !== 'string' || !msg.content.trim()) throw new Error(`Invalid content at index ${idx}`)

    return {
      role: msg.role,
      content: msg.content,
      id: typeof msg.id === 'string' ? msg.id : undefined,
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : undefined
    }
  })
}

function assertValidClaudeContentBlocks(content: unknown, idx: number): string | Array<unknown> {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (!trimmed) return ' '
    if (trimmed.length > MAX_API_MESSAGE_TEXT_CHARS) throw new Error(`Content too long at index ${idx}`)
    return trimmed
  }

  if (!Array.isArray(content)) throw new Error(`Invalid content blocks at index ${idx}`)
  if (content.length > 80) throw new Error(`Too many content blocks at index ${idx}`)

  for (const b of content) {
    if (!b || typeof b !== 'object') throw new Error('Invalid content block')
    const type = (b as { type?: string }).type
    if (typeof type !== 'string') throw new Error('Invalid content block type')

    if (type === 'tool_use') {
      if (typeof (b as { id?: unknown }).id !== 'string') throw new Error('Invalid tool_use id')
      if (typeof (b as { name?: unknown }).name !== 'string') throw new Error('Invalid tool_use name')
      if ((b as { input?: unknown }).input === undefined) throw new Error('Invalid tool_use input')
      continue
    }

    if (type === 'tool_result') {
      if (typeof (b as { tool_use_id?: unknown }).tool_use_id !== 'string') throw new Error('Invalid tool_result tool_use_id')
      if ((b as { content?: unknown }).content === undefined) throw new Error('Invalid tool_result content')
      if (
        typeof (b as { content?: unknown }).content === 'string' &&
        (b as { content: string }).content.length > MAX_TOOL_RESULT_CONTENT_CHARS
      ) {
        throw new Error('tool_result content too long')
      }
      continue
    }

    if (type === 'text') {
      if (typeof (b as { text?: unknown }).text !== 'string') throw new Error('Invalid text block')
      if ((b as { text: string }).text.length > MAX_API_MESSAGE_TEXT_CHARS) throw new Error('text too long')
      continue
    }

    if (type === 'thinking') {
      if (typeof (b as { thinking?: unknown }).thinking !== 'string') throw new Error('Invalid thinking block')
      if ((b as { thinking: string }).thinking.length > 500_000) throw new Error('thinking too long')
      continue
    }
    if (type === 'redacted_thinking') {
      if (typeof (b as { data?: unknown }).data !== 'string') throw new Error('Invalid redacted_thinking block')
      if ((b as { data: string }).data.length > 500_000) throw new Error('redacted_thinking too long')
      continue
    }
  }

  return content
}

function normalizeAndValidateClaudeMessagesWithContentBlocks(messages: unknown): ClaudeChatMessageWithContentBlocks[] {
  if (!Array.isArray(messages)) throw new Error('Invalid messages')

  const trimmed = trimClaudeToolChatMessages(messages as ClaudeChatMessageWithContentBlocks[], MAX_CHAT_API_MESSAGES)
  if (trimmed.length === 0) throw new Error('Too many messages')

  return trimmed.map((m, idx) => {
    const msg = m as Partial<ClaudeChatMessageWithContentBlocks> | null
    if (!msg || typeof msg !== 'object') throw new Error(`Invalid message at index ${idx}`)
    if (msg.role !== 'user' && msg.role !== 'assistant') throw new Error(`Invalid role at index ${idx}`)

    const content = assertValidClaudeContentBlocks((msg as { content?: unknown }).content, idx)

    return {
      role: msg.role,
      content,
      id: typeof msg.id === 'string' ? msg.id : undefined,
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : undefined
    }
  })
}

export function registerClaudeStreamHandlers(ipcMain: IpcMain, deps: ClaudeStreamDeps): void {
  ipcMain.handle(
    'claude-chat-send-stream',
    async (event, payload: ClaudeChatSendPayload): Promise<{ ok: true } | { ok: false; error: string }> => {
      const sender = event.sender

      try {
        const requestId = assertValidRequestId(payload.requestId)
        const model = assertValidModel(payload.model)
        const baseUrl = assertValidOptionalAnthropicBaseUrl(payload.baseUrl)
        const messages = normalizeAndValidateClaudeMessages(payload.messages)

        const system = typeof payload.system === 'string' ? payload.system : undefined
        const maxTokens = typeof payload.maxTokens === 'number' && Number.isFinite(payload.maxTokens) ? payload.maxTokens : undefined
        const payloadLocale =
          typeof payload.locale === 'string' && isAppLocale(payload.locale) ? payload.locale : undefined
        void runSendStream(sender, {
          requestId,
          model,
          baseUrl,
          messages,
          system,
          maxTokens,
          projectMemoryEnabled: payload.projectMemoryEnabled,
          locale: payloadLocale,
          deps
        })
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logAgentEvent('error', 'llm.error', {
          requestId: typeof payload?.requestId === 'string' ? payload.requestId : undefined,
          error: message
        })
        return { ok: false, error: message }
      }
    }
  )

  ipcMain.handle(
    'claude-chat-create-with-tools',
    async (event, payload: ClaudeChatCreateWithToolsPayload) => {
      const sender = event.sender
      let requestId = ''
      try {
        requestId = assertValidRequestId(payload.requestId)
        const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0 ? payload.sessionId : ''
        if (!sessionId) throw new Error('Invalid sessionId')
        const model = assertValidModel(payload.model)
        const baseUrl = assertValidOptionalAnthropicBaseUrl(payload.baseUrl)
        const messages = normalizeAndValidateClaudeMessagesWithContentBlocks(payload.messages)

        const toolsRaw = Array.isArray(payload.tools) ? payload.tools : []
        for (const t of toolsRaw) {
          if (!t || typeof t !== 'object') throw new Error('Invalid tool spec')
          if (typeof (t as { name?: unknown }).name !== 'string') throw new Error('Invalid tool name')
          if (typeof (t as { description?: unknown }).description !== 'string') throw new Error('Invalid tool description')
          if (!(t as { input_schema?: unknown }).input_schema || typeof (t as { input_schema?: unknown }).input_schema !== 'object') {
            throw new Error('Invalid tool input_schema')
          }
        }

        const res = await runToolChatSession({
          sender,
          requestId,
          sessionId,
          model,
          baseUrl,
          messages,
          system: payload.system,
          locale:
            typeof payload.locale === 'string' && isAppLocale(payload.locale) ? payload.locale : undefined,
          projectMemoryEnabled: payload.projectMemoryEnabled,
          options: payload.options,
          toolsConfig: deps.getToolsConfig(),
          browserConfig: deps.getBrowserConfig(),
          shellConfig: deps.getShellConfig(),
          wikiConfig: deps.getWikiConfig(),
          workDir: deps.getWorkDir(),
          userDataDir: deps.getUserDataPath(),
          getApiKey: deps.getApiKey,
          appDb: deps.getAppDatabase(),
          getBrowserDetectContext: deps.getBrowserDetectContext,
          floatingNotificationManager: deps.floatingNotificationManager
        })

        if (!res.ok) {
          logAgentEvent('error', 'llm.error', {
            requestId,
            sessionId,
            model,
            error: res.error
          })
          safeWebContentsSend(sender,'claude-chat-error', { requestId, message: res.error })
          return res
        }

        safeWebContentsSend(sender,'claude-chat-done', { requestId })

        return {
          ok: true as const,
          content: res.content,
          stopReason: res.stopReason,
          ...('usage' in res && res.usage ? { usage: res.usage } : {})
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logAgentEvent('error', 'llm.error', {
          requestId: requestId || undefined,
          sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
          model: typeof payload?.model === 'string' ? payload.model : undefined,
          error: message,
          stack: err instanceof Error ? err.stack : undefined
        })
        if (requestId) safeWebContentsSend(sender,'claude-chat-error', { requestId, message })
        return { ok: false as const, error: message }
      }
    }
  )

  ipcMain.handle('claude-chat-cancel', async (_event, payload: { requestId: string }): Promise<void> => {
    const requestId = assertValidRequestId(payload.requestId)
    signalChatCancel(requestId)
    deps.floatingNotificationManager?.onAllCancelledForRequest(requestId)
  })
}

async function runSendStream(
  sender: WebContents,
  args: {
    requestId: string
    model: string
    baseUrl: string | undefined
    messages: ClaudeChatMessage[]
    system?: string
    maxTokens?: number
    projectMemoryEnabled?: boolean
    locale?: import('../src/shared/locale').AppLocale
    deps: ClaudeStreamDeps
  }
): Promise<void> {
  const { requestId, model, baseUrl, messages, system, maxTokens: maxTokensRaw, deps } = args
  const maxTokens = normalizeToolLoopMaxTokens(maxTokensRaw)
  const chatSignal = registerChatCancel(requestId)
  try {
    const apiKey = await deps.getApiKey()
    if (!apiKey) {
      logAgentEvent('error', 'llm.error', { requestId, model, error: 'API key not configured' })
      safeWebContentsSend(sender,'claude-chat-error', { requestId, message: 'API key not configured' })
      return
    }

    if (chatSignal.aborted) {
      logAgentEvent('error', 'llm.error', { requestId, model, error: CHAT_CANCELLED_MESSAGE })
      safeWebContentsSend(sender,'claude-chat-error', { requestId, message: CHAT_CANCELLED_MESSAGE })
      return
    }

    const client = createAnthropicClient(apiKey, baseUrl)
    const messageParams: Anthropic.MessageParam[] = messages.map((msg) => ({
      role: msg.role,
      content: msg.content
    }))

    const memoryContent = getCachedMemoryContent()
    const memoryEnabled = args.projectMemoryEnabled ?? true
    const locale = resolveRequestLocale(args.locale, deps.getAppDatabase())
    const finalSystem = buildFinalSystemPrompt({
      system,
      memoryContent,
      memoryEnabled,
      locale
    })

    const streamInput = buildClaudeChatSendStreamParams({
      model,
      max_tokens: maxTokens,
      messages: messageParams,
      system: finalSystem,
      thinking: { type: 'adaptive' as const }
    })

    logAgentEvent('info', 'llm.request', {
      requestId,
      model,
      baseUrl,
      locale,
      system: finalSystem,
      messages: messageParams,
      maxTokens,
      enableThinking: true
    })

    const stream = client.messages.stream(streamInput as Parameters<typeof client.messages.stream>[0])

    const contentBlockTypes = new Map<number, string>()
    for await (const evt of stream) {
      if (chatSignal.aborted) {
        safeWebContentsSend(sender,'claude-chat-error', { requestId, message: CHAT_CANCELLED_MESSAGE })
        return
      }
      if (evt?.type === 'content_block_start') {
        const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
        const blockType = (evt as { content_block?: { type?: string } }).content_block?.type
        if (index >= 0 && typeof blockType === 'string') {
          contentBlockTypes.set(index, blockType)
        }
      }
      if (evt?.type === 'content_block_delta' && (evt as { delta?: { type?: string; thinking?: string } }).delta?.type === 'thinking_delta') {
        const thinking = (evt as { delta?: { thinking?: string } }).delta?.thinking
        if (typeof thinking === 'string' && thinking.length > 0) {
          safeWebContentsSend(sender,'claude-chat-thinking-delta', { requestId, text: thinking })
        }
      }
      if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        const text = evt.delta.text
        const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
        const blockType = contentBlockTypes.get(index)
        if (blockType === 'thinking') {
          if (typeof text === 'string' && text.length > 0) {
            safeWebContentsSend(sender,'claude-chat-thinking-delta', { requestId, text })
          }
          continue
        }
        if (typeof text === 'string' && text.length > 0) {
          safeWebContentsSend(sender,'claude-chat-delta', { requestId, text })
        }
      }
    }

    if (chatSignal.aborted) {
      logAgentEvent('error', 'llm.error', { requestId, model, error: CHAT_CANCELLED_MESSAGE })
      safeWebContentsSend(sender,'claude-chat-error', { requestId, message: CHAT_CANCELLED_MESSAGE })
      return
    }

    const res = await stream.finalMessage()
    const content = Array.isArray(res?.content) ? res.content : []
    const stopReason = typeof res?.stop_reason === 'string' ? res.stop_reason : undefined
    const usage = normalizeAnthropicMessageUsage(res)

    logAgentEvent('info', 'llm.response', {
      requestId,
      model,
      stopReason,
      content,
      usage
    })

    safeWebContentsSend(sender,'claude-chat-done', { requestId, usage: usage ?? null })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logAgentEvent('error', 'llm.error', {
      requestId,
      model,
      error: message,
      stack: err instanceof Error ? err.stack : undefined
    })
    safeWebContentsSend(sender,'claude-chat-error', { requestId, message })
  } finally {
    clearChatCancel(requestId)
  }
}
