import type { IpcMain, WebContents } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { toolIdToOpenAiCompatibleApiToolName } from '../src/shared/toolApiFunctionName'
import { DEFAULT_TOOL_LOOP_MAX_TOKENS } from '../src/shared/llm/toolLoopMaxTokens'
import { normalizeAnthropicMessageUsage } from './anthropicUsageNormalize'
import { createAnthropicClient } from './anthropicClientFactory'
import { assertValidModel, assertValidOptionalAnthropicBaseUrl, assertValidRequestId } from './claudeRequestGuards'
import { buildClaudeChatSendStreamParams, buildClaudeToolLoopStreamParams } from './claudeToolLoopStreamParams'
import { normalizeStopReason } from './stopReason'
import { resolveToolLoopModelOptions } from './toolLoopModelOptions'

export type ClaudeStreamDeps = {
  getApiKey: () => Promise<string | null>
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

function sanitizeAnthropicToolsPayloadForStrictGateways(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t
    const o = t as Record<string, unknown>
    const rawName = typeof o.name === 'string' ? o.name : ''
    return { ...o, name: toolIdToOpenAiCompatibleApiToolName(rawName) }
  })
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

function stripAssistantThinkingBlocksForDisabledThinkingApi(
  messages: ClaudeChatMessageWithContentBlocks[]
): ClaudeChatMessageWithContentBlocks[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || typeof m.content === 'string' || !Array.isArray(m.content)) {
      return m
    }
    const filtered = m.content.filter((b: unknown) => {
      if (!b || typeof b !== 'object') return true
      const t = (b as { type?: string }).type
      return t !== 'thinking' && t !== 'redacted_thinking'
    })
    if (filtered.length === m.content.length) return m
    return { ...m, content: filtered }
  })
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

        const tools = sanitizeAnthropicToolsPayloadForStrictGateways(toolsRaw)

        const apiKey = await deps.getApiKey()
        if (!apiKey) return { ok: false as const, error: 'API key not configured' }

        const client = createAnthropicClient(apiKey, baseUrl)
        const systemPrompt =
          typeof payload.system === 'string' && payload.system.trim().length > 0 ? payload.system : undefined
        const toolLoopOptions = resolveToolLoopModelOptions(payload.options)
        const thinking = toolLoopOptions.enableThinking ? ({ type: 'adaptive' as const }) : ({ type: 'disabled' as const })

        const messagesForApi = toolLoopOptions.enableThinking
          ? messages
          : stripAssistantThinkingBlocksForDisabledThinkingApi(messages)

        const toolLoopStreamParams = buildClaudeToolLoopStreamParams({
          model,
          max_tokens: toolLoopOptions.maxTokens,
          system: systemPrompt,
          messages: messagesForApi,
          tools,
          thinking
        })

        const stream = client.messages.stream({
          ...toolLoopStreamParams,
          messages: messagesForApi as Anthropic.MessageParam[],
          tools: tools as Anthropic.Tool[]
        } as Parameters<typeof client.messages.stream>[0])

        const startedAt = Date.now()
        let firstActivityAt: number | null = null
        let firstTextAt: number | null = null
        const contentBlockTypes = new Map<number, string>()
        const contentBlocks: Array<unknown> = []
        const pendingToolUseByIndex = new Map<number, { id: string; name: string; input: unknown; partialJson: string }>()
        const pendingTextByIndex = new Map<number, string>()
        let stopReason: string | undefined

        const parseToolInput = (baseInput: unknown, partialJson: string): unknown => {
          const fallback = baseInput ?? {}
          const jsonText = partialJson.trim()
          if (!jsonText) return fallback
          try {
            return JSON.parse(jsonText)
          } catch {
            return fallback
          }
        }

        for await (const evt of stream) {
          if (firstActivityAt == null) firstActivityAt = Date.now()
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
            typeof (evt as { delta?: { text?: string } }).delta?.text === 'string' &&
            (evt as { delta: { text: string } }).delta.text.length > 0
          ) {
            const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
            const blockType = contentBlockTypes.get(index)
            const textDelta = (evt as { delta: { text: string } }).delta.text
            if (blockType === 'thinking') {
              sender.send('claude-chat-thinking-delta', { requestId, text: textDelta })
            } else {
              if (firstTextAt == null) firstTextAt = Date.now()
              if (typeof textDelta === 'string' && textDelta.length > 0 && blockType === 'text') {
                const prev = pendingTextByIndex.get(index) ?? ''
                pendingTextByIndex.set(index, prev + textDelta)
              }
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
                const toolUseBlock = {
                  type: 'tool_use',
                  id: pending.id,
                  name: pending.name,
                  input: parseToolInput(pending.input, pending.partialJson)
                }
                contentBlocks.push(toolUseBlock)
                sender.send('claude-chat-tool-use', { requestId, toolUse: toolUseBlock, at: Date.now() })
              }
            }
          }
          sender.send('claude-chat-tools-activity', { requestId, at: Date.now() })
        }

        let content: Array<unknown> = contentBlocks
        const res = (await stream.finalMessage()) as { content?: unknown[]; stop_reason?: string }
        const finalContent = Array.isArray(res?.content) ? res.content : []
        content = finalContent.length > 0 ? finalContent : contentBlocks
        const rawStopReason = typeof res?.stop_reason === 'string' ? res.stop_reason : undefined
        stopReason = normalizeStopReason(rawStopReason)
        const usage = normalizeAnthropicMessageUsage(res)

        return {
          ok: true as const,
          content,
          stopReason,
          ...(usage && { usage })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
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
