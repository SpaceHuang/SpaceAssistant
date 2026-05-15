import type { IpcMain, WebContents } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_TOOL_LOOP_MAX_TOKENS } from '../src/shared/llm/toolLoopMaxTokens'
import type { ToolsConfig } from '../src/shared/domainTypes'
import { createAnthropicClient } from './anthropicClientFactory'
import { assertValidModel, assertValidOptionalAnthropicBaseUrl, assertValidRequestId } from './claudeRequestGuards'
import { buildClaudeChatSendStreamParams } from './claudeToolLoopStreamParams'
import { runToolChatSession } from './toolChatLoop'

export type ClaudeStreamDeps = {
  getApiKey: () => Promise<string | null>
  getWorkDir: () => string
  getUserDataPath: () => string
  getToolsConfig: () => ToolsConfig
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
    if (!trimmed) throw new Error(`Invalid content at index ${idx}`)
    if (trimmed.length > 40000) throw new Error(`Content too long at index ${idx}`)
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
      if (typeof (b as { content?: unknown }).content === 'string' && (b as { content: string }).content.length > 40000) {
        throw new Error('tool_result content too long')
      }
      continue
    }

    if (type === 'text') {
      if (typeof (b as { text?: unknown }).text !== 'string') throw new Error('Invalid text block')
      if ((b as { text: string }).text.length > 40000) throw new Error('text too long')
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
  if (messages.length > 60) throw new Error('Too many messages')

  return messages.map((m, idx) => {
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

        void runSendStream(sender, { requestId, model, baseUrl, messages, deps })
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
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
          options: payload.options,
          toolsConfig: deps.getToolsConfig(),
          workDir: deps.getWorkDir(),
          userDataDir: deps.getUserDataPath(),
          getApiKey: deps.getApiKey
        })

        if (!res.ok) {
          sender.send('claude-chat-error', { requestId, message: res.error })
          return res
        }

        sender.send('claude-chat-done', { requestId })
        return {
          ok: true as const,
          content: res.content,
          stopReason: res.stopReason,
          ...(res.usage && { usage: res.usage })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (requestId) sender.send('claude-chat-error', { requestId, message })
        return { ok: false as const, error: message }
      }
    }
  )
}

async function runSendStream(
  sender: WebContents,
  args: {
    requestId: string
    model: string
    baseUrl: string | undefined
    messages: ClaudeChatMessage[]
    deps: ClaudeStreamDeps
  }
): Promise<void> {
  const { requestId, model, baseUrl, messages, deps } = args
  try {
    const apiKey = await deps.getApiKey()
    if (!apiKey) {
      sender.send('claude-chat-error', { requestId, message: 'API key not configured' })
      return
    }

    const client = createAnthropicClient(apiKey, baseUrl)
    const messageParams: Anthropic.MessageParam[] = messages.map((msg) => ({
      role: msg.role,
      content: msg.content
    }))

    const streamInput = buildClaudeChatSendStreamParams({
      model,
      max_tokens: DEFAULT_TOOL_LOOP_MAX_TOKENS,
      messages: messageParams,
      thinking: { type: 'adaptive' as const }
    })

    const stream = client.messages.stream(streamInput as Parameters<typeof client.messages.stream>[0])

    const contentBlockTypes = new Map<number, string>()
    for await (const evt of stream) {
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
          sender.send('claude-chat-thinking-delta', { requestId, text: thinking })
        }
      }
      if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        const text = evt.delta.text
        const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
        const blockType = contentBlockTypes.get(index)
        if (blockType === 'thinking') {
          if (typeof text === 'string' && text.length > 0) {
            sender.send('claude-chat-thinking-delta', { requestId, text })
          }
          continue
        }
        if (typeof text === 'string' && text.length > 0) {
          sender.send('claude-chat-delta', { requestId, text })
        }
      }
    }

    sender.send('claude-chat-done', { requestId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sender.send('claude-chat-error', { requestId, message })
  }
}
