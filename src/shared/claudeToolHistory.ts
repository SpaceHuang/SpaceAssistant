import type { ChatImageAttachment, Message, ToolCallRecord } from './domainTypes'
import type { ClaudeChatMessageWithBlocks } from './api'
import { MAX_CHAT_API_MESSAGES } from './chatApiMessageLimits'
import { toolIdToOpenAiCompatibleApiToolName } from './anthropicToolSanitize'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from './toolResultPairing'

export type ClaudeUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export type ImageHydrationMode = 'full' | 'text-placeholder-only'

export interface ToolResultBlockBuild {
  content: string
  isError: boolean
}

export function buildToolResultBlock(tc: ToolCallRecord): ToolResultBlockBuild {
  if (tc.corrupted) {
    return { content: tc.result?.error ?? '工具调用记录数据损坏', isError: true }
  }
  if (!tc.result) {
    return { content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER, isError: true }
  }
  if (tc.result.success === false) {
    return { content: tc.result.error ?? '失败', isError: true }
  }
  if (tc.result.data === undefined) return { content: '{}', isError: false }
  const content =
    typeof tc.result.data === 'string' ? tc.result.data : JSON.stringify(tc.result.data)
  return { content, isError: false }
}

/** API 不接受空字符串 content；无正文时用单空格占位，避免阻断后续请求 */
function ensureApiTextContent(content: string | undefined | null): string {
  const trimmed = (content ?? '').trim()
  return trimmed.length > 0 ? trimmed : ' '
}

export function formatHistoricalImagePlaceholder(attachments: ChatImageAttachment[]): string {
  const names = attachments.map((a) => a.fileName).join(', ')
  return `[此前发送的图片: ${names}]`
}

/** 策略 A：有 attachments 即 full hydrate；staging 不可读时由 buildUserMessageContent 输出失效文案 */
function resolveHydrationMode(msg: Message): ImageHydrationMode {
  if (!msg.attachments?.length) return 'text-placeholder-only'
  return 'full'
}

export function buildUserMessageContent(
  text: string,
  attachments: ChatImageAttachment[] | undefined,
  options: {
    hydrationMode: ImageHydrationMode
    resolveImage: (a: ChatImageAttachment) => { mimeType: string; data: string } | null
  }
): string | ClaudeUserContentBlock[] {
  const apiText = ensureApiTextContent(text)
  if (!attachments?.length) return apiText

  if (options.hydrationMode === 'text-placeholder-only') {
    const placeholder = formatHistoricalImagePlaceholder(attachments)
    return `${apiText}\n${placeholder}`.trim()
  }

  const blocks: ClaudeUserContentBlock[] = [{ type: 'text', text: apiText }]
  for (const a of attachments) {
    const resolved = options.resolveImage(a)
    if (resolved) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: resolved.mimeType, data: resolved.data }
      })
    } else {
      blocks.push({
        type: 'text',
        text: `[图片附件已失效: ${a.fileName}]`
      })
    }
  }
  return blocks
}

export type BuildClaudeToolChatMessagesOptions = {
  currentUserMessageId?: string
  resolveImage?: (a: ChatImageAttachment) => { mimeType: string; data: string } | null
}

/** 将本地消息列表转为带 content blocks 的 API 消息（含历史 tool_use / tool_result） */
export function buildClaudeToolChatMessages(
  messages: Message[],
  options?: BuildClaudeToolChatMessagesOptions
): ClaudeChatMessageWithBlocks[] {
  const resolveImage = options?.resolveImage ?? (() => null)
  const out: ClaudeChatMessageWithBlocks[] = []

  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.role === 'assistant' && m.status === 'streaming') continue
    if (m.role === 'user' && m.status === 'queued') continue
    if (m.role === 'user') {
      let content: string | ClaudeUserContentBlock[]
      if (m.attachments?.length) {
        const hydrationMode = resolveHydrationMode(m)
        content = buildUserMessageContent(m.content, m.attachments, { hydrationMode, resolveImage })
      } else {
        content = ensureApiTextContent(m.content)
      }
      out.push({ role: 'user', content, id: m.id, timestamp: m.timestamp })
      continue
    }
    if (m.toolCalls?.length) {
      const blocks: unknown[] = []
      if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) {
        if (tc.status === 'calling' || tc.status === 'confirming' || tc.status === 'executing') continue
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: toolIdToOpenAiCompatibleApiToolName(tc.toolName),
          input: tc.input
        })
      }
      if (blocks.length === 0) {
        out.push({ role: 'assistant', content: ensureApiTextContent(m.content), id: m.id, timestamp: m.timestamp })
        continue
      }
      out.push({ role: 'assistant', content: blocks, id: m.id, timestamp: m.timestamp })
      const results: unknown[] = []
      for (const tc of m.toolCalls) {
        if (tc.status === 'calling' || tc.status === 'confirming' || tc.status === 'executing') continue
        const block = buildToolResultBlock(tc)
        results.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: block.content,
          ...(block.isError ? { is_error: true } : {})
        })
      }
      if (results.length) out.push({ role: 'user', content: results })
    } else {
      out.push({ role: 'assistant', content: ensureApiTextContent(m.content), id: m.id, timestamp: m.timestamp })
    }
  }
  return out
}

function isToolResultOnlyUserMessage(msg: ClaudeChatMessageWithBlocks): boolean {
  if (msg.role !== 'user' || !Array.isArray(msg.content) || msg.content.length === 0) return false
  return msg.content.every((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result')
}

/** 保留最近 N 条 API 消息；裁剪头部时丢弃孤立的 tool_result，保证以 user 文本消息开头。
 *  截断以 use+result 对为原子单元：切点落在 assistant(tool_use) 与紧邻 user(tool_result) 之间时，
 *  头部清理会丢弃孤立 assistant 或 tool_result-only user；中间孤立由 ensureToolResultPairing 兜底。 */
export function trimClaudeToolChatMessages(
  messages: ClaudeChatMessageWithBlocks[],
  maxMessages = MAX_CHAT_API_MESSAGES
): ClaudeChatMessageWithBlocks[] {
  if (messages.length <= maxMessages) return messages

  let trimmed = messages.slice(-maxMessages)
  while (trimmed.length > 0) {
    const first = trimmed[0]
    if (first.role === 'assistant') {
      trimmed = trimmed.slice(1)
      continue
    }
    if (isToolResultOnlyUserMessage(first)) {
      trimmed = trimmed.slice(1)
      continue
    }
    break
  }
  return trimmed
}

export function messageHasImageAttachments(msg: Message): boolean {
  return msg.role === 'user' && (msg.attachments?.length ?? 0) > 0
}
