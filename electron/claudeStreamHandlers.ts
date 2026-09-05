import type { IpcMain, WebContents } from 'electron'
import { safeWebContentsSend } from './safeWebContentsSend'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../src/shared/domainTypes'
import { assertValidModel, assertValidOptionalAnthropicBaseUrl, assertValidRequestId } from './claudeRequestGuards'
import { signalChatCancel } from './chatCancelRegistry'
import { logAgentEvent } from './agentLogger/agentLogger'
import type { AgentLogFields } from './agentLogger/types'
import type { AppDatabase } from './database'
import { resolveLlmCredentialsForModel } from './llmServiceResolver'
import { runToolChatSession } from './toolChatLoop'
import { isAppLocale } from '../src/shared/locale'
import { MAX_IMAGE_BASE64_CHARS } from '../src/shared/chatAttachmentLimits'
import { MAX_CHAT_API_CONTENT_BLOCKS, MAX_CHAT_API_MESSAGES } from '../src/shared/chatApiMessageLimits'
import { trimClaudeToolChatMessages } from '../src/shared/claudeToolHistory'
import { ensureToolResultPairing } from '../src/shared/toolResultPairing'
import { sanitizeForLog } from './logSanitize'
import { historyHasImageAttachments } from '../src/shared/visionModelRouting'
import { buildToolChatMessagesFromSource } from './chatMessageBuild'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
import { mayBuildMcpToolSnapshot } from './mcp/mcpToolRegistry'
import { listProfiles } from './mcp/mcpConfigStore'
import type { Message } from '../src/shared/domainTypes'
import { compactOversizedToolResultContent } from '../src/shared/oversizedToolResult'
import { MAX_API_MESSAGE_TEXT_CHARS, MAX_TOOL_RESULT_CONTENT_CHARS } from '../src/shared/toolResultLimits'

export type ClaudeStreamDeps = {
  getApiKey: () => Promise<string | null>
  getWorkDir: () => string
  resolveWorkDirForSession: (sessionId: string) => string
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
  llmServiceId?: string
  sourceMessages?: Message[]
  currentUserMessageId?: string
  messages?: ClaudeChatMessageWithContentBlocks[]
  system?: string
  options?: {
    maxTokens?: number
    enableThinking?: boolean
  }
  projectMemoryEnabled?: boolean
  locale?: string
}

function assertValidClaudeContentBlocks(
  content: unknown,
  idx: number,
  logContext?: { sessionId?: string }
): string | Array<unknown> {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (!trimmed) return ' '
    if (trimmed.length > MAX_API_MESSAGE_TEXT_CHARS) throw new Error(`Content too long at index ${idx}`)
    return trimmed
  }

  if (!Array.isArray(content)) throw new Error(`Invalid content blocks at index ${idx}`)
  if (content.length > MAX_CHAT_API_CONTENT_BLOCKS) throw new Error(`Too many content blocks at index ${idx}`)

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
      if (typeof (b as { content?: unknown }).content === 'string') {
        const block = b as { tool_use_id: string; content: string }
        const compacted = compactOversizedToolResultContent(block.content)
        if (compacted.compacted) {
          block.content = compacted.content
          logAgentEvent(
            'warn',
            'tool.result.oversized.compacted',
            sanitizeForLog({
              sessionId: logContext?.sessionId,
              toolUseId: block.tool_use_id,
              originalLength: compacted.originalLength,
              compactedLength: compacted.content.length,
              maxChars: MAX_TOOL_RESULT_CONTENT_CHARS
            }) as AgentLogFields
          )
        }
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

    if (type === 'image') {
      const source = (b as { source?: { type?: string; media_type?: string; data?: string } }).source
      if (source?.type !== 'base64') throw new Error('Invalid image source type')
      if (!/^image\//.test(source.media_type ?? '')) throw new Error('Invalid image media_type')
      if (typeof source.data !== 'string' || source.data.length === 0) throw new Error('Invalid image data')
      if (source.data.length > MAX_IMAGE_BASE64_CHARS) throw new Error('image data too long')
      continue
    }
  }

  return content
}

export function normalizeAndValidateClaudeMessagesWithContentBlocks(
  messages: unknown,
  logContext?: { sessionId?: string }
): ClaudeChatMessageWithContentBlocks[] {
  if (!Array.isArray(messages)) throw new Error('Invalid messages')

  const trimmed = trimClaudeToolChatMessages(messages as ClaudeChatMessageWithContentBlocks[], MAX_CHAT_API_MESSAGES)
  const { messages: paired, report } = ensureToolResultPairing(trimmed)
  if (report.repaired) {
    logAgentEvent('warn', 'tool.result.pairing.repaired', sanitizeForLog({
      sessionId: logContext?.sessionId,
      originalCount: report.originalCount,
      repairedCount: report.repairedCount,
      fixes: report.fixes,
      messageStructure: report.messageStructure.join('; ')
    }) as AgentLogFields)
  }
  if (paired.length === 0) throw new Error('Too many messages')

  return paired.map((m, idx) => {
    const msg = m as Partial<ClaudeChatMessageWithContentBlocks> | null
    if (!msg || typeof msg !== 'object') throw new Error(`Invalid message at index ${idx}`)
    if (msg.role !== 'user' && msg.role !== 'assistant') throw new Error(`Invalid role at index ${idx}`)

    const content = assertValidClaudeContentBlocks((msg as { content?: unknown }).content, idx, logContext)

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
    'claude-chat-create-with-tools',
    async (event, payload: ClaudeChatCreateWithToolsPayload) => {
      const sender = event.sender
      let requestId = ''
      try {
        requestId = assertValidRequestId(payload.requestId)
        const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0 ? payload.sessionId : ''
        if (!sessionId) throw new Error('Invalid sessionId')
        const model = assertValidModel(payload.model)
        const baseUrlFromPayload = assertValidOptionalAnthropicBaseUrl(payload.baseUrl)
        const llmServiceId = typeof payload.llmServiceId === 'string' ? payload.llmServiceId.trim() : undefined
        const db = deps.getAppDatabase()
        const creds = await resolveLlmCredentialsForModel(db, model, { serviceId: llmServiceId })
        const baseUrl = baseUrlFromPayload ?? creds.baseUrl
        const getApiKey = creds.error ? deps.getApiKey : creds.getApiKey
        const userDataDir = deps.getUserDataPath()
        const currentUserMessageId =
          typeof payload.currentUserMessageId === 'string' ? payload.currentUserMessageId.trim() : ''
        let builtMessages: ClaudeChatMessageWithContentBlocks[]
        if (Array.isArray(payload.sourceMessages) && payload.sourceMessages.length > 0 && currentUserMessageId) {
          builtMessages = await buildToolChatMessagesFromSource({
            userDataDir,
            sourceMessages: payload.sourceMessages,
            currentUserMessageId,
            sessionId
          })
        } else if (Array.isArray(payload.messages)) {
          builtMessages = payload.messages
        } else {
          throw new Error('Invalid messages payload')
        }
        const messages = normalizeAndValidateClaudeMessagesWithContentBlocks(builtMessages, { sessionId })
        const hasImageAttachments = Array.isArray(payload.sourceMessages)
          ? historyHasImageAttachments(payload.sourceMessages)
          : false

        const builtinCandidates = filterBuiltinToolsForApi(
          deps.getToolsConfig(),
          undefined,
          deps.getBrowserConfig(),
          undefined,
          deps.getShellConfig(),
          undefined
        )
        const needsToolWorkDir = builtinCandidates.length > 0 || mayBuildMcpToolSnapshot(listProfiles(db))
        const sessionWorkDir = needsToolWorkDir ? deps.resolveWorkDirForSession(sessionId) : ''

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
          workDir: sessionWorkDir,
          userDataDir,
          getApiKey,
          appDb: deps.getAppDatabase(),
          currentUserMessageId: currentUserMessageId || undefined,
          hasImageAttachments,
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
